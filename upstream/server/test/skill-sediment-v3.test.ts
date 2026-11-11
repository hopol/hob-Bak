import { describe, expect, it } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { listAssistantSkills, saveAssistantSkill } from "../src/assistant-skills.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

const skill = { name: "alpha-skill", title: "甲技能", description: "甲任务", content: "步骤" };
const other = { ...skill, name: "beta-skill", title: "乙技能" };

describe("技能删除", () => {
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
      hob.runtime.store.saveJob({ id: "t-running", assistantId: "hob", title: "任务", instruction: "检查", status: "queued", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], skills: [skill.name] });
      expect((await run(other.name)).content[0].text).toContain("正在被任务 t-running 用");
      hob.runtime.store.saveJob({ id: "t-running", assistantId: "hob", title: "任务", instruction: "检查", status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
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
