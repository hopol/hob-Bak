import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Job } from "../../shared/types.ts";
import { listAssistantSkills } from "../src/assistant-skills.ts";
import { saveSkillDirectory } from "../src/save-skill.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

function doneJob(cwd: string, overrides: Partial<Job> = {}): Job {
  return { id: "t-sed", assistantId: "hob", title: "整理", instruction: "整理记录", status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], model: "hob-faux/faux-1", thinking: "off", cwd, ...overrides };
}
function draft(cwd: string, name = "record-check") {
  const dir = join(cwd, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: 整理记录时使用\nmetadata:\n  title: 记录整理\n---\n\n步骤\n`);
}

describe("回顾是原任务的又一轮", () => {
  it("受阻的任务可以回顾，还在跑的不行", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd);
      hob.runtime.store.saveJob(doneJob(cwd, { status: "running" }));
      expect(() => hob.runtime.jobs.startSediment("t-sed")).toThrow("任务还没结束");
      hob.runtime.store.saveJob(doneJob(cwd, { status: "stuck" }));
      hob.faux.setResponses([call("report", { outcome: "done", result: "一次性的事" }), text("好")]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job("t-sed")?.sediment).toEqual({ status: "empty", reason: "一次性的事" });
    } finally { hob.close(); }
  });

  it("保存之后被接着说打断，版本保留，返回和续做消息都说明事实", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); draft(cwd);
      hob.runtime.store.saveJob(doneJob(cwd));
      hob.faux.setResponses([call("save_skill", { name: "record-check", from: "record-check" }), call("bash", { command: "sleep 10" }), call("report", { outcome: "done", result: "续做完成" }), text("完成")]);
      hob.runtime.jobs.startSediment("t-sed");
      await waitFor(() => hob.runtime.store.job("t-sed")?.sediment?.status === "running" && !!(hob.runtime.store.job("t-sed")?.sediment as { saved?: unknown[] }).saved?.length);
      const saved = await hob.runtime.jobs.reply("t-sed", "再核对一次", "router");
      expect(saved).toMatchObject([{ name: "record-check", title: "记录整理", version: 1 }]);
      await hob.runtime.jobs.waitIdle();
      expect(listAssistantSkills(hob.home, "hob")).toMatchObject([{ name: "record-check", version: 1 }]);
      expect(readFileSync(hob.runtime.store.workerFile("t-sed"), "utf8")).toContain("上一轮回顾停了，已存的技能：「记录整理」（record-check，第 1 版）。");
    } finally { hob.close(); }
  });

  it("重启时回顾停止，已经存好的技能保留", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); draft(cwd);
      saveSkillDirectory(hob.runtime, "hob", undefined, cwd, { name: "record-check", from: "record-check" }, { kind: "job", jobId: "t-sed" });
      hob.runtime.store.saveJob(doneJob(cwd, { sediment: { status: "running" } }));
      hob.runtime.jobs.recover();
      expect(hob.runtime.store.job("t-sed")?.sediment).toBeUndefined();
      expect(listAssistantSkills(hob.home, "hob")).toMatchObject([{ name: "record-check", version: 1 }]);
    } finally { hob.close(); }
  });

  it("模型失败通知助手；没有 report 时只提醒一次", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd);
      hob.runtime.store.saveJob(doneJob(cwd));
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([text("没有可复用的"), text("一次性的")]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job("t-sed")?.sediment).toEqual({ status: "empty", reason: "一次性的" });
      expect(notify).not.toHaveBeenCalled();
      expect(readFileSync(hob.runtime.store.workerFile("t-sed"), "utf8").split("这一轮结束了，还没有提交结果")).toHaveLength(2);
    } finally { hob.close(); }
  });

  it("回顾中的询问不出卡片，用量继续记在任务上", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd);
      hob.runtime.store.saveJob(doneJob(cwd, { usage: { input: 10, output: 5, cost: 0.01 } }));
      hob.faux.setResponses([call("ask_user", { title: "要不要重跑", options: [{ label: "要" }, { label: "不要" }] }), call("report", { outcome: "done", result: "没改" }), text("好")]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.jobs.transcript("t-sed").find((step) => step.name === "ask_user")?.output).toBe("沉淀时无需询问：拿不准的地方，在技能里写成执行前要确认的一步。");
      expect(hob.runtime.store.approvals()).toEqual([]);
      const usage = hob.runtime.store.job("t-sed")?.usage;
      expect((usage?.input ?? 0) + (usage?.output ?? 0)).toBeGreaterThan(15);
    } finally { hob.close(); }
  });

  it("模型出错通知助手，已经提交的版本仍保留", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); draft(cwd);
      hob.runtime.store.saveJob(doneJob(cwd));
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("save_skill", { name: "record-check", from: "record-check" }), fauxAssistantMessage([], { stopReason: "error", errorMessage: "API error (400): bad request" })]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(listAssistantSkills(hob.home, "hob")).toMatchObject([{ name: "record-check", version: 1 }]);
      expect(hob.runtime.store.job("t-sed")?.sediment).toEqual({ status: "failed", reason: "API error (400): bad request" });
      expect(notify).toHaveBeenCalledWith("hob", "任务「整理」（t-sed）沉淀完了：沉淀失败，API error (400): bad request。");
    } finally { hob.close(); }
  });

  it("回顾过程写在任务原会话，工具包含 save_skill", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const cwd = join(hob.home, "work"); mkdirSync(cwd); draft(cwd);
      hob.runtime.store.saveJob(doneJob(cwd));
      const open = vi.spyOn(hob.runtime.pi, "open");
      hob.faux.setResponses([call("save_skill", { name: "record-check", from: "record-check" }), call("report", { outcome: "done", result: "完成" }), text("好")]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      expect(open.mock.calls.find(([options]) => options.file === hob.runtime.store.workerFile("t-sed"))?.[0].tools).toContain("save_skill");
      expect(readFileSync(hob.runtime.store.workerFile("t-sed"), "utf8")).toContain("回顾刚才的过程");
      expect(existsSync(join(hob.home, "assistants", "hob", "jobs", "t-sed", "sediment-base"))).toBe(false);
    } finally { hob.close(); }
  });
});
