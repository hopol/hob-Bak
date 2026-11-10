import { describe, expect, it, vi } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { listAssistantSkills, saveAssistantSkill, setAssistantSkillEnabled } from "../src/assistant-skills.ts";
import { createApp } from "../src/http.ts";
import { call, makeHob, text } from "./helpers.ts";

const skill = { name: "alpha-skill", title: "甲技能", description: "甲任务", content: "步骤" };
const other = { ...skill, name: "beta-skill", title: "乙技能" };
const job = { id: "t-sediment", assistantId: "hob", title: "任务", instruction: "检查", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off" as const };

describe("第三版技能流程", () => {
  it("校验修补技能、隐藏 name、推送状态和步骤", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", skill);
      setAssistantSkillEnabled(hob.home, "hob", skill.name, false);
      hob.runtime.store.saveJob(job);
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "save_job_as_skill")!;
      expect((await tool.execute("x", { jobId: job.id, into: skill.name }, undefined, undefined, {} as never)).isError).toBe(true);
      setAssistantSkillEnabled(hob.home, "hob", skill.name, true);
      saveAssistantSkill(hob.home, "hob", other);
      const events: any[] = [];
      hob.runtime.bus.subscribe((event) => events.push(event));
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const open = vi.spyOn(hob.runtime.pi, "open");
      hob.faux.setResponses([call("save_skill", { title: skill.title, description: skill.description, content: "新步骤" }), text("完成")]);
      await tool.execute("x", { jobId: job.id, into: skill.name, note: "补充反馈，合并 beta-skill" }, undefined, undefined, {} as never);
      expect(hob.runtime.store.job(job.id)?.sediment?.status).toBe("running");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)?.sediment).toMatchObject({ status: "saved", name: skill.name, version: 2, updated: true });
      expect(events.some((event) => event.type === "job_step" && event.step.name === "save_skill")).toBe(true);
      expect(notify).toHaveBeenCalledWith("hob", `任务「任务」（${job.id}）沉淀完了：已更新技能「甲技能」（${skill.name}）· 第 2 版。`);
      expect((open.mock.calls[0][0].customTools!.find((item) => item.name === "save_skill")!.parameters as any).properties.name).toBeUndefined();
      expect(open.mock.calls[0][0].skills?.filter((item) => item.sourceInfo.source === "assistant").map((item) => item.name).sort()).toEqual([skill.name, other.name].sort());
    } finally { hob.close(); }
  });
  it("新建技能的沉淀做完事件带上目录名，对话里的提示行不带", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(job);
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("save_skill", { name: "new-guide", title: "新报告整理", description: "整理报告", content: "步骤" }), text("完成")]);
      hob.runtime.jobs.startSediment(job.id);
      await hob.runtime.jobs.waitIdle();
      expect(notify).toHaveBeenCalledWith("hob", `任务「任务」（${job.id}）沉淀完了：已沉淀技能「新报告整理」（new-guide）。`);
      const note = hob.runtime.router.items("hob").items.find((item) => item.kind === "note" && item.text.startsWith("已沉淀技能"));
      expect(note?.kind === "note" ? note.text : "").toBe("已沉淀技能「新报告整理」");
    } finally { hob.close(); }
  });
  it("新建技能重名不得覆盖", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", skill);
      hob.runtime.store.saveJob(job);
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("save_skill", skill), text("没有需要沉淀的")]);
      hob.runtime.jobs.startSediment(job.id);
      await hob.runtime.jobs.waitIdle();
      expect(listAssistantSkills(hob.home, "hob")[0].version).toBe(1);
      expect(hob.runtime.jobs.transcript(job.id).find((step) => step.name === "save_skill")?.output).toContain(`「${skill.name}」已经有了，新技能换个名字。`);
    } finally { hob.close(); }
  });
  it("删除技能检查任务及定时，并可迁移绑定", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", skill);
      saveAssistantSkill(hob.home, "hob", other);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "例行", instruction: "检查", schedules: ["0 9 * * *"], skill: skill.name });
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "delete_skill")!;
      const run = (replaced_by?: string) => tool.execute("x", { name: skill.name, replaced_by }, undefined, undefined, {} as never);
      expect((await run()).content[0].text).toContain("被定时任务「例行」用着");
      expect((await run(skill.name)).isError).toBe(true);
      hob.runtime.store.saveJob({ ...job, status: "queued", skills: [skill.name] });
      expect((await run(other.name)).content[0].text).toContain(`正在被任务 ${job.id} 用`);
      hob.runtime.store.saveJob(job);
      expect((await run(other.name)).content[0].text).toBe("技能「甲技能」已并入「乙技能」，原技能移到了归档。");
      expect(hob.runtime.store.routine(routine.id)?.skill).toBe(other.name);
      expect(listAssistantSkills(hob.home, "hob").map((item) => item.name)).toEqual([other.name]);
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      expect((await app.request(`/api/assistants/hob/skills/${other.name}`, { method: "DELETE", headers: { cookie } })).status).toBe(400);
    } finally { hob.close(); }
  });
});
