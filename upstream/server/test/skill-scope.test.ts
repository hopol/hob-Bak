import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { createApp } from "../src/http.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { assistantJobResultEvent, sedimentHint } from "../src/jobs.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { generalSkillsDir, skillViews, syncGeneralIndex, visibleSkills } from "../src/skills.ts";
import { archiveSkill, groupSkillsDir, listSkills, moveSkill, rollbackSkill, saveAssistantSkill, saveSkill, setSkillEnabled, skillIndex } from "../src/assistant-skills.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const hobSkill = { name: "weekly-report", title: "每周周报", description: "每周五写周报", content: "按项目分组写" };

/** 导入格式的技能：目录名和 name 不同、说明超过 120 字、没有 metadata.title、有额外字段、顶层多两个文件。 */
function importedSkill(root: string): string {
  const dir = join(root, "vendor-tools");
  mkdirSync(join(dir, "templates"), { recursive: true });
  writeFileSync(join(dir, "LICENSE.txt"), "MIT\n");
  writeFileSync(join(dir, "templates", "table.md"), "| a | b |\n");
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      "name: vendor-summary",
      `description: ${"从供应商表格里汇总季度用量时使用，".repeat(8)}`,
      "allowed-tools: Read, Bash",
      "version: 3",
      "---",
      "",
      "读表、按供应商汇总，最后给一张表。",
      "",
    ].join("\n"),
  );
  return dir;
}

afterEach(() => vi.unstubAllGlobals());

describe("谁能用哪些技能", () => {
  it("单聊、群、话题看到的档位不同；同名时本群在前，停用的通用技能不出现", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.settings.patch(hob.runtime.settings.get().revision, { skills: { disabled: ["hob:off-switch"] } });
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      saveSkill(generalSkillsDir(hob.home), { name: "shared", title: "通用的", description: "大家都能用", content: "通用步骤" });
      saveSkill(generalSkillsDir(hob.home), { name: "off-switch", title: "停用的", description: "设置里停用了", content: "不出现" });
      saveAssistantSkill(hob.home, "hob", { name: "shared", title: "我的", description: "只有我能用", content: "个人步骤" });
      saveAssistantSkill(hob.home, "hob", { name: "own-only", title: "自己的", description: "单聊也能用", content: "个人步骤" });
      saveSkill(groupSkillsDir(hob.home, group.id), { name: "shared", title: "本群的", description: "群里用", content: "群步骤" });

      const solo = visibleSkills(hob.runtime, "hob");
      expect(solo.map((skill) => `${skill.name}:${skill.scope}`)).toEqual(["shared:assistant", "own-only:assistant"]);
      const inGroup = visibleSkills(hob.runtime, "hob", group);
      expect(inGroup.map((skill) => `${skill.name}:${skill.scope}`)).toEqual(["shared:group", "own-only:assistant"]);
      const inTopic = visibleSkills(hob.runtime, "hob", topic);
      expect(inTopic.map((skill) => `${skill.name}:${skill.scope}`)).toEqual(["shared:group", "own-only:assistant"]);

      // 通用那档在前两份被盖住后只剩停用的一份，停用的不出现
      setSkillEnabled(groupSkillsDir(hob.home, group.id), "shared", false);
      expect(visibleSkills(hob.runtime, "other").map((skill) => `${skill.name}:${skill.scope}`)).toEqual(["shared:general"]);
      expect(visibleSkills(hob.runtime, "other")[0].version).toBe(1);
    } finally { hob.close(); }
  });

  it("Lore 和本机 ~/.agents 的只读，带来源；同名时排在通用技能后面", () => {
    const hob = makeHob({}, { memory: "lore" });
    const previous = process.env.HOME;
    const temp = join(hob.home, "fake-home");
    try {
      const local = join(temp, ".agents", "skills", "local-only");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "SKILL.md"), "---\nname: local-only\ndescription: 本机别的工具也用\n---\n正文\n");
      const lore = join(hob.home, "lore-skills");
      mkdirSync(join(lore, "shared"), { recursive: true });
      writeFileSync(join(lore, "shared", "SKILL.md"), "---\nname: shared\ndescription: Lore 里的同名技能\n---\n正文\n");
      process.env.HOME = temp;
      expect(homedir()).toBe(temp);
      saveSkill(generalSkillsDir(hob.home), { name: "shared", title: "通用的", description: "Hob 的", content: "步骤" });
      hob.runtime.pi.loreSkillPaths = [lore];
      const skills = visibleSkills(hob.runtime, "hob");
      expect(skills.map((skill) => `${skill.name}:${skill.scope}:${skill.source ?? "hob"}`)).toEqual(["shared:general:hob", "local-only:general:local"]);
      expect(skills.find((skill) => skill.name === "local-only")?.editable).toBe(false);
      // Lore 的同名那份被 Hob 的盖住，不出现
      expect(skills.filter((skill) => skill.name === "shared")).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      hob.close();
    }
  });
});

