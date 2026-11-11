import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../shared/types.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

/**
 * 假模型：对话层的回合回一句话；任务的第一次调用按 reply 交结果，交完再问就回一句话收尾
 * （任务交完 report 还会被问一次，这时不再交第二次）。
 */
function faux(reply: (all: string) => ReturnType<typeof call>) {
  return (context: any) => {
    const messages: any[] = context.messages ?? [];
    if (!JSON.stringify(messages[0] ?? "").includes("派出的后台任务")) return text("收到。");
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const reported = lastAssistant?.content?.some((block: any) => block.type === "toolCall" && block.name === "report");
    return reported ? text("好。") : reply(JSON.stringify(messages));
  };
}

const done = (result: string) => call("report", { outcome: "done", result });

describe("任务依赖（after）", () => {
  it("B 等 A 做完才开始，等的时候不占并发名额", async () => {
    const hob = makeHob({}, { settings: { work: { maxJobs: 2 } } });
    let release = () => {};
    try {
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses(Array.from({ length: 16 }, () => (context: any) => {
        const messages: any[] = context.messages ?? [];
        if (!JSON.stringify(messages[0] ?? "").includes("派出的后台任务")) return text("收到。");
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        if (lastAssistant?.content?.some((block: any) => block.type === "toolCall" && block.name === "report")) return text("好。");
        const all = JSON.stringify(messages);
        if (all.includes("JOB_A")) return gate.then(() => done("数出来 3 个文件"));
        return done("总结写好了");
      }));
      const a = await hob.runtime.jobs.start("hob", { title: "先查目录", instruction: "JOB_A 查一下目录" });
      await waitFor(() => hob.runtime.store.job(a.id)?.status === "running");

      const b = await hob.runtime.jobs.start("hob", { title: "再写总结", instruction: "JOB_B 写总结", after: [a.id] });
      expect(hob.runtime.store.job(b.id)).toMatchObject({ status: "queued", after: [a.id] });

      // 不用等的活插进空出来的名额：说明 B 在等的时候没占名额
      const c = await hob.runtime.jobs.start("hob", { title: "顺手查别的", instruction: "JOB_C 查别的" });
      await waitFor(() => hob.runtime.store.job(c.id)?.status === "running");
      expect(hob.runtime.store.job(b.id)?.status).toBe("queued");
      expect(hob.runtime.store.jobs().filter((job) => job.status === "running")).toHaveLength(2);

      release();
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(a.id)?.status).toBe("done");
      expect(hob.runtime.store.job(b.id)).toMatchObject({ status: "done", summary: "总结写好了" });
    } finally {
      release();
      hob.close();
    }
  });

  it("A 没做成：B 结束为受阻、原因写对、助手收到事件；A → B → C 时 C 也受阻", async () => {
    const hob = makeHob({}, { settings: { work: { maxJobs: 1 } } });
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses(Array.from({ length: 8 }, () => faux(() => call("report", { outcome: "stuck", result: "目录没权限" }))));
      const a = await hob.runtime.jobs.start("hob", { title: "先查目录", instruction: "JOB_A 查目录" });
      const b = await hob.runtime.jobs.start("hob", { title: "再写总结", instruction: "JOB_B 写总结", after: [a.id] });
      const c = await hob.runtime.jobs.start("hob", { title: "发布总结", instruction: "JOB_C 发布", after: [b.id] });
      await hob.runtime.jobs.waitIdle();

      expect(hob.runtime.store.job(a.id)?.status).toBe("stuck");
      expect(hob.runtime.store.job(b.id)).toMatchObject({ status: "stuck", statusReason: "前置任务「先查目录」没做成" });
      expect(hob.runtime.store.job(c.id)).toMatchObject({ status: "stuck", statusReason: "前置任务「再写总结」没做成" });
      // B、C 都没真的跑起来：没有动手的步骤
      expect(hob.runtime.jobs.transcript(b.id).filter((step) => step.kind === "tool")).toHaveLength(0);
      expect(hob.runtime.jobs.transcript(c.id).filter((step) => step.kind === "tool")).toHaveLength(0);
      const sent = event.mock.calls.map((args) => String(args[1]));
      expect(sent.filter((line) => line.startsWith("任务「再写总结」") && line.includes("前置任务「先查目录」没做成"))).toHaveLength(1);
      expect(sent.filter((line) => line.startsWith("任务「发布总结」") && line.includes("前置任务「再写总结」没做成"))).toHaveLength(1);
    } finally {
      hob.close();
    }
  });

  it("前置都已经完成：立刻排上，不留在等", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses(Array.from({ length: 16 }, () => faux(() => done("好了"))));
      const a = await hob.runtime.jobs.start("hob", { title: "先查目录", instruction: "JOB_A 查目录" });
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(a.id)?.status).toBe("done");

      const b = await hob.runtime.jobs.start("hob", { title: "再写总结", instruction: "JOB_B 写总结", after: [a.id] });
      expect(hob.runtime.store.job(b.id)?.status).not.toBe("queued");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(b.id)?.status).toBe("done");
    } finally {
      hob.close();
    }
  });

  it("B 开始时，说明后面带着前置的标题、状态和报告路径", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses(Array.from({ length: 16 }, () => faux(() => done("数出来 3 个文件"))));
      const a = await hob.runtime.jobs.start("hob", { title: "先查目录", instruction: "JOB_A 查目录" });
      await hob.runtime.jobs.waitIdle();
      const report = hob.runtime.store.job(a.id)!.reportPath!;
      expect(report).toMatch(/report\.md$/);

      const b = await hob.runtime.jobs.start("hob", { title: "再写总结", instruction: "JOB_B 写总结", after: [a.id] });
      await hob.runtime.jobs.waitIdle();
      const said = readFileSync(hob.runtime.store.workerFile(b.id), "utf8");
      expect(said).toContain(`「先查目录」（${a.id}）已完成，报告：${report}`);
    } finally {
      hob.close();
    }
  });

  it("start_job 的 after 一路带下去；填错 id 或前置没做成时报错说清是哪个", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses(Array.from({ length: 16 }, () => faux(() => done("好了"))));
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "start_job")!;
      const a = await hob.runtime.jobs.start("hob", { title: "先查目录", instruction: "JOB_A 查目录" });
      await hob.runtime.jobs.waitIdle();

      const planned = await tool.execute("call", { title: "再写总结", note: "按文件数写一句总结", after: [a.id] }) as { content: { text: string }[] };
      expect(planned.content[0].text).toMatch(/^任务「再写总结」（t-\w+）已排上，等「先查目录」做完就开始。$/);
      expect(hob.runtime.store.jobs().find((job) => job.title === "再写总结")?.after).toEqual([a.id]);
      await hob.runtime.jobs.waitIdle();

      const missing = await tool.execute("call", { title: "写总结", after: ["t-nope"] }) as { content: { text: string }[]; isError?: boolean };
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toBe("没有这个任务：t-nope");

      const failed: Job = { id: "t-old", assistantId: "hob", title: "老任务", instruction: "老活", status: "failed", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
      hob.runtime.store.saveJob(failed);
      const bad = await tool.execute("call", { title: "写总结", after: ["t-old"] }) as { content: { text: string }[]; isError?: boolean };
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toBe("前置任务「老任务」（t-old）失败，等不到它做完了。");
      expect(hob.runtime.store.jobs().filter((job) => job.title === "写总结")).toHaveLength(0);
    } finally {
      hob.close();
    }
  });
});
