import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Job, Project, Subtask } from "../../../shared/types.ts";

/** 界面从 store 拿的东西：只需要任务、成员和事项。 */
const state = vi.hoisted(() => ({ jobs: {} as Record<string, Job>, projects: {} as Record<string, Project[]> }));

vi.mock("../store.ts", () => ({
  useApp: () => ({
    jobs: state.jobs,
    projects: state.projects,
    projectsError: {},
    groups: [{ id: "g-1", name: "开发团队" }],
    assistants: [
      { id: "po", name: "产品负责人", sprite: "page", duty: "需求" },
      { id: "dev", name: "开发", sprite: "page", duty: "写代码" },
    ],
  }),
  openProject: () => undefined,
  openJob: () => undefined,
  openFilePreview: () => undefined,
  startProject: async () => null,
  doneSubtask: async () => null,
  sendProjectNote: async () => null,
}));
vi.mock("./Markdown.tsx", () => ({ Markdown: () => null }));

import { ProjectCard, ProjectPanel } from "./Projects.tsx";

const subtasks: Subtask[] = [
  { n: 1, title: "定方案", assignee: "dev", brief: "定方案", after: [] },
  { n: 2, title: "上线前用手机试一次", assignee: "user", brief: "试", after: [1] },
];

function project(patch: Partial<Project> = {}): Project {
  return {
    id: "p-1",
    groupId: "g-1",
    title: "登录页加「记住我」",
    ownerId: "po",
    stage: "plan",
    request: { text: "登录页加一个「记住我」", at: "2026-11-08T01:00:00.000Z" },
    clarify: [],
    requirements: { content: "勾选后 30 天内免登录。", acceptance: ["勾选后关掉浏览器再打开仍是登录状态"], updatedAt: "2026-11-08T01:10:00.000Z" },
    subtasks,
    itemId: "g-1",
    createdAt: "2026-11-08T01:00:00.000Z",
    updatedAt: "2026-11-08T01:10:00.000Z",
    ...patch,
  };
}

const card = (value: Project) => renderToStaticMarkup(<ProjectCard project={value} fresh={false} itemId="g-item" />);
const panel = (value: Project) => {
  state.projects = { "g-1": [value] };
  return renderToStaticMarkup(<ProjectPanel groupId="g-1" id={value.id} />);
};

const doneJob: Job = {
  id: "t-1",
  assistantId: "dev",
  title: "定方案",
  instruction: "",
  status: "done",
  createdAt: "2026-11-08T01:20:00.000Z",
  stats: { reads: 0, commands: 0, edits: 0 },
  activity: [],
};

describe("事项上的按钮", () => {  it("拆分好了还没开始时，卡片上有「开始执行」，子任务是未开始", () => {
    const html = card(project());
    expect(html).toContain("开始执行");
    expect(html).toContain("未开始");
    expect(html).not.toContain(">已完成<");
  });

  it("用户的子任务轮到时有「已完成」，还在等前置时没有", () => {
    const running = project({ stage: "doing", startedAt: "2026-11-08T01:20:00.000Z" });
    // 前置没做完：第 2 个是「等待前置任务」，没有完成按钮
    expect(card(running)).not.toContain("待你执行");
    state.jobs["t-1"] = doneJob;
    try {
      const withJob = { ...running, subtasks: [{ ...subtasks[0]!, jobId: "t-1" }, subtasks[1]!] };
      const html = card(withJob);
      expect(html).toContain("待你执行");
      expect(html).toContain("已完成");
      expect(html).not.toContain("开始执行");
      expect(panel(withJob)).toContain("已完成");
    } finally {
      delete state.jobs["t-1"];
    }
  });

  it("事项页在任务拆分阶段有「开始执行」，执行中就没有了", () => {
    expect(panel(project())).toContain("开始执行");
    expect(panel(project({ stage: "doing", startedAt: "2026-11-08T01:20:00.000Z" }))).not.toContain("开始执行");
  });
});

describe("验收标准和结束", () => {
  it("验收标准逐条打勾打叉，没结果的写未验证", () => {
    const html = panel(project({
      stage: "review",
      checks: [
        { index: 1, passed: true, evidence: "勾选后关掉浏览器再打开，仍是登录状态。", jobId: "t-check", at: "2026-11-08T01:30:00.000Z" },
        { index: 2, passed: false, evidence: "不勾选时也是登录状态：写 cookie 时没看勾选。", jobId: "t-check", at: "2026-11-08T01:30:00.000Z" },
      ],
      requirements: { content: "勾选后 30 天内免登录。", acceptance: ["第一条", "第二条", "第三条"], updatedAt: "2026-11-08T01:10:00.000Z" },
    }));
    expect(html).toContain("proj-check pass");
    expect(html).toContain("proj-check fail");
    expect(html).toContain("不勾选时也是登录状态：写 cookie 时没看勾选。");
    expect(html).toContain("未验证");
  });

  it("结束后卡片写「已完成 · 用时」，并显示结论第一行", () => {
    const html = card(project({
      stage: "done",
      createdAt: "2026-11-08T01:00:00.000Z",
      endedAt: "2026-11-08T02:22:00.000Z",
      summary: "登录页的「记住我」已经上线。\n第二条验收标准也都过了。",
    }));
    expect(html).toContain("已完成 · 用时 1 小时 22 分钟");
    expect(html).toContain("结论");
    expect(html).toContain("登录页的「记住我」已经上线。");
    expect(html).not.toContain("第二条验收标准也都过了。");
    expect(html).not.toContain("开始执行");
  });

  it("放弃的事项卡片写「已放弃」和原因第一行", () => {
    const html = card(project({
      stage: "dropped",
      endedAt: "2026-11-08T02:22:00.000Z",
      summary: "这个功能先不做了。\n下个版本改用短信验证码登录。",
    }));
    expect(html).toContain("已放弃");
    expect(html).toContain("放弃原因");
    expect(html).toContain("这个功能先不做了。");
  });
});
