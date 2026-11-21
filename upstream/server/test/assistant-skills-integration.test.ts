import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Assistant } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { assistantJobResultEvent } from "../src/jobs.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { activityLabel } from "../src/router-activity.ts";
import { combinedSkills, groupSkillsDir, listAssistantSkills, saveAssistantSkill, saveSkill, setAssistantSkillEnabled, usableAssistantSkills } from "../src/assistant-skills.ts";
import { loadedVisibleSkills, visibleSkills } from "../src/skills.ts";
import { deleteSkill } from "../src/delete-skill.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const input = { name: "daily-check", title: "每日巡检", description: "日常巡检时使用", content: "步骤" };

describe("助手技能接入", () => {
  it("只加载本助手启用的技能", () => {
    const hob = makeHob();
    try {
      saveAssistantSkill(hob.home, "hob", input);
      expect(loadedVisibleSkills(visibleSkills(hob.runtime, "hob")).map((skill) => skill.name)).toEqual([input.name]);
      expect(loadedVisibleSkills(visibleSkills(hob.runtime, "other"))).toEqual([]);
      setAssistantSkillEnabled(hob.home, "hob", input.name, false);
      expect(loadedVisibleSkills(visibleSkills(hob.runtime, "hob"))).toEqual([]);
    } finally { hob.close(); }
  });
  it("技能接口正常工作，定时任务不再绑定技能", async () => {
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
      expect((await req(`/api/routines/${routine.id}`, "PATCH", { skill: "missing" })).status).toBe(200);
      expect((await req(`/api/routines/${routine.id}`, "PATCH", { skill: input.name })).status).toBe(200);
      expect(hob.runtime.store.routine(routine.id)).not.toHaveProperty("skill");
      expect((await req(`/api/jobs/missing/sediment`, "POST")).status).toBe(404);
      hob.runtime.store.saveJob({ id: "t-running", assistantId: "hob", title: "任务", instruction: "检查", status: "running", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      expect((await req("/api/jobs/t-running/sediment", "POST")).status).toBe(409);
      expect((await req(path, "DELETE")).status).toBe(200);
    } finally { hob.close(); }
  });
  it("助手创建、修改定时任务时忽略旧的技能字段", async () => {
    const hob = makeHob();
    try {
      saveAssistantSkill(hob.home, "hob", input);
      const tools = buildRouterTools(hob.runtime, "hob");
      const create = tools.find((tool) => tool.name === "create_routine")!;
      const update = tools.find((tool) => tool.name === "update_routine")!;
      const createArgs = { name: "巡检", instruction: "检查", schedules: ["0 9 * * *"] };
      expect((await create.execute("id", { ...createArgs, skill: "missing" }, undefined, undefined, {} as never)).isError).not.toBe(true);
      const routine = hob.runtime.store.routines().find((item) => item.name === "巡检")!;
      expect(routine).not.toHaveProperty("skill");
      expect((await update.execute("id", { routineId: routine.id, skill: input.name }, undefined, undefined, {} as never)).isError).not.toBe(true);
      expect(hob.runtime.store.routine(routine.id)).not.toHaveProperty("skill");
    } finally { hob.close(); }
  });
  it("任务加载全部启用的沉淀技能和通用技能，读过的只记一次用量", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const skill = saveAssistantSkill(hob.home, "hob", input);
      const global = join(hob.home, "skills", input.name);
      mkdirSync(global, { recursive: true });
      writeFileSync(join(global, "SKILL.md"), `---\nname: ${input.name}\ndescription: 全局技能\n---\n全局`);
      const open = vi.spyOn(hob.runtime.pi, "open");
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("read", { path: skill.path }), call("read", { path: skill.path }), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "巡检", instruction: "检查" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done");
      expect(hob.runtime.store.job(job.id)?.skillsUsed).toEqual([input.name]);
      expect(listAssistantSkills(hob.home, "hob")[0].uses).toBe(1);
      const workerOpen = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile(job.id))?.[0];
      // 没点名也加载：助手自己启用的那份在，同名的通用技能只留一份
      expect(workerOpen?.skills?.filter((item) => item.name === input.name).map((item) => item.filePath)).toEqual([skill.path]);
      await hob.runtime.jobs.waitIdle();
      // 停用的不加载，同名的通用技能这时才轮到它
      setAssistantSkillEnabled(hob.home, "hob", input.name, false);
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const other = await hob.runtime.jobs.start("hob", { title: "其他", instruction: "检查" });
      await waitFor(() => hob.runtime.store.job(other.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      const otherOpen = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile(other.id))?.[0];
      expect(otherOpen?.skills?.some((item) => item.filePath === skill.path)).toBe(false);
      expect(otherOpen?.skills?.some((item) => item.filePath === join(global, "SKILL.md"))).toBe(true);
    } finally { hob.close(); }
  });
  it("群和话题里的任务带上群的沉淀技能；续做和沉淀那一轮也是同一批", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "出行安排", purpose: "排行程", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "两天行程", "user");
      saveSkill(groupSkillsDir(hob.home, group.id), { name: "trip-plan", title: "旅行行程", description: "排行程时使用", content: "步骤" });
      saveAssistantSkill(hob.home, "hob", { name: "own-check", title: "自查", description: "自查用", content: "步骤" });
      const open = vi.spyOn(hob.runtime.pi, "open");
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "排行程", instruction: "排", groupId: topic.id });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      const file = hob.runtime.store.workerFile(job.id);
      const latest = () => {
        const calls = open.mock.calls.filter(([options]) => options.file === file);
        return (calls.at(-1)?.[0].skills ?? []).map((item) => item.name);
      };
      expect(latest()).toEqual(expect.arrayContaining(["trip-plan", "own-check"]));
      // 续做：同一批
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      await hob.runtime.jobs.reply(job.id, "再排一版");
      await waitFor(() => (hob.runtime.store.job(job.id)?.rounds?.length ?? 0) === 1 && hob.runtime.store.job(job.id)?.status === "done");
      await hob.runtime.jobs.waitIdle();
      expect(latest()).toEqual(expect.arrayContaining(["trip-plan", "own-check"]));
      // 沉淀那一轮：同一批
      hob.faux.setResponses([call("report", { outcome: "done", result: "没有需要沉淀的" }), text("完成")]);
      hob.runtime.jobs.startSediment(job.id);
      await hob.runtime.jobs.waitIdle();
      expect(latest()).toEqual(expect.arrayContaining(["trip-plan", "own-check"]));
    } finally { hob.close(); }
  });
  it("删技能：有在跑的任务读过它时挡住，只是加载了没读过不挡", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      saveAssistantSkill(hob.home, "hob", input);
      const base = { assistantId: "hob", title: "任务", instruction: "检查", status: "running" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
      hob.runtime.store.saveJob({ ...base, id: "t-loaded" });
      expect(() => deleteSkill(hob.runtime, "hob", input.name)).not.toThrow();
      saveAssistantSkill(hob.home, "hob", input);
      hob.runtime.store.saveJob({ ...base, id: "t-read", skillsUsed: [input.name] });
      expect(() => deleteSkill(hob.runtime, "hob", input.name)).toThrow("正在被任务");
      // 读过它的任务结束了就不挡
      hob.runtime.store.saveJob({ ...base, id: "t-read", status: "done" });
      expect(() => deleteSkill(hob.runtime, "hob", input.name)).not.toThrow();
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
      const sediment = vi.spyOn(hob.runtime.jobs, "startSediment");
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "检查", schedules: ["0 9 * * *"] });
      hob.faux.setResponses([call("start_job", { title: "巡检", note: "检查" }), text("已安排。"), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      await hob.runtime.routines.runNow(routine.id);
      await waitFor(() => hob.runtime.store.jobs().some((job) => job.title === "巡检" && job.status === "done"));
      await hob.runtime.jobs.waitIdle();
      expect(sediment).not.toHaveBeenCalled();
      expect(listAssistantSkills(hob.home, "hob")).toEqual([]);
    } finally { hob.close(); }
  });
  it("定时任务使用技能完成后也不自动沉淀", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const sediment = vi.spyOn(hob.runtime.jobs, "startSediment");
      const skill = saveAssistantSkill(hob.home, "hob", input);
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "检查", schedules: ["0 9 * * *"] });
      hob.faux.setResponses([call("start_job", { title: "巡检", note: "检查并读可用技能" }), text("已安排。"), call("read", { path: skill.path }), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      await hob.runtime.routines.runNow(routine.id);
      await waitFor(() => hob.runtime.store.jobs().some((job) => job.title === "巡检" && job.status === "done"));
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.jobs().find((job) => job.title === "巡检")?.skillsUsed).toEqual([input.name]);
      expect(sediment).not.toHaveBeenCalled();
      expect(routine).not.toHaveProperty("skill");
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
      expect(loadedVisibleSkills(visibleSkills(hob.runtime, "hob")).map((item) => item.name)).toEqual(["other-check"]);
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
});
