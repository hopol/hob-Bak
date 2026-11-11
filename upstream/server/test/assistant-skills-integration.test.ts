import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Assistant } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { assistantJobResultEvent } from "../src/jobs.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { activityLabel } from "../src/router-activity.ts";
import { combinedSkills, loadedSkills, groupSkillsDir, listAssistantSkills, saveAssistantSkill, saveSkill, setAssistantSkillEnabled, usableAssistantSkills } from "../src/assistant-skills.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const input = { name: "daily-check", title: "每日巡检", description: "日常巡检时使用", content: "步骤" };

describe("助手技能接入", () => {
  it("只加载本助手启用的技能", () => {
    const hob = makeHob();
    try {
      saveAssistantSkill(hob.home, "hob", input);
      expect(loadedSkills(combinedSkills(hob.home, "hob")).map((skill) => skill.name)).toEqual([input.name]);
      expect(loadedSkills(combinedSkills(hob.home, "other"))).toEqual([]);
      setAssistantSkillEnabled(hob.home, "hob", input.name, false);
      expect(loadedSkills(combinedSkills(hob.home, "hob"))).toEqual([]);
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
      expect((await req(`/api/routines/${routine.id}`, "PATCH", { skill: input.name })).status).toBe(400);
      setAssistantSkillEnabled(hob.home, "hob", input.name, true);
      expect((await req(`/api/routines/${routine.id}`, "PATCH", { skill: input.name })).status).toBe(200);
      setAssistantSkillEnabled(hob.home, "hob", input.name, false);
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
  it("一份技能文件坏了，别的技能照常可用，助手照样能派任务、开对话", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const skill = saveAssistantSkill(hob.home, "hob", input);
      const other = saveAssistantSkill(hob.home, "hob", { ...input, name: "other-check", title: "别的巡检" });
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
      expect(usableAssistantSkills(hob.home, "hob").map((item) => item.name)).toEqual(["other-check"]);
      expect(loadedSkills(combinedSkills(hob.home, "hob")).map((item) => item.name)).toEqual(["other-check"]);
      const path = join(hob.home, "assistants", "hob", "skills", other.name, "SKILL.md");
      expect(path.endsWith("SKILL.md")).toBe(true);
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
  it("事项子任务能用成员全部技能，并按实际使用决定沉淀提醒", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      const dev: Assistant = { ...base, id: "dev", name: "开发", duty: "写代码", primary: false, pinned: false, instructions: "" };
      const qa: Assistant = { ...base, id: "qa", name: "测试", duty: "验收", primary: false, pinned: false, instructions: "" };
      hob.runtime.store.saveAssistant(dev);
      hob.runtime.store.saveAssistant(qa);
      const first = saveAssistantSkill(hob.home, "dev", input);
      const second = saveAssistantSkill(hob.home, "dev", { ...input, name: "release-check", title: "发布检查" });
      const group = hob.runtime.groups.create({ name: "技能事项", purpose: "验证子任务技能", workflow: "software", ownerId: "hob", members: ["hob", "dev", "qa"] });
      const groupSkill = saveSkill(groupSkillsDir(hob.home, group.id), { name: "group-skill", title: "团队经验", description: "团队做事", content: "步骤" });
      const project = hob.runtime.projects.open({ group, ownerId: "hob", title: "开发技能任务" });
      hob.runtime.projects.writeRequirements(group.id, project.id, { content: "做一件事", acceptance: ["完成"] });
      hob.runtime.projects.plan(group.id, project.id, [{ title: "开发", assignee: "dev", brief: "读发布检查技能后完成" }]);
      const open = vi.spyOn(hob.runtime.pi, "open");
      hob.faux.setResponses([call("read", { path: second.path }), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      hob.runtime.projects.start(group.id, project.id);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, project.id)?.subtasks[0]?.jobId));
      const devJobId = hob.runtime.store.project(group.id, project.id)!.subtasks[0]!.jobId!;
      await waitFor(() => hob.runtime.store.job(devJobId)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      const devJob = hob.runtime.store.job(devJobId)!;
      const devOpen = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile(devJobId))?.[0];
      expect(devOpen?.skills?.find((skill) => skill.name === groupSkill.name)?.filePath).toBe(groupSkill.path);
      expect(devOpen?.skills?.filter((skill) => [first.name, second.name].includes(skill.name)).map((skill) => skill.name)).toEqual([first.name, second.name]);
      expect(devOpen?.systemPrompt()).toContain("「开发」的技能是以前做成过的做法，用得上的照着做。");
      expect(devJob.skills).toBeUndefined();
      expect(devJob.skillsUsed).toEqual([second.name]);
      expect(assistantJobResultEvent(hob.home, devJob)).not.toContain("save_job_as_skill");

      const emptyProject = hob.runtime.projects.open({ group, ownerId: "hob", title: "无技能任务" });
      hob.runtime.projects.writeRequirements(group.id, emptyProject.id, { content: "再做一件事", acceptance: ["完成"] });
      hob.runtime.projects.plan(group.id, emptyProject.id, [{ title: "验收", assignee: "qa", brief: "完成" }]);
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      hob.runtime.projects.start(group.id, emptyProject.id);
      await waitFor(() => Boolean(hob.runtime.store.project(group.id, emptyProject.id)?.subtasks[0]?.jobId));
      const qaJobId = hob.runtime.store.project(group.id, emptyProject.id)!.subtasks[0]!.jobId!;
      await waitFor(() => hob.runtime.store.job(qaJobId)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      const qaJob = hob.runtime.store.job(qaJobId)!;
      const qaOpen = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile(qaJobId))?.[0];
      expect(qaOpen?.skills?.some((skill) => skill.name === groupSkill.name)).toBe(true);
      expect(assistantJobResultEvent(hob.home, qaJob)).toContain("save_job_as_skill");
    } finally { hob.close(); }
  });
});
