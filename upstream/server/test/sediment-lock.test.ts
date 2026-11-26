import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assistantSkillsDir, listSkills } from "../src/assistant-skills.ts";
import { saveSkillTool } from "../src/save-skill.ts";
import { makeHob } from "./helpers.ts";

describe("同一份技能的保存顺序", () => {
  it("并发调用依次形成版本，后一份以已提交的版本为基础", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"), draft = join(cwd, "record-check");
      mkdirSync(draft, { recursive: true });
      writeFileSync(join(draft, "SKILL.md"), "---\nname: record-check\ndescription: 整理记录时使用\nmetadata:\n  title: 记录整理\n---\n\n第一步\n");
      const tool = saveSkillTool(hob.runtime, "hob", undefined, cwd);
      await tool.execute("1", { name: "record-check", from: "record-check" });
      const [first, second] = await Promise.all([
        tool.execute("2", { name: "record-check", edits: [{ old: "第一步", new: "第二步" }] }),
        tool.execute("3", { name: "record-check", edits: [{ old: "第二步", new: "第三步" }] }),
      ]);
      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      const skill = listSkills(assistantSkillsDir(hob.home, "hob"))[0];
      expect(skill.version).toBe(3);
      expect(readFileSync(skill.path, "utf8")).toContain("第三步");
      expect(readFileSync(join(assistantSkillsDir(hob.home, "hob"), skill.name, ".history", "2", "SKILL.md"), "utf8")).toContain("第二步");
    } finally { hob.close(); }
  });
});
