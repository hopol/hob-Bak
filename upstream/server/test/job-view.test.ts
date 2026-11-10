import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
      expect(hob.runtime.router.items("hob").items).toContainEqual(expect.objectContaining({ kind: "note", icon: "skill", path: skill.path, text: "已更新技能「统计」· 第 2 版" }));
    } finally { hob.close(); }
  });
  it("派活选择启用技能，助手叫停有名字", async () => {
    const hob = makeHob();
    try {
      saveAssistantSkill(hob.home, "hob", { name: "dir-size", title: "统计", description: "统计用", content: "正文" });
      const tools = buildRouterTools(hob.runtime, "hob");
      const start = vi.spyOn(hob.runtime.jobs, "start").mockResolvedValue({ ...base, status: "running" });
      const tool = tools.find((item) => item.name === "start_job")!;
      const execute = (skills: string[]) => tool.execute("id", { title: "测试", skills }, undefined, undefined, {} as never);
      expect((await execute(["missing"])).content[0].text).toBe("没有这个技能：missing。能用的有：dir-size");
      await execute(["dir-size"]);
      expect(start.mock.calls[0][1].instruction).toMatch(/^按技能「统计」做（先读它的 SKILL.md）。\n/);
      expect(start.mock.calls[0][1].skills).toEqual(["dir-size"]);
      await execute([]);
      expect(start.mock.calls[1][1].instruction).not.toContain("按技能");
      saveAssistantSkill(hob.home, "hob", { name: "another", title: "检查", description: "检查用", content: "正文" });
      await execute(["dir-size", "another"]);
      expect(start.mock.calls[2][1].instruction).toMatch(/^按技能「统计」「检查」做（先读它们的 SKILL.md）。\n/);
      expect(start.mock.calls[2][1].skills).toEqual(["dir-size", "another"]);
      const stop = vi.spyOn(hob.runtime.jobs, "stop").mockResolvedValue();
      await tools.find((item) => item.name === "stop_job")!.execute("id", { jobId: "t-1" }, undefined, undefined, {} as never);
      expect(stop).toHaveBeenCalledWith("t-1", `${hob.runtime.store.assistant("hob")!.name}叫停了`);
    } finally { hob.close(); }
  });
});
