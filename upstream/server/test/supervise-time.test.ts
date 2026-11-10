import { describe, expect, it, vi } from "vitest";
import { jobResultEvent } from "../src/jobs.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

describe("任务耗时督办", () => {
  it("start_job 校验参数并返回预计用时", async () => {
    const hob = makeHob();
    try {
      const start = vi.spyOn(hob.runtime.jobs, "start").mockImplementation(async (_id, input) => ({ id: "t-1", assistantId: "hob", title: input.title, instruction: "", status: "queued", createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [], expect: input.expectMinutes === undefined ? { minutes: 10, source: "default" } : { minutes: input.expectMinutes, source: "assistant" } }));
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "start_job")!;
      const run = (value?: unknown) => tool.execute("id", { title: "测试", ...(value === undefined ? {} : { expect_minutes: value }) }, undefined, undefined, {} as never);
      for (const value of [0, 10081, 1.5, -1, "5"]) expect((await run(value)).content[0].text).toBe("expect_minutes 要在 1 到 10080 之间");
      expect(start).not.toHaveBeenCalled();
      expect((await run(5)).content[0].text).toBe("任务「测试」（t-1）已开始，预计 5 分钟。");
      expect(start.mock.calls[0][1].expectMinutes).toBe(5);
      expect((await run()).content[0].text).toBe("任务「测试」（t-1）已开始，预计 10 分钟（默认）。");
    } finally { hob.close(); }
  });

  it("定时用最近五次完成的中位数，续做回到默认", async () => {
    const hob = makeHob({}, { settings: { work: { maxJobs: 1 } } });
    try {
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "做", schedules: ["0 9 * * *"] });
      vi.spyOn(hob.runtime.jobs, "pump").mockImplementation(() => {});
      const empty = (await hob.runtime.routines.runNow(routine.id)).job!;
      expect(empty.expect).toEqual({ minutes: 10, source: "default" });
      hob.runtime.store.saveRoutine({ ...routine, runs: [
        { jobId: "a", at: "", status: "done", durationMs: 61_000 }, { jobId: "b", at: "", status: "failed", durationMs: 999_000 },
        { jobId: "c", at: "", status: "done", durationMs: 240_000 }, { jobId: "d", at: "", status: "done", durationMs: 120_000 },
        { jobId: "e", at: "", status: "done", durationMs: 180_000 }, { jobId: "f", at: "", status: "done", durationMs: 300_000 },
        { jobId: "g", at: "", status: "done", durationMs: 1 },
      ] });
      const job = (await hob.runtime.routines.runNow(routine.id)).job!;
      expect(job.expect).toEqual({ minutes: 3, source: "routine", runs: 5 });
      hob.runtime.store.saveJob({ ...job, status: "done" });
      await hob.runtime.jobs.reply(job.id, "继续");
      expect(hob.runtime.store.job(job.id)?.expect).toEqual({ minutes: 10, source: "default" });
    } finally { hob.close(); }
  });

  it.each(["assistant", "default", "routine"] as const)("%s 来源按倍数提醒并排除等待时间", async (source) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const hob = makeHob({}, { settings: { work: { jobStallMinutes: 1000 } } });
    let release = () => {};
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(undefined);
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([async () => { await gate; return call("report", { outcome: "done", result: "完成" }); }, text("好")]);
      const routine = source === "routine" ? hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "做", schedules: ["0 9 * * *"] }) : undefined;
      if (routine) hob.runtime.store.saveRoutine({ ...routine, runs: [{ jobId: "old", at: "", status: "done", durationMs: 60_000 }] });
      const job = await hob.runtime.jobs.start("hob", { title: "测试", instruction: "做", ...(routine ? { routineId: routine.id } : {}), ...(source === "assistant" ? { expectMinutes: 1 } : {}) });
      await waitFor(() => hob.faux.state.callCount >= 1);
      const start = Date.now();
      const minute = source === "default" ? 10 : 1;
      const first = source === "routine" ? 1.5 : 1;
      const check = (ms: number) => { vi.setSystemTime(start + ms); hob.runtime.jobs.checkStalls(); };
      check(minute * first * 60_000 - 1);
      expect(event).not.toHaveBeenCalled();
      check(minute * first * 60_000);
      const expectedSource = source === "assistant" ? "派活时估的" : source === "routine" ? "这个定时任务以前 1 次的中位数" : "默认 10 分钟";
      expect(event.mock.calls[0][0]).toBe("hob");
      expect(event.mock.calls[0][1]).toContain(`预计的 ${minute} 分钟（${expectedSource}）。\n最近的过程（新的在前）：`);
      hob.runtime.jobs.checkStalls();
      expect(event).toHaveBeenCalledTimes(1);
      check(minute * first * 2 * 60_000);
      expect(event).toHaveBeenCalledTimes(2);
      if (source !== "routine") { check(minute * first * 4 * 60_000); expect(event).toHaveBeenCalledTimes(3); }
    } finally { release(); hob.close(); vi.useRealTimers(); }
  });

  it("等待回答暂停计时", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const hob = makeHob();
    let release = () => {};
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(undefined);
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([async () => { await gate; return call("report", { outcome: "done", result: "完成" }); }, text("好")]);
      const job = await hob.runtime.jobs.start("hob", { title: "测试", instruction: "做", expectMinutes: 1 });
      await waitFor(() => hob.faux.state.callCount >= 1);
      const start = Date.now();
      vi.setSystemTime(start + 30_000);
      const answer = hob.runtime.jobs.askQuestion(job.id, { title: "继续吗", options: [{ key: "A", label: "继续" }] });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting");
      event.mockClear();
      vi.setSystemTime(start + 630_000);
      hob.runtime.jobs.checkStalls();
      expect(event).not.toHaveBeenCalled();
      hob.runtime.jobs.resolveAsk(hob.runtime.store.approvals()[0], "继续");
      await answer;
      vi.setSystemTime(start + 659_999); hob.runtime.jobs.checkStalls();
      expect(event).not.toHaveBeenCalled();
      vi.setSystemTime(start + 660_000); hob.runtime.jobs.checkStalls();
      expect(event).toHaveBeenCalledTimes(1);
    } finally { release(); hob.close(); vi.useRealTimers(); }
  });

  it("结果事件沿用统一时长格式，旧任务不变", () => {
    const job = { id: "t-1", assistantId: "hob", title: "测试", instruction: "", status: "done" as const, createdAt: "", durationMs: 900_000, stats: { reads: 0, commands: 0, edits: 0 }, activity: [], expect: { minutes: 5, source: "assistant" as const } };
    expect(jobResultEvent(job).split("\n")[0]).toBe("任务「测试」（t-1）已完成，用时 15 分钟，预计 5 分钟。");
    expect(jobResultEvent({ ...job, status: "failed", durationMs: 3_660_000 }).split("\n")[0]).toContain("失败，用时 1 小时 1 分钟");
    expect(jobResultEvent({ ...job, durationMs: 12_000 }).split("\n")[0]).toContain("用时 12 秒");
    expect(jobResultEvent({ ...job, expect: undefined }).split("\n")[0]).toBe("任务「测试」（t-1）已完成，用时 15 分钟。");
  });
});
