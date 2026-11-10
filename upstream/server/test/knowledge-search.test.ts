import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bus } from "../src/bus.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { Store } from "../src/store.ts";
import { writeSecret } from "../src/secrets.ts";
import type { EmbeddingSettings } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());
describe("索引生命周期和检索", () => {
  it("加入、重建、检索、失败重试与移除", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-index-"));
    const store = new Store(home); store.init();
    let config: EmbeddingSettings = { source: "off" };
    const knowledge = new KnowledgeStore(home, new Bus(), store, undefined, () => config);
    try {
      const path = join(home, "doc.txt"); writeFileSync(path, ("知识库支持中文搜索，用户可以搜索文件。\n\n").repeat(180));
      const col = await knowledge.createCollection("文档");
      const entry = (await knowledge.collect({ origin: "chat", path, assistantId: "hob" }))!;
      await knowledge.updateEntry(entry.id, { collections: [col.id] });
      await knowledge.whenIndexed();
      expect((await knowledge.entry(entry.id))?.entry.index?.state).toBe("ready");
      await knowledge.updateEntry(entry.id, { name: "新名称.txt" });
      expect((await knowledge.entry(entry.id, 0))?.chunk?.heading).toBe("新名称.txt");
      const result = await knowledge.search("中文", [col.id]);
      expect(result).toHaveLength(3);
      expect(result[0]?.chunk.text).toContain("中文");
      expect((await knowledge.search("文", [col.id])).length).toBeGreaterThan(0);
      expect(await knowledge.search("无关天气", [col.id], { gate: true })).toHaveLength(0);
      // 只有关键词时自动检索一律不附，相关问题也一样
      expect(await knowledge.search("中文搜索", [col.id], { gate: true })).toHaveLength(0);
      config = { source: "openai", baseUrl: "http://example.invalid", model: "fake" };
      writeSecret(home, "embedding", "fake-key");
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const { input } = JSON.parse(String(init.body)) as { input: string[] };
        return Response.json({ data: input.map((text, index) => { const hash = createHash("sha256").update(text).digest(); return { index, embedding: [hash[0]! + 1, hash[1]! + 1] }; }) });
      });
      await knowledge.refreshIndexes(true); await knowledge.whenIndexed();
      expect((await knowledge.entry(entry.id))?.entry.index?.state).toBe("ready");
      expect(existsSync(join(home, "knowledge", "index", `${entry.hash}.vec`))).toBe(true);
      vi.stubGlobal("fetch", async () => new Response("故障", { status: 500 }));
      expect((await knowledge.search("中文", [col.id])).length).toBeGreaterThan(0);
      await knowledge.refreshIndexes(true); await knowledge.whenIndexed();
      expect((await knowledge.entry(entry.id))?.entry.index).toMatchObject({ state: "failed", error: expect.stringContaining("故障") });
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const { input } = JSON.parse(String(init.body)) as { input: string[] };
        return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 2] })) });
      });
      await knowledge.reindex(col.id); await knowledge.whenIndexed();
      expect((await knowledge.entry(entry.id, 0))?.chunk?.index).toBe(0);
      expect((await knowledge.search("中文", [col.id], { gate: true })).length).toBeGreaterThan(0);
      writeFileSync(path, "新版本中文内容");
      await knowledge.collect({ origin: "chat", path, assistantId: "hob" }); await knowledge.whenIndexed();
      const updated = (await knowledge.entry(entry.id))!.entry;
      expect(updated.hash).not.toBe(entry.hash);
      expect(updated.index?.state).toBe("ready");
      const emptyPath = join(home, "empty.html"); writeFileSync(emptyPath, "<script>secret()</script><style>body {}</style>");
      const empty = (await knowledge.upload({ path: emptyPath, name: "empty.html" }, col.id))!;
      await knowledge.whenIndexed();
      expect((await knowledge.entry(empty.id))?.entry.index).toMatchObject({ state: "unsupported", error: "文件没有可索引的文字" });
      expect((await knowledge.list()).collections.find((c) => c.id === col.id)).toMatchObject({ count: 2, indexed: 1, failed: 0, unsupported: 1 });
      await knowledge.updateEntry(entry.id, { collections: [] }); await knowledge.whenIndexed();
      expect(existsSync(join(home, "knowledge", "index", `${updated.hash}.json`))).toBe(false);
      expect((await knowledge.entry(entry.id))?.entry.index).toBeUndefined();
    } finally { await knowledge.whenIndexed(); rmSync(home, { recursive: true, force: true }); }
  });
  it("接口检验绑定并在删除知识库时清理", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      const col = await hob.runtime.knowledge.createCollection("文档");
      expect((await app.request("/api/assistants/hob", json("PATCH", { knowledge: ["missing"] }))).status).toBe(400);
      expect((await app.request("/api/assistants/hob", json("PATCH", { knowledge: [col.id] }))).status).toBe(200);
      expect((await app.request(`/api/knowledge/collections/${col.id}/reindex`, json("POST", {}))).status).toBe(200);
      const path = join(hob.home, "interface.txt"); writeFileSync(path, "测试接口中的知识库原文");
      const entry = (await hob.runtime.knowledge.upload({ path, name: "interface.txt" }, col.id))!;
      await hob.runtime.knowledge.whenIndexed();
      const view = await app.request(`/api/knowledge/entries/${entry.id}?chunk=0`, { headers: { cookie } });
      expect(await view.json()).toMatchObject({ entry: { id: entry.id }, chunk: { index: 0, text: "测试接口中的知识库原文" } });
      expect((await app.request("/api/knowledge/entries/missing", { headers: { cookie } })).status).toBe(404);
      expect((await app.request(`/api/knowledge/collections/${col.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
      expect(hob.runtime.store.assistant("hob")?.knowledge).toEqual([]);
    } finally { await hob.runtime.knowledge.whenIndexed(); hob.close(); }
  });
});
