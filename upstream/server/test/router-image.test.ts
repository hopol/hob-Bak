import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Item } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { createRuntime } from "../src/runtime.ts";
import { writeSecret } from "../src/secrets.ts";
import { makeHob, text, waitFor } from "./helpers.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

describe("对话生图", () => {
  it("按配置和助手能力注册工具", () => {
    const hob = makeHob();
    try {
      const names = () => buildRouterTools(hob.runtime, "hob").map((tool) => tool.name);
      expect(names()).not.toContain("generate_image");
      hob.runtime.settings.setImage(hob.runtime.settings.get().revision, { source: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "fake" });
      expect(names()).toContain("generate_image");
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, abilities: { exec: true, write: true, image: false } });
      expect(names()).not.toContain("generate_image");
    } finally { hob.close(); }
  });

  it("生成和失败都先推 pending，再更新同一条；刷新与预览可读", async () => {
    let respond: (() => void) | undefined;
    const server = createServer((_req, res) => {
      respond = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })); };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const hob = makeHob();
    try {
      hob.faux.setResponses([text("好的")]);
      await hob.runtime.router.send("hob", { text: "开始" });
      await hob.runtime.router.waitIdle("hob");
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      hob.runtime.settings.setImage(hob.runtime.settings.get().revision, { source: "openai", baseUrl, model: "fake", size: "1024x1024" });
      writeSecret(hob.home, "imageApiKey", "fake");
      const events: Item[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "item" && event.item.kind === "image") events.push(event.item); });
      const tool = buildRouterTools(hob.runtime, "hob").find((entry) => entry.name === "generate_image")!;
      const result = tool.execute("call", { prompt: "猫" });
      await waitFor(() => !!respond);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "image", status: "pending", prompt: "猫", size: "1024x1024" });
      respond!();
      expect((await result).content[0]).toMatchObject({ text: expect.stringContaining("图片已经显示在对话里。路径：") });
      expect(events[1]).toMatchObject({ id: events[0].id, status: "done", path: expect.stringContaining("/images/") });
      const done = events[1];
      if (done.kind !== "image" || !done.path) throw new Error("没有图片路径");
      expect(readFileSync(done.path).equals(PNG)).toBe(true);
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const response = await app.request(`/api/files?path=${encodeURIComponent(done.path)}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
      const failed = await tool.execute("fail", { prompt: "" });
      expect(failed.isError).toBe(true);
      expect(events.slice(2)).toMatchObject([{ status: "pending" }, { status: "failed", error: "生成失败：提示词为空。" }]);
      expect(events[2].id).toBe(events[3].id);
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "image")).toEqual([events[1], events[3]]);
      hob.runtime.router.disposeAll();
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "image")).toEqual([events[1], events[3]]);
    } finally { hob.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("重启时持久化地将未完成的条目标为中断，不影响已完成的条目", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([text("好的")]);
      await hob.runtime.router.send("hob", { text: "开始" });
      await hob.runtime.router.waitIdle("hob");
      const startedAt = new Date().toISOString();
      const done = await hob.runtime.router.addItem("hob", { kind: "image", status: "pending", prompt: "完成", startedAt });
      await hob.runtime.router.updateImage("hob", done.id, { status: "done", path: "/done.png" });
      const pending = await hob.runtime.router.addItem("hob", { kind: "image", status: "pending", prompt: "中断", startedAt });
      hob.runtime.router.disposeAll();
      const restarted = createRuntime({ home: hob.home, config: hob.runtime.config, pi: hob.runtime.pi });
      expect(restarted.router.items("hob").items.filter((item) => item.kind === "image")).toMatchObject([
        { id: done.id, status: "done", path: "/done.png" },
        { id: pending.id, status: "failed", error: "生成被中断" },
      ]);
      restarted.router.disposeAll();
      const again = createRuntime({ home: hob.home, config: hob.runtime.config, pi: hob.runtime.pi });
      expect(again.router.items("hob").items.find((item) => item.id === pending.id)).toMatchObject({ status: "failed", error: "生成被中断" });
      again.router.disposeAll();
    } finally { hob.close(); }
  });
});
