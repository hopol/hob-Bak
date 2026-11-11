import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Assistant, Group, Job, Project, Subtask } from "../../shared/types.ts";
import { subtaskStatus } from "../../shared/project.ts";
import { answerApproval } from "../src/actions.ts";
import { createApp } from "../src/http.ts";
import { buildSystemPrompt, buildWorkerPrompt } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { Store } from "../src/store.ts";
import { makeHob, waitFor, type TestHob } from "./helpers.ts";

/** 定稿只在开发仓库里（.scratch 不公开），没有就跳过逐字对照 */
const DOC = ".scratch/v2/design-projects.md";
const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";

function addAssistant(hob: TestHob, id: string, name: string, duty: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty, primary: false, pinned: false, sprite: "page", instructions: "" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

/** 三人群：Hob（群主）、开发、测试。 */
function setup(options: { pushSender?: Parameters<typeof makeHob>[1]["pushSender"] } = {}) {
  const hob = makeHob({}, { memory: "off", ...(options.pushSender ? { pushSender: options.pushSender } : {}) });
  addAssistant(hob, "dev", "开发", "写代码");
  addAssistant(hob, "qa", "测试", "验收和回归");
  const group = hob.runtime.groups.create({ name: "开发团队", purpose: "做软件", workflow: "software", ownerId: "hob", members: ["hob", "dev", "qa"] });
  let jobNo = 0;
  const jobStart = vi.spyOn(hob.runtime.jobs, "start").mockImplementation(async (assistantId, input) => ({
    id: `t-auto-${++jobNo}`,
    assistantId,
    title: input.title,
    instruction: input.instruction,
    status: "queued",
    createdAt: new Date().toISOString(),
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.project ? { project: input.project } : {}),
    ...(input.files?.length ? { inputs: input.files } : {}),
  }));
  const remember = vi.spyOn(hob.runtime.router, "remember").mockResolvedValue();
  return { hob, group, jobStart, remember };
}

const groupItems = (hob: TestHob, gid: string) => hob.runtime.groups.items(gid).items;

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
  hob.runtime.projects.writeRequirements(group.id, project.id, { content: "勾选后 30 天内免登录。", acceptance: ["勾选后关掉浏览器再打开仍是登录状态"] });
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

