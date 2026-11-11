import { describe, expect, it } from "vitest";
import { gonePages, layerList, popPage, pushPage, removeMissingLivePages, replacePage, selectPanelStack, panelAssistant, type PanelPage } from "../src/panel-stack.ts";

describe("右栏页面栈", () => {
  it("退回时退掉的页盖在最上面滑出去，换掉栈顶时旧页垫在新页下面", () => {
    const jobs: PanelPage = { kind: "jobs" };
    const job: PanelPage = { kind: "job", id: "t-1" };
    const kinds = (list: { page: PanelPage; leaving: boolean }[]) => list.map(({ page, leaving }) => `${page.kind}${leaving ? " 滑出" : ""}`);
    expect(gonePages([jobs], [jobs, job])).toEqual([]);
    expect(kinds(layerList([jobs], gonePages([jobs, job], [jobs])))).toEqual(["jobs", "job 滑出"]);
    expect(kinds(layerList([], gonePages([jobs, job], [])))).toEqual(["jobs 滑出", "job 滑出"]);
    const routine: PanelPage = { kind: "routine", id: "r" };
    expect(kinds(layerList([jobs, routine], gonePages([jobs, { kind: "newRoutine" }], [jobs, routine])))).toEqual(["jobs", "newRoutine", "routine"]);
  });

  it("压栈、退回已有页面并更新参数、逐层返回", () => {
    const job: PanelPage = { kind: "job", id: "one", round: 0 };
    const stack = pushPage(pushPage([], job), { kind: "file", path: "/a", full: false });
    expect(pushPage(stack, { ...job, round: 1 })).toEqual([{ ...job, round: 1 }]);
    expect(popPage(stack)).toEqual([job]);
    expect(popPage(popPage(stack))).toEqual([]);
  });

  it("切换助手清空栈，保留栈例外保留历史", () => {
    const stack: PanelPage[] = [{ kind: "jobs" }];
    expect(selectPanelStack(stack, "a", "b", false)).toEqual([]);
    expect(selectPanelStack(stack, "a", "b", true)).toEqual(stack);
    expect(selectPanelStack(stack, "a", "a", false)).toEqual(stack);
  });

  it("创建定时后替换顶页", () => {
    expect(replacePage([{ kind: "assistant" }, { kind: "newRoutine" }], { kind: "routine", id: "r" }))
      .toEqual([{ kind: "assistant" }, { kind: "routine", id: "r" }]);
  });

  it("只移除消失的实时预览", () => {
    const stack: PanelPage[] = [{ kind: "file", path: "", full: false, liveId: "gone" }, { kind: "file", path: "", full: false, liveId: "here" }];
    expect(removeMissingLivePages(stack, { here: {} })).toEqual([stack[1]]);
  });
});

describe("右栏讲的是哪个助手", () => {
  it("栈里有群成员页就是那个成员（往下推的编辑页也跟着它），返回到群信息后回到选中的助手", () => {
    const member = pushPage([], { kind: "member", id: "ops" });
    expect(panelAssistant(member, null)).toBe("ops");
    expect(panelAssistant(pushPage(member, { kind: "assistant" }), null)).toBe("ops");
    expect(panelAssistant(popPage(member), null)).toBe("hob");
    expect(panelAssistant([], "write")).toBe("write");
  });
});
