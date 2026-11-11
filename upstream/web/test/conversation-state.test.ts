import { expect, it, vi } from "vitest";

vi.stubGlobal("location", { search: "", hash: "" });
vi.stubGlobal("localStorage", { getItem: () => null });
vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1440 });

it("同一套对话状态区分加载、空会话和回复中", async () => {
  const { conversationState } = await import("../src/components/Chat.tsx");
  const { getState } = await import("../src/store.ts");
  const base = getState();
  const assistant = { id: "test", name: "助手", busy: false } as never;
  const state = { ...base, gsel: null, sel: "test", assistants: [assistant], items: {}, itemGen: {} };
  expect(conversationState(state).empty).toBe(false);
  expect(conversationState({ ...state, items: { test: [] } }).empty).toBe(true);
  expect(conversationState({ ...state, assistants: [{ ...assistant, busy: true }], items: { test: [] } }).thinking).toBe(true);
});
