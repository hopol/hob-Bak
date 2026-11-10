import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { activityLabel } from "../src/router-activity.ts";
import { enabledAssistantSkills, listAssistantSkills, readSkillFiles, saveAssistantSkill, setAssistantSkillEnabled } from "../src/assistant-skills.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const input = { name: "daily-check", title: "每日巡检", description: "日常巡检时使用", content: "步骤" };

describe("助手技能接入", () => {
  it("只加载本助手启用的技能", () => {
    const hob = makeHob();
    try {
      saveAssistantSkill(hob.home, "hob", input);
      expect(enabledAssistantSkills(hob.home, "hob").map((skill) => skill.name)).toEqual([input.name]);
      expect(enabledAssistantSkills(hob.home, "other")).toEqual([]);
      setAssistantSkillEnabled(hob.home, "hob", input.name, false);
      expect(enabledAssistantSkills(hob.home, "hob")).toEqual([]);
    } finally { hob.close(); }
  });
  it("技能接口和定时绑定校验", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const req = (url: string, method = "GET", body?: unknown) => app.request(url, { method, headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const path = "/api/assistants/hob/skills/daily-check";
      saveAssistantSkill(hob.home, "hob", input);
      expect((await (await req("/api/assistants/hob/skills")).json() as unknown[])).toHaveLength(1);
      expect((await req(path, "PATCH", { enabled: false })).status).toBe(200);
      expect((await req(`${path}/rollback`, "POST")).status).toBe(400);
      saveAssistantSkill(hob.home, "hob", { ...input, content: "新版" });
      expect((await req(`${path}/rollback`, "POST")).status).toBe(200);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "检查", schedules: ["0 9 * * *"] });
      expect((await req(`/api/routines/${routine.id}`, "PATCH", { skill: "missing" })).status).toBe(400);
      expect((await req(`/api/routines/${routine.id}`, "PATCH", { skill: input.name })).status).toBe(200);
      const start = vi.spyOn(hob.runtime.jobs, "start").mockResolvedValue({} as never);
      await hob.runtime.routines.runNow(routine.id);
      expect(start.mock.calls[0][1].instruction).toBe("检查");
      setAssistantSkillEnabled(hob.home, "hob", input.name, true);
      await hob.runtime.routines.runNow(routine.id);
      expect(start.mock.calls[1][1].instruction).toBe("按技能「每日巡检」做（先读它的 SKILL.md）。\n检查");
      expect(start.mock.calls[1][1].skills).toEqual([input.name]);
      expect((await req(`/api/routines/${routine.id}`, "PATCH", { skill: null })).status).toBe(200);
      expect((await req("/api/jobs/missing/sediment", "POST")).status).toBe(404);
      hob.runtime.store.saveJob({ id: "t-running", assistantId: "hob", title: "任务", instruction: "检查", status: "running", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      expect((await req("/api/jobs/t-running/sediment", "POST")).status).toBe(409);
      expect((await req(path, "DELETE")).status).toBe(200);
    } finally { hob.close(); }
  });
  it("助手创建、修改定时任务时绑定和解绑技能", async () => {
    const hob = makeHob();
    try {
      saveAssistantSkill(hob.home, "hob", input);
      const tools = buildRouterTools(hob.runtime, "hob");
      const create = tools.find((tool) => tool.name === "create_routine")!;
      const update = tools.find((tool) => tool.name === "update_routine")!;
      const createArgs = { name: "巡检", instruction: "检查", schedules: ["0 9 * * *"] };
      expect((await create.execute("id", { ...createArgs, skill: "missing" }, undefined, undefined, {} as never)).isError).toBe(true);
      await create.execute("id", { ...createArgs, skill: input.name }, undefined, undefined, {} as never);
      const routine = hob.runtime.store.routines().find((item) => item.name === "巡检")!;
      expect(routine.skill).toBe(input.name);
      expect((await update.execute("id", { routineId: routine.id, skill: "missing" }, undefined, undefined, {} as never)).isError).toBe(true);
      await update.execute("id", { routineId: routine.id, skill: "" }, undefined, undefined, {} as never);
      expect(hob.runtime.store.routine(routine.id)?.skill).toBeUndefined();
    } finally { hob.close(); }
  });
  it("任务读取技能只记一次用量", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const skill = saveAssistantSkill(hob.home, "hob", input);
      const global = join(hob.home, "skills", input.name);
      mkdirSync(global, { recursive: true });
      writeFileSync(join(global, "SKILL.md"), `---\nname: ${input.name}\ndescription: 全局技能\n---\n全局`);
      const open = vi.spyOn(hob.runtime.pi, "open");
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("read", { path: skill.path }), call("read", { path: skill.path }), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "巡检", instruction: "检查", skills: [input.name] });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done");
      expect(hob.runtime.store.job(job.id)?.skillsUsed).toEqual([input.name]);
      expect(listAssistantSkills(hob.home, "hob")[0].uses).toBe(1);
      const workerOpen = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile(job.id))?.[0];
      expect(workerOpen?.skills?.filter((item) => item.name === input.name).map((item) => item.filePath)).toEqual([skill.path]);
      await hob.runtime.jobs.waitIdle();
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const other = await hob.runtime.jobs.start("hob", { title: "其他", instruction: "检查" });
      await waitFor(() => hob.runtime.store.job(other.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      const otherOpen = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile(other.id))?.[0];
      expect(otherOpen?.skills?.some((item) => item.filePath === skill.path)).toBe(false);
      expect(otherOpen?.skills?.some((item) => item.filePath === join(global, "SKILL.md"))).toBe(true);
    } finally { hob.close(); }
  });
  it("Router 工具只允许沉淀本助手的任务", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.saveJob({ id: "t-other", assistantId: "other", title: "任务", instruction: "检查", status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "save_job_as_skill")!;
      const result = await tool.execute("call", { jobId: "t-other" }, undefined, undefined, {} as never);
      expect(result.isError).toBe(true);
      expect(activityLabel("save_job_as_skill")).toBe("沉淀技能");
    } finally { hob.close(); }
  });
  it("定时任务完成后不自动沉淀", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const sediment = vi.spyOn(hob.runtime.jobs, "startSediment");
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "检查", schedules: ["0 9 * * *"] });
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const job = (await hob.runtime.routines.runNow(routine.id)).job!;
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      expect(sediment).not.toHaveBeenCalled();
      expect(listAssistantSkills(hob.home, "hob")).toEqual([]);
    } finally { hob.close(); }
  });
  it("照着技能顺利做完的定时执行不再自动沉淀", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const sediment = vi.spyOn(hob.runtime.jobs, "startSediment").mockImplementation(() => {});
      const skill = saveAssistantSkill(hob.home, "hob", input);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "检查", schedules: ["0 9 * * *"] });
      hob.runtime.routines.update(routine.id, { skill: input.name });
      hob.faux.setResponses([call("read", { path: skill.path }), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const job = (await hob.runtime.routines.runNow(routine.id)).job!;
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)?.skillsUsed).toEqual([input.name]);
      expect(sediment).not.toHaveBeenCalled();
    } finally { hob.close(); }
  });
  it("技能文件坏了，助手照样能派任务、开对话", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const skill = saveAssistantSkill(hob.home, "hob", input);
      rmSync(skill.path);
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "任务", instruction: "检查" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      hob.faux.setResponses([text("在。")]);
      await hob.runtime.router.send("hob", { text: "在吗" });
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "assistant" && item.text === "在。")).toBe(true);
      expect(error).toHaveBeenCalled();
    } finally { hob.close(); }
  });
  it("长任务和失败任务都不自动沉淀", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const sediment = vi.spyOn(hob.runtime.jobs, "startSediment").mockImplementation(() => {});
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const short = await hob.runtime.jobs.start("hob", { title: "短任务", instruction: "检查" });
      await waitFor(() => hob.runtime.store.job(short.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      expect(sediment).not.toHaveBeenCalled();
      hob.faux.setResponses([...Array.from({ length: 20 }, () => call("ls", { path: "." })), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const long = await hob.runtime.jobs.start("hob", { title: "长任务", instruction: "检查" });
      await waitFor(() => hob.runtime.store.job(long.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      expect(sediment).not.toHaveBeenCalled();
      hob.faux.setResponses([...Array.from({ length: 20 }, () => call("ls", { path: "." })), call("report", { outcome: "stuck", result: "失败" }), text("完成")]);
      const failed = await hob.runtime.jobs.start("hob", { title: "失败任务", instruction: "检查" });
      await waitFor(() => hob.runtime.store.job(failed.id)?.status === "stuck");
      expect(sediment.mock.calls.some(([id]) => id === failed.id)).toBe(false);
    } finally { hob.close(); }
  });
  it("续做成功后不自动沉淀", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const sediment = vi.spyOn(hob.runtime.jobs, "startSediment").mockImplementation(() => {});
      hob.faux.setResponses([call("report", { outcome: "done", result: "首次完成" }), text("完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "任务", instruction: "检查" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done");
      hob.faux.setResponses([call("report", { outcome: "done", result: "续做完成" }), text("完成")]);
      await hob.runtime.jobs.reply(job.id, "补充检查");
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done" && !!hob.runtime.store.job(job.id)?.rounds?.length);
      await hob.runtime.jobs.waitIdle();
      expect(sediment).not.toHaveBeenCalled();
    } finally { hob.close(); }
  });
  it("附件用 from 从工作目录复制，不能跳出工作目录", () => {
    const base = mkdtempSync(join(tmpdir(), "hob-skill-from-"));
    try {
      const cwd = join(base, "work");
      mkdirSync(join(cwd, "sub"), { recursive: true });
      writeFileSync(join(cwd, "sub", "check.py"), "print('ok')\n");
      writeFileSync(join(base, "secret.txt"), "不能复制");
      symlinkSync(join(base, "secret.txt"), join(cwd, "link.txt"));
      expect(readSkillFiles(cwd, undefined)).toBeUndefined();
      expect(readSkillFiles(cwd, [{ path: "scripts/a.py", content: "x" }, { path: "scripts/check.py", from: "sub/check.py" }]))
        .toEqual([{ path: "scripts/a.py", content: "x" }, { path: "scripts/check.py", content: "print('ok')\n" }]);
      expect(readSkillFiles(cwd, [{ path: "scripts/check.py", from: join(cwd, "sub", "check.py") }])?.[0]?.content).toBe("print('ok')\n");
      expect(() => readSkillFiles(cwd, [{ path: "scripts/x", from: "../secret.txt" }])).toThrow("from 只能是工作目录里的文件");
      expect(() => readSkillFiles(cwd, [{ path: "scripts/x", from: "link.txt" }])).toThrow("from 只能是工作目录里的文件");
      expect(() => readSkillFiles(cwd, [{ path: "scripts/x", from: "sub" }])).toThrow("from 不是文件");
      expect(() => readSkillFiles(cwd, [{ path: "scripts/x", from: "missing.py" }])).toThrow("找不到 from 指向的文件");
      expect(() => readSkillFiles(cwd, [{ path: "scripts/x", content: "x", from: "sub/check.py" }])).toThrow("只给一个");
      expect(() => readSkillFiles(cwd, [{ path: "scripts/x" }])).toThrow("只给一个");
      expect(readSkillFiles(cwd, [{ path: "scripts/check.py", content: "", from: "sub/check.py" }])?.[0]?.content).toBe("print('ok')\n");
      expect(readSkillFiles(cwd, [{ path: "scripts/a.py", content: "x", from: "" }])?.[0]?.content).toBe("x");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it("沉淀消息包含复用要求和已有技能", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", input);
      const job = { id: "t-prompt", assistantId: "hob", title: "任务", instruction: "检查", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off" as const };
      hob.runtime.store.saveJob(job);
      let message = "";
      hob.faux.setResponses([(context: any) => {
        const user = [...context.messages].reverse().find((item: any) => item.role === "user");
        message = typeof user?.content === "string" ? user.content : user?.content?.map((block: any) => block.text ?? "").join("") ?? "";
        return text("没有需要沉淀的");
      }]);
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.jobs.startSediment(job.id, { into: input.name, note: "用户的反馈" });
      await hob.runtime.jobs.waitIdle();
      expect(message).toContain("技能写这一类事怎么做，不写这一次的经过和数据");
      expect(message).toContain(`这次在技能「${input.title}」（${input.name}，第 1 版）的基础上改，先读它现在的内容。`);
      expect(message).toContain("交代：用户的反馈");
    } finally { hob.close(); }
  });
  it("没有调用保存工具时不生成技能", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const job = { id: "t-no-save", assistantId: "hob", title: "任务", instruction: "检查", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off" as const };
      hob.runtime.store.saveJob(job);
      hob.faux.setResponses([text("没有需要沉淀的")]);
      hob.runtime.jobs.startSediment(job.id);
      await waitFor(() => hob.runtime.jobs.transcript(job.id).some((step) => step.text === "没有需要沉淀的"));
      expect(listAssistantSkills(hob.home, "hob")).toEqual([]);
      await hob.runtime.jobs.waitIdle();
    } finally { hob.close(); }
  });
  it.each(["没有需要沉淀的，因为这次只是一次性操作", "没有需要沉淀的", ""])("没有技能时写状态并通知助手：%s", async (reply) => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const job = { id: "t-no-result", assistantId: "hob", title: "巡检", instruction: "检查", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off" as const };
      hob.runtime.store.saveJob(job);
      const events: string[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "job" && event.job.id === job.id) events.push(event.job.sediment?.status ?? ""); });
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([text(reply)]);
      hob.runtime.jobs.startSediment(job.id);
      await hob.runtime.jobs.waitIdle();
      const notes = hob.runtime.router.items("hob").items.filter((item) => item.kind === "note" && item.icon === "skill");
      expect(notes).toEqual([]);
      expect(events).toEqual(["running", "empty"]);
      expect(notify).toHaveBeenCalledWith("hob", expect.stringContaining("沉淀完了：没有沉淀"));
    } finally { hob.close(); }
  });
  it("沉淀失败后仍发送结束事件并保留失败提示", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const job = { id: "t-error", assistantId: "hob", title: "巡检", instruction: "检查", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off" as const };
      hob.runtime.store.saveJob(job);
      vi.spyOn(hob.runtime.pi, "open").mockRejectedValueOnce(new Error("模型不可用"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.jobs.startSediment(job.id);
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)?.sediment).toEqual({ status: "failed", reason: "模型不可用" });
      expect(notify).toHaveBeenCalledWith("hob", expect.stringContaining("沉淀失败，模型不可用"));
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.text === "技能沉淀失败：模型不可用")).toBe(true);
    } finally { hob.close(); }
  });
  it("每轮每个技能只新增一个版本，后续保存覆盖内容和附件", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", { ...input, files: [{ path: "references/keep.txt", content: "保留" }, { path: "scripts/check.sh", content: "旧版" }] });
      const job = { id: "t-versions", assistantId: "hob", title: "巡检", instruction: "检查", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off" as const };
      hob.runtime.store.saveJob(job);
      hob.faux.setResponses([
        call("save_skill", { ...input, content: "第一次", files: [{ path: "scripts/check.sh", content: "第一次" }] }),
        call("save_skill", { ...input, content: "第二次", files: [{ path: "scripts/check.sh", content: "第二次" }, { path: "references/new.txt", content: "新附件" }] }),
        text("完成"),
      ]);
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.jobs.startSediment(job.id, { into: input.name });
      await hob.runtime.jobs.waitIdle();
      const root = join(hob.home, "assistants", "hob", "skills");
      const skills = listAssistantSkills(hob.home, "hob");
      expect(skills.find((skill) => skill.name === input.name)?.version).toBe(2);
      expect(readdirSync(join(root, input.name, ".history"))).toEqual(["1"]);
      expect(readFileSync(join(root, input.name, ".history", "1", "scripts", "check.sh"), "utf8")).toBe("旧版");
      expect(readFileSync(join(root, input.name, "SKILL.md"), "utf8")).toContain("第二次");
      expect(readFileSync(join(root, input.name, "scripts", "check.sh"), "utf8")).toBe("第二次");
      expect(readFileSync(join(root, input.name, "references", "keep.txt"), "utf8")).toBe("保留");
      expect(readFileSync(join(root, input.name, "references", "new.txt"), "utf8")).toBe("新附件");
      const notes = () => hob.runtime.router.items("hob").items.filter((item) => item.kind === "note" && item.icon === "skill");
      expect(notes()).toHaveLength(1);
      hob.faux.setResponses([call("save_skill", { ...input, content: "下一轮" }), text("完成")]);
      hob.runtime.jobs.startSediment(job.id, { into: input.name });
      await hob.runtime.jobs.waitIdle();
      expect(listAssistantSkills(hob.home, "hob").find((skill) => skill.name === input.name)?.version).toBe(3);
      expect(readdirSync(join(root, input.name, ".history")).sort()).toEqual(["1", "2"]);
      expect(readFileSync(join(root, input.name, ".history", "2", "SKILL.md"), "utf8")).toContain("第二次");
      expect(notes()).toHaveLength(2);
    } finally { hob.close(); }
  });
  it("原任务会话沉淀，保存后绑定定时并通知", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "检查", schedules: ["0 9 * * *"] });
      const cwd = hob.runtime.store.workDir("t-test");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, "check.sh"), "echo ok\n");
      const job = { id: "t-test", assistantId: "hob", title: "巡检", instruction: "检查", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off" as const, routineId: routine.id, cwd };
      hob.runtime.store.saveJob(job);
      const events: string[] = [];
      hob.runtime.bus.subscribe((event) => events.push(event.type));
      const open = vi.spyOn(hob.runtime.pi, "open");
      hob.faux.setResponses([call("save_skill", { ...input, files: [{ path: "scripts/check.sh", from: "check.sh" }] }), text("完成")]);
      hob.runtime.jobs.startSediment(job.id);
      await waitFor(() => events.includes("skills"));
      expect(readFileSync(join(hob.home, "assistants", "hob", "skills", input.name, "scripts", "check.sh"), "utf8")).toBe("echo ok\n");
      expect(open.mock.calls[0][0].tools).toEqual(["read", "ls", "grep", "find", "bash", "save_skill"]);
      expect(listAssistantSkills(hob.home, "hob")).toHaveLength(1);
      expect(hob.runtime.store.routine(routine.id)?.skill).toBe(input.name);
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.icon === "skill" && !!item.path)).toBe(true);
      await waitFor(() => hob.runtime.jobs.transcript(job.id).some((step) => step.title === "保存技能：每日巡检"));
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)?.sediment).toMatchObject({ status: "saved", name: input.name, version: 1, updated: false });
    } finally { hob.close(); }
  });
});
