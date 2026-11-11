import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Assistant, Group, Job, Project } from "../../shared/types.ts";
import { buildSystemPrompt, buildWorkerPrompt } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { registerReportTool } from "../src/worker-tools.ts";
import { makeHob, call, text, waitFor, type TestHob } from "./helpers.ts";

/** 定稿只在开发仓库里（.scratch 不公开），没有就跳过逐字对照 */
const DOC = ".scratch/v2/design-projects.md";
const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";

const ACCEPTANCE = ["勾选后关掉浏览器再打开仍是登录状态", "不勾选时关掉浏览器要重新登录", "退出登录后旧的记住状态失效"];

function addAssistant(hob: TestHob, id: string, name: string, duty: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty, primary: false, pinned: false, sprite: "page", instructions: "" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

/** 三人群：Hob（群主）、开发、测试。 */
function setup() {
  const hob = makeHob({}, { memory: "off" });
  addAssistant(hob, "dev", "开发", "写代码");
  addAssistant(hob, "qa", "测试", "验收和回归");
  const group = hob.runtime.groups.create({ name: "开发团队", purpose: "做软件", workflow: "software", ownerId: "hob", members: ["hob", "dev", "qa"] });
  let jobNo = 0;
  vi.spyOn(hob.runtime.jobs, "start").mockImplementation(async (assistantId, input) => ({
    id: `t-auto-${++jobNo}`,
    assistantId,
    title: input.title,
    instruction: input.instruction,
    status: "queued",
    createdAt: new Date().toISOString(),
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.project ? { project: input.project } : {}),
  }));
  vi.spyOn(hob.runtime.router, "remember").mockResolvedValue();
  return { hob, group };
}

function toolOf(hob: TestHob, name: string, gid?: string) {
  const tool = buildRouterTools(hob.runtime, "hob", gid).find((item) => item.name === name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  return tool;
}

const textOf = (result: Awaited<ReturnType<ReturnType<typeof toolOf>["execute"]>>) => (result.content[0] as { text: string }).text;
const isError = (result: { isError?: boolean }) => result.isError === true;

/** 立一件事项并写好需求说明（到任务拆分）。 */
function seed(hob: TestHob, group: Group, title = "登录页加「记住我」"): Project {
  const project = hob.runtime.projects.open({ group, ownerId: "hob", title });
  hob.runtime.projects.writeRequirements(group.id, project.id, { content: "- 勾选「记住我」后 30 天内免登录", acceptance: ACCEPTANCE });
  return hob.runtime.store.project(group.id, project.id)!;
}

/** 事件送到了谁、写了什么（不真的跑模型）。 */
function spyEvents(hob: TestHob): { id: string; text: string }[] {
  const calls: { id: string; text: string }[] = [];
  const original = hob.runtime.groups.deliverEvent.bind(hob.runtime.groups);
  hob.runtime.groups.deliverEvent = async (gid: string, assistantId: string, text: string) => {
    calls.push({ id: assistantId, text });
    return original(gid, assistantId, text);
  };
  return calls;
}

/** 直接写一个任务进存储（有些断言只关心任务的状态和报告路径）。 */
function fakeJob(hob: TestHob, job: Partial<Job> & { id: string; assistantId: string }): Job {
  const full: Job = {
    title: job.id,
    instruction: "",
    status: "done",
    createdAt: "2026-11-08T01:00:00.000Z",
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
    ...job,
  };
  hob.runtime.store.saveJob(full);
  return full;
}

const current = (hob: TestHob, group: Group, project: Project) => hob.runtime.store.project(group.id, project.id)!;

function reportTool(hob: TestHob, jobId: string) {
  const tool = registerReportTool(hob.runtime, jobId);
  const run = (params: Record<string, unknown>) => tool.execute("c", { result: "验收结果", ...params });
  return { tool, run };
}

describe("验收子任务总是开一个新任务", () => {
  it("已经有验收任务时，自动推进会复用它，不会重复开任务", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "定方案", assignee: "dev", brief: "定" },
        { title: "验收", assignee: "qa", brief: "逐条验", after: [1], check: true },
      ]);
      fakeJob(hob, { id: "t-dev", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案" });
      hob.runtime.projects.attach(current(hob, group, project), 1, "t-dev");
      fakeJob(hob, { id: "t-check", assistantId: "qa", status: "done", groupId: group.id, project: { id: project.id, n: 2 }, title: "验收" });
      const events = spyEvents(hob);
      hob.runtime.projects.start(group.id, project.id);
      await waitFor(() => Boolean(current(hob, group, project).subtasks[1]?.jobId));
      expect(current(hob, group, project).subtasks[1]!.jobId).toBe("t-check");
      expect(hob.runtime.jobs.start).not.toHaveBeenCalled();
      expect(events.some((event) => event.text.includes("轮到你了"))).toBe(false);
    } finally { hob.close(); }
  });
});

