import { afterEach, describe, expect, it, vi } from "vitest";
import type { Item, ItemsPage } from "../../shared/types.ts";

const item = (id: string): Item => ({ kind: "note", id, at: "2026-01-01T00:00:00Z", icon: "info", text: id });
const page = (ids: string[], hasMore: boolean): ItemsPage => ({ items: ids.map(item), hasMore, jobs: [], drafts: [], approvals: [] });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("对话往前分页", () => {
  it("只请求一次，保留实时消息，顺序拼接并停止在末页", async () => {
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("window", { setTimeout, matchMedia: () => ({ matches: false, addEventListener: () => {} }) });
    const { realApi } = await import("./api.ts");
    const store = await import("./store.ts");
    store.getState().items.hob = [item("3")];
    store.getState().itemPages.hob = { hasMore: true, loading: false, error: null };
    store.getState().jobs["t-1"] = { id: "t-1", title: "新状态" } as never;
    let resolve!: (value: ItemsPage) => void;
    const fetchPage = vi.spyOn(realApi, "items").mockImplementation(() => new Promise((r) => { resolve = r; }));
    const first = store.loadOlderItems("hob");
    const second = store.loadOlderItems("hob");
    expect(fetchPage).toHaveBeenCalledTimes(1);
    store.applyEvent({ type: "item", assistantId: "hob", item: item("4") });
    resolve({ ...page(["1", "2"], false), jobs: [{ id: "t-1", title: "旧状态" } as never] });
    await Promise.all([first, second]);
    expect(store.getState().items.hob.map((i) => i.id)).toEqual(["1", "2", "3", "4"]);
    expect(store.getState().jobs["t-1"].title).toBe("新状态");
    await store.loadOlderItems("hob");
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(store.getState().itemPages.hob.hasMore).toBe(false);
  });

  it("失败时显示原因，只有重试才再次请求", async () => {
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: () => {} }) });
    const { realApi } = await import("./api.ts");
    const store = await import("./store.ts");
    store.getState().items.hob = [item("2")];
    store.getState().itemPages.hob = { hasMore: true, loading: false, error: null };
    const fetchPage = vi.spyOn(realApi, "items").mockRejectedValueOnce(new Error("断网")).mockResolvedValueOnce(page(["1"], false));
    await store.loadOlderItems("hob");
    expect(store.getState().itemPages.hob.error).toContain("断网");
    await store.loadOlderItems("hob");
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await store.loadOlderItems("hob", true);
    expect(store.getState().items.hob.map((i) => i.id)).toEqual(["1", "2"]);
    expect(store.getState().itemPages.hob.error).toBeNull();
  });
});
