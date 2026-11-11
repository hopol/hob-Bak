import { beforeAll, describe, expect, it, vi } from "vitest";

// 手机上实时连接断了又连上（切后台、网络抖、服务重启）：只补拉数据，人还停在原来那页
const { handlers, groups } = vi.hoisted(() => ({ handlers: {} as { onReconnect?: () => void }, groups: { fail: 1 } }));
const group = { id: "g", name: "团队", purpose: "", ownerId: "a", members: ["a"], busy: [], unread: 0, createdAt: "2026-01-01" };
vi.mock("../src/api.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/api.ts")>();
  return {
    ...original,
    realApi: {
      ...original.realApi,
      me: async () => ({}),
      bootstrap: async () => ({ assistants: [{ id: "a", name: "甲", primary: true }], jobs: [], routines: [], approvals: [], settings: { settings: { general: { theme: "light" } } } }),
      groups: async () => { if (groups.fail-- > 0) throw new Error("Load failed"); return [group]; },
      groupItems: async () => ({ items: [], hasMore: false, jobs: [], approvals: [] }),
      projects: async () => [],
      items: async () => ({ items: [], hasMore: false, jobs: [], approvals: [] }),
      profile: async () => ({}),
      visibility: async () => undefined,
      events: (h: { onReconnect: () => void }) => { handlers.onReconnect = h.onReconnect; return () => undefined; },
    },
  };
});
vi.mock("../src/theme.ts", () => ({ resolveTheme: () => ({ dark: false }), updateStatusColor: () => undefined }));

let store: typeof import("../src/store.ts");
beforeAll(async () => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true, addEventListener: () => undefined }), innerWidth: 390 });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined, documentElement: { classList: { toggle: () => undefined }, style: {} } });
  store = await import("../src/store.ts");
});

describe("群列表", () => {
  it("打开页面时群列表没拉到：提示原因，隔几秒自动再拉", async () => {
    vi.useFakeTimers();
    try {
      await store.start();
      expect(store.getState().groups).toEqual([]);
      expect(store.getState().notice).toContain("无法加载群");
      await vi.advanceTimersByTimeAsync(5000);
      expect(store.getState().groups.map((g) => g.id)).toEqual(["g"]);
    } finally { vi.useRealTimers(); }
  });
});

describe("实时连接重连", () => {
  it("手机停在群综合时重连，不退回话题列表，右栏和引用都留着", async () => {
    await store.start();
    await store.openGroupHome("g");
    store.openJob("j1");
    store.setQuote({ itemId: "x", text: "原话" } as never);
    expect(store.getState()).toMatchObject({ mobile: "chat", gsel: "g" });
    handlers.onReconnect!();
    await vi.waitFor(() => expect(store.getState().groupGen.g).toBe(2));
    expect(store.getState()).toMatchObject({ mobile: "chat", gsel: "g", panelStack: [{ kind: "job", id: "j1" }], quote: { text: "原话" } });
  });
});
