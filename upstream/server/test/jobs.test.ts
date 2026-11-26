import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../shared/types.ts";
import { answerApproval } from "../src/actions.ts";
import { JobManager, assistantJobResultEvent, jobResultEvent } from "../src/jobs.ts";
import { saveAssistantSkill, saveSkill } from "../src/assistant-skills.ts";
import { visibleSkills } from "../src/skills.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

/** 进程还在不在（被杀了就 false）。 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("任务", () => {
  it("非主助手开一个不填 cwd 的任务：工作目录在它自己的任务目录下", async () => {
    const hob = makeHob();
    try {
      hob.runtime.store.saveAssistant({ ...hob.runtime.store.assistant("hob")!, id: "ops", name: "服务器", primary: false });
      hob.faux.setResponses([call("report", { outcome: "done", result: "收拾好了" }), text("交给后台了")]);
      hob.faux.appendResponses([text("做完了。")]);
      const job = await hob.runtime.jobs.start("ops", { title: "收拾目录", instruction: "把目录收拾一下" });

      expect(job.cwd).toBe(join(hob.home, "assistants", "ops", "jobs", job.id, "work"));
      expect(existsSync(join(hob.home, "assistants", "hob", "jobs", job.id))).toBe(false);

      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)).toMatchObject({ status: "done", cwd: job.cwd });
    } finally { hob.close(); }
  });

  it("任务事件按完整结果长度分段，缺结果说明原因", () => {
    const job = { id: "t-1", assistantId: "hob", assistantName: "Hob", title: "测试", instruction: "", status: "done" as const, createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [], reportPath: "/tmp/report.md" };
    expect(jobResultEvent({ ...job, summary: "短结果" })).toBe("「Hob」的任务「测试」（t-1）已完成。\n过程：工具操作 0 次，没用技能。\n结果：\n短结果");
    const long = "字".repeat(3001);
    expect(jobResultEvent({ ...job, summary: long })).toBe(`「Hob」的任务「测试」（t-1）已完成。\n过程：工具操作 0 次，没用技能。\n结果（共 3001 字，以下是前 3,000 字；全文：/tmp/report.md）：\n${long.slice(0, 3000)}`);
    expect(jobResultEvent({ ...job, status: "failed", statusReason: "中断" })).toBe("「Hob」的任务「测试」（t-1）失败。\n过程：工具操作 0 次，没用技能。\n中断");
    expect(jobResultEvent({ ...job, summary: "短结果" }, "定时任务「每日」")).toBe("定时任务「每日」（t-1）已完成。\n过程：工具操作 0 次，没用技能。\n结果：\n短结果");
  });
  it("report 的 outcome 不认识就退回重填，不当成已完成", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("report", { outcome: "failed", result: "没连上" }),
        call("report", { outcome: "stuck", result: "没连上数据库" }),
        text("好"),
      ]);
      hob.faux.appendResponses([text("任务受阻。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "查库", instruction: "看看数据库" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");

      const ended = hob.runtime.store.job(job.id)!;
      expect(ended.status).toBe("stuck");
      expect(ended.summary).toBe("没连上数据库");
      // 「受阻」是状态不是原因：卡片右上角已经写了，标题下面不再重复一行
      expect(ended.statusReason).toBeUndefined();
      expect(readFileSync(ended.reportPath!, "utf8")).toContain("状态：受阻\n");
    } finally {
      hob.close();
    }
  });

  it("report 说等你拍板也是受阻，不拿状态词当原因", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("report", { outcome: "need_approval", result: "要你定发布还是先放着" }),
        text("好"),
      ]);
      hob.faux.appendResponses([text("等你定。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "发文章", instruction: "发布一篇" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");

      const ended = hob.runtime.store.job(job.id)!;
      expect(ended.status).toBe("stuck");
      expect(ended.statusReason).toBeUndefined();
    } finally {
      hob.close();
    }
  });

  it("report 流程：状态 done、写 report.md、推事件回对话", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "磁盘用了 40%，剩 60G" }), text("好")]);
      hob.faux.appendResponses([text("磁盘用了 40%。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "查磁盘", instruction: "看看磁盘用了多少" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");

      const done = hob.runtime.store.job(job.id)!;
      expect(done.status).toBe("done");
      expect(done.summary).toBe("磁盘用了 40%，剩 60G");
      expect(done.endedAt).toBeTruthy();
      expect(done.reportPath && existsSync(done.reportPath)).toBe(true);
      expect(readFileSync(done.reportPath!, "utf8")).toContain("磁盘用了 40%");
      expect(hob.runtime.store.worklog("hob")[0]).toMatchObject({ jobId: job.id, text: "任务已完成：查磁盘" });
      const items = hob.runtime.router.items("hob").items;
      expect(items.some((item) => item.kind === "job" && item.jobId === job.id)).toBe(true);
      expect(items.some((item) => item.kind === "assistant" && item.text === "磁盘用了 40%。")).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("任务收尾不等待普通、定时和群结果通知的助手回合", async () => {
    const hob = makeHob();
    let release = () => {};
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "每日检查",
        instruction: "检查",
        schedules: ["0 9 * * *"],
      });
      const group = hob.runtime.groups.create({ name: "检查群", purpose: "检查", ownerId: "hob", members: ["hob"] });
      const event = vi.spyOn(hob.runtime.router, "event");
      event.mockImplementation(async () => new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }));
      for (const extra of [{}, { routineId: routine.id }, { groupId: group.id }]) {
        let resolve!: (value: boolean) => void;
        const pending = new Promise<boolean>((done) => { resolve = done; });
        release = () => resolve(true);
        event.mockImplementationOnce(async () => pending);
        hob.faux.setResponses([call("report", { outcome: "done", result: "完成" })]);
        const job = await hob.runtime.jobs.start("hob", { title: "检查", instruction: "检查", ...extra });
        await waitFor(() => hob.runtime.store.job(job.id)?.status === "done", 1_000);
        release();
      }
    } finally {
      release();
      hob.close();
    }
  });

  it("报告原样保留：多行 markdown 不压成一行、长报告不截断", async () => {
    const hob = makeHob();
    try {
      const summary = `## 结论\n\n- 第一条\n- 第二条\n\n${"细节".repeat(2000)}`;
      const event = vi.spyOn(hob.runtime.router, "event");
      hob.faux.setResponses([call("report", { outcome: "done", result: summary }), text("好")]);
      hob.faux.appendResponses([text("写完了。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "长报告", instruction: "写一份长报告" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");

      const done = hob.runtime.store.job(job.id)!;
      expect(done.summary).toBe(summary);
      const report = readFileSync(done.reportPath!, "utf8");
      expect(report).toContain(`## 结果\n\n${summary}\n\n## 任务说明`);
      expect(event.mock.calls.some((args) => args[1].startsWith(`「Hob」的任务「长报告」（${job.id}）已完成`) && args[1].includes(`结果（共 ${summary.length} 字`))).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("没调用 report 会先追问一次，再不报就是 stuck", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([text("我做完了。"), text("没有别的事。")]);
      hob.faux.appendResponses([text("没结果。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "不该忘 report", instruction: "随便干点啥" });
      await hob.runtime.jobs.waitIdle();
      const done = hob.runtime.store.job(job.id)!;
      expect(done.status).toBe("stuck");
      expect(done.statusReason).toBe("未提交结果");
      expect(hob.faux.state.callCount).toBeGreaterThanOrEqual(2);
    } finally {
      hob.close();
    }
  });

  it("跑着时补一句：立刻出现「等待读取」一行，任务读到后换成正式的一行", async () => {
    const hob = makeHob();
    let release = () => {};
    try {
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const steps: { id: string; queued?: boolean; text?: string }[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "job_step" && event.step.from === "user") steps.push(event.step); });
      hob.faux.setResponses([
        async () => { await gate; return call("bash", { command: "true" }); },
        call("report", { outcome: "done", result: "按补充改了" }),
        text("好"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "改配置", instruction: "改配置" });
      await waitFor(() => hob.faux.state.callCount >= 1);
      await hob.runtime.jobs.reply(job.id, "只改私聊");
      expect(steps).toEqual([expect.objectContaining({ queued: true, text: "只改私聊" })]);
      expect(hob.runtime.jobs.transcript(job.id)).toContainEqual(expect.objectContaining({ queued: true, text: "只改私聊" }));
      release();
      await hob.runtime.jobs.waitIdle();
      expect(steps[1]).toMatchObject({ id: expect.stringMatching(/^u/), text: "只改私聊" });
      expect(steps[1].queued).toBeUndefined();
      expect(hob.runtime.jobs.transcript(job.id).filter((step) => step.text === "只改私聊")).toEqual([expect.objectContaining({ id: steps[1].id })]);
    } finally {
      release();
      hob.close();
    }
  });

  it("结束后用原会话接着做，覆盖报告并再次通知", async () => {
    const hob = makeHob();
    let release = () => {};
    try {
      const event = vi.spyOn(hob.runtime.router, "event");
      hob.faux.setResponses([call("report", { outcome: "done", result: "第一轮结果", files: ["/first.txt"] }), text("好"), text("第一轮完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "原任务", instruction: "第一轮说明" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      const first = hob.runtime.store.job(job.id)!;
      const before = readFileSync(hob.runtime.store.workerFile(job.id), "utf8");
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([
        async () => { await gate; return call("report", { outcome: "done", result: "第二轮结果" }); },
        text("好"), text("第二轮完成"),
      ]);
      await hob.runtime.jobs.reply(job.id, "请继续补充");
      const running = hob.runtime.store.job(job.id)!;
      expect(running).toMatchObject({ status: "running", model: first.model, thinking: first.thinking, cwd: first.cwd });
      expect(running.summary).toBeUndefined();
      expect(running.files).toBeUndefined();
      expect(running.reportPath).toBeUndefined();
      expect(running.endedAt).toBeUndefined();
      expect(running.statusReason).toBeUndefined();
      release();
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      const done = hob.runtime.store.job(job.id)!;
      expect(done).toMatchObject({ status: "done", summary: "第二轮结果", files: [] });
      expect(readFileSync(done.reportPath!, "utf8")).toContain("第二轮结果");
      const after = readFileSync(hob.runtime.store.workerFile(job.id), "utf8");
      expect(after.startsWith(before)).toBe(true);
      expect(after).toMatch(/用户接着说（\d+月\d+日 \d\d:\d\d）：请继续补充/);
      expect(event.mock.calls.filter((args) => args[1].includes(`（${job.id}）已完成`))).toHaveLength(2);
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "job" && item.jobId === job.id)).toHaveLength(2);
      // 第一轮结束时的样子留在 rounds 里，续做的那张卡记着是第 1 轮
      expect(done.rounds).toMatchObject([{ status: "done", startedAt: first.startedAt, endedAt: first.endedAt, durationMs: first.durationMs, summary: "第一轮结果", files: ["/first.txt"], usage: first.usage, followUp: "请继续补充" }]);
      expect(readFileSync(done.rounds![0].reportPath!, "utf8")).toContain("第一轮结果");
      expect(hob.runtime.router.items("hob").items.flatMap((item) => item.kind === "job" && item.jobId === job.id ? [item.round] : [])).toEqual([undefined, 1]);
      hob.faux.setResponses([call("report", { outcome: "done", result: "第三轮结果", files: ["/third.txt"] }), text("好"), text("第三轮完成")]);
      await hob.runtime.jobs.reply(job.id, "再做一次");
      await hob.runtime.jobs.waitIdle();
      const third = hob.runtime.store.job(job.id)!;
      expect(third.rounds).toHaveLength(2);
      expect(third.rounds![1]).toMatchObject({ summary: "第二轮结果", files: [], followUp: "再做一次" });
      expect(third.rounds![1].usage).toEqual({ input: done.usage!.input - first.usage!.input, output: done.usage!.output - first.usage!.output, cost: Number((done.usage!.cost - first.usage!.cost).toFixed(6)) });
      expect(readFileSync(third.rounds![0].reportPath!, "utf8")).toContain("第一轮结果");
      expect(readFileSync(third.rounds![1].reportPath!, "utf8")).toContain("第二轮结果");
      expect(third).toMatchObject({ summary: "第三轮结果", files: ["/third.txt"] });
    } finally {
      release();
      hob.close();
    }
  });

  it.each(["stuck", "failed", "stopped"] as const)("%s 状态也能接着做并清除旧原因", async (status) => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "初次" }), text("好"), text("完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "原任务", instruction: "原说明" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      hob.runtime.store.saveJob({ ...hob.runtime.store.job(job.id)!, status, statusReason: "旧原因" });
      hob.faux.setResponses([call("report", { outcome: "done", result: "继续完成" }), text("好"), text("完成")]);
      await hob.runtime.jobs.reply(job.id, "继续");
      expect(hob.runtime.store.job(job.id)?.statusReason).toBeUndefined();
      expect(hob.runtime.store.job(job.id)?.rounds).toMatchObject([{ status, statusReason: "旧原因" }]);
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)).toMatchObject({ status: "done", summary: "继续完成" });
    } finally {
      hob.close();
    }
  });

  it("名额已满时结束任务的跟进排队，空出后继续原会话", async () => {
    const hob = makeHob({}, { settings: { work: { maxJobs: 1 } } });
    let release = () => {};
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "原结果" }), text("好"), text("完成")]);
      const original = await hob.runtime.jobs.start("hob", { title: "原任务", instruction: "原说明" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([
        async () => { await gate; return call("report", { outcome: "done", result: "占位完成" }); },
        text("好"), text("占位完成"),
        call("report", { outcome: "done", result: "接续完成" }), text("好"), text("接续完成"),
      ]);
      const blocker = await hob.runtime.jobs.start("hob", { title: "占名额", instruction: "等待" });
      await waitFor(() => hob.faux.state.callCount >= 1);
      await hob.runtime.jobs.reply(original.id, "排队后接着做");
      expect(hob.runtime.store.job(original.id)).toMatchObject({ status: "queued" });
      expect(hob.runtime.store.job(original.id)?.summary).toBeUndefined();
      release();
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(blocker.id)?.status).toBe("done");
      expect(hob.runtime.store.job(original.id)).toMatchObject({ status: "done", summary: "接续完成" });
      expect(readFileSync(hob.runtime.store.workerFile(original.id), "utf8")).toContain("排队后接着做");
    } finally {
      release();
      hob.close();
    }
  });

  it("任务提问送到助手但这一轮没有接住：结束任务并过期提问", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("ask_user", { title: "要不要继续", options: [{ label: "继续" }, { label: "停止" }] }),
        text("我先看看。"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "检查资料", instruction: "检查资料" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "stuck");
      expect(hob.runtime.store.job(job.id)).toMatchObject({ statusReason: "提问没有得到答复：要不要继续" });
      expect(hob.runtime.store.approvals()[0]).toMatchObject({ jobId: job.id, status: "expired" });
    } finally { hob.close(); }
  });

  it("群里：提问到达时成员正说着话，那一轮结束不算没接住；收到提问的那一轮没接住才结束", async () => {
    const hob = makeHob();
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    try {
      const group = hob.runtime.groups.create({ name: "资料群", purpose: "整理资料", ownerId: "hob", members: ["hob"] });
      const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
      hob.faux.setResponses([
        async () => { await first; return text("先回这一句。"); },
        call("ask_user", { title: "要哪一版", options: [{ label: "新版" }, { label: "旧版" }] }),
        async () => { await second; return text("我先看看。"); },
      ]);
      await hob.runtime.groups.send(group.id, { text: "在吗" });
      await waitFor(() => hob.faux.state.callCount >= 1);
      const job = await hob.runtime.jobs.start("hob", { title: "整理资料", instruction: "整理资料", groupId: group.id });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting");
      releaseFirst();
      await waitFor(() => hob.faux.state.callCount >= 3);
      expect(hob.runtime.store.job(job.id)?.status).toBe("waiting");
      releaseSecond();
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "stuck");
      expect(hob.runtime.store.job(job.id)?.statusReason).toBe("提问没有得到答复：要哪一版");
    } finally {
      releaseFirst();
      releaseSecond();
      hob.close();
    }
  });

  it("任务提问送不到助手：直接结束为受阻并写清投递失败", async () => {
    const hob = makeHob();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue(false);
      hob.faux.setResponses([call("ask_user", { title: "需要哪份资料", options: [{ label: "甲" }, { label: "乙" }] })]);
      const job = await hob.runtime.jobs.start("hob", { title: "整理资料", instruction: "整理资料" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "stuck");
      expect(hob.runtime.store.job(job.id)?.statusReason).toBe("提问没有得到答复：需要哪份资料（没有送到助手）");
      expect(hob.runtime.store.approvals()[0]).toMatchObject({ jobId: job.id, status: "expired" });
    } finally { hob.close(); }
  });

  it("助手转问用户后，用户答卡但助手仍不接任务：下一轮结束任务", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("ask_user", { title: "要不要继续", options: [{ label: "继续" }, { label: "停止" }] }),
        call("ask_user", { title: "请用户决定", options: [{ label: "可以" }, { label: "不可以" }] }),
        text("知道了。"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "检查资料", instruction: "检查资料" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting" && hob.runtime.store.approvals().some((item) => item.source === "router" && item.status === "pending"));
      const userApproval = hob.runtime.store.approvals().find((item) => item.source === "router" && item.status === "pending")!;
      expect((await answerApproval(hob.runtime, userApproval.id, { key: "A" })).status).toBe(200);
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "stuck");
      expect(hob.runtime.store.job(job.id)?.statusReason).toBe("提问没有得到答复：要不要继续");
    } finally { hob.close(); }
  });
  it("ask_user 阻塞等答复，答完继续跑并 report", async () => {
    const hob = makeHob();
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const push = vi.spyOn(hob.runtime.push, "send");
      hob.faux.setResponses([
        call("ask_user", { title: "删掉旧报告吗？", options: [{ label: "删" }, { label: "别删" }] }),
        call("report", { outcome: "done", result: "删了 3 个旧报告" }),
        text("好"),
        text("删掉了。"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "清旧报告", instruction: "删掉旧报告" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting");
      const approval = hob.runtime.store.approvals()[0];
      expect(approval).toMatchObject({ source: "job", jobId: job.id, status: "pending" });
      expect(hob.runtime.router.items("hob").items.find((item) => item.kind === "question")).toBeUndefined();
      expect(hob.runtime.router.bootstrap().approvals).toEqual([]);
      expect(push).not.toHaveBeenCalled();
      expect(event).toHaveBeenCalledWith("hob", `任务「清旧报告」（${job.id}）在等你回复：删掉旧报告吗？选项：A 删、B 别删。`, expect.objectContaining({ job: { id: job.id, round: 0, kind: "question" } }));
      // 等用户答多久都不算「无响应」（以前 15 分钟后被看门狗标成受阻，审批卡跟着作废）
      hob.runtime.jobs.checkStalls(Date.now() + 24 * 3600_000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("waiting");

      const result = await answerApproval(hob.runtime, approval.id, { key: "A" });
      expect(result.status).toBe(200);
      await hob.runtime.jobs.waitIdle();
      const done = hob.runtime.store.job(job.id)!;
      expect(done.status).toBe("done");
      expect(done.summary).toBe("删了 3 个旧报告");
    } finally {
      hob.close();
    }
  });

  it("任务提问的标题和说明保留原有句末标点，缺标点才补句号", async () => {
    const hob = makeHob();
    let release = () => {};
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([async () => { await gate; return call("report", { outcome: "done", result: "完成" }); }, text("完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "测试", instruction: "测试" });
      await waitFor(() => hob.faux.state.callCount > 0);
      for (const end of ["。", "！", "？", ".", "!", "?", ""]) {
        const answer = hob.runtime.jobs.askQuestion(job.id, { title: `问题${end}`, detail: `说明${end}`, options: [{ key: "A", label: "好" }] });
        const expected = end || "。";
        expect(event).toHaveBeenLastCalledWith("hob", `任务「测试」（${job.id}）在等你回复：问题${expected}说明${expected}选项：A 好。`, expect.objectContaining({ job: { id: job.id, round: 0, kind: "question" } }));
        hob.runtime.jobs.resolveAsk(hob.runtime.store.approvals().find((item) => item.status === "pending")!, "好");
        await answer;
      }
    } finally { release(); hob.close(); }
  });

  it("ask_user 用自己写的一段话回答：工具结果说明没选给出的选项，任务接着跑", async () => {
    const hob = makeHob();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([
        call("ask_user", { title: "删掉旧报告吗？", options: [{ label: "删" }, { label: "别删" }] }),
        call("report", { outcome: "done", result: "只删了三个月前的旧报告" }),
        text("好"),
        text("只删了旧的。"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "清旧报告", instruction: "删掉旧报告" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting");
      const approval = hob.runtime.store.approvals()[0];

      const answer = "只删三个月前的，上个月的别动";
      expect((await answerApproval(hob.runtime, approval.id, { text: answer })).status).toBe(200);
      expect(hob.runtime.store.approval(approval.id)).toMatchObject({ status: "answered", answerText: answer });

      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
      // 模型看到的就是这句：没选给出的选项，而是用户自己回的
      const ask = hob.runtime.jobs.transcript(job.id).find((step) => step.name === "ask_user");
      expect(ask?.output).toContain(`用户没有选给出的选项，而是回复：${answer}`);
    } finally {
      hob.close();
    }
  });

  it("ask_user 等答复时用户在对话里回（reply）：当作答复，卡片结束，任务接着跑", async () => {
    const hob = makeHob();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([
        call("ask_user", { title: "删掉旧报告吗？", options: [{ label: "删" }, { label: "别删" }] }),
        call("report", { outcome: "done", result: "只删了旧的" }),
        text("好"),
        text("只删了旧的。"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "清旧报告", instruction: "删掉旧报告" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting");
      const approval = hob.runtime.store.approvals()[0];

      await hob.runtime.jobs.reply(job.id, "只删三个月前的");
      expect(hob.runtime.store.approval(approval.id)).toMatchObject({ status: "answered", answerText: "只删三个月前的" });
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
      const ask = hob.runtime.jobs.transcript(job.id).find((step) => step.name === "ask_user");
      expect(ask?.output).toContain("而是在对话里回复：只删三个月前的");
    } finally {
      hob.close();
    }
  });

  it("助手转达任务提问的答复：卡片结束而不冒充用户原话，任务继续", async () => {
    const hob = makeHob();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([
        call("ask_user", { title: "删掉旧报告吗？", options: [{ label: "删" }, { label: "别删" }] }),
        call("report", { outcome: "done", result: "只删了旧的" }),
        text("好"), text("只删了旧的。"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "清旧报告", instruction: "删掉旧报告" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting");
      const approval = hob.runtime.store.approvals()[0];
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "reply_job")!;
      await tool.execute("call", { jobId: job.id, text: "只删三个月前的" });
      expect(hob.runtime.store.approval(approval.id)).toMatchObject({ status: "expired" });
      expect(hob.runtime.store.approval(approval.id)?.answerText).toBeUndefined();
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
      expect(hob.runtime.jobs.transcript(job.id).find((step) => step.name === "ask_user")?.output).toContain("「Hob」回复：只删三个月前的");
    } finally { hob.close(); }
  });

  it("超过 maxJobs 的任务排队，调大以后立刻接着跑", async () => {
    const hob = makeHob({}, { settings: { work: { maxJobs: 1 } } });
    try {
      // 两个会话共用一套假模型，用工厂按“是不是 Worker”决定回什么，避免抢响应
      const factory = (context: any) => {
        const isWorker = JSON.stringify(context.messages[0]).includes("派出的后台任务");
        if (!isWorker) return text("收到。");
        const lastAssistant = [...context.messages].reverse().find((message: any) => message.role === "assistant");
        const reported = lastAssistant?.content?.some((block: any) => block.type === "toolCall" && block.name === "report");
        return reported ? text("好的。") : call("report", { outcome: "done", result: "好了" });
      };
      hob.faux.setResponses(Array.from({ length: 10 }, () => factory));
      const first = await hob.runtime.jobs.start("hob", { title: "一", instruction: "干活一" });
      const second = await hob.runtime.jobs.start("hob", { title: "二", instruction: "干活二" });
      expect(hob.runtime.store.job(second.id)?.status).toBe("queued");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(first.id)?.status).toBe("done");
      expect(hob.runtime.store.job(second.id)?.status).toBe("done");
    } finally {
      hob.close();
    }
  });

  it("改设置里的同时干活数立即生效：调大后排队的不等重启就启动", async () => {
    const hob = makeHob({}, { settings: { work: { maxJobs: 1 } } });
    try {
      hob.faux.setResponses(
        Array.from({ length: 10 }, () => (context: any) => {
          const isWorker = JSON.stringify(context.messages[0]).includes("派出的后台任务");
          return isWorker ? call("report", { outcome: "done", result: "好了" }) : text("收到。");
        }),
      );
      const first = await hob.runtime.jobs.start("hob", { title: "一", instruction: "干活一" });
      const second = await hob.runtime.jobs.start("hob", { title: "二", instruction: "干活二" });
      expect(hob.runtime.store.job(second.id)?.status).toBe("queued");

      const { revision } = hob.runtime.settings.get();
      hob.runtime.settings.patch(revision, { work: { maxJobs: 3 } });
      hob.runtime.jobs.pump();
      expect(hob.runtime.store.job(second.id)?.status).not.toBe("queued");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(first.id)?.status).toBe("done");
    } finally {
      hob.close();
    }
  });

  it("stop 停掉正在跑的任务", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([text("我在想。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "停我", instruction: "慢慢想" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "running");
      await hob.runtime.jobs.stop(job.id);
      expect(hob.runtime.store.job(job.id)?.status).toBe("stopped");
    } finally {
      hob.close();
    }
  });

  it("停止任务会杀掉正在跑的命令，状态停在 stopped", async () => {
    const hob = makeHob();
    try {
      const pidFile = join(hob.home, "bash.pid");
      hob.faux.setResponses([
        call("bash", { command: `echo $$ > ${pidFile}; sleep 60; echo 跑完了` }),
        call("report", { outcome: "done", result: "命令跑完了" }),
        text("好"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "长命令", instruction: "跑一个很长的命令" });
      await waitFor(() => existsSync(pidFile) && hob.runtime.store.job(job.id)?.status === "running");
      const pid = Number(readFileSync(pidFile, "utf8").trim());

      const startedAt = Date.now();
      await hob.runtime.jobs.stop(job.id);
      // 命令被终止，stop 不会等它自己跑完
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("stopped");
      expect(isRunning(pid)).toBe(false);

      // 停下来之后不会被后续的 report 改成完成
      await new Promise((resolve) => setTimeout(resolve, 500));
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.store.job(job.id)?.status).toBe("stopped");

      // Router 收到“已停止”事件
      const transcript = readFileSync(join(hob.home, "assistants", "hob", "router.jsonl"), "utf8");
      expect(transcript).toContain(`任务「长命令」（${job.id}）已停止`);
    } finally {
      hob.close();
    }
  });

  it("重启恢复：running 的任务标失败，pending 的任务类审批标过期", () => {
    const hob = makeHob();
    try {
      const job = {
        id: "t-abcd",
        assistantId: "hob",
        title: "断电前",
        instruction: "干一半",
        status: "running" as const,
        createdAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      };
      hob.runtime.store.saveJob(job);
      hob.runtime.store.saveApproval({
        id: "q-old",
        assistantId: "hob",
        title: "还在问",
        options: [
          { key: "A", label: "好" },
          { key: "B", label: "不好" },
        ],
        status: "pending",
        source: "job",
        jobId: "t-abcd",
        createdAt: new Date().toISOString(),
      });
      new JobManager(hob.runtime).recover();
      expect(hob.runtime.store.job("t-abcd")).toMatchObject({
        status: "failed",
        statusReason: "Hob 重启，任务中断",
      });
      expect(hob.runtime.store.approval("q-old")?.status).toBe("expired");
    } finally {
      hob.close();
    }
  });

  it("本机任务的工作目录是 HOB_HOME/jobs/<id>/work，显式给了 cwd 才用它", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "写好了" }), text("好")]);
      hob.faux.appendResponses([text("好了")]);
      const job = await hob.runtime.jobs.start("hob", { title: "写简报", instruction: "写一份简报" });
      expect(job.cwd).toBe(join(hob.home, "assistants", "hob", "jobs", job.id, "work"));
      expect(existsSync(job.cwd!)).toBe(true);
      await hob.runtime.jobs.waitIdle();

      const explicit = await hob.runtime.jobs.start("hob", {
        title: "在别处干活",
        instruction: "在给定目录干活",
        cwd: tmpdir(),
      });
      expect(explicit.cwd).toBe(tmpdir());
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });
});

describe("任务做完就提醒沉淀，写明用了哪些技能", () => {
  const hint = "这个任务没用到技能。可以用 review_job 让它回顾一遍，把能复用的做法沉淀下来，有没有值得沉淀的由它判断。";
  const usedHint = (titles: string[]) => `这个任务用了技能${titles.map((title) => `「${title}」`).join("")}。可以用 review_job 让它回顾一遍，有没有值得沉淀的由它判断：技能里没写到的做法、写错的地方，它会补进对应的那份；是另一类事的做法，它会新建一份。`;
  const makeJob = (overrides: Partial<Job> = {}): Job => ({
    id: "t-hint", assistantId: "hob", assistantName: "Hob", title: "整理报告", instruction: "整理报告", status: "done",
    createdAt: new Date().toISOString(), stats: { reads: 2, commands: 1, edits: 0 }, activity: [], summary: "报告整理好了",
    ...overrides,
  });

  it("已完成、没读到技能：提醒紧跟在「过程」那行后面", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const lines = assistantJobResultEvent(hob.home, makeJob(), { toolCount: 3 }).split("\n");
      expect(lines.slice(0, 4)).toEqual(["「Hob」的任务「整理报告」（t-hint）已完成。", "过程：工具操作 3 次，没用技能。", hint, "结果："]);
    } finally { hob.close(); }
  });

  it("读到了技能也提醒，写出技能标题；受阻、失败、已停止不提醒", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", { name: "report-guide", title: "报告整理", description: "整理报告", content: "步骤" });
      const event = (job: Job) => assistantJobResultEvent(hob.home, job);
      // 用到了技能也一样提醒：用到了不代表没东西可沉淀
      expect(event(makeJob({ skillsUsed: ["report-guide"] }))).toContain(usedHint(["报告整理"]));
      for (const status of ["stuck", "failed", "stopped"] as const) expect(event(makeJob({ status }))).not.toContain("这个任务");
    } finally { hob.close(); }
  });

  it("读了多份技能：标题按读过的顺序写全；只读了通用技能也算用过", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", { name: "report-guide", title: "报告整理", description: "整理报告", content: "步骤" });
      saveSkill(join(hob.home, "skills"), { name: "table-summary", title: "表格汇总", description: "汇总表格", content: "步骤" });
      const event = (job: Job) => assistantJobResultEvent(hob.home, job, { skills: visibleSkills(hob.runtime, "hob") });
      expect(event(makeJob({ skillsUsed: ["report-guide", "table-summary"] }))).toContain(usedHint(["报告整理", "表格汇总"]));
      expect(event(makeJob({ skillsUsed: ["table-summary"] }))).toContain(usedHint(["表格汇总"]));
      expect(event(makeJob())).toContain(hint);
    } finally { hob.close(); }
  });

  it("有从这个任务沉淀出来的技能：行末点名最近更新的那份", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const job = makeJob();
      hob.runtime.store.saveJob(job);
      saveAssistantSkill(hob.home, "hob", { name: "report-guide", title: "报告整理", description: "整理报告", content: "步骤" }, job.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      saveAssistantSkill(hob.home, "hob", { name: "report-brief", title: "报告简报", description: "整理简报", content: "步骤" }, job.id);
      saveAssistantSkill(hob.home, "hob", { name: "other-skill", title: "别的事", description: "别的事", content: "步骤" }, "t-other");
      const lines = assistantJobResultEvent(hob.home, job).split("\n");
      expect(lines[2]).toBe(hint);
    } finally { hob.close(); }
  });

  it("定时任务不绑定技能，先把任务本身交给助手", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "每日简报", instruction: "整理简报", schedules: ["0 9 * * *"], skill: "daily-brief" } as never);
      saveAssistantSkill(hob.home, "hob", { name: "daily-brief", title: "每日简报", description: "整理简报", content: "步骤" });
      expect(routine).not.toHaveProperty("skill");
      await hob.runtime.routines.runNow(routine.id);
      expect(event).toHaveBeenCalledWith("hob", expect.stringContaining("整理简报"), expect.anything());
      expect(event.mock.calls.at(-1)?.[1]).not.toContain("按技能");
    } finally { hob.close(); }
  });
});
