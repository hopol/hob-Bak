import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { assistantSkillsDir, listAssistantSkills, lockSkillsDir, rollbackAssistantSkill, saveAssistantSkill, unlockSkillsDir } from "../src/assistant-skills.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { importSkills } from "../src/skills.ts";
import { makeHob } from "./helpers.ts";

const skill = { name: "alpha-skill", title: "甲技能", description: "甲任务", content: "步骤" };
const locked = "「巡检助手」正在沉淀技能，等这一轮结束再改。";

function tool(hob: ReturnType<typeof makeHob>, name: string) {
  const found = buildRouterTools(hob.runtime, "hob").find((item) => item.name === name);
  if (!found) throw new Error(`没有这个工具：${name}`);
  return found;
}

describe("沉淀进行中的技能目录归这一轮", () => {
  it("edit_skill、delete_skill、回滚都报错，写清是谁在沉淀", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", skill);
      lockSkillsDir(assistantSkillsDir(hob.home, "hob"), "巡检助手");
      const edit = await tool(hob, "edit_skill").execute("c", { name: skill.name, edits: [{ old: "步骤", new: "改了" }] });
      expect(edit.isError).toBe(true);
      expect(edit.content[0].text).toBe(locked);
      const remove = await tool(hob, "delete_skill").execute("c", { name: skill.name });
      expect(remove.isError).toBe(true);
      expect(remove.content[0].text).toBe(locked);
      expect(() => rollbackAssistantSkill(hob.home, "hob", skill.name)).toThrow(locked);
      // 用量计数和启用开关不算改目录，照旧能记
      expect(listAssistantSkills(hob.home, "hob")[0]).toMatchObject({ version: 1, enabled: true });
      unlockSkillsDir(assistantSkillsDir(hob.home, "hob"));
      expect((await tool(hob, "edit_skill").execute("c", { name: skill.name, edits: [{ old: "步骤", new: "改了" }] })).isError).not.toBe(true);
    } finally { hob.close(); }
  });

  it("设置里导入的技能目录在沉淀中时，导入报错、一个都不写", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const destination = join(hob.home, "skills");
      lockSkillsDir(destination, "巡检助手");
      expect(() => importSkills(hob.home, "claude", [], false)).toThrow(locked);
      unlockSkillsDir(destination);
      expect(importSkills(hob.home, "claude", [], false).imported).toEqual([]);
    } finally { hob.close(); }
  });
});