describe("验收任务的说明", () => {
  it("有所有不是验收的子任务交来的结果，不只是直接前置的", () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "定方案", assignee: "dev", brief: "定" },
        { title: "写文档", assignee: "dev", brief: "写" },
        { title: "验收", assignee: "qa", brief: "验", after: [1], check: true },
      ]);
      hob.runtime.projects.start(group.id, project.id);
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案", reportPath: "/tmp/方案报告.md", files: ["/tmp/方案.md"] });
      hob.runtime.projects.attach(current(hob, group, project), 1, "t-1");
      fakeJob(hob, { id: "t-2", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 2 }, title: "写文档", reportPath: "/tmp/文档报告.md" });
      hob.runtime.projects.attach(current(hob, group, project), 2, "t-2");

      const saved = current(hob, group, project);
      const instruction = hob.runtime.projects.taskInstruction(saved, saved.subtasks[2]!);
      expect(instruction).toContain("## 各子任务交来的结果");
      expect(instruction).toContain("- 子任务 1「定方案」· 开发 · 已完成 · 报告：/tmp/方案报告.md\n  交来的文件：/tmp/方案.md");
      // 子任务 2 不是验收的前置，也要写进来
      expect(instruction).toContain("- 子任务 2「写文档」· 开发 · 已完成 · 报告：/tmp/文档报告.md");
      // 验收自己不在这一栏里
      const results = instruction.split("## 各子任务交来的结果")[1]!.split("## 事项记录")[0]!;
      expect(results).not.toContain("子任务 3「验收」");
    } finally { hob.close(); }
  });
});

