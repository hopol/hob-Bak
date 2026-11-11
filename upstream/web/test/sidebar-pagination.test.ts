import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../shared/types.ts";
import type { KnowledgeEntry } from "../../shared/knowledge.ts";
import { realApi } from "../src/api.ts";

vi.stubGlobal("location", { search: "", hash: "" });
vi.stubGlobal("localStorage", { getItem: () => null });
vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1440 });

const job = (id: string) => ({ id, assistantId: "paging", createdAt: id }) as Job;
const file = (id: string) => ({ id, updatedAt: id }) as KnowledgeEntry;

describe("右栏分页缓存", () => {
  it("知识库事件后重新读取目录，不覆盖文件分页", async () => {
    const result = (name: string) => ({ entries: [], hasMore: false, collections: [{ id: "c", name }], total: 0 }) as never;
    const fetch = vi.spyOn(realApi, "knowledge").mockResolvedValueOnce(result("旧名")).mockResolvedValueOnce(result("新名"));
    const store = await import("../src/store.ts");
    Object.assign(store.getState(), { page: "main" });
    await store.loadSidebarCollections();
    store.applyEvent({ type: "knowledge" });
    await store.loadSidebarCollections();
    expect(store.getState().knowledge.collections[0]?.name).toBe("新名");
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockRestore();
  });
  it("任务按 id 翻页，刷新和切助手时保留已读取的条目", async () => {
    const fetch = vi.spyOn(realApi, "jobs").mockResolvedValueOnce({ jobs: [job("3"), job("2")], hasMore: true }).mockResolvedValueOnce({ jobs: [job("1")], hasMore: false });
    const { loadSidebarJobs, getState } = await import("../src/store.ts");
    await loadSidebarJobs("paging");
    await loadSidebarJobs("paging", true);
    expect(fetch).toHaveBeenLastCalledWith({ assistantId: "paging", groupId: "none", before: "2", limit: 20 });
    expect(getState().sidebarJobs.paging?.items.map((j) => j.id)).toEqual(["3", "2", "1"]);
    let finish!: (value: { jobs: Job[]; hasMore: boolean }) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const refresh = loadSidebarJobs("paging");
    expect(getState().sidebarJobs.paging?.items).toHaveLength(3);
    finish({ jobs: [job("4"), job("3")], hasMore: true });
    await refresh;
    expect(getState().sidebarJobs.paging?.items.map((j) => j.id)).toEqual(["4", "3", "2", "1"]);
    fetch.mockResolvedValueOnce({ jobs: [job("other")], hasMore: false });
    await loadSidebarJobs("other");
    expect(getState().sidebarJobs.paging?.items).toHaveLength(4);
    fetch.mockRestore();
  });

  it("文件按更新时间翻页，刷新期间不清空缓存", async () => {
    const result = (entries: KnowledgeEntry[], hasMore: boolean) => ({ entries, hasMore, collections: [], total: entries.length });
    const fetch = vi.spyOn(realApi, "knowledge").mockResolvedValueOnce(result([file("3"), file("2")], true)).mockResolvedValueOnce(result([file("1")], false));
    const { loadSidebarFiles, getState } = await import("../src/store.ts");
    await loadSidebarFiles("paging");
    await loadSidebarFiles("paging", true);
    expect(fetch).toHaveBeenLastCalledWith({ origin: "output", assistantId: "paging", groupId: "none", before: "2", limit: 30 });
    let finish!: (value: ReturnType<typeof result>) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const refresh = loadSidebarFiles("paging");
    expect(getState().sidebarFiles.paging?.items.map((f) => f.id)).toEqual(["3", "2", "1"]);
    finish(result([file("4"), file("3")], true));
    await refresh;
    expect(getState().sidebarFiles.paging?.items.map((f) => f.id)).toEqual(["4", "3", "2", "1"]);
    fetch.mockRestore();
  });
});
