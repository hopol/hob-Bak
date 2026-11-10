import { describe, expect, it } from "vitest";
import type { Approval, AssistantSummary, Job, Routine } from "../../shared/types.ts";
import { homeGroups, pinList, RECENT } from "../src/home.ts";

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
/** n 分钟前（ISO，和接口给的一致用 Z）。 */
const minsAgo = (n: number) => new Date(NOW - n * 60000).toISOString();

function asst(id: string, extra: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id,
    name: id,
    duty: "",
    sprite: "hob",
    primary: false,
    pinned: false,
    hidden: false,
    notify: false,
    instructions: "",
    createdAt: minsAgo(60 * 24 * 30),
    unread: 0,
    busy: false,
    ...extra,
  };
}

function job(id: string, status: Job["status"], extra: Partial<Job> = {}): Job {
  return {
    id,
    assistantId: "hob",
    title: id,
    instruction: "",
    status,
    createdAt: minsAgo(60),
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
    ...extra,
  };
}

function approval(id: string, status: Approval["status"], extra: Partial<Approval> = {}): Approval {
  return {
    id,
    assistantId: "hob",
    title: id,
    options: [{ key: "A", label: "好" }],
    status,
    source: "router",
    createdAt: minsAgo(30),
    ...extra,
  };
}

function routine(id: string, active: boolean, schedule = "0 9 * * *"): Routine {
  return {
    id,
    assistantId: "hob",
    name: id,
    instruction: "",
    schedules: [schedule],
    active,
    createdAt: minsAgo(60 * 24 * 10),
    runs: [],
  };
}

function index<T extends { id: string }>(list: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const x of list) out[x.id] = x;
  return out;
}

describe("首页分组", () => {
  it("待确认只取还没答的，新的在前", () => {
    const groups = homeGroups({
      assistants: [asst("hob", { pinned: true })],
      jobs: {},
      approvals: index([
        approval("ap-old", "pending", { createdAt: minsAgo(90) }),
        approval("ap-new", "pending", { createdAt: minsAgo(5) }),
        approval("ap-done", "answered", { createdAt: minsAgo(1) }),
      ]),
      routines: [],
      query: "",
    });
    expect(groups.asks.map((a) => a.id)).toEqual(["ap-new", "ap-old"]);
  });

  it(`最近任务只取 ${RECENT} 条、24 小时内结束的，在跑的不算`, () => {
    const done = Array.from({ length: RECENT + 2 }, (_, i) =>
      job(`t-${i}`, "done", { createdAt: minsAgo(200 + i), endedAt: minsAgo(10 + i) }),
    );
    const old = job("t-old", "done", { createdAt: minsAgo(60 * 40), endedAt: minsAgo(60 * 30) });
    const live = job("t-live", "running", { startedAt: minsAgo(2) });
    const groups = homeGroups(
      { assistants: [asst("hob", { pinned: true })], jobs: index([...done, old, live]), approvals: {}, routines: [], query: "" },
      NOW,
    );
    expect(groups.recent).toHaveLength(RECENT);
    expect(groups.recent.map((j) => j.id)).toEqual(done.slice(0, RECENT).map((j) => j.id));
    expect(groups.live.map((j) => j.id)).toEqual(["t-live"]);
  });

  it("进行中和最近任务都包含定时执行", () => {
    const groups = homeGroups({ assistants: [], jobs: index([
      job("t-routine-live", "running", { routineId: "r-1" }),
      job("t-routine-done", "done", { routineId: "r-1", endedAt: minsAgo(2) }),
    ]), approvals: {}, routines: [], query: "" }, NOW);
    expect(groups.live.map((j) => j.id)).toEqual(["t-routine-live"]);
    expect(groups.recent.map((j) => j.id)).toEqual(["t-routine-done"]);
  });

  it("搜索时只列匹配的助手，其它组隐藏", () => {
    const groups = homeGroups(
      {
        assistants: [
          asst("hob", { pinned: true, name: "Hob" }),
          asst("page", { name: "写作", duty: "周报和文章" }),
          asst("house", { name: "家里 NAS", duty: "相册和备份" }),
        ],
        jobs: index([job("t-live", "running", { startedAt: minsAgo(3) })]),
        approvals: index([approval("ap-1", "pending")]),
        routines: [routine("r-1", true)],
        query: "写作",
      },
      NOW,
    );
    expect(groups.searching).toBe(true);
    expect(groups.pins).toEqual([]);
    expect(groups.rows.map((a) => a.id)).toEqual(["page"]);
    expect(groups.asks).toEqual([]);
    expect(groups.live).toEqual([]);
    expect(groups.recent).toEqual([]);
    expect(groups.routines).toEqual([]);
    expect(groups.empty).toBe(false);
  });

  it("什么都没有时用虚线占位（只有置顶不算内容）", () => {
    const bare = { assistants: [asst("hob", { pinned: true })], jobs: {}, approvals: {}, routines: [], query: "" };
    expect(homeGroups(bare, NOW).empty).toBe(true);

    const withJob = { ...bare, jobs: index([job("t-1", "done", { endedAt: minsAgo(20) })]) };
    expect(homeGroups(withJob, NOW).empty).toBe(false);

    // 停掉的定时任务不列出来
    const paused = { ...bare, routines: [routine("r-1", false)] };
    expect(homeGroups(paused, NOW).routines).toEqual([]);
    expect(homeGroups(paused, NOW).empty).toBe(true);
  });
});

describe("置顶先后", () => {
  const at = (list: AssistantSummary[]) => pinList(list, "").map((a) => a.id);

  it("都没排过时按创建时间，先建的在前", () => {
    expect(at([
      asst("later", { pinned: true, createdAt: minsAgo(10) }),
      asst("earlier", { pinned: true, createdAt: minsAgo(90) }),
    ])).toEqual(["earlier", "later"]);
  });

  it("排过的按位置数字，和创建时间无关", () => {
    expect(at([
      asst("hob", { pinned: true, pinOrder: 1, createdAt: minsAgo(900) }),
      asst("wifi", { pinned: true, pinOrder: 0, createdAt: minsAgo(1) }),
    ])).toEqual(["wifi", "hob"]);
  });

  it("新置顶的还没有位置，排在排过的后面", () => {
    expect(at([
      asst("fresh", { pinned: true, createdAt: minsAgo(1) }),
      asst("first", { pinned: true, pinOrder: 0, createdAt: minsAgo(500) }),
      asst("second", { pinned: true, pinOrder: 1, createdAt: minsAgo(400) }),
    ])).toEqual(["first", "second", "fresh"]);
  });

  it("没置顶的、收起的都不进这一排，搜索时只留匹配的", () => {
    const list = [
      asst("hob", { pinned: true, pinOrder: 0 }),
      asst("off", { pinned: false }),
      asst("folded", { pinned: true, hidden: true }),
      asst("wifi", { pinned: true, pinOrder: 1, name: "网络管家", duty: "网络" }),
    ];
    expect(pinList(list, "").map((a) => a.id)).toEqual(["hob", "wifi"]);
    expect(pinList(list, "网络").map((a) => a.id)).toEqual(["wifi"]);
  });

  it("首页分组里的置顶也跟着位置走", () => {
    const groups = homeGroups({
      assistants: [
        asst("a", { pinned: true, pinOrder: 1, createdAt: minsAgo(600) }),
        asst("b", { pinned: true, pinOrder: 0, createdAt: minsAgo(30) }),
      ],
      jobs: {},
      approvals: {},
      routines: [],
      query: "",
    });
    expect(groups.pins.map((a) => a.id)).toEqual(["b", "a"]);
  });
});
