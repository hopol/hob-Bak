import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { JobStatus, JobStep } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({ status: "done" as string, sediment: undefined as undefined | { status: "running" }, steps: undefined as JobStep[] | undefined }));
vi.mock("../store.ts", () => ({
  backPanel: vi.fn(), closePanelPages: vi.fn(), closeSheet: vi.fn(), sedimentJob: vi.fn(), togglePreviewFull: vi.fn(), fetchFileMeta: vi.fn(), loadJobFiles: vi.fn(), loadModels: vi.fn(),
  loadWorklog: vi.fn(), moreWorklog: vi.fn(), openFilePreview: vi.fn(), openJob: vi.fn(),
  replyJob: vi.fn(), select: vi.fn(), selectGroup: vi.fn(), stopJob: vi.fn(),
  useApp: () => ({
    page: "main", panelStack: [{ kind: "job", id: "t-1" }],
    jobs: { "t-1": { id: "t-1", assistantId: "hob", title: "测试任务", instruction: "测试", status: state.status, sediment: state.sediment, summary: "报告内容", files: ["/work/结果.md"], createdAt: "2026-11-04T00:00:00Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] } },
    steps: { "t-1": state.steps }, assistants: [], worklog: null,
  }),
}));

import { JobOverlay, openWorklogJob } from "./JobDetail.tsx";
import { openJob, select, selectGroup } from "../store.ts";
import type { Job } from "../../../shared/types.ts";

it("工作记录中的群任务打开原话题和任务详情", () => {
  const job = { id: "j-group", assistantId: "dev", groupId: "g-topic" } as Job;
  openWorklogJob(job, true, true);
  expect(selectGroup).toHaveBeenCalledWith("g-topic", true, true, true);
  expect(select).not.toHaveBeenCalled();
  expect(openJob).toHaveBeenCalledWith("j-group");
});

describe("任务详情回复", () => {
  it.each<JobStatus>(["done", "stuck", "failed", "stopped"])("%s 显示接着说", (status) => {
    state.status = status;
    expect(renderToStaticMarkup(<JobOverlay />)).toContain('placeholder="接着说…"');
  });
  it("运行中的任务保留补充提示且不显示报告和产出", () => {
    state.status = "running";
    const html = renderToStaticMarkup(<JobOverlay />);
    expect(html).toContain('placeholder="补充说明或更正方向"');
    expect(html).not.toContain("报告内容");
    expect(html).not.toContain("产出文件");
  });
  it("按任务沉淀状态禁用按钮", () => {
    state.status = "done";
    state.sediment = { status: "running" };
    expect(renderToStaticMarkup(<JobOverlay />)).toContain('<button class="hob-btn hob-btn-compact" disabled="">');
    expect(renderToStaticMarkup(<JobOverlay />)).toContain("正在沉淀…");
    state.sediment = undefined;
    expect(renderToStaticMarkup(<JobOverlay />)).toContain('<button class="hob-btn hob-btn-compact">');
  });
  it("详情把沉淀步骤放在独立的沉淀技能段", () => {
    state.status = "done";
    state.sediment = { status: "running" };
    state.steps = [
      { id: "u1", kind: "text", at: "2026-11-04T01:00:00Z", from: "user", text: "沉淀技能" },
      { id: "s1", kind: "tool", at: "2026-11-04T01:01:00Z", name: "save_skill", title: "保存技能" },
    ];
    const html = renderToStaticMarkup(<JobOverlay />);
    expect(html).toContain("沉淀技能 · 沉淀技能中…");
    expect(html).toContain("保存技能");
    state.steps = undefined;
    state.sediment = undefined;
  });
  it("结束任务按报告、产出、要求、过程、目录排列", () => {
    state.status = "done";
    const html = renderToStaticMarkup(<JobOverlay />);
    const positions = ["报告内容", "产出文件", "任务内容", "执行过程", "工作目录"].map((text) => html.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain("结果.md");
    expect(html).not.toContain("源码.ts");
  });
});