describe("plan_subtasks：只有拆分和执行时能用，每条校验写清怎么改", () => {
  it("需求澄清时调用报错，说明现在在哪一步", async () => {
    const { hob, group } = setup();
    try {
      const project = hob.runtime.projects.open({ group, ownerId: "hob", title: "登录页加「记住我」" });
      const result = await toolOf(hob, "plan_subtasks", group.id).execute("c", { project: project.id, subtasks: [{ title: "做", assignee: "开发", brief: "做" }] });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain("现在是需求澄清");
      expect(textOf(result)).toContain("plan_subtasks 只在任务拆分或执行时用");
    } finally { hob.close(); }
  });

  it("没有子任务、assignee 对不上、after 填了后面的序号、验收子任务交给用户，都报错", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      const tool = toolOf(hob, "plan_subtasks", group.id);
      const plan = (subtasks: unknown[]) => tool.execute("c", { project: project.id, subtasks });

      const empty = await plan([]);
      expect(isError(empty)).toBe(true);
      expect(textOf(empty)).toContain("subtasks 不能为空");

      const who = await plan([{ title: "做", assignee: "产品经理", brief: "做" }]);
      expect(isError(who)).toBe(true);
      expect(textOf(who)).toContain("assignee 要填群里成员的名字，或者「用户」");
      expect(textOf(who)).toContain("开发、测试");

      const later = await plan([{ title: "一", assignee: "开发", brief: "一" }, { title: "二", assignee: "开发", brief: "二", after: [2] }]);
      expect(isError(later)).toBe(true);
      expect(textOf(later)).toContain("只能填排在前面的序号");

      const loop = await plan([{ title: "一", assignee: "开发", brief: "一", after: [1] }, { title: "二", assignee: "开发", brief: "二" }]);
      expect(isError(loop)).toBe(true);
      expect(textOf(loop)).toContain("只能填排在前面的序号");

      const checkUser = await plan([{ title: "验收", assignee: "用户", brief: "验", check: true }]);
      expect(isError(checkUser)).toBe(true);
      expect(textOf(checkUser)).toContain("不能交给用户");

      // 都挡住了：事项还是拆好的那步，一个子任务都没有
      expect(hob.runtime.store.project(group.id, project.id)!.subtasks).toEqual([]);
    } finally { hob.close(); }
  });

  it("从 1 开始编号，assignee 换成成员 id，after 换成前置的序号，不结束这一轮", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      const tool = toolOf(hob, "plan_subtasks", group.id);
      const result = await tool.execute("c", {
        project: project.id,
        subtasks: [
          { title: "定方案", assignee: "开发", brief: "定方案" },
          { title: "上线前试一次", assignee: "用户", brief: "在手机上试" },
          { title: "验收", assignee: "测试", brief: "逐条验", after: [1, 2], check: true },
        ],
      });
      expect(isError(result)).toBe(false);
      expect((result as { terminate?: boolean }).terminate).toBeUndefined();
      const saved = hob.runtime.store.project(group.id, project.id)!;
      expect(saved.subtasks.map((item) => [item.n, item.title, item.assignee, item.after, item.check ?? false])).toEqual([
        [1, "定方案", "dev", [], false],
        [2, "上线前试一次", "user", [], false],
        [3, "验收", "qa", [1, 2], true],
      ]);
      expect(textOf(result)).toContain("现在有 3 个子任务");
      expect(textOf(result)).toContain("还没开始执行");
    } finally { hob.close(); }
  });

  it("整份替换：已经有任务的、用户已经点过的原样保留，序号不变，其余换成这次的", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "一", assignee: "dev", brief: "一" },
        { title: "二", assignee: "用户", brief: "二" },
        { title: "三", assignee: "dev", brief: "三" },
        { title: "四", assignee: "dev", brief: "四" },
      ]);
      hob.runtime.projects.start(group.id, project.id);
      const current = hob.runtime.store.project(group.id, project.id)!;
      fakeJob(hob, { id: "t-keep", assistantId: "dev", project: { id: project.id, n: 1 } });
      hob.runtime.projects.attach(current, 1, "t-keep");
      hob.runtime.projects.done(group.id, project.id, 2);

      const result = await toolOf(hob, "plan_subtasks", group.id).execute("c", {
        project: project.id,
        subtasks: [
          { title: "五", assignee: "开发", brief: "五" },
          { title: "六", assignee: "测试", brief: "六", after: [1] },
        ],
      });
      expect(isError(result)).toBe(false);
      const saved = hob.runtime.store.project(group.id, project.id)!;
      expect(saved.subtasks.map((item) => [item.n, item.title, item.assignee, item.after, Boolean(item.jobId), Boolean(item.doneAt)])).toEqual([
        [1, "一", "dev", [], true, false],
        [2, "二", "user", [], false, true],
        [3, "五", "dev", [], true, false],
        [4, "六", "qa", [3], true, false],
      ]);
    } finally { hob.close(); }
  });
});

