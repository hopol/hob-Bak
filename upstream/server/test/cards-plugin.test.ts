import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CardRecord } from "../../shared/types.ts";
import { answerCard } from "../src/actions.ts";
import { createApp } from "../src/http.ts";
import { pluginToolDisplayNames, pluginToolsForAssistant } from "../src/plugin-host.ts";
import { call, makeHob, seedPluginSource, text } from "./helpers.ts";

describe("plugin cards", () => {
  it("keeps app-only callback tools out of model tools and displays/callbacks plugin cards", async () => {
    const hob = makeHob({}, { memory: "off" });
    seedPluginSource(hob.home);
    try {
      const host = hob.runtime.plugins;
      host.store.install("github");
      host.store.saveConfig("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "fixture-token" });
      const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
      writeFileSync(join(hob.home, "plugins/github/mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixture], env: { HOB_MCP_CARDS: "1" } } } }));
      await host.start();
      const pluginTools = pluginToolsForAssistant(host, "hob");
      expect(pluginTools.map((tool) => tool.name)).toContain("github_show_card");
      expect(pluginTools.map((tool) => tool.name)).not.toContain("github_save_callback");
      expect(pluginToolDisplayNames(host)).not.toHaveProperty("github_save_callback");

      hob.faux.setResponses([call("github_show_card", {}), text("卡片已出")]);
      await hob.runtime.router.send("hob", { text: "请显示凭据卡" });
      await hob.runtime.router.waitIdle("hob");
      const record = hob.runtime.store.cards()[0]!;
      expect(record).toMatchObject({ owner: { type: "plugin", pluginId: "github" }, plugin: { service: "demo", callbackTool: "save_callback" }, card: { header: { title: "保存凭据" } } });

      hob.faux.setResponses([text("收到插件结果")]);
      const response = await answerCard(hob.runtime, record.id, { action: { tag: "button" }, button_text: "保存", form_value: { secret: "fixture-password" } });
      expect(response.status).toBe(200);
      expect(hob.runtime.store.card(record.id)).toMatchObject({ feedback: { toast: { type: "success", content: "保存成功" } }, card: { header: { title: "已保存" } } });
      const files = readFileSync(join(hob.home, "assistants/hob/cards.json"), "utf8");
      expect(files).not.toContain("fixture-password");

      const rawTool = pluginToolsForAssistant(host, "hob").find((tool) => tool.name === "github_show_card")!;
      const rawResult = await rawTool.execute("call-raw", {}) as { content: { text?: string }[] };
      expect(rawResult.content.map((part) => part.text ?? "").join("\n")).not.toContain("已显示给用户");
    } finally {
      await hob.runtime.plugins.close();
      hob.close();
    }
  });

  it("keeps plugin cards open on errors, timeouts, and unavailable services", async () => {
    const hob = makeHob({}, { memory: "off" });
    seedPluginSource(hob.home);
    try {
      const host = hob.runtime.plugins;
      host.store.install("github");
      host.store.saveConfig("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "fixture-token" });
      const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
      writeFileSync(join(hob.home, "plugins/github/mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixture], env: { HOB_MCP_CARDS: "1" } } } }));
      await host.start();
      const record = (id: string): CardRecord => ({ id, owner: { type: "plugin", pluginId: "github", assistantId: "hob" }, plugin: { service: "demo", callbackTool: "save_callback", pluginName: "GitHub" }, card: { header: { title: "保存凭据" }, body: { elements: [{ tag: "div", text: "原卡" }] } }, status: "open", createdAt: new Date().toISOString() });

      hob.runtime.store.saveCard(record("c-error"));
      vi.spyOn(host, "call").mockRejectedValueOnce(new Error("插件拒绝"));
      const failed = await answerCard(hob.runtime, "c-error", { action: { tag: "button" }, button_text: "保存" });
      expect(failed.status).toBe(200);
      expect(hob.runtime.store.card("c-error")).toMatchObject({ status: "open", feedback: { toast: { type: "error", content: "插件拒绝" } } });
      vi.restoreAllMocks();

      hob.runtime.store.saveCard(record("c-timeout"));
      vi.useFakeTimers();
      vi.spyOn(host, "call").mockImplementation(() => new Promise<never>(() => {}));
      const pending = answerCard(hob.runtime, "c-timeout", { action: { tag: "button" }, button_text: "保存" });
      await vi.advanceTimersByTimeAsync(60_000);
      const timed = await pending;
      expect(timed.status).toBe(200);
      expect(hob.runtime.store.card("c-timeout")?.feedback?.toast?.content).toContain("60 秒");
      vi.useRealTimers();
      vi.restoreAllMocks();

      hob.runtime.store.saveCard(record("c-offline"));
      host.store.patch("github", { enabled: false });
      await host.reload("github");
      const offline = await answerCard(hob.runtime, "c-offline", { action: { tag: "button" }, button_text: "保存" });
      expect(offline.status).toBe(409);
      expect(hob.runtime.store.card("c-offline")?.feedback?.unavailable).toBe("GitHub 现在用不了");

      host.store.patch("github", { enabled: true });
      await host.reload("github");
      vi.spyOn(host, "call").mockResolvedValue({ content: [{ type: "text", text: "恢复后已保存" }] } as any);
      const recovered = await answerCard(hob.runtime, "c-offline", { action: { tag: "button" }, button_text: "保存" });
      expect(recovered.status).toBe(200);
      expect(hob.runtime.store.card("c-offline")?.feedback).toBeUndefined();
      vi.restoreAllMocks();

      let release!: (value: unknown) => void;
      hob.runtime.store.saveCard(record("c-lock"));
      vi.spyOn(host, "call").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
      const first = answerCard(hob.runtime, "c-lock", { action: { tag: "button" }, button_text: "保存" });
      await vi.waitFor(() => expect(hob.runtime.store.card("c-lock")?.processing).toBe(true));
      const second = await answerCard(hob.runtime, "c-lock", { action: { tag: "button" }, button_text: "再次保存" });
      expect(second).toMatchObject({ status: 409, body: { error: "这张卡正在处理中" } });
      release({ content: [{ type: "text", text: "完成" }] });
      await expect(first).resolves.toMatchObject({ status: 200 });
      expect(hob.runtime.store.card("c-lock")?.processing).toBeUndefined();
      vi.restoreAllMocks();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await hob.runtime.plugins.close();
      hob.close();
    }
  });

  it("retires open cards a plugin raised before it was updated", async () => {
    const hob = makeHob({}, { memory: "off" });
    seedPluginSource(hob.home);
    try {
      const host = hob.runtime.plugins;
      const source = join(hob.home, "cache/plugin-sources/official/github");
      const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
      writeFileSync(join(source, "mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixture] } } }));
      host.store.install("github");
      const card = (id: string, pluginId: string, status: CardRecord["status"] = "open"): CardRecord => ({ id, owner: { type: "plugin", pluginId, assistantId: "hob" }, plugin: { service: "demo", callbackTool: "save_callback", pluginName: pluginId === "github" ? "GitHub" : "邮箱" }, card: { header: { title: "保存凭据" }, body: { elements: [{ tag: "input", name: "secret", min_length: 10 }] } }, status, createdAt: new Date().toISOString() });
      for (const record of [card("c-old", "github"), card("c-done", "github", "done"), card("c-other", "email")]) hob.runtime.store.saveCard(record);
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const update = () => app.request("/api/plugins/github/update", { method: "POST", body: "{}", headers: { "content-type": "application/json", cookie } });

      expect((await update()).status).toBe(200);
      expect(hob.runtime.store.card("c-old")?.status).toBe("open");

      const manifest = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"));
      writeFileSync(join(source, "plugin.json"), JSON.stringify({ ...manifest, version: "1.0.1" }));
      expect((await update()).status).toBe(200);
      expect(hob.runtime.store.card("c-old")).toMatchObject({ status: "done", feedback: { unavailable: "GitHub 更新了，这张卡是更新前出的，已作废。还需要的话，请助手重新发起。" } });
      expect(hob.runtime.store.card("c-done")?.feedback).toBeUndefined();
      expect(hob.runtime.store.card("c-other")?.status).toBe("open");
    } finally {
      await hob.runtime.plugins.close();
      hob.close();
    }
  });
});
