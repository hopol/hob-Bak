import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../shared/types.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { archiveAssistantSkill, listAssistantSkills, recordAssistantSkillUse, saveAssistantSkill, setAssistantSkillEnabled, usableAssistantSkills } from "../src/assistant-skills.ts";
import { reconcileSkills, restoreSkills, snapshotSkills } from "../src/sediment.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const skill = { name: "alpha-skill", title: "甲技能", description: "甲任务", content: "步骤" };

function doneJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "t-sed", assistantId: "hob", title: "巡检", instruction: "检查",
    status: "done", createdAt: new Date().toISOString(),
    stats: { reads: 0, commands: 0, edits: 0 }, activity: [],
    model: "hob-faux/faux-1", thinking: "off",
    ...overrides,
  };
}

function skillFile(home: string, name: string): string {
  return join(home, "assistants", "hob", "skills", name, "SKILL.md");
}

function head(name: string, title: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  title: ${title}\n---\n\n步骤\n`;
}

describe("沉淀是任务的又一轮", () => {
  it("用 write 建技能和脚本，report 后登记第 1 版", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(doneJob());
      const dir = join(hob.home, "assistants", "hob", "skills", "file-stats");
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const events: string[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "job") events.push(event.job.sediment?.status ?? ""); });
      hob.faux.setResponses([
        call("write", { path: join(dir, "SKILL.md"), content: head("file-stats", "文件统计", "统计目录里的文件") }),
        call("write", { path: join(dir, "scripts", "count.sh"), content: "#!/bin/sh\nfind . -type f | wc -l\n" }),
        call("report", { outcome: "done", result: "新建了 file-stats，脚本跑通" }),
        text("存好了"),
      ]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      const job = hob.runtime.store.job("t-sed")!;
      expect(job.status).toBe("done");
      expect(job.rounds).toBeUndefined();
      expect(job.sediment).toEqual({ status: "saved", name: "file-stats", title: "文件统计", version: 1, updated: false });
      expect(listAssistantSkills(hob.home, "hob")).toMatchObject([
        { name: "file-stats", title: "文件统计", description: "统计目录里的文件", version: 1, fromJobId: "t-sed", uses: 0, enabled: true },
      ]);
      expect(readFileSync(join(dir, "scripts", "count.sh"), "utf8")).toContain("find .");
      expect(notify).not.toHaveBeenCalled();
      expect(events[0]).toBe("running");
      expect(events.at(-1)).toBe("saved");
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "note" && item.icon === "skill"))
        .toMatchObject([{ text: "已沉淀技能「文件统计」", path: join(dir, "SKILL.md") }]);
    } finally { hob.close(); }
  });

  it("在已有技能上改：版本加一，旧版进历史，标题和说明跟着 SKILL.md", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const saved = saveAssistantSkill(hob.home, "hob", skill);
      hob.runtime.store.saveJob(doneJob());
      hob.faux.setResponses([
        call("edit", { path: saved.path, edits: [{ oldText: "步骤", newText: "新步骤" }, { oldText: "甲任务", newText: "甲的日常任务" }] }),
        call("edit", { path: saved.path, edits: [{ oldText: "甲技能", newText: "甲技能二" }] }),
        call("report", { outcome: "done", result: "改了两处" }),
        text("改好了"),
      ]);
      hob.runtime.jobs.startSediment("t-sed", { into: skill.name });
      await hob.runtime.jobs.waitIdle();
      const after = listAssistantSkills(hob.home, "hob")[0];
      expect(after).toMatchObject({ name: skill.name, title: "甲技能二", description: "甲的日常任务", version: 2, fromJobId: "t-sed" });
      expect(hob.runtime.store.job("t-sed")?.sediment).toEqual({ status: "saved", name: skill.name, title: "甲技能二", version: 2, updated: true });
      const history = join(hob.home, "assistants", "hob", "skills", skill.name, ".history", "1");
      expect(readFileSync(join(history, "SKILL.md"), "utf8")).toContain("甲技能");
      expect(readFileSync(join(history, "SKILL.md"), "utf8")).toContain("步骤");
      expect(readFileSync(after.path, "utf8")).toContain("新步骤");
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "note").map((item) => (item.kind === "note" ? item.text : "")))
        .toContain("已更新技能「甲技能二」· 第 2 版");
    } finally { hob.close(); }
  });

  it("校验不过时 report 返回出错文字，改好再交才存上", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(doneJob());
      const dir = join(hob.home, "assistants", "hob", "skills", "weekly-report");
      const long = "很长".repeat(70);
      hob.faux.setResponses([
        call("write", { path: join(dir, "SKILL.md"), content: head("weekly-report", "每周周报", long) }),
        call("report", { outcome: "done", result: "建好了" }),
        call("write", { path: join(dir, "SKILL.md"), content: head("weekly-report", "每周周报", "每周五写周报") }),
        call("report", { outcome: "done", result: "描述改短了" }),
        text("好了"),
      ]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      const steps = hob.runtime.jobs.transcript("t-sed").filter((step) => step.name === "report");
      expect(steps[0].isError).toBe(true);
      expect(steps[0].output).toContain("技能还没存上：「weekly-report」的 description 超过 120 字（现在 140 字）。改好以后再调用 report。");
      expect(steps[1].output).toBe("技能已保存。");
      expect(listAssistantSkills(hob.home, "hob")[0]).toMatchObject({ description: "每周五写周报", version: 1 });
    } finally { hob.close(); }
  });

  it("没交 report 就停下：提醒一次，还是没改好就恢复原样、记失败并通知", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(doneJob());
      const dir = join(hob.home, "assistants", "hob", "skills", "bad-skill");
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([
        call("write", { path: join(dir, "SKILL.md"), content: "---\nname: bad-skill\ndescription: 少了标题\n---\n正文\n" }),
        text("改好了"),
        text("真的改好了"),
      ]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(existsSync(dir)).toBe(false);
      expect(hob.runtime.store.job("t-sed")?.sediment).toEqual({ status: "failed", reason: "技能没改好，已恢复原样：「bad-skill」的 SKILL.md 开头缺 metadata.title" });
      expect(notify).toHaveBeenCalledWith("hob", `任务「巡检」（t-sed）沉淀完了：沉淀失败，技能没改好，已恢复原样：「bad-skill」的 SKILL.md 开头缺 metadata.title。`);
      expect(readFileSync(hob.runtime.store.workerFile("t-sed"), "utf8").split("这一轮结束了，还没有交结果")).toHaveLength(2);
    } finally { hob.close(); }
  });

  it("没有改动就记 empty，原因是 report 的 result", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(doneJob());
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("report", { outcome: "done", result: "一次性的事，照常做就行" }), text("好")]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job("t-sed")?.sediment).toEqual({ status: "empty", reason: "一次性的事，照常做就行" });
      expect(notify).not.toHaveBeenCalled();
      expect(hob.runtime.jobs.transcript("t-sed").find((step) => step.name === "report")?.output).toBe("结果已记录。");
    } finally { hob.close(); }
  });

  it("沉淀中接着说：停下来、照底稿恢复、状态清掉，照常开新一轮", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(doneJob());
      const dir = join(hob.home, "assistants", "hob", "skills", "half-done");
      hob.faux.setResponses([
        call("write", { path: join(dir, "SKILL.md"), content: head("half-done", "半成品", "写了一半") }),
        call("bash", { command: "sleep 3" }),
        call("report", { outcome: "done", result: "续做完成" }),
        text("完成"),
      ]);
      hob.runtime.jobs.startSediment("t-sed");
      await waitFor(() => existsSync(join(dir, "SKILL.md")));
      await hob.runtime.jobs.reply("t-sed", "补充检查");
      expect(existsSync(dir)).toBe(false);
      expect(hob.runtime.store.job("t-sed")?.sediment).toBeUndefined();
      await waitFor(() => hob.runtime.store.job("t-sed")?.status === "done" && (hob.runtime.store.job("t-sed")?.rounds?.length ?? 0) === 1);
      await hob.runtime.jobs.waitIdle();
      const job = hob.runtime.store.job("t-sed")!;
      expect(job.rounds?.[0]?.followUp).toBe("补充检查");
      expect(job.rounds?.[0]?.sediment).toBeUndefined();
      expect(listAssistantSkills(hob.home, "hob")).toEqual([]);
    } finally { hob.close(); }
  });

  it("重启时沉淀中的任务照底稿恢复并记失败", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", skill);
      hob.runtime.store.saveJob(doneJob());
      const dir = join(hob.home, "assistants", "hob", "skills", skill.name);
      hob.faux.setResponses([
        call("edit", { path: join(dir, "SKILL.md"), edits: [{ oldText: "步骤", newText: "改了一半" }] }),
        call("bash", { command: "sleep 5" }),
      ]);
      hob.runtime.jobs.startSediment("t-sed", { into: skill.name });
      await waitFor(() => readFileSync(join(dir, "SKILL.md"), "utf8").includes("改了一半"));
      hob.runtime.jobs.recover();
      expect(hob.runtime.store.job("t-sed")?.sediment).toEqual({ status: "failed", reason: "Hob 重启，沉淀中断" });
      expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("步骤");
      expect(readFileSync(join(dir, "SKILL.md"), "utf8")).not.toContain("改了一半");
    } finally { hob.close(); }
  });

  it("删了技能目录、改了 skills.json、留下 __pycache__：都按底稿处理，不算改动", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const saved = saveAssistantSkill(hob.home, "hob", { ...skill, files: [{ path: "scripts/check.sh", content: "echo ok\n" }] });
      const root = join(hob.home, "assistants", "hob", "skills");
      hob.runtime.store.saveJob(doneJob());
      hob.faux.setResponses([
        call("bash", { command: `mkdir -p '${join(root, skill.name, "scripts", "__pycache__")}'` }),
        call("write", { path: join(root, "skills.json"), content: "{}" }),
        call("report", { outcome: "done", result: "没动技能" }),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment("t-sed", { into: skill.name });
      await hob.runtime.jobs.waitIdle();
      expect(existsSync(saved.path)).toBe(true);
      expect(readFileSync(join(root, skill.name, "scripts", "check.sh"), "utf8")).toBe("echo ok\n");
      expect(existsSync(join(root, skill.name, "scripts", "__pycache__"))).toBe(false);
      expect(listAssistantSkills(hob.home, "hob").map((item) => item.name)).toEqual([skill.name]);
      expect(listAssistantSkills(hob.home, "hob")[0]).toMatchObject({ version: 1 });
      expect(hob.runtime.store.job("t-sed")?.sediment).toEqual({ status: "empty", reason: "没动技能" });
    } finally { hob.close(); }
  });

  it("从定时任务来的任务新建技能：定时任务绑上，提示行换成定时那句", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "检查", schedules: ["0 9 * * *"] });
      hob.runtime.store.saveJob(doneJob({ routineId: routine.id }));
      const dir = join(hob.home, "assistants", "hob", "skills", "daily-check");
      hob.faux.setResponses([
        call("write", { path: join(dir, "SKILL.md"), content: head("daily-check", "每日巡检", "每天检查一遍") }),
        call("report", { outcome: "done", result: "建了技能" }),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.routine(routine.id)?.skill).toBe("daily-check");
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.text === "已沉淀技能「每日巡检」，以后定时执行按它做")).toBe(true);
    } finally { hob.close(); }
  });

  it("沉淀这一轮的工具和正常一轮一样，另有 write、edit，没有 save_skill", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, abilities: { exec: true, write: false, image: false } });
      const open = vi.spyOn(hob.runtime.pi, "open");
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const normal = await hob.runtime.jobs.start("hob", { title: "普通任务", instruction: "检查" });
      await waitFor(() => hob.runtime.store.job(normal.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      const normalTools = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile(normal.id))![0].tools!;
      expect(normalTools).not.toContain("write");
      expect(normalTools).not.toContain("edit");
      hob.runtime.store.saveJob(doneJob({ id: "t-sed" }));
      hob.faux.setResponses([call("report", { outcome: "done", result: "没改" }), text("好")]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      const sedimentTools = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile("t-sed"))![0].tools!;
      expect(new Set(sedimentTools)).toEqual(new Set([...normalTools, "write", "edit"]));
      expect(sedimentTools).not.toContain("save_skill");
      const prompt = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile("t-sed"))![0];
      expect(prompt.model).toBe(hob.runtime.store.job("t-sed")?.model);
    } finally { hob.close(); }
  });

  it("沉淀后续做：上一轮的沉淀结果还在", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", skill);
      hob.runtime.store.saveJob(doneJob());
      const dir = join(hob.home, "assistants", "hob", "skills", skill.name);
      hob.faux.setResponses([
        call("edit", { path: join(dir, "SKILL.md"), edits: [{ oldText: "步骤", newText: "第二次的步骤" }] }),
        call("report", { outcome: "done", result: "改了" }),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment("t-sed", { into: skill.name });
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job("t-sed")?.sediment).toMatchObject({ status: "saved", version: 2 });
      hob.faux.setResponses([call("report", { outcome: "done", result: "续做完成" }), text("完成")]);
      await hob.runtime.jobs.reply("t-sed", "再检查一遍");
      await waitFor(() => hob.runtime.store.job("t-sed")?.status === "done" && (hob.runtime.store.job("t-sed")?.rounds?.length ?? 0) === 1);
      await hob.runtime.jobs.waitIdle();
      const job = hob.runtime.store.job("t-sed")!;
      expect(job.rounds?.[0]?.sediment).toMatchObject({ status: "saved", name: skill.name, version: 2 });
      expect(job.sediment).toBeUndefined();
    } finally { hob.close(); }
  });

  it("一份技能的 SKILL.md 坏了，其他技能照常可用", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const good = saveAssistantSkill(hob.home, "hob", skill);
      const bad = saveAssistantSkill(hob.home, "hob", { ...skill, name: "beta-skill", title: "乙技能" });
      rmSync(bad.path);
      expect(usableAssistantSkills(hob.home, "hob").map((item) => item.name)).toEqual([skill.name]);
      expect(existsSync(good.path)).toBe(true);
      expect(error).toHaveBeenCalled();
    } finally { hob.close(); }
  });

  it("手动沉淀不带 into 时改这个任务沉淀出来的那份", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const earlier = saveAssistantSkill(hob.home, "hob", skill, "t-sed");
      saveAssistantSkill(hob.home, "hob", { ...skill, name: "other-skill", title: "别的技能" }, "t-other");
      hob.runtime.store.saveJob(doneJob());
      hob.faux.setResponses([
        call("edit", { path: earlier.path, edits: [{ oldText: "步骤", newText: "又一次" }] }),
        call("report", { outcome: "done", result: "改了" }),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment("t-sed", { manual: true });
      await hob.runtime.jobs.waitIdle();
      expect(listAssistantSkills(hob.home, "hob").find((item) => item.name === skill.name)?.version).toBe(2);
      expect(listAssistantSkills(hob.home, "hob").find((item) => item.name === "other-skill")?.version).toBe(1);
    } finally { hob.close(); }
  });

  it("沉淀消息按草稿带上技能目录或技能目录名", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const saved = saveAssistantSkill(hob.home, "hob", skill);
      hob.runtime.store.saveJob(doneJob());
      let message = "";
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([(context: any) => {
        const user = [...context.messages].reverse().find((item: any) => item.role === "user");
        message = typeof user?.content === "string" ? user.content : user?.content?.map((block: any) => block.text ?? "").join("") ?? "";
        return text("没有要沉淀的");
      }]);
      hob.runtime.jobs.startSediment("t-sed", { into: skill.name, note: "用户的反馈" });
      await hob.runtime.jobs.waitIdle();
      expect(message).toContain("技能写这一类事怎么做，不写这一次的经过和数据");
      expect(message).toContain(`这次在技能「${skill.title}」（${skill.name}，第 1 版）的基础上改：它在 ${dirname(saved.path)}，先读它现在的内容，再直接改这个目录里的文件。`);
      expect(message).toContain("「Hob」交代：用户的反馈");
      expect(message).toContain("写好以后调用 report，result 里写这次新建或改了哪些地方。");
      const dir = join(hob.home, "assistants", "hob", "skills");
      hob.faux.setResponses([(context: any) => {
        const user = [...context.messages].reverse().find((item: any) => item.role === "user");
        message = typeof user?.content === "string" ? user.content : user?.content?.map((block: any) => block.text ?? "").join("") ?? "";
        return text("没有要沉淀的");
      }]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(message).toContain(`这次新建一个技能，名字和说明按这一类事来起，不按这一次。建在 ${dir}/<名字>/`);
      expect(message).toContain("name: <名字>");
      expect(message).toContain("metadata:\n  title: <中文名，如「每周周报」>");
    } finally { hob.close(); }
  });

  it("沉淀时的 ask_user 不出卡片、不改任务状态", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(doneJob());
      const events: string[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "job") events.push(event.job.status); });
      hob.faux.setResponses([
        call("ask_user", { title: "要不要重跑", options: [{ label: "要" }, { label: "不要" }] }),
        call("report", { outcome: "done", result: "没改" }),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      const ask = hob.runtime.jobs.transcript("t-sed").find((step) => step.name === "ask_user");
      expect(ask?.output).toBe("沉淀时不用问：拿不准的地方，在技能里写成执行前要确认的一步。");
      expect(hob.runtime.store.approvals()).toEqual([]);
      expect(events.every((status) => status === "done")).toBe(true);
    } finally { hob.close(); }
  });

  it("底稿只在沉淀进行中存在：开始时拍，收尾删掉", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", skill);
      hob.runtime.store.saveJob(doneJob());
      const base = join(hob.runtime.store.jobDir("t-sed"), "sediment-base");
      let during: string[] = [];
      hob.faux.setResponses([
        () => { during = readdirSync(base).sort(); return call("report", { outcome: "done", result: "没改" }); },
        text("好"),
      ]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(during).toEqual([".snapshot-ready", ".target.json", skill.name, "skills.json"]);
      expect(existsSync(base)).toBe(false);
      expect(existsSync(join(hob.runtime.store.jobDir("t-sed"), "sediment"))).toBe(false);
    } finally { hob.close(); }
  });

  it("同一个助手的沉淀一个个来：后一次拿到的是前一次存好以后的底稿", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const saved = saveAssistantSkill(hob.home, "hob", skill);
      hob.runtime.store.saveJob(doneJob({ id: "t-sa" }));
      hob.runtime.store.saveJob(doneJob({ id: "t-sb" }));
      hob.faux.setResponses([
        call("edit", { path: saved.path, edits: [{ oldText: "步骤", newText: "第一次" }] }),
        call("report", { outcome: "done", result: "改了" }),
        text("好"),
        call("edit", { path: saved.path, edits: [{ oldText: "第一次", newText: "第二次" }] }),
        call("report", { outcome: "done", result: "又改了" }),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment("t-sa", { into: skill.name });
      hob.runtime.jobs.startSediment("t-sb", { into: skill.name });
      expect(hob.runtime.store.job("t-sb")?.sediment).toEqual({ status: "running" });
      await hob.runtime.jobs.waitIdle();
      expect(listAssistantSkills(hob.home, "hob")[0]).toMatchObject({ version: 3, fromJobId: "t-sb" });
      const history = join(dirname(saved.path), ".history");
      expect(readFileSync(join(history, "1", "SKILL.md"), "utf8")).toContain("步骤");
      expect(readFileSync(join(history, "2", "SKILL.md"), "utf8")).toContain("第一次");
      expect(readFileSync(saved.path, "utf8")).toContain("第二次");
      expect(hob.runtime.store.job("t-sa")?.sediment).toMatchObject({ status: "saved", version: 2 });
      expect(hob.runtime.store.job("t-sb")?.sediment).toMatchObject({ status: "saved", version: 3 });
    } finally { hob.close(); }
  });

  it("排队的沉淀被接着说停下：不等前面那个，直接开新一轮", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(doneJob({ id: "t-sa" }));
      hob.runtime.store.saveJob(doneJob({ id: "t-sb" }));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([
        async () => { await gate; return call("report", { outcome: "done", result: "没改" }); },
        call("report", { outcome: "done", result: "续做完成" }),
        text("完成"),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment("t-sa");
      hob.runtime.jobs.startSediment("t-sb");
      await hob.runtime.jobs.reply("t-sb", "补充");
      expect(hob.runtime.store.job("t-sb")?.sediment).toBeUndefined();
      await waitFor(() => hob.runtime.store.job("t-sb")?.status === "done" && (hob.runtime.store.job("t-sb")?.rounds?.length ?? 0) === 1);
      expect(hob.runtime.store.job("t-sa")?.sediment).toEqual({ status: "running" });
      release();
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job("t-sa")?.sediment).toEqual({ status: "empty", reason: "没改" });
      expect(hob.runtime.store.job("t-sb")?.sediment).toBeUndefined();
    } finally { hob.close(); }
  });

  it("沉淀期间别处改的用量和开关、别处加的技能，对账和恢复都不动它们", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", { ...skill, name: "other-skill", title: "别的技能" });
      hob.runtime.store.saveJob(doneJob());
      const root = join(hob.home, "assistants", "hob", "skills");
      hob.faux.setResponses([
        () => {
          recordAssistantSkillUse(hob.home, "hob", "other-skill");
          setAssistantSkillEnabled(hob.home, "hob", "other-skill", false);
          return call("write", { path: join(root, "new-skill", "SKILL.md"), content: head("new-skill", "新技能", "新的一类事") });
        },
        call("report", { outcome: "done", result: "建了" }),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      const all = listAssistantSkills(hob.home, "hob");
      expect(all.find((item) => item.name === "other-skill")).toMatchObject({ uses: 1, enabled: false, version: 1 });
      expect(all.find((item) => item.name === "new-skill")).toMatchObject({ version: 1, fromJobId: "t-sed" });

      // 恢复：模型改坏的换回底稿、新建没登记的删掉；别处导入的、删掉的、记的用量照现在的
      const base = join(hob.home, "base");
      snapshotSkills(root, base);
      saveAssistantSkill(hob.home, "hob", { ...skill, name: "imported-skill", title: "导入的" });
      recordAssistantSkillUse(hob.home, "hob", "new-skill");
      archiveAssistantSkill(hob.home, "hob", "other-skill");
      writeFileSync(join(root, "new-skill", "SKILL.md"), "改坏了");
      mkdirSync(join(root, "half-done"));
      writeFileSync(join(root, "half-done", "SKILL.md"), head("half-done", "半成品", "没写完"));
      restoreSkills(root, base);
      expect(readFileSync(join(root, "new-skill", "SKILL.md"), "utf8")).toContain("新的一类事");
      expect(existsSync(join(root, "half-done"))).toBe(false);
      expect(existsSync(join(root, "other-skill"))).toBe(false);
      const after = listAssistantSkills(hob.home, "hob");
      expect(after.map((item) => item.name).sort()).toEqual(["imported-skill", "new-skill"]);
      expect(after.find((item) => item.name === "new-skill")?.uses).toBe(1);

      // 对账也一样：设置里删掉的不放回去
      snapshotSkills(root, base);
      archiveAssistantSkill(hob.home, "hob", "imported-skill");
      expect(reconcileSkills(root, base, "t-sed")).toEqual({ ok: true, saved: [] });
      expect(existsSync(join(root, "imported-skill"))).toBe(false);
    } finally { hob.close(); }
  });

  it("模型出错停下：改了一半的照底稿恢复，记失败并通知助手", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const saved = saveAssistantSkill(hob.home, "hob", skill);
      hob.runtime.store.saveJob(doneJob());
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([
        call("edit", { path: saved.path, edits: [{ oldText: "步骤", newText: "改了一半" }] }),
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "API error (400): bad request" }),
      ]);
      hob.runtime.jobs.startSediment("t-sed", { into: skill.name });
      await hob.runtime.jobs.waitIdle();
      expect(readFileSync(saved.path, "utf8")).toContain("步骤");
      expect(readFileSync(saved.path, "utf8")).not.toContain("改了一半");
      expect(listAssistantSkills(hob.home, "hob")[0]).toMatchObject({ version: 1 });
      expect(hob.runtime.store.job("t-sed")?.sediment).toEqual({ status: "failed", reason: "API error (400): bad request" });
      expect(notify).toHaveBeenCalledWith("hob", "任务「巡检」（t-sed）沉淀完了：沉淀失败，API error (400): bad request。");
    } finally { hob.close(); }
  });

  it("SKILL.md 开头写错读不出来：report 说清原因，改好再交", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(doneJob());
      const dir = join(hob.home, "assistants", "hob", "skills", "bad-yaml");
      hob.faux.setResponses([
        call("write", { path: join(dir, "SKILL.md"), content: "---\nname: bad-yaml\ndescription: 用法: 先查: 再改\nmetadata:\n  title: 坏开头\n---\n正文\n" }),
        call("report", { outcome: "done", result: "建好了" }),
        call("write", { path: join(dir, "SKILL.md"), content: "---\nname: bad-yaml\ndescription: \"用法: 先查: 再改\"\nmetadata:\n  title: 坏开头\n---\n正文\n" }),
        call("report", { outcome: "done", result: "加了引号" }),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      const reports = hob.runtime.jobs.transcript("t-sed").filter((step) => step.name === "report");
      expect(reports[0].isError).toBe(true);
      expect(reports[0].output).toContain("技能还没存上：「bad-yaml」的 SKILL.md 开头读不出来：");
      expect(reports[1].output).toBe("技能已保存。");
      expect(listAssistantSkills(hob.home, "hob")[0]).toMatchObject({ name: "bad-yaml", description: "用法: 先查: 再改", version: 1 });
    } finally { hob.close(); }
  });

  it("沉淀这一轮没有新的会话文件，对话写在任务自己的会话里", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("report", { outcome: "done", result: "首次完成" }), text("完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "巡检", instruction: "检查" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      const dir = join(hob.home, "assistants", "hob", "skills", "later");
      hob.faux.setResponses([
        call("write", { path: join(dir, "SKILL.md"), content: head("later", "以后的事", "以后还会再做") }),
        call("report", { outcome: "done", result: "建好了" }),
        text("好"),
      ]);
      hob.runtime.jobs.startSediment(job.id);
      await hob.runtime.jobs.waitIdle();
      expect(readFileSync(hob.runtime.store.workerFile(job.id), "utf8")).toContain("回顾刚才的过程");
      const steps = hob.runtime.jobs.transcript(job.id);
      expect(steps.some((step) => step.kind === "text" && step.text === "沉淀技能")).toBe(true);
      expect(steps.some((step) => step.kind === "tool" && step.name === "report")).toBe(true);
      expect(existsSync(join(hob.runtime.store.jobDir(job.id), "sediment"))).toBe(false);
    } finally { hob.close(); }
  });

  it("沉淀的用量记进任务的用量", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob(doneJob({ usage: { input: 10, output: 5, cost: 0.01 } }));
      hob.faux.setResponses([call("report", { outcome: "done", result: "没改" }), text("好")]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job("t-sed")?.usage?.input).toBeGreaterThan(10);
    } finally { hob.close(); }
  });
});