describe("start_subtasks：工具和接口两条路", () => {
  it("工具开工会进入执行、直接以成员名义开任务，不为成员开一轮", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "定方案", assignee: "dev", brief: "定" },
        { title: "验收", assignee: "qa", brief: "验", after: [1], check: true },
      ]);
      const result = await toolOf(hob, "start_subtasks", group.id).execute("c", { project: project.id });
      expect(isError(result)).toBe(false);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.jobId));
      const saved = hob.runtime.store.project(group.id, project.id)!;
      expect(saved.stage).toBe("doing");
      expect(saved.startedAt).toBeTruthy();
      expect(saved.subtasks[0]!.jobId).toBe("t-auto-1");
      expect(saved.subtasks[0]!.notifiedAt).toBeTruthy();
      expect(saved.subtasks[1]!.notifiedAt).toBeUndefined();
      expect(hob.runtime.jobs.start).toHaveBeenCalledWith("dev", expect.objectContaining({ title: "定方案", groupId: group.id, instruction: expect.stringContaining("## 你的子任务"), project: { id: project.id, n: 1 } }));
      expect(hob.runtime.router.remember).toHaveBeenCalledWith("dev", `事项「登录页加「记住我」」的子任务 1「定方案」轮到你了，已经以你的名义开了任务 t-auto-1。`, group.id);
    } finally { hob.close(); }
  });

  it("cwd 校验、返回和再次拆分沿用工作目录", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      const tool = toolOf(hob, "plan_subtasks", group.id);
      const missing = await tool.execute("c", { project: project.id, cwd: `${process.cwd()}/.hob-missing-158`, subtasks: [{ title: "做", assignee: "开发", brief: "做" }] });
      expect(isError(missing)).toBe(true);
      expect(textOf(missing)).toContain("没有这个目录：");
      const inside = await tool.execute("c", { project: project.id, cwd: `${hob.home}/project`, subtasks: [{ title: "做", assignee: "开发", brief: "做" }] });
      expect(isError(inside)).toBe(true);
      expect(textOf(inside)).toContain("不能在 Hob 的数据目录里干活");
      const cwd = process.cwd();
      const first = await tool.execute("c", { project: project.id, cwd, subtasks: [{ title: "做", assignee: "开发", brief: "做" }] });
      expect(textOf(first)).toContain(`工作目录：${cwd}。`);
      const second = await tool.execute("c", { project: project.id, subtasks: [{ title: "换做", assignee: "开发", brief: "换做" }] });
      expect(textOf(second)).toContain(`工作目录：${cwd}。`);
      expect(hob.runtime.store.project(group.id, project.id)?.cwd).toBe(cwd);
      expect(readFileSync(hob.runtime.projects.recordPath(project), "utf8")).toContain(`工作目录：${cwd}`);
    } finally { hob.close(); }
  });

  it("成员任务启动失败会记为受阻并通知负责人", async () => {
    const { hob, group, jobStart } = setup();
    try {
      jobStart.mockRejectedValueOnce(new Error("模型不可用"));
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "开发", brief: "定" }]);
      const events = spyEvents(hob);
      hob.runtime.projects.start(group.id, project.id);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.startError));
      const saved = hob.runtime.store.project(group.id, project.id)!;
      expect(subtaskStatus(saved, saved.subtasks[0]!)).toBe("受阻");
      expect(saved.subtasks[0]!.startError).toBe("模型不可用");
      expect(events.some((event) => event.id === "hob" && event.text === "事项「登录页加「记住我」」的子任务 1「定方案」受阻：任务没开起来，模型不可用。")).toBe(true);
      expect(readFileSync(hob.runtime.projects.recordPath(project), "utf8")).toContain("原因：模型不可用");
    } finally { hob.close(); }
  });

  it("重启恢复已轮到但还没开出的成员子任务", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      const now = new Date().toISOString();
      hob.runtime.store.saveProject({ ...project, stage: "doing", startedAt: now, subtasks: [{ n: 1, title: "定方案", assignee: "dev", brief: "定", after: [], notifiedAt: now }] });
      hob.runtime.projects.recover();
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.jobId));
      expect(hob.runtime.jobs.start).toHaveBeenCalledTimes(1);
      hob.runtime.projects.recover();
      expect(hob.runtime.jobs.start).toHaveBeenCalledTimes(1);
    } finally { hob.close(); }
  });
  it("连续推进同一子任务只开一个任务", async () => {
    const { hob, group, jobStart } = setup();
    try {
      let resolveJob!: (job: Job) => void;
      const pending = new Promise<Job>((resolve) => { resolveJob = resolve; });
      jobStart.mockImplementationOnce(() => pending);
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "开发", brief: "定" }]);
      hob.runtime.projects.start(group.id, project.id);
      hob.runtime.projects.recover();
      hob.runtime.projects.recover();
      expect(jobStart).toHaveBeenCalledTimes(1);
      resolveJob({ id: "t-pending", assistantId: "dev", title: "定方案", instruction: "定", status: "queued", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], groupId: group.id, project: { id: project.id, n: 1 } });
      await waitFor(() => hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.jobId === "t-pending");
    } finally { hob.close(); }
  });  it("remember 失败不影响已经开出的任务", async () => {
    const { hob, group, remember } = setup();
    try {
      remember.mockRejectedValueOnce(new Error("成员会话打不开"));
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "开发", brief: "定" }]);
      const events = spyEvents(hob);
      hob.runtime.projects.start(group.id, project.id);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.jobId));
      const saved = hob.runtime.store.project(group.id, project.id)!;
      expect(saved.subtasks[0]!.jobId).toBe("t-auto-1");
      expect(saved.subtasks[0]!.startError).toBeUndefined();
      expect(subtaskStatus(saved, saved.subtasks[0]!)).not.toBe("受阻");
      expect(events.some((event) => event.text.includes("任务没开起来"))).toBe(false);
    } finally { hob.close(); }
  });

  it("启动失败原因末尾有句号时只保留一个句号", async () => {
    const { hob, group, jobStart } = setup();
    try {
      jobStart.mockRejectedValueOnce(new Error("不能在 Hob 的数据目录里干活；不填 cwd 就在任务自己的目录里做。"));
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "开发", brief: "定" }]);
      const events = spyEvents(hob);
      hob.runtime.projects.start(group.id, project.id);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.startError));
      const failure = events.find((event) => event.text.includes("任务没开起来"))!;
      expect(failure.text).toContain("任务没开起来，不能在 Hob 的数据目录里干活；不填 cwd 就在任务自己的目录里做。");
      expect(failure.text).not.toContain("做。。");
    } finally { hob.close(); }
  });
  it("没有子任务时报错，说明先用 plan_subtasks", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      const result = await toolOf(hob, "start_subtasks", group.id).execute("c", { project: project.id });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain("还没有子任务");
      expect(hob.runtime.store.project(group.id, project.id)!.stage).toBe("plan");
    } finally { hob.close(); }
  });

  it("用户点「开始执行」走同一个接口", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "dev", brief: "定" }]);
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const response = await app.request(`/api/groups/${group.id}/projects/${project.id}/start`, { method: "POST", headers: { cookie } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Project;
      expect(body.stage).toBe("doing");
      expect(body.startedAt).toBeTruthy();
      expect(hob.runtime.store.project(group.id, project.id)!.stage).toBe("doing");
    } finally { hob.close(); }
  });
});

