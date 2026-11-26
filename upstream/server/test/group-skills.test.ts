import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http.ts";
import { groupSkillsDir, listSkills, saveAssistantSkill, saveSkill, setSkillEnabled } from "../src/assistant-skills.ts";
import { deleteSkill } from "../src/delete-skill.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text } from "./helpers.ts";

const info = { name: "shared-skill", title: "群技能", description: "群里做事", content: "群步骤" };
const header = (name: string) => `---\nname: ${name}\ndescription: 群里做事\nmetadata:\n  title: 群技能\n---\n\n群步骤\n`;

describe("群技能", () => {
  it("停用的群技能不遮住个人同名技能及其占用检查", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const dir = groupSkillsDir(hob.home, group.id);
      saveSkill(dir, info); setSkillEnabled(dir, info.name, false);
      const own = saveAssistantSkill(hob.home, "hob", { ...info, content: "个人步骤" });
      const edit = buildRouterTools(hob.runtime, "hob", group.id).find((tool) => tool.name === "save_skill")!;
      expect((await edit.execute("edit", { name: info.name, edits: [{ old: "个人步骤", new: "新个人步骤" }] })).isError).not.toBe(true);
      expect(readFileSync(own.path, "utf8")).toContain("新个人步骤");
      hob.runtime.store.saveJob({ id: "t-active", assistantId: "hob", groupId: group.id, title: "任务", instruction: "测试", status: "running", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], skillsUsed: [info.name] });
      expect(() => deleteSkill(hob.runtime, "hob", info.name)).toThrow("正在被任务");
    } finally { hob.close(); }
  });

  it("群技能接口由话题访问同一目录", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      saveSkill(groupSkillsDir(hob.home, group.id), info); saveSkill(groupSkillsDir(hob.home, group.id), { ...info, content: "第二版" });
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

  it("话题任务带上群技能和自己的技能，并按群优先修改", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      const dir = groupSkillsDir(hob.home, group.id);
      saveSkill(dir, info);
      const own = saveAssistantSkill(hob.home, "hob", { ...info, content: "个人步骤" });
      const second = saveAssistantSkill(hob.home, "hob", { name: "own-only", title: "个人技能", description: "自己做事", content: "个人步骤" });
      const open = vi.spyOn(hob.runtime.pi, "open");
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const tools = buildRouterTools(hob.runtime, "hob", topic.id);
      expect((await tools.find((tool) => tool.name === "start_job")!.execute("start", { title: "测试", note: "按群里的资料完成测试", skills: ["missing"] })).isError).not.toBe(true);
      await hob.runtime.jobs.waitIdle();
      const job = hob.runtime.store.jobs().find((item) => item.groupId === topic.id)!;
      const loaded = open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile(job.id))?.[0].skills ?? [];
      expect(loaded.find((skill) => skill.name === info.name)?.filePath).toBe(listSkills(dir)[0].path);
      expect(loaded.find((skill) => skill.name === second.name)?.filePath).toBe(second.path);
      expect((await tools.find((tool) => tool.name === "save_skill")!.execute("edit", { name: info.name, edits: [{ old: "群步骤", new: "新群步骤" }] })).isError).not.toBe(true);
      expect(readFileSync(own.path, "utf8")).toContain("个人步骤");
      expect(readFileSync(listSkills(dir)[0].path, "utf8")).toContain("新群步骤");
    } finally { hob.close(); }
  });

  it("话题任务存本群技能，也能修改个人技能", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      const cwd = join(hob.home, "work"); mkdirSync(join(cwd, "group-new"), { recursive: true });
      writeFileSync(join(cwd, "group-new", "SKILL.md"), header("group-new"));
      const own = saveAssistantSkill(hob.home, "hob", { name: "own-skill", title: "个人技能", description: "个人做事", content: "个人步骤" });
      hob.runtime.store.saveJob({ id: "t-group-sed", assistantId: "hob", groupId: topic.id, title: "任务", instruction: "测试", status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off", cwd });
      hob.faux.setResponses([call("save_skill", { name: "group-new", from: "group-new" }), call("save_skill", { name: "own-skill", edits: [{ old: "个人步骤", new: "修改个人步骤" }] }), call("report", { outcome: "done", result: "保存" }), text("完成")]);
      hob.runtime.jobs.startSediment("t-group-sed");
      await hob.runtime.jobs.waitIdle();
      expect(listSkills(groupSkillsDir(hob.home, group.id))).toMatchObject([{ name: "group-new" }]);
      expect(readFileSync(own.path, "utf8")).toContain("修改个人步骤");
      expect(existsSync(own.path)).toBe(true);
    } finally { hob.close(); }
  });
});
