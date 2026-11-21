import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job, JobStep } from "../../shared/types.ts";
import { jobProcessLines, jobView } from "../src/job-view.ts";
import { listAssistantSkills, saveAssistantSkill, setAssistantSkillEnabled } from "../src/assistant-skills.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { makeHob } from "./helpers.ts";

const now = new Date("2026-11-05T16:00:00Z");
const base: Job = { id: "t-1", assistantId: "hob", title: "检查", instruction: "做", status: "running", createdAt: "2026-11-05T15:50:00Z", startedAt: "2026-11-05T15:51:00Z", cwd: "/work", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
const steps: JobStep[] = [
  { id: "a", kind: "text", from: "assistant", text: "正在\n检查", at: "2026-11-05T15:56:00Z" },
  { id: "b", kind: "thinking", text: "思考", at: "2026-11-05T15:57:00Z" },
  { id: "c", kind: "text", from: "user", text: "补充\n信息", at: "2026-11-05T15:58:00Z" },
  { id: "d", kind: "tool", title: "运行 命令", at: "2026-11-05T15:59:00Z", running: true },
];

describe("任务查看", () => {
  it("按时区展示在跑过程和提问，排除思考", () => {
    const text = jobView(base, steps, [{ id: "q", assistantId: "hob", jobId: "t-1", title: "是否继续", options: [], status: "pending", source: "job", createdAt: now.toISOString() }], [], "Asia/Shanghai", now);
    expect(text).toContain("进行中，已运行 9 分钟");
    expect(text).toContain("在等你回复：是否继续");
    expect(text).toContain("过程（新的在前，共 3 步）：\n11-05 23:59 运行 命令 · 还在跑，1 分钟\n11-05 23:58 收到：补充 信息\n11-05 23:56 说：正在 检查");
    expect(jobProcessLines([{ ...steps[0], at: "2026-11-04T15:56:00Z", text: "甲".repeat(200) }], "Asia/Shanghai", now)[0]).toHaveLength(160);
  });
  it("已结束的原因、长结果和历史轮次", () => {
    const text = jobView({ ...base, status: "stuck", statusReason: "缺权限", summary: "甲".repeat(1001), reportPath: "/report.md", durationMs: 3660000, rounds: [{ status: "done", durationMs: 12000 }] }, [], [], [], "UTC", now);
    expect(text).toContain("受阻，用时 1 小时 1 分钟（第 2 轮）");
    expect(text).toContain("原因：缺权限");
    expect(text).toContain("结果（共 1001 字，全文：/report.md）：");
    expect(text).toContain("之前的轮次：第 1 轮 已完成，用时 12 秒");
  });
  it("bash 步骤用原命令，没有原命令时退回 title", () => {
    const at = "2026-11-05T15:59:00Z";
    const line = jobProcessLines([{ id: "c", kind: "tool", name: "bash", title: "运行 `git cherry-pick abc`", args: { command: "cd /tmp/lane1   &&  timeout 60 git cherry-pick\n abc" }, at }], "Asia/Shanghai", now)[0];
    expect(line).toBe("11-05 23:59 运行 `cd /tmp/lane1 && timeout 60 git cherry-pick abc`");
    expect(jobProcessLines([{ id: "d", kind: "tool", name: "bash", title: "运行 `npm test`", at }], "Asia/Shanghai", now)[0]).toContain("运行 `npm test`");
  });
  it("同一轮重复查看没有新步骤时只回一句，状态变化后恢复完整过程", async () => {
    const hob = makeHob();
    try {
      await hob.runtime.router.ensure("hob");
      hob.runtime.store.saveJob(base);
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "check_job")!;
      const run = async () => (await tool.execute("id", { jobId: base.id }, undefined, undefined, {} as never)).content[0].text as string;
      expect(await run()).toContain("任务「检查」（t-1）：");
      expect(await run()).toBe("和你上次查看时一样，没有新的步骤。任务结束或提问时会通知你。");
      hob.runtime.store.saveJob({ ...base, status: "done", endedAt: now.toISOString() });
      expect(await run()).toContain("已完成");
    } finally { hob.close(); }
  });
  it("不是这个会话开的任务：查看多一行出处", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "团队", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "相册", "user");
      hob.runtime.store.saveJob({ ...base, groupId: topic.id });
      const check = async (jobId: string) => (await buildRouterTools(hob.runtime, "hob", group.id).find((tool) => tool.name === "check_job")!.execute("id", { jobId }, undefined, undefined, {} as never)).content[0].text as string;
      const lines = (await check("t-1")).split("\n");
      expect(lines[0]).toContain(`任务「检查」（t-1）：`);
      expect(lines[1]).toBe("这个任务是话题「相册」开的，结果回到那边。");
      // 这个会话自己开的：不多这一行
      const own = jobView({ ...base, id: "t-own", groupId: group.id }, [], [], [], "UTC", now);
      expect(own.split("\n")[1]).toContain("工作目录");
    } finally { hob.close(); }
  });
  it("主助手可看其他助手，其他助手只能看自己的", async () => {
    const hob = makeHob();
    try {
      const primary = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...primary, id: "ops", name: "运维", primary: false });
      hob.runtime.store.saveJob({ ...base, assistantId: "ops" });
      const run = async (id: string, jobId: string) => buildRouterTools(hob.runtime, id).find((tool) => tool.name === "check_job")!.execute("id", { jobId }, undefined, undefined, {} as never);
      expect((await run("hob", "t-1")).content[0].text).toContain("任务「检查」");
      hob.runtime.store.saveJob({ ...base, id: "t-2" });
      expect((await run("ops", "t-2")).content[0].text).toBe("没有这个任务：t-2");
      expect((await run("ops", "missing")).content[0].text).toBe("没有这个任务：missing");
    } finally { hob.close(); }
  });
});