describe("轮到谁：按前置一个一个来", () => {
  it("前置做完才轮到后面的；用户的子任务不发事件，点了完成后面的才开始", async () => {
    const pushed: string[] = [];
    const { hob, group } = setup({ pushSender: async (_target, payload) => { pushed.push(payload); } });
    try {
      hob.runtime.push.subscribe({ endpoint: "https://push.example/1", keys: { p256dh: "k", auth: "a" } }, "测试机");
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "定方案", assignee: "dev", brief: "定" },
        { title: "上线前试一次", assignee: "用户", brief: "在手机上试", after: [1] },
        { title: "验收", assignee: "qa", brief: "验", after: [2], check: true },
      ]);
      const events = spyEvents(hob);
      hob.runtime.projects.start(group.id, project.id);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.jobId));
      expect(events).toEqual([]);
      expect(pushed).toEqual([]);

      // 子任务 1 的任务做完了：负责人收到通知，用户那边轮到
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案", reportPath: "/tmp/report-1.md" });
      hob.runtime.projects.attach(hob.runtime.store.project(group.id, project.id)!, 1, "t-1");
      hob.runtime.projects.jobEnded(hob.runtime.store.job("t-1")!);
      await waitFor(() => pushed.length > 0);
      expect(events.filter((event) => event.id === "hob").map((event) => event.text).at(-1)).toBe("事项「登录页加「记住我」」的子任务 1「定方案」已完成。");
      expect(JSON.parse(pushed.at(-1)!)).toMatchObject({ title: "待你执行：上线前试一次", url: `/#/group/${group.id}` });
      // 用户的子任务不发事件
      expect(events.some((event) => event.id === "user")).toBe(false);
      expect(events.some((event) => event.text.includes("子任务 2「上线前试一次」轮到你了"))).toBe(false);

      // 用户点了完成：后面的才轮到
      hob.runtime.projects.done(group.id, project.id, 2);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[2]?.jobId));
      expect(events.map((event) => event.id)).toEqual(["hob"]);
      expect(events.at(-1)!.text).toBe("事项「登录页加「记住我」」的子任务 1「定方案」已完成。");
    } finally { hob.close(); }
  });

  it("全部做完后阶段进入验收，负责人收到「现在是验收」", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "dev", brief: "定" }]);
      const events = spyEvents(hob);
      hob.runtime.projects.start(group.id, project.id);
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案" });
      hob.runtime.projects.attach(hob.runtime.store.project(group.id, project.id)!, 1, "t-1");
      hob.runtime.projects.jobEnded(hob.runtime.store.job("t-1")!);
      const saved = hob.runtime.store.project(group.id, project.id)!;
      expect(saved.stage).toBe("review");
      expect(events.filter((event) => event.id === "hob").map((event) => event.text)).toEqual([
        "事项「登录页加「记住我」」的子任务 1「定方案」已完成。",
        "事项「登录页加「记住我」」的子任务都做完了，现在是验收。\n验收结果：通过 0 条，没通过 0 条，未验证 1 条。",
      ]);
    } finally { hob.close(); }
  });

  it("重启时更新事项记录并通知负责人子任务受阻", () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "dev", brief: "定" }]);
      hob.runtime.projects.start(group.id, project.id);
      fakeJob(hob, { id: "t-restart", assistantId: "dev", status: "running", groupId: group.id, project: { id: project.id, n: 1 } });
      hob.runtime.projects.attach(hob.runtime.store.project(group.id, project.id)!, 1, "t-restart");
      const events = spyEvents(hob);
      hob.runtime.jobs.recover();
      const markdown = readFileSync(hob.runtime.projects.recordPath(project), "utf8");
      expect(markdown).toContain("1. 定方案 · 开发 · 前置：无 · 受阻 · 任务 t-restart");
      expect(events.some((event) => event.id === "hob" && event.text.includes("受阻：Hob 重启，任务中断"))).toBe(true);
    } finally { hob.close(); }
  });

  it("子任务受阻时，负责人收到原因", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "dev", brief: "定" }]);
      const events = spyEvents(hob);
      hob.runtime.projects.start(group.id, project.id);
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "stuck", statusReason: "15 分钟没动静", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案" });
      hob.runtime.projects.attach(hob.runtime.store.project(group.id, project.id)!, 1, "t-1");
      hob.runtime.projects.jobEnded(hob.runtime.store.job("t-1")!);
      expect(events.filter((event) => event.id === "hob").map((event) => event.text).at(-1)).toBe("事项「登录页加「记住我」」的子任务 1「定方案」受阻：15 分钟没动静。");
      expect(hob.runtime.store.project(group.id, project.id)!.stage).toBe("doing");
    } finally { hob.close(); }
  });
});

