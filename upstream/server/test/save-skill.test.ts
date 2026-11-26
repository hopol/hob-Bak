import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assistantSkillsDir, groupSkillsDir, listSkills } from "../src/assistant-skills.ts";
import { generalSkillsDir } from "../src/skills.ts";
import { saveSkillDirectory, saveSkillTool } from "../src/save-skill.ts";
import { protectedFileTools, writablePath } from "../src/write-protection.ts";
import { jobView } from "../src/job-view.ts";
import { call, makeHob, text } from "./helpers.ts";

function draft(cwd: string, name: string, body = "原来的步骤") {
  const dir = join(cwd, name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: 重复处理一类记录时使用\nmetadata:\n  title: 记录处理\n---\n\n${body}\n`);
  writeFileSync(join(dir, "scripts", "check.sh"), "echo old\n");
  return dir;
}
const origin = { kind: "assistant" as const, assistantId: "hob" };

describe("统一保存技能", () => {
  it.each(["assistant", "group", "general"] as const)("从工作目录新建到 %s", (scope) => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); draft(cwd, "record-check");
      const group = scope === "group" ? hob.runtime.groups.create({ name: "资料组", purpose: "整理资料", ownerId: "hob", members: ["hob"] }) : undefined;
      const saved = saveSkillDirectory(hob.runtime, "hob", group, cwd, { name: "record-check", from: "record-check", ...(scope === "general" ? { general: true } : {}) }, origin);
      const root = scope === "general" ? generalSkillsDir(hob.home) : group ? groupSkillsDir(hob.home, group.id) : assistantSkillsDir(hob.home, "hob");
      expect(saved.version).toBe(1);
      expect(listSkills(root)[0]).toMatchObject({ name: "record-check", version: 1, origin });
      expect(readFileSync(join(root, "record-check", "scripts", "check.sh"), "utf8")).toBe("echo old\n");
    } finally { hob.close(); }
  });

  it("整份更新、多个文件替换、历史和来源；某处失败整次不动", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); draft(cwd, "record-check");
      const save = (input: Parameters<typeof saveSkillDirectory>[4], who = origin) => saveSkillDirectory(hob.runtime, "hob", undefined, cwd, input, who);
      save({ name: "record-check", from: "record-check", edits: [] });
      const root = join(assistantSkillsDir(hob.home, "hob"), "record-check");
      expect(() => save({ name: "record-check", edits: [{ old: "原来的步骤", new: "新步骤" }, { file: "scripts/check.sh", old: "missing", new: "x" }] })).toThrow("scripts/check.sh 里找不到这段原文：missing");
      expect(readFileSync(join(root, "SKILL.md"), "utf8")).toContain("原来的步骤");
      save({ name: "record-check", from: "", edits: [{ old: "原来的步骤", new: "新步骤" }, { file: "scripts/check.sh", old: "old", new: "new" }] });
      expect(readFileSync(join(root, ".history", "1", "SKILL.md"), "utf8")).toContain("原来的步骤");
      expect(readFileSync(join(root, "scripts", "check.sh"), "utf8")).toContain("new");
      writeFileSync(join(cwd, "record-check", "SKILL.md"), readFileSync(join(cwd, "record-check", "SKILL.md"), "utf8").replace("原来的步骤", "整份替换"));
      saveSkillDirectory(hob.runtime, "hob", undefined, cwd, { name: "record-check", from: "record-check" }, { kind: "job", jobId: "t-1" });
      expect(listSkills(assistantSkillsDir(hob.home, "hob"))[0]).toMatchObject({ version: 3, origin: { kind: "job", jobId: "t-1" } });
      expect(readFileSync(join(root, "SKILL.md"), "utf8")).toContain("整份替换");
      save({ name: "record-check", general: true });
      expect(existsSync(root)).toBe(false);
      expect(listSkills(generalSkillsDir(hob.home))[0].version).toBe(4);
      expect(existsSync(join(generalSkillsDir(hob.home), "record-check", ".history", "3"))).toBe(true);
    } finally { hob.close(); }
  });

  it("参数错误、名字不符、缺文件、重复原文、校验失败均不提交", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); const dir = draft(cwd, "record-check", "相同 相同");
      const save = (input: Parameters<typeof saveSkillDirectory>[4]) => saveSkillDirectory(hob.runtime, "hob", undefined, cwd, input, origin);
      expect(() => save({ name: "record-check" })).toThrow("from、edits、general 至少填一样");
      expect(() => save({ name: "record-check", from: "record-check", edits: [{ old: "x", new: "y" }] })).toThrow("from 和 edits 只填一样");
      expect(() => save({ name: "record-check", general: true })).toThrow("新建要填 from");
      expect(() => save({ name: "other-name", from: "record-check" })).toThrow("SKILL.md 里的 name 是 record-check");
      save({ name: "record-check", from: "record-check" });
      expect(() => save({ name: "record-check", edits: [{ file: "missing", old: "x", new: "y" }] })).toThrow("技能里没有 missing");
      expect(() => save({ name: "record-check", edits: [{ old: "相同", new: "不同" }] })).toThrow("出现了 2 次");
      writeFileSync(join(dir, "SKILL.md"), `---\nname: record-check\ndescription: ${"长".repeat(121)}\nmetadata:\n  title: 记录\n---\n步骤`);
      // 新建校验失败不会生成技能。
      writeFileSync(join(dir, "SKILL.md"), readFileSync(join(dir, "SKILL.md"), "utf8").replace("record-check", "new-check"));
      expect(() => save({ name: "new-check", from: "record-check" })).toThrow("没存上：");
      expect(listSkills(assistantSkillsDir(hob.home, "hob"))).toHaveLength(1);
    } finally { hob.close(); }
  });

  it("暂存目录的首尾空格是路径的一部分", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd);
      const dir = join(cwd, " draft "); mkdirSync(dir);
      writeFileSync(join(dir, "SKILL.md"), "---\nname: record-check\ndescription: 一套记录处理步骤\nmetadata:\n  title: 记录处理\n---\n\n步骤\n");
      expect(saveSkillDirectory(hob.runtime, "hob", undefined, cwd, { name: "record-check", from: " draft " }, origin).version).toBe(1);
    } finally { hob.close(); }
  });

  it("只保留最近五个历史版本，并拒绝技能里的符号链接", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); const dir = draft(cwd, "record-check");
      const save = (input: Parameters<typeof saveSkillDirectory>[4]) => saveSkillDirectory(hob.runtime, "hob", undefined, cwd, input, origin);
      save({ name: "record-check", from: "record-check" });
      for (let i = 0; i < 6; i++) save({ name: "record-check", edits: [{ old: i ? `步骤${i}` : "原来的步骤", new: `步骤${i + 1}` }] });
      const root = join(assistantSkillsDir(hob.home, "hob"), "record-check");
      expect(existsSync(join(root, ".history", "1"))).toBe(false);
      expect(existsSync(join(root, ".history", "2"))).toBe(true);
      expect(existsSync(join(root, ".history", "6"))).toBe(true);
      symlinkSync(join(hob.home, "system"), join(dir, "references-link"));
      expect(() => save({ name: "record-check", from: "record-check" })).toThrow("里不能有符号链接：references-link");
      expect(listSkills(assistantSkillsDir(hob.home, "hob"))[0].version).toBe(7);
    } finally { hob.close(); }
  });

  it("未登记的同名目录不会被覆盖或删除", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); draft(cwd, "record-check");
      const existing = join(assistantSkillsDir(hob.home, "hob"), "record-check");
      mkdirSync(existing, { recursive: true });
      writeFileSync(join(existing, "data.txt"), "原有文件");
      expect(() => saveSkillDirectory(hob.runtime, "hob", undefined, cwd, { name: "record-check", from: "record-check" }, origin)).toThrow("技能目录已存在");
      expect(readFileSync(join(existing, "data.txt"), "utf8")).toBe("原有文件");
    } finally { hob.close(); }
  });

  it("工具保存后产生时间线提示，普通任务未调用时不产生技能", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); draft(cwd, "record-check");
      const tool = saveSkillTool(hob.runtime, "hob", undefined, cwd);
      const result = await tool.execute("s", { name: "record-check", from: "record-check" });
      expect(result.isError).not.toBe(true);
      expect(result.content[0]).toMatchObject({ text: "已存技能「记录处理」（record-check），第 1 版，是你的。" });
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.text.includes("已存技能「记录处理」第 1 版"))).toBe(true);
    } finally { hob.close(); }
  });
});

describe("文件工具保护", () => {
  it("允许工作目录，拒绝数据和指向数据的符号链接", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd);
      const data = join(hob.home, "system", "settings.json");
      symlinkSync(join(hob.home, "system"), join(cwd, "link"));
      symlinkSync(join(hob.home, "system", "not-yet-created"), join(cwd, "dangling"));
      const [edit, write] = protectedFileTools(cwd, hob.home, () => [cwd]);
      await write.execute("1", { path: join(cwd, "draft.txt"), content: "old" });
      await edit.execute("2", { path: join(cwd, "draft.txt"), edits: [{ oldText: "old", newText: "new" }] });
      expect(readFileSync(join(cwd, "draft.txt"), "utf8")).toBe("new");
      const blocked = "这是 Hob 自己的数据，不能直接改：用户发来的文件复制到你的工作目录再改；技能在你的工作目录写好，用 save_skill 存；助手和群的资料用对应的工具。";
      await expect(write.execute("3", { path: data, content: "不能覆盖" })).rejects.toThrow(blocked);
      await expect(edit.execute("4", { path: data, edits: [{ oldText: "x", newText: "y" }] })).rejects.toThrow(blocked);
      expect(() => writablePath(hob.home, [cwd], data)).toThrow(blocked);
      expect(() => writablePath(hob.home, [cwd], join(cwd, "link", "settings.json"))).toThrow("这是 Hob 自己的数据，不能直接改");
      expect(() => writablePath(hob.home, [cwd], join(cwd, "dangling"))).toThrow("这是 Hob 自己的数据，不能直接改");
    } finally { hob.close(); }
  });
});

describe("回顾", () => {
  it("原任务会话可存两份，report 后不叫醒助手", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); draft(cwd, "first-skill"); draft(cwd, "second-skill");
      hob.runtime.store.saveJob({ id: "t-review", assistantId: "hob", title: "整理记录", instruction: "整理", status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], cwd, model: "hob-faux/faux-1", thinking: "off" });
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("save_skill", { name: "first-skill", from: "first-skill" }), call("save_skill", { name: "second-skill", from: "second-skill" }), call("report", { outcome: "done", result: "保存两份" }), text("完成")]);
      hob.runtime.jobs.startSediment("t-review");
      await hob.runtime.jobs.waitIdle();
      expect(listSkills(assistantSkillsDir(hob.home, "hob"))).toHaveLength(2);
      expect(hob.runtime.store.job("t-review")?.sediment).toEqual({ status: "saved", name: "first-skill", title: "记录处理", version: 1, updated: false });
      expect(notify).not.toHaveBeenCalled();
      expect(readFileSync(hob.runtime.store.workerFile("t-review"), "utf8")).toContain("改已有的还是新建、新建几份");
    } finally { hob.close(); }
  });

  it("显示进行中已经保存的技能", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const job = { id: "t-a", assistantId: "hob", title: "整理", instruction: "整理", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], sediment: { status: "running" as const, saved: [{ name: "first-skill", title: "第一份", version: 2, updated: true }] } };
      expect(jobView(job, [], [], [], "UTC")).toContain("正在回顾，已存的技能：「第一份」（first-skill，第 2 版）。");
    } finally { hob.close(); }
  });
});