describe("任务的系统提示词", () => {
  const prompts = (hob: TestHob, jobId: string) => {
    const { timezone, aboutYou } = hob.runtime.settings.settings.general;
    return buildWorkerPrompt(hob.runtime.store, jobId, { timezone, aboutYou, memory: "off" });
  };

  /** 一件事项和它的两个子任务的任务：1 是做的，2 是验收。 */
  function withJobs(hob: TestHob, group: Group) {
    const project = seed(hob, group);
    hob.runtime.projects.plan(group.id, project.id, [
      { title: "定方案", assignee: "dev", brief: "定" },
      { title: "验收", assignee: "qa", brief: "验", after: [1], check: true },
    ]);
    hob.runtime.projects.start(group.id, project.id);
    fakeJob(hob, { id: "t-dev", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案" });
    fakeJob(hob, { id: "t-check", assistantId: "qa", status: "done", groupId: group.id, project: { id: project.id, n: 2 }, title: "验收" });
    return project;
  }

  it("验收子任务的任务有 4.8，没有 4.7", () => {
    const { hob, group } = setup();
    try {
      const project = withJobs(hob, group);
      const prompt = prompts(hob, "t-check");
      expect(prompt).toContain(`## 验收\n你在验收事项「${project.title}」。做的过程你没参与，正好照着要求查：报告里说做到了不算数，要你自己查到才算。`);
      expect(prompt).toContain("发现的问题写进报告，交给原来的子任务去改");
      expect(prompt).not.toContain("## 子任务\n");
    } finally { hob.close(); }
  });

  it("做子任务的任务有 4.7，没有 4.8", () => {
    const { hob, group } = setup();
    try {
      withJobs(hob, group);
      const prompt = prompts(hob, "t-dev");
      expect(prompt).toContain("## 子任务\n你在做事项");
      expect(prompt).not.toContain("## 验收\n");
    } finally { hob.close(); }
  });
});

describe("report 的 checks", () => {
  /** 一件事项和一个验收任务（三条验收标准）。 */
  function withCheckJob(hob: TestHob, group: Group) {
    const project = seed(hob, group);
    hob.runtime.projects.plan(group.id, project.id, [
      { title: "定方案", assignee: "dev", brief: "定" },
      { title: "验收", assignee: "qa", brief: "验", after: [1], check: true },
    ]);
    fakeJob(hob, { id: "t-dev", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案" });
    hob.runtime.projects.attach(current(hob, group, project), 1, "t-dev");
    fakeJob(hob, { id: "t-check", assistantId: "qa", status: "running", groupId: group.id, project: { id: project.id, n: 2 }, title: "验收" });
    hob.runtime.projects.attach(current(hob, group, project), 2, "t-check");
    hob.runtime.projects.start(group.id, project.id);
    return project;
  }

  it("只有验收子任务的任务有这个参数", () => {
    const { hob, group } = setup();
    try {
      withCheckJob(hob, group);
      expect(reportTool(hob, "t-check").tool.parameters.properties.checks).toBeDefined();
      expect(reportTool(hob, "t-dev").tool.parameters.properties.checks).toBeUndefined();
    } finally { hob.close(); }
  });

  it("outcome 为 done 时缺条目报错，写明缺第几条，且不改事项", async () => {
    const { hob, group } = setup();
    try {
      const project = withCheckJob(hob, group);
      const { run } = reportTool(hob, "t-check");
      const partial = await run({
        outcome: "done",
        checks: [
          { index: 1, passed: true, evidence: "关掉再打开仍是登录状态。" },
          { index: 3, passed: true, evidence: "退出登录后接口返回 401。" },
        ],
      });
      expect(isError(partial)).toBe(true);
      expect(textOf(partial)).toContain("缺第 2 条验收结果");
      expect(current(hob, group, project).checks).toBeUndefined();

      const none = await run({ outcome: "done" });
      expect(isError(none)).toBe(true);
      expect(textOf(none)).toContain("缺第 1、2、3 条验收结果");

      // 序号、passed、证据填错也退回
      const wrongIndex = await run({ outcome: "done", checks: [{ index: 4, passed: true, evidence: "x" }] });
      expect(isError(wrongIndex)).toBe(true);
      expect(textOf(wrongIndex)).toContain("序号要填验收标准的序号（1 到 3）");
      const noPassed = await run({ outcome: "done", checks: [{ index: 1, evidence: "x" }] });
      expect(isError(noPassed)).toBe(true);
      expect(textOf(noPassed)).toContain("passed 要填 true 或 false");
      const noEvidence = await run({ outcome: "done", checks: [{ index: 1, passed: true, evidence: "  " }] });
      expect(isError(noEvidence)).toBe(true);
      expect(textOf(noEvidence)).toContain("evidence 不能为空");
    } finally { hob.close(); }
  });

  it("存进事项，同一条以最新的为准，记下任务和时间", async () => {
    const { hob, group } = setup();
    try {
      const project = withCheckJob(hob, group);
      const { run } = reportTool(hob, "t-check");
      const first = await run({
        outcome: "done",
        checks: [
          { index: 1, passed: true, evidence: "关掉再打开仍是登录状态。", files: ["proof.txt"] },
          { index: 2, passed: false, evidence: "不勾选时也是登录状态：写 cookie 时没看勾选。" },
          { index: 3, passed: true, evidence: "退出登录后接口返回 401。" },
        ],
      });
      expect(isError(first)).toBe(false);
      const saved = current(hob, group, project);
      expect(saved.checks?.map((check) => [check.index, check.passed])).toEqual([[1, true], [2, false], [3, true]]);
      const firstAt = saved.checks![1]!.at;
      expect(saved.checks![1]).toMatchObject({ jobId: "t-check", evidence: "不勾选时也是登录状态：写 cookie 时没看勾选。" });
      // 证据里的相对路径落到任务工作目录
      expect(saved.checks![0]!.files?.[0]).toBe(`${hob.runtime.store.workDir("t-check")}/proof.txt`);

      // 返工后再验：同一条换成新的结果和证据，其余的照旧
      const second = await run({
        outcome: "done",
        checks: [
          { index: 1, passed: true, evidence: "关掉再打开仍是登录状态。" },
          { index: 2, passed: true, evidence: "复验：不勾选时重新打开要重新登录。" },
          { index: 3, passed: true, evidence: "退出登录后接口返回 401。" },
        ],
      });
      expect(isError(second)).toBe(false);
      const latest = current(hob, group, project);
      expect(latest.checks).toHaveLength(3);
      expect(latest.checks?.map((check) => [check.index, check.passed])).toEqual([[1, true], [2, true], [3, true]]);
      expect(latest.checks![1]!.evidence).toBe("复验：不勾选时重新打开要重新登录。");
      expect(Date.parse(latest.checks![1]!.at)).toBeGreaterThanOrEqual(Date.parse(firstAt));
    } finally { hob.close(); }
  });

  it("没验完就受阻（stuck）可以只交几条，剩下的算未验证", async () => {
    const { hob, group } = setup();
    try {
      const project = withCheckJob(hob, group);
      const { run } = reportTool(hob, "t-check");
      const partial = await run({
        outcome: "stuck",
        checks: [
          { index: 1, passed: true, evidence: "这一条验过了。" },
          { index: 2, passed: false, evidence: "这一条没通过。" },
        ],
      });
      expect(isError(partial)).toBe(false);
      expect(current(hob, group, project).checks?.map((check) => check.index)).toEqual([1, 2]);
      expect(hob.runtime.projects.checkCounts(current(hob, group, project))).toEqual({ passed: 1, failed: 1, unchecked: 1 });
    } finally { hob.close(); }
  });
});

describe("返工再验", () => {
  /** 已在验收的事项：两个做的子任务和验收任务都结束过，验收任务有结果。 */
  function reviewed(hob: TestHob, group: Group): Project {
    const project = seed(hob, group);
    hob.runtime.projects.plan(group.id, project.id, [
      { title: "定方案", assignee: "dev", brief: "定" },
      { title: "实现记住我", assignee: "dev", brief: "做", after: [1] },
      { title: "验收", assignee: "qa", brief: "验", after: [2], check: true },
    ]);
    fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案", reportPath: "/tmp/方案.md" });
    hob.runtime.projects.attach(current(hob, group, project), 1, "t-1");
    fakeJob(hob, { id: "t-2", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 2 }, title: "实现记住我", reportPath: "/tmp/实现.md" });
    hob.runtime.projects.attach(current(hob, group, project), 2, "t-2");
    fakeJob(hob, { id: "t-check", assistantId: "qa", status: "done", groupId: group.id, project: { id: project.id, n: 3 }, title: "验收登录功能", reportPath: "/tmp/验收.md" });
    hob.runtime.projects.attach(current(hob, group, project), 3, "t-check");
    hob.runtime.projects.start(group.id, project.id);
    return current(hob, group, project);
  }

  it("改过的子任务做完后，验收成员收到「可以再验一次」；阶段 review → doing → review", async () => {
    const { hob, group } = setup();
    try {
      const project = reviewed(hob, group);
      expect(current(hob, group, project).stage).toBe("review");
      const events = spyEvents(hob);

      // 验收任务交回子任务 2 去改：接着做
      hob.runtime.projects.jobResumed({ ...hob.runtime.store.job("t-2")!, status: "queued" });
      expect(current(hob, group, project).stage).toBe("doing");

      // 改完（第二轮）
      fakeJob(hob, {
        id: "t-2",
        assistantId: "dev",
        title: "实现记住我",
        status: "done",
        groupId: group.id,
        project: { id: project.id, n: 2 },
        rounds: [{ status: "done" }],
        reportPath: "/tmp/实现-2.md",
      });
      hob.runtime.projects.jobEnded(hob.runtime.store.job("t-2")!);

      expect(current(hob, group, project).stage).toBe("review");
      expect(events).toContainEqual({
        id: "qa",
        text: `事项「${project.title}」的子任务 2「实现记住我」改过了，验收任务「验收登录功能」（t-check）可以再验一次。`,
      });
    } finally { hob.close(); }
  });

  it("没被接着做过的子任务做完，不打扰验收成员", () => {
    const { hob, group } = setup();
    try {
      const project = reviewed(hob, group);
      const events = spyEvents(hob);
      hob.runtime.projects.jobEnded({ ...hob.runtime.store.job("t-2")!, rounds: undefined });
      expect(events.some((event) => event.text.includes("可以再验一次"))).toBe(false);
    } finally { hob.close(); }
  });

  it("reply_job 接着做已验收的子任务：阶段回到执行，改完再回验收并请验收成员再验", async () => {
    const { hob, group } = setup();
    try {
      const project = reviewed(hob, group);
      expect(current(hob, group, project).stage).toBe("review");
      const events = spyEvents(hob);

      // 验收不过，交回子任务 2 接着做
      hob.faux.setResponses([call("report", { outcome: "done", result: "改好了" }), text("好")]);
      hob.faux.appendResponses([text("收到")]);
      await hob.runtime.jobs.reply("t-2", "第二条没过：不勾选时也记住了登录，改掉");
      expect(current(hob, group, project).stage).toBe("doing");
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("dev");

      const saved = current(hob, group, project);
      expect(saved.stage).toBe("review");
      expect(hob.runtime.store.job("t-2")!.rounds).toHaveLength(1);
      expect(events).toContainEqual({
        id: "qa",
        text: `事项「${project.title}」的子任务 2「实现记住我」改过了，验收任务「验收登录功能」（t-check）可以再验一次。`,
      });
      expect(events.filter((event) => event.id === "hob").map((event) => event.text)).toContain(
        `事项「${project.title}」的子任务都做完了，现在是验收。\n验收结果：通过 0 条，没通过 0 条，未验证 3 条。`,
      );
    } finally { hob.close(); }
  });
});

describe("进入验收时的事件带验收结果", () => {
  it("写清通过、没通过、未验证各几条", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "定方案", assignee: "dev", brief: "定" },
        { title: "验收", assignee: "qa", brief: "验", after: [1], check: true },
      ]);
      const planned = current(hob, group, project);
      hob.runtime.store.saveProject({ ...planned, stage: "doing", startedAt: new Date().toISOString() });
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案" });
      hob.runtime.projects.attach(current(hob, group, project), 1, "t-1");
      fakeJob(hob, { id: "t-check", assistantId: "qa", status: "done", groupId: group.id, project: { id: project.id, n: 2 }, title: "验收" });
      // 验收任务先交了两条结果：一条过、一条没过
      await reportTool(hob, "t-check").run({
        outcome: "stuck",
        checks: [
          { index: 1, passed: true, evidence: "第一条验过了。" },
          { index: 2, passed: false, evidence: "第二条没过。" },
        ],
      });
      hob.runtime.projects.attach(current(hob, group, project), 2, "t-check");
      hob.runtime.store.saveJob({ ...hob.runtime.store.job("t-check")!, status: "done" });
      const events = spyEvents(hob);
      hob.runtime.projects.jobEnded(hob.runtime.store.job("t-check")!);
      expect(current(hob, group, project).stage).toBe("review");
      expect(events.filter((event) => event.id === "hob").map((event) => event.text)).toEqual([
        `事项「${project.title}」的子任务 2「验收」已完成。`,
        `事项「${project.title}」的子任务都做完了，现在是验收。\n验收结果：通过 1 条，没通过 1 条，未验证 1 条。`,
      ]);
    } finally { hob.close(); }
  });
});

