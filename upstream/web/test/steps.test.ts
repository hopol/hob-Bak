import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSteps } from "../../server/src/transcript.ts";
import type { Job, JobStep, SedimentStatus } from "../../shared/types.ts";
import { diffLines, groupThinking, jobDetailRounds, jobReason, jobRoundView, mergeStep, mergeSteps, titleParts } from "../src/steps.ts";

function tool(id: string, extra: Partial<JobStep> = {}): JobStep {
  return { id, kind: "tool", at: "2026-11-01T01:00:00.000Z", name: "bash", title: "跑 `ls`", ...extra };
}

describe("任务过程合并", () => {
  it("补充先显示为等待读取；被任务读到后换成正式的一行，重新拉 transcript 也不重复", () => {
    const mine = (id: string, extra: Partial<JobStep> = {}): JobStep => ({ id, kind: "text", at: "2026-11-01T01:00:00.000Z", from: "user", text: "改成只关私聊", ...extra });
    const waiting = mergeStep([tool("call-1", { running: true })], mine("q1", { queued: true }));
    expect(waiting.map((step) => step.id)).toEqual(["call-1", "q1"]);
    const read = mergeStep(mergeStep(waiting, tool("call-1")), mine("u123"));
    expect(read.map((step) => step.id)).toEqual(["call-1", "u123"]);
    // 服务端那份里已经没有 q1（读到了），本地残留的等待行不能再接回去
    expect(mergeSteps(waiting, [tool("call-1"), mine("u123")]).map((step) => step.id)).toEqual(["call-1", "u123"]);
    // 还在等的，服务端那份里带着，照常显示一行
    expect(mergeSteps(waiting, [tool("call-1"), mine("q1", { queued: true })]).map((step) => step.id)).toEqual(["call-1", "q1"]);
  });

  it("同一个 id 替换，不新增一行", () => {
    const started = mergeStep([], tool("call-1", { running: true }));
    const done = mergeStep(started, tool("call-1", { output: "a.ts" }));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ output: "a.ts" });
    expect(done[0].running).toBeUndefined();
  });

  it("新 id 接在末尾，顺序就是到达顺序", () => {
    const list = mergeStep(mergeStep([], tool("call-1")), tool("call-2"));
    expect(list.map((step) => step.id)).toEqual(["call-1", "call-2"]);
  });

  it("拉回整份 transcript 时保留还没落盘的实时步骤", () => {
    const live = [tool("call-1", { output: "旧" }), tool("call-2", { running: true })];
    const fromDisk = [tool("call-1", { output: "新" })];
    expect(mergeSteps(live, fromDisk)).toEqual([tool("call-1", { output: "新" }), tool("call-2", { running: true })]);
  });
});

