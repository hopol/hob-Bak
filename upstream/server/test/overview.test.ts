import { describe, expect, it } from "vitest";
import type { Assistant, Job } from "../../shared/types.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { overviewText, overviewTool } from "../src/overview.ts";
import { buildWorkerPrompt } from "../src/prompt.ts";
import { text } from "./helpers.ts";
import { makeHob } from "./helpers.ts";

function job(input: Partial<Job> & { id: string; assistantId: string; title: string }): Job {
  return {
    instruction: "看看",
    status: "done",
    createdAt: new Date().toISOString(),
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
    ...input,
  } as Job;
}

const HOUR = 3600 * 1000;

describe("overview", () => {
  it("列出各助手这段时间的工作日志、结束的任务、在跑的任务和还没答的审批", async () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      const other: Assistant = {
        id: "write",
        name: "写作",
        duty: "周报和文章",
        sprite: "page",
        primary: false,
        pinned: true,
        hidden: false,
        notify: true,
        createdAt: new Date().toISOString(),
      };
      store.saveAssistant(other);

      const longSummary = `${"今天 6 条要闻。".repeat(20)}`;
      store.saveJob(
        job({
          id: "t-a",
          assistantId: "hob",
          title: "每日简报",
          status: "done",
          endedAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
          summary: longSummary,
        }),
      );
      store.saveJob(
        job({
          id: "t-b",
          assistantId: "write",
          title: "写周报",
          status: "stuck",
          endedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
          statusReason: "缺少素材",
        }),
      );
      store.saveJob(
        job({
          id: "t-c",
          assistantId: "hob",
          title: "查磁盘",
          status: "running",
          startedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
        }),
      );
      // 三天前的任务不进 24 小时的窗口
      store.saveJob(
        job({
          id: "t-d",
          assistantId: "hob",
          title: "三天前的老任务",
          status: "done",
          endedAt: new Date(Date.now() - 72 * HOUR).toISOString(),
          summary: "老结果",
        }),
      );

      store.saveApproval({
        id: "q-1",
        assistantId: "write",
        title: "发到公众号吗？",
        options: [
          { key: "A", label: "发" },
          { key: "B", label: "别发" },
        ],
        status: "pending",
        source: "router",
        createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      });
      store.saveApproval({
        id: "q-2",
        assistantId: "write",
        title: "已经答过的问题",
        options: [
          { key: "A", label: "好" },
          { key: "B", label: "不好" },
        ],
        status: "answered",
        chosen: "A",
        source: "router",
        createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      });

      store.addWorklog("hob", {
        at: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
        text: "任务已完成：每日简报",
        jobId: "t-a",
      });
      store.addWorklog("hob", {
        at: new Date(Date.now() - 72 * HOUR).toISOString(),
        text: "任务已完成：三天前的老任务",
        jobId: "t-d",
      });

      const out = overviewText(hob.runtime, 24);
      expect(out).toContain("## Hob（hob）");
      expect(out).toContain("## 写作（write）");
      // 结束的任务：标题 + 结果 + summary 前 100 字
      expect(out).toContain("- 每日简报 · 已完成 · 今天 6 条要闻。");
      expect(out).toContain("…");
      expect(out).not.toContain(longSummary);
      expect(out).toContain("- 写周报 · 受阻 · 缺少素材");
      // 在跑的任务
      expect(out).toContain("- 查磁盘 · 进行中");
      // 还没答的审批，答过的不算
      expect(out).toContain("- 发到公众号吗？");
      expect(out).not.toContain("已经答过的问题");
      // 工作日志
      expect(out).toContain("任务已完成：每日简报");
      expect(out).not.toContain("三天前的老任务");
      expect(out).not.toContain("老结果");

      // 窗口按 sinceHours 算：50 分钟前的简报还在，2 小时前的周报不在
      const recent = overviewText(hob.runtime, 1);
      expect(recent).toContain("每日简报");
      expect(recent).not.toContain("写周报");
    } finally {
      hob.close();
    }
  });

  it("没有记录时如实说明", async () => {
    const hob = makeHob();
    try {
      expect(overviewText(hob.runtime, 6)).toContain("这段时间没有记录");
    } finally {
      hob.close();
    }
  });

  it("工具默认看 24 小时，只给主助手", async () => {
    const hob = makeHob();
    try {
      const tool = overviewTool(hob.runtime);
      const result = (await tool.execute("tool-call", {})) as { content: { text: string }[] };
      expect(result.content[0].text).toContain("最近 24 小时");

      const primaryNames = buildRouterTools(hob.runtime, "hob").map((item) => item.name);
      expect(primaryNames).toContain("overview");

      hob.runtime.store.saveAssistant({
        id: "write",
        name: "写作",
        duty: "周报和文章",
        sprite: "page",
        primary: false,
        pinned: true,
        hidden: false,
        notify: true,
        createdAt: new Date().toISOString(),
      });
      expect(buildRouterTools(hob.runtime, "write").map((item) => item.name)).not.toContain("overview");

      // 主助手的 Worker 提示词里也写了早报怎么做
      const job = await hob.runtime.jobs.start("hob", { title: "早上汇总", instruction: "写今天的早报" });
      await hob.runtime.jobs.waitIdle(10_000);
      const promptSettings = () => {
        const { timezone, aboutYou } = hob.runtime.settings.settings.general;
        return { timezone, aboutYou };
      };
      expect(buildWorkerPrompt(hob.runtime.store, job.id, promptSettings())).not.toContain("overview");
      const otherJob = await hob.runtime.jobs.start("write", { title: "写周报", instruction: "写周报" });
      await hob.runtime.jobs.waitIdle(10_000);
      expect(buildWorkerPrompt(hob.runtime.store, otherJob.id, promptSettings())).not.toContain("overview");
    } finally {
      hob.close();
    }
  });

  it("主助手的 Worker 拿得到 overview 工具，别的助手拿不到", async () => {
    const hob = makeHob();
    try {
      hob.runtime.store.saveAssistant({
        id: "write",
        name: "写作",
        duty: "周报和文章",
        sprite: "page",
        primary: false,
        pinned: true,
        hidden: false,
        notify: true,
        createdAt: new Date().toISOString(),
      });
      const seen: string[][] = [];
      const record = (context: { messages: ReadonlyArray<{ role: string; toolsAdded?: { name: string }[] }> }) => {
        seen.push(context.messages.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name)));
        return text("好。");
      };

      hob.faux.setResponses([record, text("好。")]);
      await hob.runtime.jobs.start("hob", { title: "早上汇总", instruction: "写今天的早报" });
      await hob.runtime.jobs.waitIdle(20_000);
      expect(seen.flat()).toContain("overview");

      seen.length = 0;
      hob.faux.setResponses([record, text("好。")]);
      await hob.runtime.jobs.start("write", { title: "写周报", instruction: "写周报" });
      await hob.runtime.jobs.waitIdle(20_000);
      expect(seen.flat()).not.toContain("overview");
    } finally {
      hob.close();
    }
  });
});
