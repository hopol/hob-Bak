import { describe, expect, it, vi } from "vitest";
import { makeHob } from "./helpers.ts";

describe("定时任务不再保存用户原话或技能绑定", () => {
  it("create 和 update 都忽略旧字段", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "巡检",
        instruction: "检查目录",
        schedules: ["0 9 * * *"],
        userWords: [{ text: "旧原话", at: new Date().toISOString() }],
        skill: "old-skill",
      } as never);
      expect(routine).not.toHaveProperty("userWords");
      expect(routine).not.toHaveProperty("skill");
      const updated = hob.runtime.routines.update(routine.id, { userWords: [{ text: "另一句", at: new Date().toISOString() }], skill: "new-skill" } as never);
      expect(updated).not.toHaveProperty("userWords");
      expect(updated).not.toHaveProperty("skill");
      expect(hob.runtime.store.routine(routine.id)).not.toHaveProperty("userWords");
      expect(hob.runtime.store.routine(routine.id)).not.toHaveProperty("skill");
    } finally { hob.close(); }
  });

  it("instructionBy 只说明谁写了任务内容", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      const user = hob.runtime.routines.create({ assistantId: "hob", name: "日报", instruction: "读取日报文件", instructionBy: "user", schedules: ["0 9 * * *"] });
      await hob.runtime.routines.runNow(user.id);
      expect(event.mock.calls.at(-1)?.[1]).toContain("用户填写的任务内容：读取日报文件");
      const assistant = hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "检查服务", instructionBy: "hob", schedules: ["0 10 * * *"] });
      await hob.runtime.routines.runNow(assistant.id);
      expect(event.mock.calls.at(-1)?.[1]).toContain("Hob 填写的任务内容：检查服务");
      expect(event.mock.calls.at(-1)?.[1]).not.toContain("用户原话");
    } finally { hob.close(); }
  });
});
