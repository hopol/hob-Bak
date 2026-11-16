import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TodoItem } from "../../../shared/types.ts";
import { TodoList, TodoStrip, todoCurrent, todoProgress, todoUnfinished } from "./Todos.tsx";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

const doing: TodoItem[] = [
  { text: "定方案", status: "done" },
  { text: "实现「记住我」", status: "doing" },
  { text: "检查用例和回归", status: "todo" },
];

describe("待办", () => {
  it("做完几项、一共几项，正在做的那项先看 doing 再看第一项没做的", () => {
    expect(todoProgress(doing)).toEqual({ done: 1, total: 3 });
    expect(todoCurrent(doing)?.text).toBe("实现「记住我」");
    expect(todoCurrent([{ text: "先定方案", status: "todo" }, { text: "再做", status: "todo" }])?.text).toBe("先定方案");
    expect(todoUnfinished(doing)).toBe(true);
    expect(todoUnfinished([{ text: "做完了", status: "done" }])).toBe(false);
    expect(todoUnfinished(undefined)).toBe(false);
  });

  it("会话里那一条：还有没做完的才显示，写正在做的那项和 k/n", () => {
    const html = render(<TodoStrip items={doing} />);
    expect(html).toContain("实现「记住我」");
    expect(html).toContain(">1/3<");
    expect(html).toContain("todobar-line");
    expect(html).toContain('title="待办 1/3"');
    // 都做完了、没有待办都不出现
    expect(render(<TodoStrip items={[{ text: "做完了", status: "done" }]} />)).toBe("");
    expect(render(<TodoStrip items={[]} />)).toBe("");
  });

  it("在跑的任务并进同一条：助手在忙或有任务在跑时左边的圈转；只有任务时写任务名，没有进度条", () => {
    const job = { id: "j1", title: "排查页面卡顿", since: new Date().toISOString() };
    const solo = render(<TodoStrip items={[]} jobs={[job]} />);
    expect(solo).toContain("排查页面卡顿");
    expect(solo).toContain("todobar-ring spin");
    expect(solo).not.toContain("todobar-line");
    const both = render(<TodoStrip items={doing} jobs={[job]} />);
    expect(both).toContain("todobar-ring spin");
    expect(both).toContain(">1/3<");
    expect(both).toContain("实现「记住我」");
    // 助手自己在这一轮里做：也转
    expect(render(<TodoStrip items={doing} busy />)).toContain("todobar-ring spin");
    // 没人在做：不放一个不转的圈，换成暂停
    const idle = render(<TodoStrip items={doing} />);
    expect(idle).not.toContain("todobar-ring spin");
    expect(idle).toContain("M10 9v6M14 9v6");
  });

  it("点开的清单是只读的：每项一个状态图标", () => {
    const html = render(<TodoList items={doing} />);
    expect(html).toContain("定方案");
    expect(html).toContain("实现「记住我」");
    expect(html).toContain('aria-label="已完成"');
    expect(html).toContain('aria-label="进行中"');
    expect(html).toContain('aria-label="未开始"');
    expect(html).not.toContain("<input");
  });
});
