import { describe, expect, it, vi } from "vitest";
import type { State } from "../src/store.ts";

vi.mock("../src/store.ts", () => ({
  backPanel: vi.fn(), closeImageViewer: vi.fn(), closeKnowledge: vi.fn(),
  closeSettings: vi.fn(), closeSheet: vi.fn(), closeSub: vi.fn(), getState: vi.fn(),
  leaveChat: vi.fn(), leaveTopicList: vi.fn(),
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

  it("群里是话题列表、话题、首页三层：先退话题，再退话题列表", () => {
    const topic = { page: "main", mobile: "chat", gsel: "t-1", panelStack: [] } as State;
    expect(layers(topic, true)).toEqual(["topics", "chat"]);
    const list = { ...topic, mobile: "topics" } as State;
    expect(layers(list, true)).toEqual(["topics"]);
    expect(layers({ ...list, mobile: "list", gsel: null } as State, true)).toEqual([]);
    // 单聊没有话题列表这一层
    expect(layers({ page: "main", mobile: "chat", sel: "hob", panelStack: [] } as State, true)).toEqual(["chat"]);
  });
});
