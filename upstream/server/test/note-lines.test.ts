import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "../../shared/types.ts";
import { describe, expect, it } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { groupSkillsDir, saveAssistantSkill, saveSkill } from "../src/assistant-skills.ts";
import { call, makeHob, text } from "./helpers.ts";

const NEW_SKILL = `---\nname: new-skill\ndescription: 新的一类事\nmetadata:\n  title: 新技能\n---\n\n步骤\n`;

/** 提示行说的是谁的技能或定时：自己单聊里操作时不说，别处的一定要写清。 */
function tool(hob: ReturnType<typeof makeHob>, name: string, gid?: string) {
  const found = buildRouterTools(hob.runtime, "hob", gid).find((item) => item.name === name);
  if (!found) throw new Error(`没有这个工具：${name}`);
  return found;
}

const notes = (hob: ReturnType<typeof makeHob>, gid?: string) =>
  (gid ? hob.runtime.store.groupItems(gid) : hob.runtime.router.items("hob").items).filter((item) => item.kind === "note") as { text: string; icon: string }[];

/** Hob 和另一个助手「运维」。 */
function setup() {
  const hob = makeHob({}, { memory: "off" });
  const primary = hob.runtime.store.assistant("hob")!;
  hob.runtime.store.saveAssistant({ ...primary, id: "ops", name: "运维", primary: false });
  return hob;
}

const skill = { name: "alpha-skill", title: "甲技能", description: "甲任务", content: "步骤" };

describe("提示行写明对象", () => {
  it("主助手改别的助手的定时：写清是哪个助手的", async () => {
    const hob = setup();
    try {
      const create = await tool(hob, "create_routine").execute("c", { name: "巡检", instruction: "看一眼", schedules: ["0 9 * * *"], assistantId: "ops" });
      expect(create.isError).not.toBe(true);
      const routine = hob.runtime.store.routines()[0]!;
      expect(notes(hob).map((item) => item.text)).toContain("新增「运维」的定时任务 · 巡检 · 每天 09:00");
      await tool(hob, "update_routine").execute("c", { routineId: routine.id, name: "晨检", assistantId: "ops" });
      expect(notes(hob).map((item) => item.text)).toContain("修改「运维」的定时任务 · 晨检 · 每天 09:00");
      await tool(hob, "delete_routine").execute("c", { routineId: routine.id, assistantId: "ops" });
      expect(notes(hob).map((item) => item.text)).toContain("删除了「运维」的定时任务「晨检」");
      // 自己的不说：单聊里给自己建的还是原来那句
      await tool(hob, "create_routine").execute("c", { name: "日报", instruction: "写日报", schedules: ["0 9 * * *"] });
      expect(notes(hob).map((item) => item.text)).toContain("新增定时任务 · 日报 · 每天 09:00");
    } finally { hob.close(); }
  });

  it("群里建的定时写明是本群的", async () => {
    const hob = setup();
    try {
      const group = hob.runtime.groups.create({ name: "运维组", purpose: "看机器", ownerId: "hob", members: ["hob"] });
      await tool(hob, "create_routine", group.id).execute("c", { name: "巡检", instruction: "看一眼", schedules: ["0 9 * * *"] });
      expect(notes(hob, group.id).map((item) => item.text)).toContain("新增本群的定时任务 · 巡检 · 每天 09:00");
    } finally { hob.close(); }
  });

  it("改技能不在对话里落行；删技能的那行写清是哪个助手的", async () => {
    const hob = setup();
    try {
      saveAssistantSkill(hob.home, "ops", skill);
      const edit = await tool(hob, "save_skill").execute("c", { name: skill.name, assistantId: "ops", edits: [{ old: "步骤", new: "新步骤" }] });
      expect(edit.isError).not.toBe(true);
      expect(notes(hob).filter((item) => item.icon === "skill")).toMatchObject([{ text: "已存技能「甲技能」第 2 版" }]);
      await tool(hob, "delete_skill").execute("c", { name: skill.name, assistantId: "ops" });
      expect(notes(hob).map((item) => item.text)).toContain("已删除「运维」的技能「甲技能」");
    } finally { hob.close(); }
  });

  it("群里删的是本群的技能还是成员的：写清是哪一个", async () => {
    const hob = setup();
    try {
      const group = hob.runtime.groups.create({ name: "运维组", purpose: "看机器", ownerId: "hob", members: ["hob"] });
      saveSkill(groupSkillsDir(hob.home, group.id), skill);
      saveAssistantSkill(hob.home, "hob", { ...skill, name: "own-skill", title: "自己的技能" });
      expect((await tool(hob, "delete_skill", group.id).execute("c", { name: skill.name })).isError).not.toBe(true);
      expect((await tool(hob, "delete_skill", group.id).execute("c", { name: "own-skill" })).isError).not.toBe(true);
      const texts = notes(hob, group.id).map((item) => item.text);
      expect(texts).toContain("已删除本群的技能「甲技能」");
      expect(texts).toContain("已删除「Hob」的技能「自己的技能」");
    } finally { hob.close(); }
  });

  it("主助手删别的助手的规则：写清是谁的", async () => {
    const hob = setup();
    try {
      hob.runtime.store.saveRules("ops", [{ id: "r-1", text: "发布公众号", mode: "ask", changedAt: new Date().toISOString() }]);
      await tool(hob, "remove_rule").execute("c", { ruleId: "r-1", assistantId: "ops" });
      expect(notes(hob).map((item) => item.text)).toContain("删除了运维的一条规则");
    } finally { hob.close(); }
  });

  it("群任务沉淀出来的本群技能：登记在任务上，群的时间线里不落行", async () => {
    const hob = setup();
    try {
      const group = hob.runtime.groups.create({ name: "运维组", purpose: "看机器", ownerId: "hob", members: ["hob"] });
      const job: Job = {
        id: "t-sed", assistantId: "hob", groupId: group.id, title: "巡检", instruction: "检查",
        status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [],
        model: "hob-faux/faux-1", thinking: "off",
      };
      const cwd = join(hob.home, "work");
      mkdirSync(join(cwd, "new-skill"), { recursive: true });
      writeFileSync(join(cwd, "new-skill", "SKILL.md"), NEW_SKILL);
      job.cwd = cwd;
      hob.runtime.store.saveJob(job);
      hob.faux.setResponses([
        call("save_skill", { name: "new-skill", from: "new-skill" }),
        call("report", { outcome: "done", result: "建好了" }),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment(job.id);
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)?.sediment).toMatchObject({ status: "saved", title: "新技能" });
      expect(notes(hob, group.id).filter((item) => item.icon === "skill")).toMatchObject([{ text: "已存技能「新技能」第 1 版" }]);
    } finally { hob.close(); }
  });
});