describe("思考过程归到下一步", () => {
  const at = "2026-11-01T01:00:00.000Z";
  const think = (id: string, text: string): JobStep => ({ id, kind: "thinking", at, text });
  const reply = (id: string, text: string): JobStep => ({ id, kind: "text", at, from: "assistant", text });

  it("思考并到后面那个工具步骤上，不再单独成行", () => {
    const rows = groupThinking([think("k1", "先看看目录"), tool("call-1")]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: "call-1", kind: "tool", thinking: "先看看目录" });
    expect(rows.thinking).toBeNull();
  });

  it("思考并到后面那句回复上", () => {
    const rows = groupThinking([think("k1", "想完了"), reply("t1", "查到了。")]);
    expect(rows.rows).toMatchObject([{ id: "t1", kind: "text", thinking: "想完了" }]);
  });

  it("连着几段思考拼成一段，不踩到后面的步骤", () => {
    const rows = groupThinking([
      think("k1", "第一步"),
      think("k2", "第二步"),
      tool("call-1", { output: "a.ts" }),
      think("k3", "再看看任务列表"),
      tool("call-2"),
      tool("call-3"),
    ]);
    expect(rows.rows.map((row) => [row.id, row.thinking])).toEqual([
      ["call-1", "第一步\n\n第二步"],
      ["call-2", "再看看任务列表"],
      ["call-3", undefined],
    ]);
  });

  it("最后一段思考后面没有步骤：单留一段「思考中」", () => {
    const rows = groupThinking([tool("call-1"), think("k9", "还在想怎么收尾")]);
    expect(rows.rows.map((row) => row.id)).toEqual(["call-1"]);
    expect(rows.thinking).toBe("还在想怎么收尾");
  });

  it("你补的那句话不接思考，思考留给后面助手自己的步骤", () => {
    const rows = groupThinking([
      think("k1", "它想了一半"),
      { id: "u1", kind: "text", at, from: "user", text: "换个方向" },
      tool("call-1"),
    ]);
    expect(rows.rows.map((row) => [row.id, row.thinking])).toEqual([
      ["u1", undefined],
      ["call-1", "它想了一半"],
    ]);
  });

  it("空思考、纯空白的不占位", () => {
    const rows = groupThinking([think("k1", "   "), tool("call-1")]);
    expect(rows.rows).toMatchObject([{ id: "call-1" }]);
    expect(rows.rows[0].thinking).toBeUndefined();
    expect(rows.thinking).toBeNull();
    expect(groupThinking([])).toEqual({ rows: [], thinking: null });
  });

  it("实时事件拼出来的步骤和落盘 transcript 得到同样的行", () => {
    const home = mkdtempSync(join(tmpdir(), "hob-steps-"));
    try {
      const file = join(home, "worker.jsonl");
      const entry = (message: Record<string, unknown>) => JSON.stringify({ type: "message", message });
      writeFileSync(
        file,
        [
          entry({ role: "user", content: [{ type: "text", text: "看看机器" }], timestamp: at }),
          entry({
            role: "assistant",
            timestamp: at,
            content: [
              { type: "thinking", thinking: "先跑 uname" },
              { type: "text", text: "我看一下。" },
              { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "uname -a" } },
            ],
          }),
          entry({ role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "Linux\n" }], timestamp: at }),
        ].join("\n"),
      );
      const fromDisk = groupThinking(deriveSteps(file));
      // 同一份内容从实时事件来：思考并到的行和顺序都一样
      const live = groupThinking([
        think("k1", "先跑 uname"),
        reply("t1", "我看一下。"),
        { ...tool("call-1"), output: "Linux\n" },
      ]);
      expect(fromDisk.rows.map((row) => [row.kind, row.thinking])).toEqual(
        live.rows.map((row) => [row.kind, row.thinking]),
      );
      expect(fromDisk.rows.map((row) => row.thinking)).toEqual(["先跑 uname", undefined]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("任务卡的原因行", () => {
  it("每个状态词都不当原因显示（右上角状态已经写过一遍）", () => {
    for (const word of ["排队中", "进行中", "待确认", "等你确认", "已完成", "受阻", "失败", "已停止"]) {
      expect(jobReason({ statusReason: word })).toBeUndefined();
    }
  });

  it("具体原因照常显示", () => {
    expect(jobReason({ statusReason: "15 分钟没动静" })).toBe("15 分钟没动静");
    expect(jobReason({ statusReason: "Hob 重启，任务中断" })).toBe("Hob 重启，任务中断");
    expect(jobReason({ statusReason: "你叫停了" })).toBe("你叫停了");
    expect(jobReason({ statusReason: "  未提交结果  " })).toBe("未提交结果");
    expect(jobReason({})).toBeUndefined();
    expect(jobReason({ statusReason: "   " })).toBeUndefined();
  });
});

describe("改文件的 diff", () => {
  it("只改一行：删的行标 -，加的行标 +，前后留三行上下文", () => {
    const before = ["a", "b", "c", "d", "e", "old", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "c", "d", "e", "new", "g", "h", "i", "j"].join("\n");
    const lines = diffLines(before, after);
    expect(lines.map((line) => `${line.sign}${line.text}`)).toEqual([
      " c",
      " d",
      " e",
      "-old",
      "+new",
      " g",
      " h",
      " i",
    ]);
  });

  it("纯新增和纯删除", () => {
    expect(diffLines("a", "a\nb").map((line) => `${line.sign}${line.text}`)).toEqual([" a", "+b"]);
    expect(diffLines("a\nb", "a").map((line) => `${line.sign}${line.text}`)).toEqual([" a", "-b"]);
    expect(diffLines("", "只有新的").map((line) => line.sign)).toEqual(["+"]);
  });

  it("改动很大时不算 LCS，两边各给开头一段，并且不会无限长", () => {
    const before = Array.from({ length: 800 }, (_, i) => `old-${i}`).join("\n");
    const after = Array.from({ length: 800 }, (_, i) => `new-${i}`).join("\n");
    const lines = diffLines(before, after);
    expect(lines.filter((line) => line.sign === "-")).toHaveLength(190);
    expect(lines.filter((line) => line.sign === "+")).toHaveLength(190);
    expect(lines.find((line) => line.sign === "-")?.text).toBe("old-0");
    expect(lines.find((line) => line.sign === "+")?.text).toBe("new-0");
    expect(lines).toHaveLength(381);
    expect(lines[190]).toEqual({ sign: " ", text: "…" });
  });
});

describe("步骤说明分段", () => {
  it("反引号里的部分用等宽字体", () => {
    expect(titleParts("跑 `npm test`")).toEqual([
      { text: "跑 ", mono: false },
      { text: "npm test", mono: true },
    ]);
    expect(titleParts("改 server/src/jobs.ts")).toEqual([{ text: "改 server/src/jobs.ts", mono: false }]);
  });
});

describe("任务详情分轮", () => {
  it("按时间切步骤并使用各轮说明和结果，不把旧报告显示在进行中一轮", () => {
    const job: Job = { id: "t", assistantId: "hob", title: "测试", instruction: "初始说明", status: "running", createdAt: "01", startedAt: "05", summary: "旧报告", files: ["旧文件"], stats: { reads: 0, commands: 0, edits: 0 }, activity: [], rounds: [
      { status: "done", startedAt: "01", endedAt: "02", summary: "报告一", files: ["文件一"], followUp: "第二轮说明" },
      { status: "stuck", startedAt: "03", endedAt: "04", summary: "报告二", followUp: "第三轮说明" },
    ] };
    const rounds = jobDetailRounds(job, [tool("a", { at: "01" }), tool("b", { at: "02" }), tool("c", { at: "03" }), tool("d", { at: "05" })]);
    expect(rounds.map((round) => round.instruction)).toEqual(["初始说明", "第二轮说明", "第三轮说明"]);
    expect(rounds.map((round) => round.steps?.map((step) => step.id))).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(rounds.map((round) => round.job.summary)).toEqual(["报告一", "报告二", undefined]);
    expect(rounds.map((round) => round.job.files)).toEqual([["文件一"], undefined, undefined]);
    expect(jobDetailRounds(job, undefined)[0].steps).toBeUndefined();
  });

  it("续做那一轮开头那句就是「这一轮的要求」，不在执行过程里再列一遍；轮中途补充的照常列", () => {
    const job: Job = { id: "t", assistantId: "hob", title: "测试", instruction: "初始说明", status: "running", createdAt: "01", startedAt: "03", stats: { reads: 0, commands: 0, edits: 0 }, activity: [], rounds: [
      { status: "done", startedAt: "01", endedAt: "02", followUp: "继续做完" },
    ] };
    const user = (id: string, at: string, text: string): JobStep => ({ id, kind: "text", at, from: "user", text });
    const rounds = jobDetailRounds(job, [tool("a", { at: "01" }), user("u1", "03", "「Hob」接着说（11月8日 05:00）：继续做完"), tool("b", { at: "04" }), user("u2", "05", "用户接着说（11月8日 05:10）：顺便看下日志")]);
    expect(rounds[1]!.steps?.map((step) => step.id)).toEqual(["b", "u2"]);
  });
});

describe("续做过的任务卡", () => {
  const job: Job = {
    id: "t-1", assistantId: "hob", title: "巡检", instruction: "检查", status: "running", createdAt: "2026-11-05T01:00:00.000Z",
    startedAt: "2026-11-05T03:00:00.000Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [],
    rounds: [
      { status: "done", startedAt: "2026-11-05T01:00:00.000Z", endedAt: "2026-11-05T01:06:00.000Z", durationMs: 360000 },
      { status: "stuck", statusReason: "等不到接口", startedAt: "2026-11-05T02:00:00.000Z", endedAt: "2026-11-05T02:01:00.000Z", durationMs: 60000 },
    ],
  };

  it("前面几张停在那一轮结束时，最后一张跟着任务", () => {
    expect(jobRoundView(job, 0)).toMatchObject({ status: "done", durationMs: 360000, statusReason: undefined });
    expect(jobRoundView(job)).toMatchObject({ status: "done" });
    expect(jobRoundView(job, 1)).toMatchObject({ status: "stuck", statusReason: "等不到接口", durationMs: 60000 });
    expect(jobRoundView(job, 2)).toBe(job);
    const fresh = { ...job, rounds: undefined };
    expect(jobRoundView(fresh, 0)).toBe(fresh);
  });

  it("沉淀结果跟着那一轮走，最后一张不带上一轮的", () => {
    const sediment: SedimentStatus = { status: "saved", name: "x", title: "写报告", version: 2, updated: true };
    const withSediment: Job = { ...job, rounds: [{ ...job.rounds![0]!, sediment }], sediment: undefined };
    expect(jobRoundView(withSediment, 0).sediment).toEqual(sediment);
    expect(jobRoundView(withSediment, 1).sediment).toBeUndefined();
  });
});