describe("Router 技能工具", () => {
  it("顺序替换并保留历史、附件；失败不保存", async () => {
    const hob = makeHob();
    try {
      const skill = saveAssistantSkill(hob.home, "hob", { name: "dir-size", title: "统计", description: "统计用", content: "前 10 名\n重复 重复", files: [{ path: "scripts/a.sh", content: "echo yes" }] });
      setAssistantSkillEnabled(hob.home, "hob", skill.name, false);
      const events: string[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "skills") events.push(event.assistantId); });
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "edit_skill")!;
      const run = async (name: string, edits: { old: string; new: string }[]) => tool.execute("id", { name, edits }, undefined, undefined, {} as never);
      expect((await run("none", [])).content[0].text).toBe("没有这个技能：none");
      expect((await run(skill.name, [{ old: "不存在", new: "x" }])).content[0].text).toContain("正文里找不到这段原文：不存在");
      expect((await run(skill.name, [{ old: "重复", new: "x" }])).content[0].text).toBe("这段原文出现了 2 次，多带几个字");
      expect((await run(skill.name, [{ old: "前 10 名", new: "前 5 名" }, { old: "不存在", new: "x" }])).isError).toBe(true);
      expect(listAssistantSkills(hob.home, "hob")[0].version).toBe(1);
      expect((await run(skill.name, [{ old: "前 10 名", new: "前 5 名" }])).content[0].text).toBe("已更新技能「统计」，第 2 版。");
      expect(readFileSync(skill.path, "utf8")).toContain("前 5 名");
      expect(readFileSync(join(skill.path, "../scripts/a.sh"), "utf8")).toBe("echo yes");
      expect(existsSync(join(skill.path, "../.history/1/SKILL.md"))).toBe(true);
      expect(events).toEqual(["hob"]);
      // 改技能是给模型和技能页的事，对话里不落行
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "note")).toEqual([]);
    } finally { hob.close(); }
  });
  it("通用技能可改可删；定时任务不绑定技能，只读技能仍拦住", async () => {
    const hob = makeHob();
    const previous = process.env.HOME;
    const temp = join(hob.home, "fake-home");
    try {
      mkdirSync(join(hob.home, "skills", "table-summary"), { recursive: true });
      writeFileSync(join(hob.home, "skills", "table-summary", "SKILL.md"), "---\nname: table-summary\ndescription: 汇总表格时使用\n---\n\n正文");
      process.env.HOME = temp;
      const local = join(temp, ".agents", "skills", "local-only");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "SKILL.md"), "---\nname: local-only\ndescription: 本机别的工具也用\n---\n正文\n");
      const tools = buildRouterTools(hob.runtime, "hob");
      const run = async (name: string, params: Record<string, unknown>) => (await tools.find((tool) => tool.name === name)!.execute("id", params as never, undefined, undefined, {} as never)).content[0].text;
      expect(await run("edit_skill", { name: "table-summary", edits: [{ old: "正文", new: "新正文" }] })).toBe("已更新技能「table-summary」，第 2 版。");
      expect(readFileSync(join(hob.home, "skills", "table-summary", "SKILL.md"), "utf8")).toContain("新正文");
      const bind = await tools.find((tool) => tool.name === "create_routine")!.execute("id", { name: "汇总", instruction: "汇总表格", schedules: ["0 9 * * *"], skill: "table-summary" } as never, undefined, undefined, {} as never);
      expect(bind.isError).not.toBe(true);
      expect(hob.runtime.store.routines()[0]).not.toHaveProperty("skill");
      expect(await run("edit_skill", { name: "table-summary" })).toBe("edits 和 general 至少填一样：改正文填 edits，换给谁用填 general。");
      expect(await run("edit_skill", { name: "none", edits: [] })).toBe("没有这个技能：none");
      expect(await run("edit_skill", { name: "local-only", edits: [{ old: "正文", new: "新" }] })).toBe("local-only 在本机 ~/.agents/skills 里，只能照着用，Hob 里改不了；要改得在那个目录里改，或者让任务另存一份 Hob 的技能。");
      expect(await run("delete_skill", { name: "table-summary" })).toBe("已删除技能「table-summary」，移到了归档。");
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      hob.close();
    }
  });
  it("派活不再点名技能：多填 skills 也照常开任务，助手叫停有名字", async () => {
    const hob = makeHob();
    try {
      saveAssistantSkill(hob.home, "hob", { name: "dir-size", title: "统计", description: "统计用", content: "正文" });
      const tools = buildRouterTools(hob.runtime, "hob");
      const start = vi.spyOn(hob.runtime.jobs, "start").mockResolvedValue({ ...base, status: "running" });
      const tool = tools.find((item) => item.name === "start_job")!;
      // 参数里去掉了 skills：任何情况下都没东西可填错，也没有名字校验
      expect(tool.parameters.properties.skills).toBeUndefined();
      const execute = (extra: Record<string, unknown>) => tool.execute("id", { title: "测试", note: "执行测试任务", ...extra }, undefined, undefined, {} as never);
      // 旧对话里带下来的 skills：不报错、不起作用，照常开任务
      expect((await execute({ skills: ["missing", "dir-size"] })).isError).not.toBe(true);
      expect(start.mock.calls[0]![1].instruction).not.toContain("按技能");
      expect(start.mock.calls[0]![1]).not.toHaveProperty("skills");
      await execute({});
      expect(start.mock.calls[1]![1].instruction).not.toContain("按技能");
      hob.runtime.store.saveJob(base);
      const stop = vi.spyOn(hob.runtime.jobs, "stop").mockResolvedValue();
      await tools.find((item) => item.name === "stop_job")!.execute("id", { jobId: "t-1" }, undefined, undefined, {} as never);
      expect(stop).toHaveBeenCalledWith("t-1", `${hob.runtime.store.assistant("hob")!.name}停止了`);
    } finally { hob.close(); }
  });
  it("在别的会话里补充、停止：返回和停止原因都写出处", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "团队", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const topicA = hob.runtime.groups.createTopic(group.id, "相册", "user");
      const topicB = hob.runtime.groups.createTopic(group.id, "打印机", "user");
      hob.runtime.store.saveJob({ ...base, groupId: topicA.id });
      const reply = vi.spyOn(hob.runtime.jobs, "reply").mockResolvedValue();
      const stop = vi.spyOn(hob.runtime.jobs, "stop").mockResolvedValue();
      const run = async (gid: string, name: string) => (await buildRouterTools(hob.runtime, "hob", gid).find((tool) => tool.name === name)!.execute("id", { jobId: "t-1", text: "再查一次" }, undefined, undefined, {} as never)).content[0].text as string;
      // 在综合里：任务在话题「相册」
      expect(await run(group.id, "reply_job")).toBe("已交给任务「检查」（t-1），它会接着做。这个任务是话题「相册」创建的，结果回到那边。");
      expect(await run(group.id, "stop_job")).toBe("已停止。这个任务是话题「相册」创建的。");
      expect(stop).toHaveBeenLastCalledWith("t-1", `${hob.runtime.store.assistant("hob")!.name}在综合停止了`);
      // 在话题 B 里停话题 A 的任务：原因写话题「B」
      expect(await run(topicB.id, "stop_job")).toBe("已停止。这个任务是话题「相册」创建的。");
      expect(stop).toHaveBeenLastCalledWith("t-1", `${hob.runtime.store.assistant("hob")!.name}在话题「打印机」停止了`);
      // 这个会话自己开的：和以前一样
      expect(await run(topicA.id, "reply_job")).toBe("已交给任务「检查」（t-1），它会接着做，结果会回到这里。");
      expect(await run(topicA.id, "stop_job")).toBe("已停止。");
      expect(stop).toHaveBeenLastCalledWith("t-1", `${hob.runtime.store.assistant("hob")!.name}停止了`);
      expect(reply).toHaveBeenCalled();
    } finally { hob.close(); }
  });
});
