import { describe, expect, it } from "vitest";
import type { Approval, Delegation, Job, JobStatus } from "../../shared/types.ts";
import { assistantStatus } from "./sidebar-data.ts";

const job = (over: Partial<Job> = {}): Job => ({ id: "t-1", assistantId: "hob", title: "写周报", instruction: "", status: "running" as JobStatus, createdAt: "2026-11-08T02:00:00.000Z", activity: [], stats: { reads: 0, commands: 0, edits: 0 }, ...over } as Job);
const delegation = (over: Partial<Delegation> = {}): Delegation => ({ id: "dg-1", from: "hob", to: "a-code", text: "改一下关于页", createdAt: "2026-11-08T02:47:00.000Z", status: "running", jobIds: [], ...over });
const approval = (over: Partial<Approval> = {}): Approval => ({ id: "q-1", assistantId: "hob", title: "选一个", options: [], status: "pending", createdAt: "2026-11-08T02:00:00.000Z", ...over } as Approval);

const hob = { id: "hob", busy: false };
const code = { id: "a-code", busy: false };

describe("助手状态", () => {
  it("交出去的事还在对方那儿跑时，主助手自己不算执行中", () => {
    expect(assistantStatus(hob, [], [], [delegation()])).toBe("空闲");
  });

  it("收到转交的助手算执行中", () => {
    expect(assistantStatus(code, [], [], [delegation()])).toBe("执行中");
  });

  it("自己在回复时算执行中", () => {
    expect(assistantStatus({ id: "hob", busy: true }, [], [], [])).toBe("执行中");
  });

  it("自己名下任务在跑时算执行中", () => {
    expect(assistantStatus(hob, [job()], [], [])).toBe("执行中");
  });

  it("转交出去、对方在等用户回答时，主助手不算等你确认", () => {
    expect(assistantStatus(hob, [], [], [delegation({ status: "waiting" })])).toBe("空闲");
  });

  it("主助手自己提问没人答时算等你确认", () => {
    expect(assistantStatus(hob, [], [approval()], [])).toBe("等你确认");
  });
});
