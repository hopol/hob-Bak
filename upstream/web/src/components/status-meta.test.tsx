import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GroupSummary, Job, TodoItem } from "../../../shared/types.ts";
import { DELEGATION_STATUS, JOB_STATUS, StatusTag, jobStatusIcon, jobStatusMeta, todoStamp } from "./status-meta.tsx";

/** 左栏话题行只看话题自己的待办。 */
function topic(todos: TodoItem[] | undefined, patch: Partial<GroupSummary> = {}): GroupSummary {
  return { id: "t-1", name: "登录页加「记住我」", purpose: "", ownerId: "po", members: ["po", "dev"], createdAt: "", unread: 0, busy: [], ...(todos ? { todos } : {}), ...patch };
}

describe("任务和转交状态元数据", () => {
  it("覆盖所有任务状态，统一文字、图标和转圈", () => {
    expect(Object.keys(JOB_STATUS).sort()).toEqual(["queued", "running", "waiting", "done", "stuck", "failed", "stopped"].sort());
    for (const [status, meta] of Object.entries(JOB_STATUS)) {
      expect(meta.text, status).toBeTruthy();
      expect(meta.icon, status).toBeTruthy();
      expect(meta.spin, status).toBe(status === "running");
      expect(renderToStaticMarkup(<StatusTag meta={meta} />)).toContain(meta.text);
    }
    expect(JOB_STATUS.waiting.text).toBe("等助手回复");
    expect(JOB_STATUS.stopped.icon).toBe("stop");
    expect(JOB_STATUS.queued.icon).toBe("clock");
    expect(renderToStaticMarkup(jobStatusIcon("queued", 16))).toContain('M12 7.5V12l3 2');
  });

  it("排队中的任务在等别的任务：写等谁、等几个，都找不到就写等前面的", () => {
    const job = (over: Partial<Job>): Job => ({ id: "t-b", assistantId: "hob", title: "写总结", instruction: "", status: "queued", createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [], ...over });
    const prereq = (id: string, title: string): Job => job({ id, title, status: "running" });
    const jobs = { "t-a": prereq("t-a", "先查目录"), "t-c": prereq("t-c", "再发布") };
    expect(jobStatusMeta(job({}), jobs)).toBe(JOB_STATUS.queued);
    expect(jobStatusMeta(job({ after: ["t-a"] }), jobs)).toMatchObject({ text: "等「先查目录」", icon: "clock" });
    expect(jobStatusMeta(job({ after: ["t-a", "t-c"] }), jobs).text).toBe("等 2 个任务");
    expect(jobStatusMeta(job({ after: ["t-gone"] }), jobs).text).toBe("等前面的任务");
    // 已经在跑的带着 after 也不显示等：只有排队中才等
    expect(jobStatusMeta(job({ status: "running", after: ["t-a"] }), jobs)).toBe(JOB_STATUS.running);
  });

  it("左栏话题行的待办标签只写 k/n，全做完的和没有待办的不写", () => {
    expect(todoStamp(topic([{ text: "定方案", status: "done" }, { text: "实现「记住我」", status: "doing" }]))).toEqual({ text: "1/2", title: "待办 1/2" });
    expect(todoStamp(topic([{ text: "定方案", status: "done" }]))).toBeNull();
    expect(todoStamp(topic([]))).toBeNull();
    expect(todoStamp(topic(undefined))).toBeNull();
  });

  it("覆盖所有转交状态，并保留各自文字和图标", () => {
    expect(Object.keys(DELEGATION_STATUS).sort()).toEqual(["running", "waiting", "done", "stuck", "interrupted", "returned", "takenOver"].sort());
    for (const [status, meta] of Object.entries(DELEGATION_STATUS)) {
      expect(meta.text, status).toBeTruthy();
      expect(meta.icon, status).toBeTruthy();
      expect(meta.spin, status).toBe(status === "running");
      expect(renderToStaticMarkup(<StatusTag meta={meta} card />)).toContain(meta.text);
    }
    expect(DELEGATION_STATUS.takenOver.icon).toBe("user");
    expect(DELEGATION_STATUS.waiting.text).toBe("等你确认");
  });
});