describe("事项子任务由 Hob 直接开任务", () => {
  it("start_job 不再提供 subtask 参数", () => {
    const { hob, group } = setup();
    try {
      const tool = buildRouterTools(hob.runtime, "hob", group.id).find((item) => item.name === "start_job");
      expect(tool?.parameters.properties).not.toHaveProperty("subtask");
    } finally { hob.close(); }
  });

  it("直接开的任务使用事项记录生成的说明和共享工作目录", async () => {
    const { hob, group } = setup();
    try {
      const cwd = process.cwd();
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "实现记住我", assignee: "开发", brief: "照方案做出来，带上测试" }], cwd);
      hob.runtime.projects.start(group.id, project.id);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.jobId));
      expect(hob.runtime.jobs.start).toHaveBeenCalledWith("dev", expect.objectContaining({ cwd, title: "实现记住我", project: { id: project.id, n: 1 }, instruction: expect.stringContaining("## 原始需求") }));
      expect(hob.runtime.store.project(group.id, project.id)?.cwd).toBe(cwd);
      expect(readFileSync(hob.runtime.projects.recordPath(project), "utf8")).toContain(`工作目录：${cwd}`);
    } finally { hob.close(); }
  });
});

describe("群主能看事项里的任务", () => {
  it("群主能 check_job 成员的子任务任务，别的成员看不了", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "dev", brief: "定" }]);
      hob.runtime.projects.start(group.id, project.id);
      fakeJob(hob, { id: "t-sub", assistantId: "dev", status: "running", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案" });
      const owner = buildRouterTools(hob.runtime, "hob", group.id).find((tool) => tool.name === "check_job")!;
      const ownerView = await owner.execute("c", { jobId: "t-sub" });
      expect(isError(ownerView)).toBe(false);
      expect(textOf(ownerView)).toContain("定方案");

      const other = buildRouterTools(hob.runtime, "qa", group.id).find((tool) => tool.name === "check_job")!;
      const otherView = await other.execute("c", { jobId: "t-sub" });
      expect(isError(otherView)).toBe(false);
    } finally { hob.close(); }
  });
});