describe("Hob 自带的 playwright-cli 技能", () => {
  it("只在云桌面开着时出现，只读", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      expect(visibleSkills(hob.runtime, "hob").some((skill) => skill.name === "playwright-cli")).toBe(false);
      vi.spyOn(hob.runtime.desktop, "view").mockReturnValue({ ...hob.runtime.desktop.view(), enabled: true, url: "http://desktop.test", tokenConfigured: true });
      const skill = visibleSkills(hob.runtime, "hob").find((item) => item.name === "playwright-cli");
      expect(skill).toMatchObject({ source: "builtin", editable: false });
    } finally {
      vi.restoreAllMocks();
      hob.close();
    }
  });
});

describe("通用技能和别的两档一样能改", () => {
  it("启动时给导入格式的技能补索引，目录改成 name，标题没有就用名字", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const dir = importedSkill(generalSkillsDir(hob.home));
      syncGeneralIndex(generalSkillsDir(hob.home));
      expect(existsSync(dir)).toBe(false);      const index = skillIndex(generalSkillsDir(hob.home));
      expect(index["vendor-summary"]).toMatchObject({ title: "vendor-summary", version: 1 });
      expect(index["vendor-summary"].updatedAt).toBeTruthy();
    } finally { hob.close(); }
  });

  it("导入格式的技能：改、回退、沉淀进去都留着 frontmatter、附件和目录结构", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      importedSkill(generalSkillsDir(hob.home));
      const dir = join(generalSkillsDir(hob.home), "vendor-summary");
      const edit = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "save_skill")!;
      const edited = await edit.execute("e", { name: "vendor-summary", edits: [{ old: "最后给一张表", new: "最后给一张按用量排序的表" }] });
      expect(edited.isError).not.toBe(true);
      const kept = readFileSync(join(dir, "SKILL.md"), "utf8");
      expect(kept).toContain("allowed-tools: Read, Bash");
      expect(kept).toContain("version: 3");
      expect(kept).not.toContain("metadata:");
      expect(kept).toContain("按用量排序");
      expect(existsSync(join(dir, "LICENSE.txt"))).toBe(true);
      expect(existsSync(join(dir, "templates", "table.md"))).toBe(true);
      expect(listSkills(generalSkillsDir(hob.home))[0].version).toBe(2);
      // pi 照样加载得出来
      expect(loadSkillsFromDir({ dir, source: "hob" }).skills.map((skill) => skill.name)).toEqual(["vendor-summary"]);

      rollbackSkill(generalSkillsDir(hob.home), "vendor-summary");
      const rolled = readFileSync(join(dir, "SKILL.md"), "utf8");
      expect(rolled).toContain("最后给一张表");
      expect(rolled).not.toContain("按用量排序");
      expect(rolled).toContain("allowed-tools: Read, Bash");
      expect(existsSync(join(dir, "templates", "table.md"))).toBe(true);

      // 沉淀进去：任务直接改文件，对账只查底线（说明超 120 字、没有 metadata.title 都不算错）
      hob.runtime.store.saveJob({ id: "t-general", assistantId: "hob", title: "汇总", instruction: "汇总", status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      hob.faux.setResponses([
        call("save_skill", { name: "vendor-summary", edits: [{ old: "最后给一张表", new: "最后给一张按金额排序的表" }] }),
        call("report", { outcome: "done", result: "补了一句" }),
        text("好了"),
      ]);
      hob.runtime.jobs.startSediment("t-general");
      await hob.runtime.jobs.waitIdle();
      const after = readFileSync(join(dir, "SKILL.md"), "utf8");
      expect(after).toContain("按金额排序");
      expect(after).toContain("allowed-tools: Read, Bash");
      expect(hob.runtime.store.job("t-general")?.sediment).toMatchObject({ status: "saved", name: "vendor-summary" });
    } finally { hob.close(); }
  });

  it("通用技能能删（移到归档）", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveSkill(generalSkillsDir(hob.home), hobSkill);
      archiveSkill(generalSkillsDir(hob.home), hobSkill.name);
      expect(listSkills(generalSkillsDir(hob.home))).toEqual([]);
      expect(readdirSync(join(generalSkillsDir(hob.home), ".archive")).some((entry) => entry.startsWith(hobSkill.name))).toBe(true);
    } finally { hob.close(); }
  });

  it("只读的两类：改、删、into 填了它都照实说是哪来的", async () => {
    const hob = makeHob({}, { memory: "lore" });
    const previous = process.env.HOME;
    const temp = join(hob.home, "fake-home");
    try {
      const local = join(temp, ".agents", "skills", "local-only");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "SKILL.md"), "---\nname: local-only\ndescription: 本机别的工具也用\n---\n正文\n");
      process.env.HOME = temp;
      const tools = buildRouterTools(hob.runtime, "hob");
      const edit = tools.find((tool) => tool.name === "save_skill")!;
      const remove = tools.find((tool) => tool.name === "delete_skill")!;
      const result = await edit.execute("e", { name: "local-only", edits: [{ old: "正文", new: "新正文" }] });
      expect(result.content[0].text).toBe("local-only 是只读的技能，不能改；换个名字另存一份。");
      expect((await remove.execute("d", { name: "local-only" })).content[0].text).toContain("本机 ~/.agents/skills 里");

      expect(tools.find((tool) => tool.name === "review_job")?.parameters.properties.into).toBeUndefined();

      hob.runtime.pi.loreSkillPaths = [join(hob.home, "lore-skills")];
      mkdirSync(join(hob.home, "lore-skills", "lore-only"), { recursive: true });
      writeFileSync(join(hob.home, "lore-skills", "lore-only", "SKILL.md"), "---\nname: lore-only\ndescription: Lore 里的\n---\n正文\n");
      const loreResult = await edit.execute("e2", { name: "lore-only", edits: [{ old: "正文", new: "新" }] });
      expect(loreResult.content[0].text).toBe("lore-only 是只读的技能，不能改；换个名字另存一份。");
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      hob.close();
    }
  });
});