describe("结束事项", () => {
  it("有没通过的条目也能结束，记录里照实写打勾、打叉、未验证", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "定方案", assignee: "dev", brief: "定" },
        { title: "验收", assignee: "qa", brief: "验", after: [1], check: true },
      ]);
      hob.runtime.projects.start(group.id, project.id);
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案" });
      hob.runtime.projects.attach(current(hob, group, project), 1, "t-1");
      fakeJob(hob, { id: "t-check", assistantId: "qa", status: "done", groupId: group.id, project: { id: project.id, n: 2 }, title: "验收" });
      hob.runtime.projects.attach(current(hob, group, project), 2, "t-check");
      hob.runtime.projects.jobEnded(hob.runtime.store.job("t-check")!);
      await reportTool(hob, "t-check").run({
        outcome: "stuck",
        checks: [
          { index: 1, passed: true, evidence: "第一条验过了。" },
          { index: 2, passed: false, evidence: "第二条没过。" },
        ],
      });

      const close = toolOf(hob, "close_project", group.id);
      const result = await close.execute("c", { project: project.id, outcome: "done", summary: "先上线，第二条下个版本修。" });
      expect(isError(result)).toBe(false);
      const ended = current(hob, group, project);
      expect(ended.stage).toBe("done");
      expect(ended.checks?.map((check) => check.passed)).toEqual([true, false]);

      const record = readFileSync(hob.runtime.projects.recordPath(ended), "utf8");
      expect(record).toContain(`1. [x] ${ACCEPTANCE[0]}`);
      expect(record).toContain(`2. [!] ${ACCEPTANCE[1]}`);
      expect(record).toContain(`3. [ ] ${ACCEPTANCE[2]}`);
      expect(record).toContain("先上线，第二条下个版本修。");
    } finally { hob.close(); }
  });
});

