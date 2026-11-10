import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HobEvent, JobStep } from "../../shared/types.ts";
import { commandSummary } from "../../shared/command.ts";
import { STEP_OUTPUT_LIMIT, SEDIMENT_PROMPT_HEAD, deriveSteps, toolStep, toolTitle } from "../src/transcript.ts";
import { call, makeHob, text } from "./helpers.ts";

const homes: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hob-transcript-"));
  homes.push(dir);
  return dir;
}

/** 一条会话条目：type=message。 */
function message(role: string, extra: Record<string, unknown>) {
  return { type: "message", id: `e-${Math.random().toString(16).slice(2)}`, timestamp: "2026-11-01T10:00:00.000Z", message: { role, ...extra } };
}

function sessionFile(lines: unknown[]): string {
  const file = join(tempDir(), "worker.jsonl");
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

function mixedSession(): string {
  return sessionFile([
    { type: "session", version: 3, id: "s-1", timestamp: "2026-11-01T10:00:00.000Z", cwd: "/work" },
    message("user", { content: "写个脚本跑通", timestamp: 1_000 }),
    message("assistant", {
      timestamp: 1_100,
      content: [
        { type: "thinking", thinking: "先看看目录里有什么" },
        { type: "text", text: "我先看下目录。" },
        { type: "toolCall", id: "call-read", name: "read", arguments: { path: "/work/a.ts", offset: 1, limit: 10 } },
        { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "npm test" } },
        { type: "toolCall", id: "call-edit", name: "edit", arguments: { path: "/work/b.ts", edits: [{ oldText: "let a = 1", newText: "let a = 2" }] } },
        { type: "toolCall", id: "call-write", name: "write", arguments: { path: "/work/run.sh", content: "#!/bin/sh\necho hi\n" } },
      ],
    }),
    message("toolResult", {
      timestamp: 1_200,
      toolCallId: "call-read",
      toolName: "read",
      content: [{ type: "text", text: "export const a = 1;\n" }],
      isError: false,
      durationMs: 12,
    }),
    message("toolResult", {
      timestamp: 1_300,
      toolCallId: "call-bash",
      toolName: "bash",
      content: [{ type: "text", text: "1 test failed" }],
      isError: true,
      durationMs: 2_400,
    }),
    message("toolResult", {
      timestamp: 1_400,
      toolCallId: "call-edit",
      toolName: "edit",
      content: [{ type: "text", text: "Edited b.ts" }],
      isError: false,
    }),
    message("toolResult", {
      timestamp: 1_500,
      toolCallId: "call-write",
      toolName: "write",
      content: [{ type: "text", text: "Wrote 21 bytes to /work/run.sh" }],
      isError: false,
    }),
    message("user", { content: "别动 git 历史", timestamp: 1_600 }),
    message("assistant", { timestamp: 1_700, content: [{ type: "text", text: "好。" }] }),
    // 系统追问不进时间线
    message("user", { content: "你还没有调用 report 提交结果。请现在调用 report(outcome, summary)。", timestamp: 1_800 }),
    message("assistant", {
      timestamp: 1_900,
      content: [{ type: "toolCall", id: "call-report", name: "report", arguments: { outcome: "done", result: "脚本跑通了" } }],
    }),
    message("toolResult", {
      timestamp: 2_000,
      toolCallId: "call-report",
      toolName: "report",
      content: [{ type: "text", text: "结果已记录。" }],
      isError: false,
    }),
  ]);
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("任务过程推导", () => {
  it("说明、思考、各种工具、出错、补话都进时间线", () => {
    const steps = deriveSteps(mixedSession(), { cwd: "/work" });
    expect(steps.map((step) => `${step.kind}:${step.name ?? step.from}`)).toEqual([
      "thinking:undefined",
      "text:assistant",
      "tool:read",
      "tool:bash",
      "tool:edit",
      "tool:write",
      "text:user",
      "text:assistant",
      "tool:report",
    ]);

    const [thinking, intro, read, bash, edit, write, mine, closing, report] = steps;
    expect(thinking.text).toBe("先看看目录里有什么");
    expect(intro.text).toBe("我先看下目录。");

    expect(read.title).toBe("读取 a.ts · 1–10 行");
    expect(read.args).toEqual({ path: "a.ts", offset: 1, limit: 10 });
    expect(read.output).toBe("export const a = 1;\n");
    expect(read.durationMs).toBe(12);
    expect(read.running).toBeUndefined();

    expect(bash.title).toBe("运行 `npm test`");
    expect(bash.isError).toBe(true);
    expect(bash.output).toBe("1 test failed");
    expect(bash.durationMs).toBe(2400);

    expect(edit.title).toBe("修改 b.ts");
    expect(edit.args).toEqual({ path: "b.ts", edits: [{ oldText: "let a = 1", newText: "let a = 2" }] });

    expect(write.title).toBe("写入 run.sh");
    expect(write.args).toEqual({ path: "run.sh", contentLength: 18 });

    expect(mine).toMatchObject({ kind: "text", from: "user", text: "别动 git 历史" });
    expect(closing.text).toBe("好。");
    expect(report.title).toBe("提交结果");
    expect(report.output).toBe("结果已记录。");
  });

  it("输出超过 20KB 截断，全文落到任务目录", () => {
    const full = "x".repeat(STEP_OUTPUT_LIMIT + 500);
    const file = sessionFile([
      message("assistant", { timestamp: 1_000, content: [{ type: "toolCall", id: "call-big", name: "bash", arguments: { command: "cat big" } }] }),
      message("toolResult", { timestamp: 1_100, toolCallId: "call-big", toolName: "bash", content: [{ type: "text", text: full }], isError: false }),
    ]);
    const saved: string[] = [];
    const steps = deriveSteps(file, {
      save: (stepId, text) => {
        const path = join(tempDir(), `${stepId}.txt`);
        writeFileSync(path, text);
        saved.push(path);
        return path;
      },
    });
    const step = steps[0];
    expect(step.output?.startsWith("x".repeat(100))).toBe(true);
    expect((step.output ?? "").length).toBeLessThan(full.length);
    expect(step.output).toContain("完整输出在");
    expect(step.outputPath).toBe(saved[0]);
    expect(readFileSync(saved[0], "utf8")).toHaveLength(full.length);
  });

  it("新旧开头的沉淀消息都显示成「沉淀技能」", () => {
    const file = sessionFile([
      message("user", { content: "整理报告", timestamp: 1_000 }),
      message("user", { content: `${SEDIMENT_PROMPT_HEAD}，下次接到同类的事，照着它就能一次做成用户要的样子。`, timestamp: 2_000 }),
      message("user", { content: "这件事以后还会再做。回顾刚才的过程，把能复用的做法写成技能，下次接到同类的事，照着它就能一次做成用户要的样子。", timestamp: 3_000 }),
      message("user", { content: "这件事以后还会再做。回顾刚才的过程，把能复用的做法沉淀成技能，下次接到同类的事，照着它就能一次做成用户要的样子。", timestamp: 4_000 }),
    ]);
    expect(deriveSteps(file).map((step) => step.text)).toEqual(["沉淀技能", "沉淀技能", "沉淀技能"]);
  });

  it("没有会话文件时是空列表，不会报错", () => {
    expect(deriveSteps(join(tempDir(), "nope.jsonl"))).toEqual([]);
  });

  it("工具步骤的一行说明用相对路径，没行范围就不带", () => {
    expect(toolStep({ id: "a", name: "read", args: { path: "/work/src/a.ts" }, cwd: "/work" }).title).toBe("读取 src/a.ts");
    expect(toolStep({ id: "b", name: "ls", args: {}, cwd: "/work" }).title).toBe("列出 .");
    expect(toolStep({ id: "c", name: "grep", args: { pattern: "TODO" } }).title).toBe("搜索 `TODO`");
  });
});

describe("任务过程实时事件", () => {
  it("工具调用推 job_step，跑完按同一个 id 替换（带输出和用时）", async () => {
    const hob = makeHob();
    try {
      const events: HobEvent[] = [];
      hob.runtime.bus.subscribe((event) => events.push(event));
      hob.faux.setResponses([
        call("bash", { command: "echo hi" }),
        call("report", { outcome: "done", result: "跑通了" }),
        text("好"),
      ]);
      hob.faux.appendResponses([text("跑通了。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "跑命令", instruction: "跑一下 echo" });
      await hob.runtime.jobs.waitIdle();

      const steps = events.flatMap((event) => (event.type === "job_step" ? [event.step as JobStep] : []));
      const bash = steps.filter((step) => step.name === "bash");
      expect(bash.length).toBeGreaterThanOrEqual(2);
      expect(bash[0].running).toBe(true);
      expect(bash.some((step) => step.running === undefined && (step.output ?? "").includes("hi"))).toBe(true);
      // 交代完结果后模型又说了一句，这句也在时间线里
      expect(steps.some((step) => step.kind === "text" && step.text === "好")).toBe(true);
      expect(steps.some((step) => step.name === "report" && step.title === "提交结果")).toBe(true);

      const done = hob.runtime.store.job(job.id)!;
      expect(done.model).toBe("hob-faux/faux-1");
      expect(done.thinking).toBe("off");
      expect(done.usage).toBeTruthy();
      expect(done.durationMs ?? -1).toBeGreaterThanOrEqual(0);
    } finally {
      hob.close();
    }
  });

  it("实时事件里超过 4KB 的输出也截断，全文落在任务目录", async () => {
    const hob = makeHob();
    try {
      const events: HobEvent[] = [];
      hob.runtime.bus.subscribe((event) => events.push(event));
      hob.faux.setResponses([
        call("bash", { command: "seq 1 4000" }),
        call("report", { outcome: "done", result: "打了很多行" }),
        text("好"),
      ]);
      hob.faux.appendResponses([text("打完了。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "多输出", instruction: "打点东西出来" });
      await hob.runtime.jobs.waitIdle();

      const bash = events.flatMap((event) => (event.type === "job_step" ? [event.step as JobStep] : [])).filter((step) => step.name === "bash");
      const finished = [...bash].reverse().find((step) => step.running === undefined)!;
      expect((finished.output ?? "").length).toBeLessThan(5_000);
      expect(finished.output).toContain("完整输出在");
      expect(finished.outputPath && existsSync(finished.outputPath)).toBe(true);
      // 落盘的是全文，transcript 拉得到完整输出
      const transcript = hob.runtime.jobs.transcript(job.id);
      const full = transcript.find((step) => step.name === "bash")!;
      expect(full.output).toContain("4000");
      expect((full.output ?? "").length).toBeGreaterThan(5_000);
    } finally {
      hob.close();
    }
  });
});

describe("步骤标题", () => {
  it("命令去掉 cd 目录 && / timeout N 外壳，只留真正执行的那条", () => {
    expect(commandSummary("cd /home/u/.hob; timeout 60 ssh -o BatchMode=yes mac 'df -h'")).toBe("mac: df -h");
    expect(commandSummary("cd /tmp && timeout 30 curl -sS https://example.com")).toBe("curl -sS https://example.com");
    expect(commandSummary('cd "/a b" && timeout -k 5 2m npm test')).toBe("npm test");
    expect(commandSummary("npm test")).toBe("npm test");
    // 只有外壳、没有后续命令时原样保留
    expect(commandSummary("cd /tmp")).toBe("cd /tmp");
    expect(commandSummary("timeout 5")).toBe("timeout 5");
    expect(toolTitle("bash", { command: "cd /w && npm run build" })).toBe("运行 `npm run build`");
  });

  it("ssh 到别的机器：写成「主机: 命令」，剥掉 bash -lc 的引号", () => {
    const script = 'cd /home/u/.hob; timeout 60 ssh -o BatchMode=yes mac \'bash -lc "\necho \\"=== df ===\\"; df -h\n"\'';
    expect(commandSummary(script)).toBe('mac: echo "=== df ==="; df -h');
    expect(commandSummary('ssh -p 2222 -tt user@host "cd /srv && git pull" 2>&1')).toBe("user@host: git pull 2>&1");
    expect(commandSummary("ssh -o ConnectTimeout=8 10.0.0.7 uptime")).toBe("10.0.0.7: uptime");
    // 没有要跑的命令（登录）时不动
    expect(commandSummary("ssh mac")).toBe("ssh mac");
    // 旧任务的活动行存的是截断过的命令，引号没收尾
    expect(commandSummary("ssh -o BatchMode=yes mac 'bash -lc \" echo \\\"=== df ===\\\"; df -h; ec…")).toBe(
      'mac: echo "=== df ==="; df -h; ec…',
    );
  });

  it("记忆工具显示成动作，带上查询或节点", () => {
    expect(toolTitle("lore_get_node", { uri: "core://agent" })).toBe("读取记忆 `core://agent`");
    expect(toolTitle("memory_search", { query: "周报格式" })).toBe("搜索记忆 `周报格式`");
    expect(toolTitle("lore_update_node", {})).toBe("保存记忆");
    expect(toolTitle("some_new_tool", {})).toBe("some_new_tool");
  });

  it("找资料显示关键词", () => {
    expect(toolTitle("find_knowledge", { query: "周报" })).toBe("找资料：周报");
    expect(toolTitle("find_knowledge", {})).toBe("找资料");
  });
});