describe("新建在哪、换范围", () => {
  it("save_job_as_skill 的 general：新技能落在 HOB_HOME/skills", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "drafts");
      const dir = join(cwd, "csv-to-json");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: csv-to-json\ndescription: 把表格转成 JSON 时使用\nmetadata:\n  title: 表格转 JSON\n---\n\n步骤\n");
      hob.runtime.store.saveJob({ id: "t-gen", assistantId: "hob", title: "转表", instruction: "转", status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], cwd });
      const review = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "review_job")!;
      hob.faux.setResponses([
        call("save_skill", { name: "csv-to-json", from: "csv-to-json", general: true }),
        call("report", { outcome: "done", result: "新建了 csv-to-json" }),
        text("存好了"),
      ]);
      expect((await review.execute("s", { jobId: "t-gen" })).isError).not.toBe(true);
      await hob.runtime.jobs.waitIdle();
      expect(listSkills(generalSkillsDir(hob.home)).map((skill) => skill.name)).toEqual(["csv-to-json"]);
      expect(listSkills(join(hob.home, "assistants", "hob", "skills"))).toEqual([]);
    } finally { hob.close(); }
  });

  it("edit_skill 的 general：换成通用的（版本历史跟着搬、提示行），收回来归自己", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const saved = saveAssistantSkill(hob.home, "hob", { ...hobSkill, content: "第一版" });
      saveAssistantSkill(hob.home, "hob", { ...hobSkill, content: "第二版" });
      const tools = buildRouterTools(hob.runtime, "hob");
      const edit = tools.find((tool) => tool.name === "save_skill")!;
      const result = await edit.execute("e", { name: hobSkill.name, general: true });
      expect(result.isError).not.toBe(true);
      const dir = join(generalSkillsDir(hob.home), hobSkill.name);
      expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, ".history", "1", "SKILL.md"))).toBe(true);
      expect(listSkills(join(hob.home, "assistants", "hob", "skills"))).toEqual([]);
      const notes = hob.runtime.router.items("hob").items.filter((item) => item.kind === "note");
      expect(notes.at(-1)).toMatchObject({ icon: "skill", text: "已存技能「每周周报」第 3 版" });
      expect(saved.version).toBe(1);

      // 收回来：还在原位置，提示行说收回
      expect((await edit.execute("e2", { name: hobSkill.name, general: false })).isError).not.toBe(true);
      expect(existsSync(join(hob.home, "assistants", "hob", "skills", hobSkill.name, "SKILL.md"))).toBe(true);
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "note").at(-1)?.text).toBe("已存技能「每周周报」第 4 版");
    } finally { hob.close(); }
  });

  it("换范围时不影响定时任务；定时任务不绑定技能", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", { ...hobSkill, content: "自己的" });
      saveSkill(generalSkillsDir(hob.home), hobSkill);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "周报", instruction: "写周报", schedules: ["0 9 * * *"], skill: hobSkill.name } as never);
      expect(routine).not.toHaveProperty("skill");
      expect(() => moveSkill(join(hob.home, "assistants", "hob", "skills"), generalSkillsDir(hob.home), hobSkill.name, "已有名为 weekly-report 的通用技能")).toThrow("已有名为 weekly-report 的通用技能");
      archiveSkill(generalSkillsDir(hob.home), hobSkill.name);
      moveSkill(join(hob.home, "assistants", "hob", "skills"), generalSkillsDir(hob.home), hobSkill.name, "冲突");
      expect(visibleSkills(hob.runtime, "hob").map((skill) => skill.name)).toContain(hobSkill.name);
      expect(hob.runtime.store.routine(routine.id)).not.toHaveProperty("skill");
    } finally { hob.close(); }
  });

  it("通用技能不会绑定到定时任务", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveSkill(generalSkillsDir(hob.home), hobSkill);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "周报", instruction: "写周报", schedules: ["0 9 * * *"], skill: hobSkill.name } as never);
      expect(routine).not.toHaveProperty("skill");
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      await hob.runtime.routines.runNow(routine.id);
      expect(event).toHaveBeenCalledWith("hob", expect.stringContaining("写周报"), expect.anything());
      expect(event.mock.calls[0]?.[1]).not.toContain("按技能");
    } finally { hob.close(); }
  });
});

