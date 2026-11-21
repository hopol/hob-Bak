import { beforeAll, describe, expect, it, vi } from "vitest";

// 点助手（首页行、置顶头像）进的是它的对话；它手下有任务在等（等助手回复），不该把人带进任务
const waitingJob = { id: "t-1", assistantId: "a", title: "整理资料", status: "waiting", createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z" };
vi.mock("../src/api.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/api.ts")>();
  return {
    ...original,
    realApi: {
      ...original.realApi,
      me: async () => ({}),
      bootstrap: async () => ({ assistants: [{ id: "a", name: "甲", primary: true, unread: 0 }], jobs: [waitingJob], routines: [], approvals: [], settings: { settings: { general: { theme: "light", locale: "zh-CN" } } } }),
      groups: async () => [],
      projects: async () => [],
      items: async () => ({ items: [], hasMore: false, jobs: [waitingJob], approvals: [] }),
      profile: async () => ({}),
      visibility: async () => undefined,
      events: () => () => undefined,
    },
  };
});
vi.mock("../src/theme.ts", () => ({ resolveTheme: () => ({ dark: false }), updateStatusColor: () => undefined, updateManifest: () => undefined, isNarrow: () => window.innerWidth < 768 }));

let store: typeof import("../src/store.ts");
beforeAll(async () => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true, addEventListener: () => undefined }), innerWidth: 390 });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined, documentElement: { classList: { toggle: () => undefined }, style: {} } });
  store = await import("../src/store.ts");
});

describe("点助手", () => {
  it("有任务在等时照样进对话，不打开任务", async () => {
    await store.start();
    store.openAssistant("a");
    await vi.waitFor(() => expect(store.getState().sel).toBe("a"));
    expect(store.getState().mobile).toBe("chat");
    expect(store.getState().panelStack.some((page) => page.kind === "job")).toBe(false);
  });
});
