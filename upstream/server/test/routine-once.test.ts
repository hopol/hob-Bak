import { afterEach, describe, expect, it, vi } from "vitest";
import type { Item } from "../../shared/types.ts";
import { cronToChinese, timePointText } from "../src/cron-text.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text, type TestHob } from "./helpers.ts";

/** 只假 Date：定时器、子进程照常走真的，时间点靠 fake system time 走过去。 */
function setNow(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

afterEach(() => vi.useRealTimers());

function routineNotes(hob: TestHob): string[] {
  return hob.runtime.router
    .items("hob")
    .items.filter((item): item is Extract<Item, { kind: "note" }> => item.kind === "note" && item.icon === "routine")
    .map((item) => item.text);
}

function tool(hob: TestHob, name: string) {
  const found = buildRouterTools(hob.runtime, "hob").find((item) => item.name === name)!;
  return (params: Record<string, unknown>) => found.execute("id", params, undefined, undefined, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;
}

describe("定时任务：具体时间点和一次就停", () => {
  it("具体时间点到点跑一次，跑完就停，原因 finished", async () => {
    setNow("2026-11-08T00:30:00Z"); // 上海 08:30
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "提醒了" }), text("好")]);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "交房租", instruction: "提醒我交房租", schedules: ["2026-11-08T09:00"] });
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(1);

      setNow("2026-11-08T01:00:05Z"); // 上海 09:00:05，到点了
      await hob.runtime.routines.fire(routine.id);

      const saved = hob.runtime.store.routine(routine.id)!;
      expect(saved.active).toBe(false);
      expect(saved.stopReason).toBe("finished");
      expect(saved.stoppedAt).toBeTruthy();
      expect(hob.runtime.store.jobs()).toHaveLength(1);
      expect(hob.runtime.store.jobs()[0]).toMatchObject({ routineId: routine.id, instruction: "提醒我交房租" });
      expect(routineNotes(hob)).toContain("定时任务「交房租」已跑完最后一次，停了");
      // 停了就不再排
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(0);
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("过去的时间点和格式不对的写法都报错", () => {
    setNow("2026-11-08T01:00:00Z"); // 上海 09:00
    const hob = makeHob();
    try {
      const base = { assistantId: "hob", name: "交房租", instruction: "提醒我交房租" };
      expect(() => hob.runtime.routines.create({ ...base, schedules: ["2026-11-08T08:59"] })).toThrow("这个时间已经过了：2026-11-08T08:59");
      expect(() => hob.runtime.routines.create({ ...base, schedules: ["不是 cron"] })).toThrow(/cron 表达式（如「0 9 \* \* \*」），也可以是具体时间（如 2026-11-08T09:00）/);
      expect(() => hob.runtime.routines.create({ ...base, schedules: [] })).toThrow("定时任务至少需要一个执行时间。");
      expect(hob.runtime.store.routines()).toHaveLength(0);

      const routine = hob.runtime.routines.create({ ...base, schedules: ["0 9 * * *"] });
      expect(() => hob.runtime.routines.update(routine.id, { schedules: ["2026-11-08T08:00"] })).toThrow(/这个时间已经过了/);
      expect(hob.runtime.store.routine(routine.id)?.schedules).toEqual(["0 9 * * *"]);
    } finally {
      hob.close();
    }
  });

  it("once 没有检查脚本：跑一次就停，原因 hit", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "好了" }), text("好")]);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "交房租", instruction: "提醒我交房租", schedules: ["0 9 * * *"], once: true });

      await hob.runtime.routines.fire(routine.id);

      const saved = hob.runtime.store.routine(routine.id)!;
      expect(saved).toMatchObject({ active: false, stopReason: "hit" });
      expect(hob.runtime.store.jobs()).toHaveLength(1);
      expect(routineNotes(hob)).toContain("定时任务「交房租」已触发，按设置停了");
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("once 加检查：没变化、检查失败都不停，第一次有输出（notify）才停", async () => {
    const hob = makeHob();
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "盯新文件",
        instruction: "看看新文件",
        schedules: ["*/10 * * * *"],
        once: true,
        check: { script: "true", then: "notify" },
      });

      await hob.runtime.routines.fire(routine.id);
      expect(hob.runtime.store.routine(routine.id)).toMatchObject({ active: true });
      expect(hob.runtime.store.routine(routine.id)?.stopReason).toBeUndefined();
      expect(hob.runtime.store.routine(routine.id)?.checks).toMatchObject({ total: 1, hits: 0 });

      hob.runtime.routines.update(routine.id, { check: { script: "echo 坏了 >&2; exit 3", then: "notify" } });
      await hob.runtime.routines.fire(routine.id);
      expect(hob.runtime.store.routine(routine.id)).toMatchObject({ active: true });
      expect(hob.runtime.store.routine(routine.id)?.checks).toMatchObject({ total: 2, hits: 0 });

      hob.runtime.routines.update(routine.id, { check: { script: "echo 新文件到了", then: "notify" } });
      await hob.runtime.routines.fire(routine.id);
      const saved = hob.runtime.store.routine(routine.id)!;
      expect(saved).toMatchObject({ active: false, stopReason: "hit" });
      expect(saved.checks).toMatchObject({ total: 3, hits: 1 });
      expect(routineNotes(hob)).toContain("定时任务「盯新文件」已触发，按设置停了");
    } finally {
      hob.close();
    }
  });

  it("once 加检查、then 是 job：第一次有输出就停，任务照着开", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "看过了" }), text("好")]);
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "盯新文件",
        instruction: "看看新文件",
        schedules: ["*/10 * * * *"],
        once: true,
        check: { script: "echo 新文件到了", then: "job" },
      });

      await hob.runtime.routines.fire(routine.id);

      expect(hob.runtime.store.routine(routine.id)).toMatchObject({ active: false, stopReason: "hit" });
      expect(hob.runtime.store.jobs()).toHaveLength(1);
      expect(hob.runtime.store.jobs()[0].instruction).toContain("这次检查有新内容");
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("立即运行不算触发，不会把定时任务停掉", async () => {
    setNow("2026-11-08T00:30:00Z");
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "试跑好了" }), text("好")]);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "交房租", instruction: "提醒我交房租", schedules: ["2026-11-08T09:00"], once: true });

      expect((await hob.runtime.routines.runNow(routine.id)).outcome).toBe("job");

      expect(hob.runtime.store.routine(routine.id)).toMatchObject({ active: true });
      expect(hob.runtime.store.routine(routine.id)?.stopReason).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(1);
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("重新打开：停下的记录清掉，又会按时跑", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "好了" }), text("好"), call("report", { outcome: "done", result: "又好了" }), text("好")]);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "交房租", instruction: "提醒我交房租", schedules: ["0 9 * * *"], once: true });
      await hob.runtime.routines.fire(routine.id);
      expect(hob.runtime.store.routine(routine.id)?.active).toBe(false);

      const reopened = hob.runtime.routines.update(routine.id, { active: true });
      expect(reopened.active).toBe(true);
      expect(reopened.stoppedAt).toBeUndefined();
      expect(reopened.stopReason).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(1);

      await hob.runtime.routines.fire(routine.id);
      expect(hob.runtime.store.routine(routine.id)).toMatchObject({ active: false, stopReason: "hit" });
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("没开 once 的周期任务：跑多少次都还在", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "好了" }), text("好"), call("report", { outcome: "done", result: "又好了" }), text("好")]);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "每日简报", instruction: "整理简报", schedules: ["0 9 * * *"] });

      await hob.runtime.routines.fire(routine.id);
      await hob.runtime.routines.fire(routine.id);

      const saved = hob.runtime.store.routine(routine.id)!;
      expect(saved.active).toBe(true);
      expect(saved.stoppedAt).toBeUndefined();
      expect(saved.stopReason).toBeUndefined();
      expect(hob.runtime.store.jobs()).toHaveLength(2);
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("时间点和 cron 混在一起：cron 还有下一次就不停", async () => {
    setNow("2026-11-08T00:30:00Z");
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "好了" }), text("好")]);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "交房租", instruction: "提醒我交房租", schedules: ["2026-11-08T09:00", "0 21 * * *"] });

      setNow("2026-11-08T01:00:05Z");
      await hob.runtime.routines.fire(routine.id);

      expect(hob.runtime.store.routine(routine.id)).toMatchObject({ active: true });
      expect(hob.runtime.store.routine(routine.id)?.stopReason).toBeUndefined();
      // 只剩 21:00 那一个
      expect(hob.runtime.routines.nextRuns(routine.id).filter(Boolean)).toHaveLength(1);
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("工具：once 和具体时间传进去，返回里写清只跑一次、触发一次就停", async () => {
    setNow("2026-11-08T00:30:00Z");
    const hob = makeHob();
    try {
      const create = tool(hob, "create_routine");
      const created = await create({ name: "交房租", instruction: "提醒我交房租", schedules: ["2026-11-08T09:00"], once: true });
      expect(created.isError).toBeFalsy();
      expect(created.content[0].text).toContain("定时任务「交房租」已创建，11月8日 09:00跑一次；触发一次就停。");
      const routine = hob.runtime.store.routines()[0];
      expect(routine).toMatchObject({ schedules: ["2026-11-08T09:00"], once: true });

      const update = tool(hob, "update_routine");
      const updated = await update({ routineId: routine.id, active: true, once: false });
      expect(updated.content[0].text).toContain("已修改，11月8日 09:00跑一次。");
      expect(hob.runtime.store.routine(routine.id)?.once).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("工具说明和定稿一致：schedules 收两种写法，once 说明做成一次就停", () => {
    const hob = makeHob();
    try {
      const tools = buildRouterTools(hob.runtime, "hob");
      const expected = "一个或多个；可以是 cron 表达式，也可以是具体时间（如 2026-11-08T09:00），到点只跑一次。";
      for (const name of ["create_routine", "update_routine"]) {
        const found = tools.find((item) => item.name === name)!;
        expect(found.parameters.properties.schedules.description, name).toBe(expected);
        expect(found.parameters.properties.once.description, name).toContain("为 true 时做成一次就停");
      }
      expect(tools.find((item) => item.name === "create_routine")!.description).toBe(
        "新增一个定时任务。执行时间用 cron 表达式，如「0 9 * * *」每天 9 点；只跑一次就填具体时间；多个执行时间就传多个。",
      );
    } finally {
      hob.close();
    }
  });

  it("服务端显示：具体时间点说成「11月8日 09:00（一次）」，跨年的带年份", () => {
    const year = new Date().getFullYear();
    expect(timePointText(`${year}-11-08T09:00`)).toBe("11月8日 09:00");
    expect(timePointText(`${year + 1}-01-08T09:30`)).toBe(`${year + 1}年1月8日 09:30`);
    expect(cronToChinese(`${year}-11-08T09:00`)).toBe("11月8日 09:00（一次）");
    expect(cronToChinese(`${year}-11-08T09:00:30`)).toBe("11月8日 09:00（一次）");
    expect(cronToChinese("0 9 * * *")).toBe("每天 09:00");
  });
});