describe("沉淀提醒", () => {
  const job = { id: "t-hint", assistantId: "hob", title: "整理", instruction: "", status: "done" as const, createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [], summary: "好了" };

  it("没用技能、用了技能两种原文；用了的写出标题", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(job);
      const none = sedimentHint(hob.home, job);
      expect(none).toBe("这个任务没用到技能。可以用 review_job 让它回顾一遍，把能复用的做法沉淀下来，有没有值得沉淀的由它判断。");
      saveAssistantSkill(hob.home, "hob", hobSkill);
      saveSkill(generalSkillsDir(hob.home), { name: "table-summary", title: "表格汇总", description: "汇总表格时使用", content: "步骤" });
      const used = { ...job, skillsUsed: [hobSkill.name, "table-summary"] };
      hob.runtime.store.saveJob(used);
      const event = assistantJobResultEvent(hob.home, used, { skills: visibleSkills(hob.runtime, "hob") });
      expect(event).toContain("这个任务用了技能「每周周报」「表格汇总」。可以用 review_job 让它回顾一遍，有没有值得沉淀的由它判断：技能里没写到的做法、写错的地方，它会补进对应的那份；是另一类事的做法，它会新建一份。");
      // 做完就提醒，用到了技能也一样
      expect(sedimentHint(hob.home, used)).toContain("这个任务用了技能");
      for (const status of ["stuck", "failed", "stopped"] as const) expect(sedimentHint(hob.home, { ...used, status })).toBeUndefined();
    } finally { hob.close(); }
  });

  it("任务读了通用技能：记进 skillsUsed，用量记在通用技能上", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const saved = saveSkill(generalSkillsDir(hob.home), { ...hobSkill, name: "table-summary", title: "表格汇总", description: "汇总表格时使用", content: "步骤" });
      hob.faux.setResponses([call("read", { path: saved.path }), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const started = await hob.runtime.jobs.start("hob", { title: "汇总", instruction: "汇总" });
      await waitFor(() => hob.runtime.store.job(started.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(started.id)?.skillsUsed).toEqual(["table-summary"]);
      expect(listSkills(generalSkillsDir(hob.home))[0].uses).toBe(1);
    } finally { hob.close(); }
  });
});

