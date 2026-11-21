import { describe, expect, it, vi } from "vitest";
import { makeHob, call, text, waitFor } from "./helpers.ts";

describe("定时任务到点先交给单聊助手", () => {
  it("到点给助手事件，runs 记 handed，提示行带 routineId", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "每日检查", instruction: "检查固定目录", instructionBy: "user", schedules: ["0 9 * * *"] });
      const result = await hob.runtime.routines.runNow(routine.id);
      expect(result.outcome).toBe("handed");
      expect(event).toHaveBeenCalledWith("hob", expect.stringContaining("用户填写的任务内容：检查固定目录"), expect.objectContaining({ routineTrigger: { id: routine.id, name: "每日检查" } }));
      expect(hob.runtime.store.routine(routine.id)?.runs[0]).toMatchObject({ status: "handed" });
      const note = hob.runtime.router.items("hob").items.find((item) => item.kind === "note" && item.icon === "routine");
      expect(note).toMatchObject({ text: "定时任务「每日检查」已到执行时间", routineId: routine.id });
    } finally { hob.close(); }
  });

  it("助手开出的任务带 routineId，任务完成后运行记录改为 done", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "整理收件箱", instruction: "整理新增文件", instructionBy: "hob", schedules: ["0 9 * * *"] });
      hob.faux.setResponses([call("start_job", { title: "整理收件箱", note: "背景：收件箱在 /data/inbox；完成标准：整理后汇报文件名。" }), text("已安排。"), call("report", { outcome: "done", result: "已整理" }), text("已整理")]);
      await hob.runtime.routines.runNow(routine.id);
      await waitFor(() => hob.runtime.store.jobs().some((job) => job.routineId === routine.id));
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      const job = hob.runtime.store.jobs().find((item) => item.routineId === routine.id)!;
      expect(job.instruction).toContain("背景：收件箱在 /data/inbox");
      expect(hob.runtime.store.routine(routine.id)?.runs[0]).toMatchObject({ jobId: job.id, status: "done" });
    } finally { hob.close(); }
  });

  it("once 在交给助手时停下，检查脚本没变化时不交", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const once = hob.runtime.routines.create({ assistantId: "hob", name: "一次提醒", instruction: "提醒用户", schedules: ["0 9 * * *"], once: true });
      await hob.runtime.routines.runNow(once.id);
      expect(hob.runtime.store.routine(once.id)).toMatchObject({ active: true });
      const quiet = hob.runtime.routines.create({ assistantId: "hob", name: "无变化", instruction: "处理变化", schedules: ["0 9 * * *"], check: { script: "true", then: "job" } });
      await hob.runtime.routines.runNow(quiet.id);
      expect(hob.runtime.store.routine(quiet.id)).toMatchObject({ active: true });
      expect(hob.runtime.store.routine(quiet.id)?.runs).toEqual([]);
    } finally { hob.close(); }
  });
});