describe("提示词 4.5", () => {
  const prompt = (hob: TestHob, group: Group, projects: Project[], memory: "off" | "local" = "off") =>
    buildSystemPrompt(hob.runtime.store, "hob", {
      timezone: "Asia/Shanghai",
      aboutYou: { name: "", language: "", notes: "" },
      memory,
      group,
      projects,
    });
  const MEMORY_LINE = "这次定下来、以后还用得上的叫法和决定，记进记忆。";

  it("只在负责人负责的事项在验收时出现", () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      expect(prompt(hob, group, hob.runtime.projects.list(group.id))).not.toMatch(/## 事项[^\n]*：验收\n/);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "dev", brief: "定" }]);
      hob.runtime.projects.start(group.id, project.id);
      expect(prompt(hob, group, hob.runtime.projects.list(group.id))).not.toMatch(/## 事项[^\n]*：验收\n/);
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案" });
      hob.runtime.projects.attach(current(hob, group, project), 1, "t-1");
      hob.runtime.projects.jobEnded(hob.runtime.store.job("t-1")!);
      expect(current(hob, group, project).stage).toBe("review");
      const shown = prompt(hob, group, hob.runtime.projects.list(group.id));
      expect(shown).toContain(`## 事项「${project.title}」：验收`);
      expect(shown).toContain("子任务都做完了，验收结果逐条记在验收标准下面。");
      // 别的成员没有这一段
      expect(buildSystemPrompt(hob.runtime.store, "dev", {
        timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off", group, projects: hob.runtime.projects.list(group.id),
      })).not.toMatch(/## 事项[^\n]*：验收\n/);
      expect(hob.runtime.projects.checkCounts(current(hob, group, project))).toEqual({ passed: 0, failed: 0, unchecked: 3 });
    } finally { hob.close(); }
  });

  it("两件事项同在验收：标题连起来，正文只出一次", () => {
    const { hob, group } = setup();
    try {
      for (const title of ["登录页加「记住我」", "导出加按月筛选"]) {
        const project = seed(hob, group, title);
        hob.runtime.projects.plan(group.id, project.id, [{ title: "做", assignee: "dev", brief: "做" }]);
        hob.runtime.projects.start(group.id, project.id);
        fakeJob(hob, { id: `t-${project.id}`, assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "做" });
        hob.runtime.projects.attach(current(hob, group, project), 1, `t-${project.id}`);
        hob.runtime.projects.jobEnded(hob.runtime.store.job(`t-${project.id}`)!);
      }
      const shown = prompt(hob, group, hob.runtime.projects.list(group.id));
      const header = /## 事项(.+)：验收/.exec(shown)?.[1];
      expect(header).toBeDefined();
      expect(header!.split("、")).toHaveLength(2);
      expect(shown.split("子任务都做完了，验收结果逐条记在验收标准下面。")).toHaveLength(2);
    } finally { hob.close(); }
  });

  it("记忆那句只在记忆开着时出现", () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "做", assignee: "dev", brief: "做" }]);
      hob.runtime.projects.start(group.id, project.id);
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "做" });
      hob.runtime.projects.attach(current(hob, group, project), 1, "t-1");
      hob.runtime.projects.jobEnded(hob.runtime.store.job("t-1")!);

      const off = prompt(hob, group, hob.runtime.projects.list(group.id), "off");
      expect(off).toContain("## 事项「登录页加「记住我」」：验收");
      expect(off).not.toContain(MEMORY_LINE);
      expect(prompt(hob, group, hob.runtime.projects.list(group.id), "local")).toContain(MEMORY_LINE);
    } finally { hob.close(); }
  });
});

