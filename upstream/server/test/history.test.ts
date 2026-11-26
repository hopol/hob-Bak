import { writeFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";
import { searchHistory } from "../src/history.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

describe("收藏和历史搜索", () => {
  it("持久化收藏并搜索已关闭话题，多词、大小写、排序和上限", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "植物研究", purpose: "整理观察", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "温室", "user");
      hob.runtime.groups.closeByUser(topic.id, "", "user");
      for (let i = 0; i < 55; i++) hob.runtime.store.appendGroupItem(topic.id, { kind: "assistant", id: `g-${i}`, speaker: "hob", at: new Date(1700000000000 + i * 1000).toISOString(), text: `Greenhouse Report ${i}` });
      const ref = { kind: "group" as const, id: topic.id };
      hob.runtime.store.saveStar({ conversation: ref, itemId: "g-1", speaker: "hob", at: new Date(1700000001000).toISOString(), starredAt: new Date().toISOString(), text: "Greenhouse Report 1" });
      expect(new Store(hob.home).stars()).toHaveLength(1);
      const result = await searchHistory(hob.runtime.store, { query: "report GREENHOUSE" });
      expect(result.total).toBe(55);
      expect(result.results).toHaveLength(50);
      expect(result.results[0].itemId).toBe("g-54");
      expect((await searchHistory(hob.runtime.store, { starred: true })).results[0].snippet).toBe("Greenhouse Report 1");
      rmSync(hob.runtime.store.groupTimelineFile(topic.id));
      expect((await searchHistory(hob.runtime.store, { starred: true })).total).toBe(1);
      hob.runtime.store.deleteStar(ref, "g-1");
      expect(new Store(hob.home).stars()).toEqual([]);
    } finally { hob.close(); }
  });

  it("工具参数、收藏过滤、截断和空结果", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((entry) => entry.name === "search_history")!;
      expect((await tool.execute("x", {})).content[0].text).toBe("query 和 starred 至少填一个");
      expect((await tool.execute("x", { starred: true })).content[0].text).toBe("用户还没有收藏过消息");
      const ref = { kind: "assistant" as const, id: "hob" };
      for (let i = 0; i < 22; i++) hob.runtime.store.saveStar({ conversation: ref, itemId: `m-${i}`, speaker: "hob", at: new Date(1700000000000 + i * 1000).toISOString(), starredAt: new Date().toISOString(), text: `${"前".repeat(100)} 树苗 ${"后".repeat(100)}` });
      const result = (await tool.execute("x", { starred: true, query: "树苗" })).content[0].text;
      expect(result.split("\n")).toHaveLength(21);
      expect(result).toContain("★[");
      expect(result).toContain("还有 2 条没列出");
      expect(result).not.toContain("前".repeat(100));
      expect((await tool.execute("x", { starred: true, query: "不存在" })).content[0].text).toBe("没找到包含「不存在」的消息");
    } finally { hob.close(); }
  });

  it("接口根据原消息存快照，并拒绝不存在的消息", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const file = hob.runtime.store.routerFile("hob");
      writeFileSync(file, `${JSON.stringify({ type: "custom", customType: "hob.user", id: "u-1", timestamp: "2026-01-01T00:00:00.000Z", data: { text: "种植记录" } })}\n`);
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const req = (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const body = { conversation: { kind: "assistant", id: "hob" }, itemId: "u-1" };
      expect((await req("/api/stars", "POST", body)).status).toBe(200);
      expect((await (await req("/api/history/search?query=种植")).json() as any).total).toBe(1);
      expect((await req("/api/stars", "POST", { ...body, itemId: "missing" })).status).toBe(404);
      expect((await req("/api/stars", "DELETE", body)).status).toBe(200);
      expect((await (await req("/api/stars")).json() as any).stars).toEqual([]);
    } finally { hob.close(); }
  });
});
