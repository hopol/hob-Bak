import { describe, expect, it } from "vitest";
import type { Approval, Delegation, Job, Routine } from "../../shared/types.ts";
import type { KnowledgeEntry } from "../../shared/knowledge.ts";
import { assistantStatus, formatNext, groupSidebarFiles, nextRoutine, routineSummary, sidebarInfoValues, sidebarJobs } from "../src/sidebar-data.ts";

const routine = (active = true): Routine => ({ id: "r", assistantId: "a", name: "简报", instruction: "", schedules: ["0 9 * * *"], active, createdAt: "2026-01-01T00:00:00Z", runs: [] });
const job = (status: Job["status"], id = status): Job => ({ id, assistantId: "a", title: id, instruction: "", status, createdAt: "2026-01-01T00:00:00Z", endedAt: ["done", "failed", "stuck", "stopped"].includes(status) ? "2026-01-01T02:00:00Z" : undefined, stats: { reads: 0, edits: 0, commands: 0 }, activity: [] });

describe("右栏数据", () => {
  it("按设置时区计算跨天的下次运行", () => {
    const now = new Date("2026-01-01T02:00:00Z");
    const next = nextRoutine([routine()], "Asia/Shanghai", now)!;
    expect(next.at.toISOString()).toBe("2026-01-02T01:00:00.000Z");
    expect(formatNext(next.at, "Asia/Shanghai", now)).toBe("明天 09:00");
    expect(routineSummary([routine()], "Asia/Shanghai", now)).toBe("1 个 · 明天 09:00");
  });
  it("没有和全部暂停", () => {
    expect(nextRoutine([routine(false)], "UTC")).toBeUndefined();
    expect(routineSummary([], "UTC")).toBe("没有");
    expect(routineSummary([routine(false)], "UTC")).toBe("1 个 · 已暂停");
  });
  it.each(["running", "queued", "waiting"] as const)("%s 只有运行中显示命令行", (status) => {
    const result = sidebarJobs([job(status), job("done")], "a");
    expect(result.running?.status).toBe(status === "running" ? status : undefined);
    expect(result.last?.status).toBe("done");
  });
  it("无任务和空闲最近任务", () => {
    expect(sidebarJobs([], "a")).toMatchObject({ running: undefined, last: undefined });
    expect(sidebarJobs([job("failed")], "a").last?.status).toBe("failed");
  });
  it("只显示当前助手的任务", () => {
    const other = { ...job("running", "other"), assistantId: "other" };
    expect(sidebarJobs([other, job("done")], "a")).toMatchObject({ running: undefined, last: job("done") });
  });
  it("助手状态统一计算并按确认、执行、排队排序", () => {
    const a = { id: "a", busy: false };
    const approval: Approval = { id: "p", assistantId: "a", title: "确认", options: [], status: "pending", source: "router", createdAt: "2026-01-01T00:00:00Z" };
    const delegation: Delegation = { id: "d", from: "hob", to: "a", text: "", createdAt: "2026-01-01T00:00:00Z", status: "running", jobIds: [] };
    expect(assistantStatus({ ...a, busy: true }, [], [], [])).toBe("执行中");
    expect(assistantStatus(a, [], [approval], [])).toBe("等你确认");
    expect(assistantStatus(a, [], [], [delegation])).toBe("执行中");
    // 交出去的一方（主助手）这一轮已经说完了，等结果时是空闲的
    expect(assistantStatus({ id: "hob", busy: false }, [], [], [delegation])).toBe("空闲");
    expect(assistantStatus(a, [job("queued")], [], [])).toBe("排队中");
    expect(assistantStatus(a, [], [], [])).toBe("空闲");
    expect(assistantStatus({ ...a, busy: true }, [job("running"), job("queued")], [approval], [delegation])).toBe("等你确认");
    // 任务提了问在等助手回：不是等用户，算执行中
    expect(assistantStatus(a, [job("waiting"), job("queued")], [], [])).toBe("执行中");
    expect(assistantStatus(a, [job("running"), job("queued")], [], [])).toBe("执行中");
    expect(assistantStatus(a, [job("queued")], [], [delegation])).toBe("执行中");
    expect(assistantStatus(a, [job("running")], [{ ...approval, assistantId: "other", source: "job", jobId: "running" }], [])).toBe("等你确认");
    expect(assistantStatus(a, [{ ...job("running"), assistantId: "other" }], [{ ...approval, assistantId: "other", status: "answered" }], [{ ...delegation, to: "other" }])).toBe("空闲");
    expect(assistantStatus(a, [], [], [{ ...delegation, status: "waiting" }])).toBe("空闲");
  });
  it("有排队任务时仍能找到正在运行的任务", () => {
    const running = job("running");
    const queued = { ...job("queued"), createdAt: "2026-01-02T00:00:00Z" };
    expect(sidebarJobs([running, queued], "a").running).toEqual(running);
  });
  it("信息卡的空值和数量", () => {
    expect(sidebarInfoValues(0, [], 0)).toEqual({ skills: "没有", knowledge: "未开启", rules: "没有" });
    expect(sidebarInfoValues(2, ["工作资料", "产品文档"], 3)).toEqual({ skills: "2 个", knowledge: "工作资料、产品文档", rules: "3 条" });
  });
  it("文件从周一零点分组", () => {
    const now = new Date(2026, 0, 7, 12);
    const entry = (day: number) => ({ updatedAt: new Date(2026, 0, day).toISOString() }) as KnowledgeEntry;
    expect(groupSidebarFiles([entry(5), entry(4)], now)).toEqual({ week: [entry(5)], older: [entry(4)] });
  });
});
