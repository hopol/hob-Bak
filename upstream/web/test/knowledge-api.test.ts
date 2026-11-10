import { afterEach, describe, expect, it, vi } from "vitest";
import { realApi } from "../src/api.ts";
import { createMock } from "../src/mock.ts";

describe("知识库客户端响应", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("从服务端响应拆出知识库和条目，并保留删除结果", async () => {
    const collection = { id: "kc-1", name: "资料", createdAt: "2026-01-01", count: 0 };
    const entry = { id: "k-1", name: "报告" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ collection })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ collection })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entry })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetch);
    expect(await realApi.createKnowledgeCollection("资料")).toEqual(collection);
    expect(await realApi.renameKnowledgeCollection("kc-1", "资料")).toEqual(collection);
    expect(await realApi.patchKnowledgeEntry("k-1", { name: "报告" })).toEqual(entry);
    expect(await realApi.deleteKnowledgeEntry("k-1")).toEqual({ ok: true });
  });

  it("mock 返回与客户端相同的结果", async () => {
    const api = createMock();
    const collection = await api.createKnowledgeCollection("测试资料");
    expect(collection.name).toBe("测试资料");
    expect((await api.renameKnowledgeCollection(collection.id, "新名称")).name).toBe("新名称");
    const entry = (await api.knowledge()).entries[0];
    expect((await api.patchKnowledgeEntry(entry.id, { collections: [collection.id] })).collections).toEqual([collection.id]);
    expect(await api.deleteKnowledgeEntry(entry.id)).toEqual({ ok: true });
  });
});
