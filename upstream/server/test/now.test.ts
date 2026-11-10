import { describe, expect, it, vi } from "vitest";
import type { HobRuntime } from "../src/runtime.ts";
import { nowBlock } from "../src/now.ts";

describe("现在", () => {
  it("按助手、状态和时间过滤，并格式化各行", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-04T09:07:00Z"));
    try {
      const jobs = [
        { id: "t-run", assistantId: "hob", title: "统计用量", status: "running", startedAt: "2026-11-04T09:04:00Z" },
        { id: "t-new", assistantId: "hob", title: "刚开始", status: "running", startedAt: "2026-11-04T09:06:30Z" },
        { id: "t-queue", assistantId: "hob", title: "查磁盘", status: "queued" },
        { id: "t-wait", assistantId: "hob", title: "清理日志", status: "waiting" },
        { id: "t-done", assistantId: "hob", title: "读回 CSV 数字", status: "done", endedAt: "2026-11-04T08:58:00Z" },
        { id: "t-stuck", assistantId: "hob", title: "每人明细页", status: "stuck", endedAt: "2026-11-04T09:05:00Z" },
        { id: "t-long", assistantId: "hob", title: "一二三四五六七八九十一二三四五六七八九十一", status: "failed", endedAt: "2026-11-04T09:00:00Z" },
        { id: "t-old", assistantId: "hob", title: "旧", status: "done", endedAt: "2026-11-03T09:06:59Z" },
        { id: "t-routine", assistantId: "hob", title: "定时", status: "done", endedAt: "2026-11-04T09:06:00Z", routineId: "r" },
        { id: "t-other", assistantId: "other", title: "别人的", status: "running" },
      ];
      const store = {
        jobs: () => jobs,
        delegations: () => [{ from: "hob", to: "writer", status: "running", text: "整理周报素材", createdAt: "2026-11-04T03:20:00Z" }],
        approvals: () => [{ assistantId: "hob", status: "pending", title: "发到公众号吗？" }, { assistantId: "other", status: "pending", title: "别人的问题" }],
        assistant: () => ({ name: "写作" }),
      };
      const runtime = { store, settings: { settings: { general: { timezone: "Asia/Shanghai" } } } } as unknown as HobRuntime;
      expect(nowBlock(runtime, "hob")).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-run「统计用量」，运行 3 分钟；t-new「刚开始」，刚开始；t-queue「查磁盘」，排队中；t-wait「清理日志」，等你回复",
        "转交中：写作「整理周报素材」，11:20 起",
        "等用户选：发到公众号吗？",
        "最近结束：t-stuck「每人明细页」17:05 受阻；t-long「一二三四五六七八九十一二三四五六七八九十…」17:00 失败；t-done「读回 CSV 数字」16:58 已完成",
      ].join("\n"));
      expect(nowBlock(runtime, "other")).toBe("【现在】2026-11-04 17:07 周三\n进行中：t-other「别人的」，刚开始\n等用户选：别人的问题");
      expect(nowBlock(runtime, "empty")).toBe("【现在】2026-11-04 17:07 周三");
      jobs.push(...Array.from({ length: 6 }, (_, i) => ({ id: `t-extra${i}`, assistantId: "hob", title: "结束", status: i === 5 ? "stopped" : "done", endedAt: `2026-11-04T09:0${i}:30Z` })));
      const recent = nowBlock(runtime, "hob").split("\n").find((line) => line.startsWith("最近结束："))!;
      expect(recent.split("；")).toHaveLength(5);
      expect(recent).toContain("t-extra5「结束」17:05 已停止");
      expect(recent).not.toContain("t-done");
    } finally { vi.useRealTimers(); }
  });
});