describe("设置 → 技能", () => {
  it("三节都有、Hob 的带版本和上版本、删了走归档、能回退", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveSkill(generalSkillsDir(hob.home), { ...hobSkill, content: "第一版" });
      saveSkill(generalSkillsDir(hob.home), { ...hobSkill, content: "第二版" });
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const req = (path: string, method = "GET") => app.request(path, { method, headers: { cookie } });
      const view = await (await req("/api/skills")).json() as { skills: { name: string; version?: number; updatedAt?: string; rollbackable?: boolean; source: string }[] };
      expect(view.skills).toMatchObject([{ name: hobSkill.name, source: "hob", version: 2, rollbackable: true }]);
      expect(view.skills[0].updatedAt).toBeTruthy();
      expect((await req(`/api/skills/${hobSkill.name}/rollback`, "POST")).status).toBe(200);
      expect(readFileSync(join(generalSkillsDir(hob.home), hobSkill.name, "SKILL.md"), "utf8")).toContain("第一版");
      expect((await req(`/api/skills/${hobSkill.name}`, "DELETE")).status).toBe(200);
      const after = await (await req("/api/skills")).json() as { skills: unknown[] };
      expect(after.skills).toEqual([]);
      expect(readdirSync(join(generalSkillsDir(hob.home), ".archive"))).toHaveLength(1);
    } finally { hob.close(); }
  });

  it("技能列表按 Hob、Lore、本机三档，同名时 Hob 的优先", () => {
    const hob = makeHob({}, { memory: "off" });
    const previous = process.env.HOME;
    const temp = join(hob.home, "fake-home");
    try {
      process.env.HOME = temp;
      saveSkill(generalSkillsDir(hob.home), { ...hobSkill, name: "shared", content: "Hob 的" });
      for (const [root, name, description] of [[join(temp, ".agents", "skills"), "shared", "本机的"], [join(temp, ".agents", "skills"), "local-only", "本机独有"]] as const) {
        mkdirSync(join(root, name), { recursive: true });
        writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`);
      }
      const view = skillViews(hob.home, [], []);
      expect(view.filter((skill) => skill.name === "shared").map((skill) => `${skill.source}:${skill.overridden}`)).toEqual(["hob:false", "common:true"]);
      expect(view.filter((skill) => skill.name === "local-only").map((skill) => `${skill.source}:${skill.overridden}`)).toEqual(["common:false"]);
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      hob.close();
    }
  });
});

describe("提示词里的技能清单", () => {
  it("三档各一行，只读的写明从哪来；通用技能不再单列", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      saveSkill(groupSkillsDir(hob.home, group.id), { name: "trip-plan", title: "旅行行程", description: "排行程时使用", content: "步骤" });
      saveAssistantSkill(hob.home, "hob", hobSkill);
      saveSkill(generalSkillsDir(hob.home), { name: "table-summary", title: "表格汇总", description: "汇总表格时使用", content: "步骤" });
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", {
        timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off",
        skills: visibleSkills(hob.runtime, "hob", group),
      });
      expect(prompt).toContain("你能用的技能（括号里是它的文件，需要时可以读）：");
      expect(prompt).toContain("- trip-plan「旅行行程」· 本群 · 第 1 版 · ");
      expect(prompt).toContain("- weekly-report「每周周报」· 你的 · 第 1 版 · ");
      expect(prompt).toContain("- table-summary「表格汇总」· 通用 · 第 1 版 · ");
      expect(prompt).toContain("（" + join(generalSkillsDir(hob.home), "table-summary", "SKILL.md") + "）");
      expect(prompt).not.toContain("任务带上的通用技能");
      expect(prompt).not.toContain("你现在的技能");
    } finally { hob.close(); }
  });
});
