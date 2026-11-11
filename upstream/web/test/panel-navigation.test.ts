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
  it("创建定时后无需等待事件即可打开返回的定时", async () => {
    const store = await import("../src/store.ts");
    const routine = { id: "r-new", name: "新定时", assistantId: "hob", instruction: "", schedules: [], active: true, createdAt: "2026-01-01", runs: [] };
    vi.spyOn(realApi, "createRoutine").mockResolvedValueOnce({ routine });
    await store.createRoutine(routine);
    expect(store.getState().routines.find((r) => r.id === routine.id)).toEqual(routine);
    expect(store.getState().panelStack.at(-1)).toEqual({ kind: "routine", id: routine.id });
  });
  it("定时运行记录打开群任务详情，即使任务不在当前缓存", async () => {
    const store = await import("../src/store.ts");
    const job = { id: "t-routine", assistantId: "hob", groupId: "g-topic", title: "定时", instruction: "", status: "done", createdAt: "2026-01-01", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] } as const;
    Object.assign(store.getState(), { groups: [{ id: "g-topic", name: "话题", members: ["hob"], ownerId: "hob", purpose: "", createdAt: "2026-01-01", unread: 0, busy: [] }] });
    vi.spyOn(realApi, "transcript").mockResolvedValueOnce({ job, steps: [] });
    vi.spyOn(realApi, "groupItems").mockResolvedValue({ items: [], approvals: [], jobs: [], hasMore: false });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    await store.jumpToJob("hob", job.id);
    expect(store.getState().gsel).toBe("g-topic");
    expect(store.getState().panelStack.at(-1)).toEqual({ kind: "job", id: job.id });
  });

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

  it("回首页：对话、右栏、弹层、设置一次全收起", async () => {
    const store = await import("../src/store.ts");
    await store.select("bird");
    Object.assign(store.getState(), { gsel: "g-1", sideHome: false, sheet: true });
    store.openRoutine("r");
    store.openSettings();
    store.goHome();
    const s = store.getState();
    expect({ sel: s.sel, gsel: s.gsel, page: s.page, panelStack: s.panelStack, sheet: s.sheet, sideHome: s.sideHome }).toEqual({ sel: null, gsel: null, page: "main", panelStack: [], sheet: false, sideHome: true });
  });
});
