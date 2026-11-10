import { describe, expect, it, vi } from "vitest";
import type { State } from "../src/store.ts";

vi.mock("../src/store.ts", () => ({
  backPanel: vi.fn(), closeKnowledge: vi.fn(),
  closeSettings: vi.fn(), closeSheet: vi.fn(), closeSub: vi.fn(), getState: vi.fn(),
  setMobile: vi.fn(), setSection: vi.fn(), subscribe: vi.fn(),
}));

import { layers } from "../src/history.ts";
import { popPage } from "../src/panel-stack.ts";

describe("知识库手机历史层级", () => {
  it("知识库独占一层，预览叠在其上", () => {
    const state = { page: "knowledge", mobile: "chat", sel: "hob", panelStack: [] } as State;
    expect(layers(state, true)).toEqual(["knowledge"]);
    expect(layers({ ...state, panelStack: [{ kind: "file", path: "/a", full: false }] }, true)).toEqual(["knowledge", "panelPage"]);
    expect(layers(state, false)).toEqual([]);
  });

  it("对话、根页和两层右栏页面各占一层", () => {
    const state = { page: "main", mobile: "chat", sel: "hob", sheet: true, panelStack: [{ kind: "jobs" }, { kind: "job", id: "t" }] } as State;
    expect(layers(state, true)).toEqual(["chat", "sheet", "panelPage", "panelPage"]);
    const afterBack = { ...state, panelStack: popPage(state.panelStack) };
    expect(afterBack.panelStack).toEqual([{ kind: "jobs" }]);
    expect(layers(afterBack, true)).toEqual(["chat", "sheet", "panelPage"]);
  });
});
