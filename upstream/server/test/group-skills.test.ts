import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http.ts";
import { groupSkillsDir, listSkills, saveAssistantSkill, saveSkill, setSkillEnabled } from "../src/assistant-skills.ts";
import { deleteSkill } from "../src/delete-skill.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { snapshotSkills } from "../src/sediment.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const info = { name: "shared-skill", title: "群技能", description: "群里做事", content: "群步骤" };
const header = (name: string) => `---\nname: ${name}\ndescription: 群里做事\nmetadata:\n  title: 群技能\n---\n\n群步骤\n`;

describe("群技能", () => {
  it("停用的群技能不遮住个人同名技能及其占用检查", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const dir = groupSkillsDir(hob.home, group.id);
      saveSkill(dir, info);
      setSkillEnabled(dir, info.name, false);
      const own = saveAssistantSkill(hob.home, "hob", { ...info, content: "个人步骤" });
      const edit = buildRouterTools(hob.runtime, "hob", group.id).find((tool) => tool.name === "edit_skill")!;
      expect((await edit.execute("edit", { name: info.name, edits: [{ old: "个人步骤", new: "新个人步骤" }] })).isError).not.toBe(true);
      expect(readFileSync(own.path, "utf8")).toContain("新个人步骤");
      hob.runtime.store.saveJob({ id: "t-active", assistantId: "hob", groupId: group.id, title: "任务", instruction: "测试", status: "running", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], skills: [info.name] });
      expect(() => deleteSkill(hob.runtime, "hob", info.name)).toThrow("正在被任务");
    } finally { hob.close(); }
  });
  it("群技能接口由话题访问同一目录", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      saveSkill(groupSkillsDir(hob.home, group.id), info);
      saveSkill(groupSkillsDir(hob.home, group.id), { ...info, content: "第二版" });
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const req = (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const url = `/api/groups/${topic.id}/skills`;
      expect(await (await req(url)).json()).toMatchObject([{ name: info.name, version: 2 }]);
      expect((await req(`${url}/${info.name}`, "PATCH", { enabled: false })).status).toBe(200);
      expect((await req(`${url}/${info.name}/rollback`, "POST")).status).toBe(200);
      expect((await req(`${url}/${info.name}`, "DELETE")).status).toBe(200);
      expect(await (await req(url)).json()).toEqual([]);
    } finally { hob.close(); }
  });

  it("群会话优先使用群技能，修改、删除和定时绑定按群检查", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      const dir = groupSkillsDir(hob.home, group.id);
      saveSkill(dir, info);
      const own = saveAssistantSkill(hob.home, "hob", { ...info, title: "个人技能", content: "个人步骤" });
      const second = saveAssistantSkill(hob.home, "hob", { name: "own-only", title: "个人技能", description: "自己做事", content: "个人步骤" });
      const open = vi.spyOn(hob.runtime.pi, "open");
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const start = buildRouterTools(hob.runtime, "hob", topic.id).find((tool) => tool.name === "start_job")!;
      expect((await start.execute("start", { title: "测试", skills: [info.name, second.name] })).isError).not.toBe(true);
      await hob.runtime.jobs.waitIdle();
      const job = hob.runtime.store.jobs().find((item) => item.groupId === topic.id)!;
      const loaded = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile(job.id))?.[0].skills ?? [];
      expect(loaded.find((skill) => skill.name === info.name)?.filePath).toBe(listSkills(dir)[0]!.path);
      expect(loaded.find((skill) => skill.name === second.name)?.filePath).toBe(second.path);
      const tools = buildRouterTools(hob.runtime, "hob", topic.id);
      const edit = tools.find((tool) => tool.name === "edit_skill")!;
      expect((await edit.execute("edit", { name: info.name, edits: [{ old: "群步骤", new: "新群步骤" }] })).isError).not.toBe(true);
      expect(readFileSync(own.path, "utf8")).toContain("个人步骤");
      expect(readFileSync(listSkills(dir)[0]!.path, "utf8")).toContain("新群步骤");
      const routine = hob.runtime.routines.create({ assistantId: "hob", groupId: topic.id, name: "检查", instruction: "做事", schedules: ["0 9 * * *"], skill: info.name });
      const remove = tools.find((tool) => tool.name === "delete_skill")!;
      expect((await remove.execute("delete", { name: info.name })).isError).toBe(true);
      hob.runtime.routines.remove(routine.id);
      expect((await remove.execute("delete", { name: info.name })).isError).not.toBe(true);
      expect(listSkills(dir)).toHaveLength(0);
      expect(existsSync(own.path)).toBe(true);
    } finally { hob.close(); }
  });

  it("同一群目录的不同成员沉淀排队", async () => {
    const hob = makeHob({}, { memory: "off" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, id: "ops", name: "服务器", primary: false });
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob", "ops"] });
      const base = { groupId: group.id, title: "任务", instruction: "测试", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off" as const };
      hob.runtime.store.saveJob({ ...base, id: "t-first", assistantId: "hob" });
      hob.runtime.store.saveJob({ ...base, id: "t-next", assistantId: "ops" });
      hob.faux.setResponses([async () => { await gate; return call("report", { outcome: "done", result: "第一份" }); }, text("完成"), call("report", { outcome: "done", result: "第二份" }), text("完成")]);
      hob.runtime.jobs.startSediment("t-first");
      await waitFor(() => existsSync(join(hob.runtime.store.jobDir("t-first"), "sediment-base", ".snapshot-ready")));
      hob.runtime.jobs.startSediment("t-next");
      const nextBase = join(hob.runtime.store.jobDir("t-next"), "sediment-base");
      expect(JSON.parse(readFileSync(join(nextBase, ".target.json"), "utf8"))).toEqual({ kind: "group", id: group.id });
      expect(existsSync(join(nextBase, ".snapshot-ready"))).toBe(false);
      release();
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job("t-next")?.sediment?.status).toBe("empty");
    } finally { release(); hob.close(); }
  });

  it("不同技能目录的沉淀可以同时运行", async () => {
    const hob = makeHob({}, { memory: "off" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const base = { assistantId: "hob", title: "任务", instruction: "测试", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off" as const };
      hob.runtime.store.saveJob({ ...base, id: "t-group-gate", groupId: group.id });
      hob.runtime.store.saveJob({ ...base, id: "t-own-gate" });
      hob.faux.setResponses([async () => { await gate; return call("report", { outcome: "done", result: "群完成" }); }, call("report", { outcome: "done", result: "个人完成" }), text("完成")]);
      hob.runtime.jobs.startSediment("t-group-gate");
      await waitFor(() => existsSync(join(hob.runtime.store.jobDir("t-group-gate"), "sediment-base", ".snapshot-ready")));
      hob.runtime.jobs.startSediment("t-own-gate");
      await waitFor(() => hob.runtime.store.job("t-own-gate")?.sediment?.status === "empty");
      expect(hob.runtime.store.job("t-group-gate")?.sediment?.status).toBe("running");
      release();
      await hob.runtime.jobs.waitIdle();
    } finally { release(); hob.close(); }
  });

  it("重启时按底稿记录的目标恢复，排队未拍底稿时不改技能", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const own = saveAssistantSkill(hob.home, "hob", { name: "own-skill", title: "个人技能", description: "个人做事", content: "原始内容" });
      const job = { id: "t-recover", assistantId: "hob", groupId: group.id, title: "任务", instruction: "测试", status: "done" as const, sediment: { status: "running" as const }, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
      hob.runtime.store.saveJob(job);
      const base = join(hob.runtime.store.jobDir(job.id), "sediment-base");
      snapshotSkills(join(hob.home, "assistants", "hob", "skills"), base);
      writeFileSync(join(base, ".target.json"), JSON.stringify({ kind: "assistant", id: "hob" }));
      writeFileSync(own.path, "改坏了");
      hob.runtime.jobs.recover();
      expect(readFileSync(own.path, "utf8")).toContain("原始内容");
      hob.runtime.store.saveJob({ ...job, id: "t-queued" });
      const queued = join(hob.runtime.store.jobDir("t-queued"), "sediment-base");
      mkdirSync(queued, { recursive: true });
      writeFileSync(join(queued, ".target.json"), JSON.stringify({ kind: "assistant", id: "hob" }));
      hob.runtime.jobs.recover();
      expect(readFileSync(own.path, "utf8")).toContain("原始内容");
    } finally { hob.close(); }
  });

  it("群任务新技能存群里，into 指向个人技能时只修改个人技能", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      const job = { id: "t-group-sed", assistantId: "hob", groupId: topic.id, title: "任务", instruction: "测试", status: "done" as const, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off" as const };
      hob.runtime.store.saveJob(job);
      const path = join(groupSkillsDir(hob.home, group.id), "group-new", "SKILL.md");
      hob.faux.setResponses([call("write", { path, content: header("group-new") }), call("report", { outcome: "done", result: "保存" }), text("完成")]);
      hob.runtime.jobs.startSediment(job.id);
      await hob.runtime.jobs.waitIdle();
      expect(listSkills(groupSkillsDir(hob.home, group.id))).toMatchObject([{ name: "group-new" }]);
      const own = saveAssistantSkill(hob.home, "hob", { name: "own-skill", title: "个人技能", description: "个人做事", content: "个人步骤" });
      hob.faux.setResponses([call("edit", { path: own.path, edits: [{ oldText: "个人步骤", newText: "修改个人步骤" }] }), call("report", { outcome: "done", result: "保存" }), text("完成")]);
      hob.runtime.jobs.startSediment(job.id, { into: "own-skill" });
      await hob.runtime.jobs.waitIdle();
      expect(readFileSync(own.path, "utf8")).toContain("修改个人步骤");
      expect(listSkills(groupSkillsDir(hob.home, group.id)).map((skill) => skill.name)).toEqual(["group-new"]);
    } finally { hob.close(); }
  });
});