describe("问答记进事项", () => {
  const approval = (hob: TestHob, group: Group, patch: Record<string, unknown>) => {
    const at = new Date().toISOString();
    const record = {
      id: "q-1",
      assistantId: "hob",
      groupId: group.id,
      title: "勾选后多久免登录？",
      detail: "太长了设备丢了麻烦",
      options: [{ key: "A" as const, label: "7 天" }, { key: "B" as const, label: "30 天" }],
      status: "pending" as const,
      source: "router" as const,
      createdAt: at,
      ...patch,
    };
    hob.runtime.store.saveApproval(record as never);
    return record;
  };

  it("单问题卡：问题、为什么、选项、回答都记下来", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.store.saveProject({ ...project, stage: "clarify", requirements: undefined });
      const record = approval(hob, group, {});
      await answerApproval(hob.runtime, record.id, { key: "A" });
      const saved = hob.runtime.store.project(group.id, project.id)!;
      expect(saved.clarify[0]).toMatchObject({ title: "勾选后多久免登录？", why: "太长了设备丢了麻烦", options: ["7 天", "30 天"], answer: "7 天", askedBy: "hob" });
      expect(saved.clarify[0]!.answeredAt).toBeTruthy();
    } finally { hob.close(); }
  });

  it("多问题卡：每个问题一条，带上推荐和答案；同时有几件在澄清的，记到最近更新的那件", async () => {
    const { hob, group } = setup();
    try {
      const older = hob.runtime.projects.open({ group, ownerId: "hob", title: "老的一件事" });
      const newer = hob.runtime.projects.open({ group, ownerId: "hob", title: "导出加按月筛选" });
      // 同时立的两件 updatedAt 可能一样：固定成能比较的值，看它记到哪件
      hob.runtime.store.saveProject({ ...hob.runtime.store.project(group.id, older.id)!, updatedAt: "2020-01-01T00:00:00.000Z" });
      hob.runtime.store.saveProject({ ...hob.runtime.store.project(group.id, newer.id)!, updatedAt: "2030-01-01T00:00:00.000Z" });
      const record = approval(hob, group, {
        id: "q-2",
        title: "导出这几处定一下",
        options: [],
        questions: [
          { title: "筛选放在哪儿？", why: "放在哪决定改哪里。", options: [{ key: "A" as const, label: "对话框里" }, { key: "B" as const, label: "页面上" }], recommended: "A" as const },
          { title: "默认导出哪一段？", options: [{ key: "A" as const, label: "本月" }, { key: "B" as const, label: "全部" }] },
        ],
      });
      await answerApproval(hob.runtime, record.id, { answers: [{ key: "A" }, { text: "按季度" }] });
      const saved = hob.runtime.store.project(group.id, newer.id)!;
      expect(saved.clarify).toHaveLength(2);
      expect(saved.clarify[0]).toMatchObject({ title: "筛选放在哪儿？", why: "放在哪决定改哪里。", options: ["对话框里", "页面上"], recommended: "对话框里", answer: "对话框里" });
      expect(saved.clarify[1]).toMatchObject({ title: "默认导出哪一段？", answer: "按季度" });
      expect(hob.runtime.store.project(group.id, older.id)!.clarify).toEqual([]);
    } finally { hob.close(); }
  });
});

describe("服务重启后", () => {
  it("轮到的子任务和用户的按钮都还在（状态从磁盘推出来）", () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "定方案", assignee: "开发", brief: "定" },
        { title: "上线前试一次", assignee: "用户", brief: "试", after: [1] },
      ]);
      hob.runtime.projects.start(group.id, project.id);
      const saved = hob.runtime.store.project(group.id, project.id)!;
      expect(saved.subtasks[0]!.notifiedAt).toBeTruthy();

      // 重新从磁盘读（服务重启后就是这样）：通知过的事实还在，状态照样推出来
      const reopened = new Store(hob.home).project(group.id, project.id)!;
      const jobOf = (subtask: Subtask) => (subtask.jobId ? hob.runtime.store.job(subtask.jobId) : undefined);
      expect(subtaskStatus(reopened, reopened.subtasks[0]!, jobOf(reopened.subtasks[0]!), jobOf)).toBe("待开始");
      expect(subtaskStatus(reopened, reopened.subtasks[1]!, jobOf(reopened.subtasks[1]!), jobOf)).toBe("等待前置任务");

      // 前置做完：用户的按钮就出现（待你执行），点了完成后面的才算完
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 } });
      hob.runtime.projects.attach(hob.runtime.store.project(group.id, project.id)!, 1, "t-1");
      const ready = hob.runtime.store.project(group.id, project.id)!;
      expect(subtaskStatus(ready, ready.subtasks[1]!, jobOf(ready.subtasks[1]!), jobOf)).toBe("待你执行");
      const finished = hob.runtime.projects.done(group.id, project.id, 2);
      expect(finished.stage).toBe("review");
      expect(finished.subtasks[1]!.doneAt).toBeTruthy();
    } finally { hob.close(); }
  });
});

