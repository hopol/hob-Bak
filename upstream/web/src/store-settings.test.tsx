import { beforeAll, describe, expect, it, vi } from "vitest";
import { conversations, pinList } from "./home.ts";

const storage = new Map<string, string>();

const { putSettings, patchAssistant, jobs } = vi.hoisted(() => ({ putSettings: vi.fn(), patchAssistant: vi.fn(), jobs: vi.fn() }));
vi.mock("./api.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api.ts")>();
  return { ...original, realApi: { ...original.realApi, putSettings, patchAssistant, jobs } };
});
vi.mock("./theme.ts", () => ({ resolveTheme: () => ({ dark: false }), updateStatusColor: () => undefined }));

let store: typeof import("./store.ts");
beforeAll(async () => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: () => undefined }), innerWidth: 1440 });
  vi.stubGlobal("document", { documentElement: { classList: { toggle: () => undefined }, style: {} } });
  store = await import("./store.ts");
});

describe("设置乐观保存", () => {
  it("请求期间保留其他配置，技能更新可见，失败恢复", async () => {
    const state = store.getState();
    const before = { ...state.settings, settings: { ...state.settings.settings, skills: { disabled: ["old"] }, desktop: { url: "test", enabled: true }, knowledge: { embedding: { source: "off" as const } } } };
    state.settings = before;
    let reject!: (error: Error) => void;
    putSettings.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const saving = store.saveSettings({ skills: { disabled: ["new"] } });
    await Promise.resolve();
    expect(store.getState().settings.settings.skills).toEqual({ disabled: ["new"] });
    expect(store.getState().settings.settings.desktop).toEqual(before.settings.desktop);
    expect(store.getState().settings.settings.knowledge).toEqual(before.settings.knowledge);
    reject(new Error("失败"));
    expect(await saving).toBe(false);
    expect(store.getState().settings).toEqual(before);
  });
});

describe("混排置顶", () => {
  it("保存后以持久化的助手和群顺序重新计算置顶列表", async () => {
    const state = store.getState();
    state.groups = [{ id: "g", name: "群", purpose: "", ownerId: "a", members: ["a"], busy: [], unread: 0, createdAt: "2026-01-01" }];
    state.groupPrefs = { g: { pinned: true, pinOrder: 9 } };
    state.assistants = ["a", "b"].map(id => ({ id, name: id, duty: "", pinned: true, hidden: false, createdAt: "2026-01-01" })) as typeof state.assistants;
    const saved: Record<string, number> = {};
    patchAssistant.mockImplementation(async (id: string, patch: { pinOrder: number }) => { saved[id] = patch.pinOrder; return {}; });
    expect(await store.savePinOrder(["g", "a", "b"])).toBeNull();
    const reloaded = state.assistants.map(a => ({ ...a, pinOrder: saved[a.id] }));
    const preferences = JSON.parse(storage.get("hob.groups.local")!);
    expect(pinList(conversations(reloaded, state.groups, preferences), "").map(row => row.id)).toEqual(["g", "a", "b"]);
  });
  it("按混排位置保存助手；部分失败时保留已经保存的顺序", async () => {
    const state = store.getState();
    state.groups = [{ id: "g" }] as typeof state.groups;
    state.groupPrefs = {};
    state.assistants = [{ id: "a", pinOrder: 9 }, { id: "b", pinOrder: 8 }] as typeof state.assistants;
    patchAssistant.mockImplementation((id: string) => id === "a" ? Promise.resolve({}) : Promise.reject(new Error("失败")));
    expect(await store.savePinOrder(["g", "a", "b"])).toContain("失败");
    expect(patchAssistant).toHaveBeenCalledWith("a", { pinOrder: 1 });
    expect(patchAssistant).toHaveBeenCalledWith("b", { pinOrder: 2 });
    expect(store.getState().groupPrefs.g?.pinOrder).toBe(0);
    expect(store.getState().assistants.find(a => a.id === "a")?.pinOrder).toBe(1);
    expect(store.getState().assistants.find(a => a.id === "b")?.pinOrder).toBe(8);
  });
});

describe("任务记录筛选", () => {
  it("A→B→A 时拒绝旧请求失败及旧分页结果", async () => {
    let rejectOld!: (error: Error) => void;
    jobs.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
      .mockResolvedValueOnce({ jobs: [{ id: "b" }], hasMore: false })
      .mockResolvedValueOnce({ jobs: [{ id: "a-new" }], hasMore: true });
    const old = store.loadWorklog({ assistantId: "a" });
    await store.loadWorklog({ assistantId: "b" });
    await store.loadWorklog({ assistantId: "a" });
    rejectOld(new Error("旧请求失败"));
    await old;
    expect(store.getState().worklog?.jobs.map(job => job.id)).toEqual(["a-new"]);
    let resolvePage!: (value: unknown) => void;
    jobs.mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }))
      .mockResolvedValueOnce({ jobs: [{ id: "refresh" }], hasMore: false });
    const oldPage = store.moreWorklog();
    await store.loadWorklog({ assistantId: "a" });
    resolvePage({ jobs: [{ id: "stale-page" }], hasMore: false });
    await oldPage;
    expect(store.getState().worklog?.jobs.map(job => job.id)).toEqual(["refresh"]);
  });
  it("较旧的筛选响应不会覆盖最新筛选", async () => {
    let oldResolve!: (value: unknown) => void;
    let newResolve!: (value: unknown) => void;
    jobs.mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { newResolve = resolve; }));
    const old = store.loadWorklog({ assistantId: "a" });
    const current = store.loadWorklog({ assistantId: "b" });
    newResolve({ jobs: [{ id: "new" }], hasMore: false });
    await current;
    oldResolve({ jobs: [{ id: "old" }], hasMore: false });
    await old;
    expect(store.getState().worklog?.assistantId).toBe("b");
    expect(store.getState().worklog?.jobs.map(job => job.id)).toEqual(["new"]);
  });
});
