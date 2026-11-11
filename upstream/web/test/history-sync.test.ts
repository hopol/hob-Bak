import { beforeAll, describe, expect, it, vi } from "vitest";

// 手机返回和浏览器历史对齐：一次打开好几层只压一条，退一次回到原来那页
const { app, listeners } = vi.hoisted(() => ({
  app: { page: "main", section: null, sub: null, gsel: null as string | null, sel: null as string | null, mobile: "list", sheet: false, panelStack: [] as { kind: string; id?: string }[], viewer: null },
  listeners: [] as (() => void)[],
}));
const change = (patch: Partial<typeof app>) => { Object.assign(app, patch); for (const listener of listeners) listener(); };
vi.mock("../src/store.ts", () => ({
  getState: () => app,
  subscribe: (listener: () => void) => { listeners.push(listener); return () => undefined; },
  backPanel: () => change({ panelStack: app.panelStack.slice(0, -1) }),
  leaveChat: () => change({ mobile: app.gsel ? "topics" : "list" }),
  leaveTopicList: () => change({ mobile: "list", gsel: null }),
  closeImageViewer: () => undefined, closeKnowledge: () => undefined, closeSettings: () => undefined, closeSheet: () => undefined, closeSub: () => undefined, setMobile: () => undefined, setSection: () => undefined,
}));

const entries: { hobDepth: number }[] = [];
let index = 0;
let onPop: (event: { state: unknown }) => void = () => undefined;
const pop = () => onPop({ state: entries[index] });

beforeAll(async () => {
  vi.stubGlobal("location", { pathname: "/", search: "", hash: "" });
  vi.stubGlobal("window", { innerWidth: 390, addEventListener: (_: string, fn: typeof onPop) => { onPop = fn; } });
  vi.stubGlobal("history", {
    get state() { return entries[index]; },
    replaceState: (state: { hobDepth: number }) => { entries[index] = state; },
    pushState: (state: { hobDepth: number }) => { entries.length = ++index; entries.push(state); },
    go: (delta: number) => { index += delta; queueMicrotask(pop); },
  });
  const { startHistory } = await import("../src/history.ts");
  startHistory();
});

describe("手机历史", () => {
  it("首页直接打开群里的任务：只压一条，侧滑一次回首页", async () => {
    change({ gsel: "g", mobile: "chat" });
    change({ panelStack: [{ kind: "job", id: "j" }] });
    await Promise.resolve();
    expect(entries.map((e) => e.hobDepth)).toEqual([0, 3]);
    index = 0;
    pop();
    expect(app).toMatchObject({ mobile: "list", gsel: null, panelStack: [] });
    expect(entries[index]!.hobDepth).toBe(0);
  });

  it("页面里的返回键先退一层：改写那一条，不退出应用", async () => {
    change({ gsel: "g", mobile: "chat", panelStack: [{ kind: "job", id: "j" }] });
    await Promise.resolve();
    change({ panelStack: [] });
    await Promise.resolve();
    expect(entries.slice(0, index + 1).map((e) => e.hobDepth)).toEqual([0, 2]);
    change({ mobile: "topics" });
    await Promise.resolve();
    change({ mobile: "list", gsel: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(index).toBe(0);
  });

  it("一层层打开的，侧滑一层层退", async () => {
    change({ gsel: "g", mobile: "topics" });
    await Promise.resolve();
    change({ mobile: "chat" });
    await Promise.resolve();
    change({ panelStack: [{ kind: "job", id: "j" }] });
    await Promise.resolve();
    expect(entries.slice(0, index + 1).map((e) => e.hobDepth)).toEqual([0, 1, 2, 3]);
    index--;
    pop();
    await Promise.resolve();
    expect(app).toMatchObject({ mobile: "chat", gsel: "g", panelStack: [] });
  });
});