describe("提示词 4.3、4.4、4.6 的出现条件", () => {
  const prompt = (hob: TestHob, assistantId: string, group: Group, projects: Project[] | undefined) =>
    buildSystemPrompt(hob.runtime.store, assistantId, {
      timezone: "Asia/Shanghai",
      aboutYou: { name: "", language: "", notes: "" },
      memory: "off",
      group,
      ...(projects ? { projects } : {}),
    });

  it("4.3 只在群主负责的事项在任务拆分时出现；几件事项同在一步标题连起来、正文只出一次", () => {
    const { hob, group } = setup();
    try {
      const a = seed(hob, group, "登录页加「记住我」");
      const b = seed(hob, group, "导出加按月筛选");
      const shown = prompt(hob, "hob", group, hob.runtime.projects.list(group.id));
      const header = /## 事项(.+)：任务拆分/.exec(shown)?.[1];
      expect(header).toBeDefined();
      expect(header!.split("、")).toHaveLength(2);
      expect(shown.split("需求说明写好了，现在把它拆成子任务（plan_subtasks）。")).toHaveLength(2);
      expect(prompt(hob, "dev", group, hob.runtime.projects.list(group.id))).not.toContain("：任务拆分");
      hob.runtime.projects.plan(group.id, a.id, [{ title: "定方案", assignee: "dev", brief: "定" }]);
      hob.runtime.projects.start(group.id, a.id);
      const after = prompt(hob, "hob", group, hob.runtime.projects.list(group.id));
      expect(after).not.toContain(`${a.title}」：任务拆分`);
      expect(after).toContain(`${b.title}」：任务拆分`);
    } finally { hob.close(); }
  });

  it("4.4 只在负责人负责的事项在执行时出现", () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "dev", brief: "定" }]);
      expect(prompt(hob, "hob", group, hob.runtime.projects.list(group.id))).not.toContain("：执行");
      hob.runtime.projects.start(group.id, project.id);
      const shown = prompt(hob, "hob", group, hob.runtime.projects.list(group.id));
      expect(shown).toContain(`## 事项「${project.title}」：执行`);
      expect(shown).toContain("子任务按前置的先后自动开始，轮到谁，就以谁的名义开任务去做。");
      expect(prompt(hob, "dev", group, hob.runtime.projects.list(group.id))).not.toContain("：执行");
    } finally { hob.close(); }
  });

  it("4.6 只给分到还没结束的子任务的成员，写序号、标题、状态和负责人的名字", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "定方案", assignee: "dev", brief: "定" },
        { title: "验收", assignee: "qa", brief: "验", after: [1], check: true },
      ]);
      hob.runtime.projects.start(group.id, project.id);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.jobId));
      const mine = prompt(hob, "dev", group, hob.runtime.projects.list(group.id));
      expect(mine).toContain("## 分给你的子任务");
      expect(mine).toContain(`- 事项「${project.title}」· 子任务 1「定方案」· 待开始 · 任务 t-auto-1`);
      expect(mine).toContain("在群里找事项负责人「Hob」");
      const waiting = prompt(hob, "qa", group, hob.runtime.projects.list(group.id));
      expect(waiting).toContain(`- 事项「${project.title}」· 子任务 2「验收」· 等待前置任务`);
      expect(prompt(hob, "hob", group, hob.runtime.projects.list(group.id))).not.toContain("## 分给你的子任务");
      // 做完的子任务不再列
      fakeJob(hob, { id: "t-1", assistantId: "dev", status: "done", groupId: group.id, project: { id: project.id, n: 1 } });
      hob.runtime.projects.attach(hob.runtime.store.project(group.id, project.id)!, 1, "t-1");
      expect(prompt(hob, "dev", group, hob.runtime.projects.list(group.id))).not.toContain("## 分给你的子任务");
    } finally { hob.close(); }
  });
});

