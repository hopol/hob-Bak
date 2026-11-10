import { beforeAll, describe, expect, it, vi } from "vitest";
import { realApi } from "../src/api.ts";

beforeAll(() => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1440 });
  vi.spyOn(realApi, "items").mockResolvedValue({ items: [], approvals: [], jobs: [], drafts: [], hasMore: false });
  vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: { id: "hob" }, routines: [], rules: [], worklog: [] } as never);
  vi.spyOn(realApi, "knowledge").mockResolvedValue({ entries: [], collections: [], hasMore: false } as never);
});

describe("右栏状态切换", () => {
  it("切换助手清空，任务记录跨助手跳转可保留栈", async () => {
    const store = await import("../src/store.ts");
    store.openRoutine("r");
    await store.select("bird");
    expect(store.getState().panelStack).toEqual([]);
    store.openRoutine("r");
    await store.select("hob", false, true, true);
    expect(store.getState().panelStack).toEqual([{ kind: "routine", id: "r" }]);
  });

  it("进入知识库或设置清空栈", async () => {
    const store = await import("../src/store.ts");
    store.openFilePreview("/a");
    store.openKnowledge();
    expect(store.getState().panelStack).toEqual([]);
    store.openFilePreview("/b");
    store.openSettings();
    expect(store.getState().panelStack).toEqual([]);
    store.openFilePreview("/settings");
    store.closeSettings();
    expect(store.getState().panelStack).toEqual([]);
  });
});