describe("逐字对照设计稿", () => {
  const section = (start: string, end: string) => doc.split(start)[1]?.split(end)[0] ?? "";
  const block = (start: string) => section(start, "\n```\n").trim();

  it.skipIf(!doc)("4.5 与设计稿一字不差（记忆那句跟着设置出现）", () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "做", assignee: "dev", brief: "做" }]);
      hob.runtime.projects.start(group.id, project.id);
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "做" });
      hob.runtime.projects.attach(current(hob, group, project), 1, "t-1");
      hob.runtime.projects.jobEnded(hob.runtime.store.job("t-1")!);

      // 设计稿里最后一句后面带着【记忆开着才有这一句】，不是提示词的一部分
      const full = block("### 4.5 验收和结论 【你负责的事项在验收时才有】\n\n```\n")
        .replace("{标题}", project.title)
        .replace(/\s*【记忆开着才有这一句】/, "");
      const memoryLine = "这次定下来、以后还用得上的叫法和决定，记进记忆。";
      expect(full.endsWith(memoryLine)).toBe(true);
      const without = full.split("\n").slice(0, -1).join("\n");
      const build = (memory: "off" | "local") => buildSystemPrompt(hob.runtime.store, "hob", {
        timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory, group, projects: hob.runtime.projects.list(group.id),
      });
      expect(build("local")).toContain(full);
      expect(build("off")).toContain(without);
      expect(build("off")).not.toContain(memoryLine);
    } finally { hob.close(); }
  });

  it.skipIf(!doc)("4.8 与设计稿一字不差", () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "定方案", assignee: "dev", brief: "定" },
        { title: "验收", assignee: "qa", brief: "验", after: [1], check: true },
      ]);
      hob.runtime.projects.start(group.id, project.id);
      fakeJob(hob, { id: "t-check", assistantId: "qa", status: "running", groupId: group.id, project: { id: project.id, n: 2 }, title: "验收" });
      const expected = block("### 4.8 任务：验收子任务 【任务的系统提示词，验收子任务才有】\n\n```\n").replace("{标题}", project.title);
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      expect(buildWorkerPrompt(hob.runtime.store, "t-check", { timezone, aboutYou, memory: "off" })).toContain(expected);
    } finally { hob.close(); }
  });

  it.skipIf(!doc)("report 的 checks 说明与设计稿一字不差", () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "验收", assignee: "qa", brief: "验", check: true }]);
      hob.runtime.projects.start(group.id, project.id);
      fakeJob(hob, { id: "t-check", assistantId: "qa", status: "running", groupId: group.id, project: { id: project.id, n: 1 }, title: "验收" });
      const line = doc.split("\n").find((item) => item.startsWith("- `checks`："));
      expect(line).toBeDefined();
      expect(reportTool(hob, "t-check").tool.parameters.properties.checks.description).toBe(line!.slice("- `checks`：".length));
    } finally { hob.close(); }
  });
});