describe("逐字对照设计稿", () => {
  const section = (start: string, end: string) => doc.split(start)[1]?.split(end)[0] ?? "";
  const block = (start: string) => section(start, "\n```\n").trim();
  /** 工具说明草稿：每个工具第一行是说明，后面的 `参数`：… 是参数说明（含缩进的子项）。 */
  const tools = new Map<string, { text: string; params: Map<string, string> }>();
  for (const line of section("### 工具说明草稿", "## 六、评测").split("\n")) {
    const head = /^\*\*(\w+)\*\*(?:（群主）)?：(.+)$/.exec(line);
    if (head) {
      tools.set(head[1]!, { text: head[2]!, params: new Map() });
      continue;
    }
    const param = /^\s*- `(\w+)`：(.+)$/.exec(line);
    if (param) tools.get([...tools.keys()].at(-1)!)?.params.set(param[1]!, param[2]!);
  }
  const toolsOf = (hob: TestHob, gid: string, names: string[]) => Object.fromEntries(names.map((name) => [name, toolOf(hob, name, gid)]));

  it.skipIf(!doc)("4.3、4.4、4.6 与设计稿一字不差", () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      const plan = block("### 4.3 任务拆分 【你负责的事项在任务拆分时才有】\n\n```\n").replace("{标题}", project.title);
      expect(buildSystemPrompt(hob.runtime.store, "hob", {
        timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off", group, projects: hob.runtime.projects.list(group.id),
      })).toContain(plan);

      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "dev", brief: "定" }]);
      hob.runtime.projects.start(group.id, project.id);
      const doing = block("### 4.4 执行 【你负责的事项在执行时才有】\n\n```\n").replace("{标题}", project.title);
      expect(buildSystemPrompt(hob.runtime.store, "hob", {
        timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off", group, projects: hob.runtime.projects.list(group.id),
      })).toContain(doing);

      const assigned = block("### 4.6 成员：分给你的子任务 【这个成员有还没结束的子任务才有】\n\n```\n")
        .replace("{标题}", project.title)
        .replace("{N}", "1")
        .replace("{子任务标题}", "定方案")
        .replace("{状态}", "待开始")
        .replace("{负责人}", "Hob");
      expect(buildSystemPrompt(hob.runtime.store, "dev", {
        timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off", group, projects: hob.runtime.projects.list(group.id),
      })).toContain(assigned);
    } finally { hob.close(); }
  });

  it.skipIf(!doc)("4.7 与设计稿一字不差", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [{ title: "定方案", assignee: "dev", brief: "定" }]);
      hob.runtime.projects.start(group.id, project.id);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.jobId));
      fakeJob(hob, { id: "t-auto-1", assistantId: "dev", status: "queued", groupId: group.id, project: { id: project.id, n: 1 }, title: "定方案" });
      const job = hob.runtime.store.job("t-auto-1")!;
      const expected = block("### 4.7 任务：做子任务 【任务的系统提示词，子任务才有】\n\n```\n")
        .replace("{标题}", project.title)
        .replace("{N}", "1")
        .replace("{子任务标题}", "定方案")
        .replace("{助手}", "开发");
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      expect(buildWorkerPrompt(hob.runtime.store, job.id, { timezone, aboutYou, memory: "off" })).toContain(expected);
      expect(job.project).toEqual({ id: project.id, n: 1 });
    } finally { hob.close(); }
  });

  it.skipIf(!doc)("plan_subtasks、start_subtasks 的说明和参数说明，以及 start_job 的 subtask 参数，与设计稿一字不差", () => {
    const { hob, group } = setup();
    try {
      const found = toolsOf(hob, group.id, ["plan_subtasks", "start_subtasks"]);
      for (const name of ["plan_subtasks", "start_subtasks"]) {
        expect(found[name]!.description, name).toBe(tools.get(name)!.text);
      }
      const plan = found.plan_subtasks!.parameters.properties;
      for (const key of ["project", "cwd", "subtasks", "title", "assignee", "brief", "after", "check"]) {
        if (key === "subtasks") {
          expect(plan.subtasks.description).toBe(tools.get("plan_subtasks")!.params.get("subtasks"));
          continue;
        }
        const where = ["project", "cwd", "subtasks"].includes(key) ? plan : plan.subtasks.items.properties;
        expect(where[key].description, key).toBe(tools.get("plan_subtasks")!.params.get(key));
      }
      expect(found.start_subtasks!.parameters.properties.project.description).toBe(tools.get("start_subtasks")!.params.get("project"));
      const start = buildRouterTools(hob.runtime, "dev", group.id).find((tool) => tool.name === "start_job")!;
      expect(start.parameters.properties.subtask).toBeUndefined();
    } finally { hob.close(); }
  });
});

describe("记录里也有子任务", () => {
  it("写序号、标题、谁做、前置和状态", async () => {
    const { hob, group } = setup();
    try {
      const project = seed(hob, group);
      hob.runtime.projects.plan(group.id, project.id, [
        { title: "定方案", assignee: "开发", brief: "定" },
        { title: "上线前试一次", assignee: "用户", brief: "试", after: [1] },
      ]);
      hob.runtime.projects.start(group.id, project.id);
      const markdown = readFileSync(hob.runtime.projects.recordPath(hob.runtime.store.project(group.id, project.id)!), "utf8");
      expect(markdown).toContain("1. 定方案 · 开发 · 前置：无 · 待开始");
      expect(markdown).toContain("2. 上线前试一次 · 你 · 前置：子任务 1 · 等待前置任务");
    } finally { hob.close(); }
  });
});

