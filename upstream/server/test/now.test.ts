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
      const runtime = { store, home: "/tmp/hob-now-empty", settings: { settings: { general: { timezone: "Asia/Shanghai" } } } } as unknown as HobRuntime;
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

  it("自己的只列这个会话的，别处的写明出处", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-04T09:07:00Z"));
    try {
      const groups: Record<string, { id: string; name: string; parentId?: string }> = {
        "g-a": { id: "g-a", name: "团队" },
        "g-a1": { id: "g-a1", name: "相册", parentId: "g-a" },
        "g-a2": { id: "g-a2", name: "打印机", parentId: "g-a" },
        "g-b": { id: "g-b", name: "别的团队" },
        "g-b1": { id: "g-b1", name: "服务器", parentId: "g-b" },
      };
      const jobs = [
        { id: "t-g", assistantId: "hob", title: "综合里的", status: "running", startedAt: "2026-11-04T09:04:00Z", groupId: "g-a" },
        { id: "t-topic", assistantId: "hob", title: "话题里的", status: "queued", groupId: "g-a1" },
        { id: "t-sibling", assistantId: "hob", title: "别的话题", status: "running", startedAt: "2026-11-04T09:04:00Z", groupId: "g-a2" },
        { id: "t-other", assistantId: "hob", title: "别的群", status: "running", startedAt: "2026-11-04T09:04:00Z", groupId: "g-b" },
        { id: "t-othertopic", assistantId: "hob", title: "别的群的话题", status: "waiting", groupId: "g-b1" },
        { id: "t-dm", assistantId: "hob", title: "单聊的", status: "running", startedAt: "2026-11-04T09:04:00Z" },
        { id: "t-done", assistantId: "hob", title: "结束的", status: "done", endedAt: "2026-11-04T09:05:00Z", groupId: "g-a" },
        { id: "t-done-else", assistantId: "hob", title: "别处结束的", status: "done", endedAt: "2026-11-04T09:05:00Z", groupId: "g-a2" },
      ];
      const approvals = [
        { assistantId: "hob", status: "pending", source: "router", title: "综合里的问题", groupId: "g-a" },
        { assistantId: "hob", status: "pending", source: "router", title: "话题里的问题", groupId: "g-a2" },
        { assistantId: "hob", status: "pending", source: "router", title: "单聊里的问题" },
        { assistantId: "hob", status: "pending", source: "job", title: "任务里的问题" },
      ];
      const root = (id: string) => groups[id]?.parentId ?? groups[id]?.id;
      const store = { jobs: () => jobs, group: (id: string) => groups[id], groupMatches: (filter: string, id?: string) => !!id && !!root(id) && root(filter) === root(id), delegations: () => [], approvals: () => approvals, assistant: () => ({ name: "写作" }) };
      const runtime = { store, home: "/tmp/hob-now-empty", settings: { settings: { general: { timezone: "Asia/Shanghai" } } } } as unknown as HobRuntime;
      // 综合：只看自己的，别处是同一个群的话题；单聊和别的群里的管不了，不列
      expect(nowBlock(runtime, "hob", "g-a")).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-g「综合里的」，运行 3 分钟",
        "等用户选：综合里的问题",
        "最近结束：t-done「结束的」17:05 已完成",
        "别处进行中：话题「相册」里 t-topic「话题里的」，排队中；话题「打印机」里 t-sibling「别的话题」，运行 3 分钟",
        "别处等用户选：话题「打印机」里「话题里的问题」",
      ].join("\n"));
      // 话题：自己只列这个话题的，别处是综合和别的话题
      expect(nowBlock(runtime, "hob", "g-a1")).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-topic「话题里的」，排队中",
        "别处进行中：综合里 t-g「综合里的」，运行 3 分钟；话题「打印机」里 t-sibling「别的话题」，运行 3 分钟",
        "别处等用户选：综合里「综合里的问题」；话题「打印机」里「话题里的问题」",
      ].join("\n"));
      // 单聊：自己只列单聊的，别处是它所在的所有群和话题
      expect(nowBlock(runtime, "hob")).toBe([
        "【现在】2026-11-04 17:07 周三",
        "进行中：t-dm「单聊的」，运行 3 分钟",
        "等用户选：单聊里的问题",
        "别处进行中：群「团队」里 t-g「综合里的」，运行 3 分钟；群「团队」的话题「相册」里 t-topic「话题里的」，排队中；群「团队」的话题「打印机」里 t-sibling「别的话题」，运行 3 分钟；群「别的团队」里 t-other「别的群」，运行 3 分钟；群「别的团队」的话题「服务器」里 t-othertopic「别的群的话题」，等你回复",
        "别处等用户选：群「团队」里「综合里的问题」；群「团队」的话题「打印机」里「话题里的问题」",
      ].join("\n"));
    } finally { vi.useRealTimers(); }
  });
});
