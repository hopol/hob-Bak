// 首页各组的数据筛选：手机首页（Mobile）和桌面左栏（Sidebar）共用一份规则，渲染在
// components/HomeSections.tsx。这里只算数据，不碰界面，好单测。
import { t } from "../../shared/i18n.ts";
import type { Approval, AssistantSummary, Delegation, GroupSummary, Job, Routine } from "../../shared/types.ts";
import type { GroupPrefs } from "./store.ts";
import { topicsOf } from "./topics.ts";
import { assistantStatus } from "./sidebar-data.ts";
import { parseCron } from "./util.ts";

/** 最近任务最多列几条，其余去任务记录看。 */
export const RECENT = 5;
/** 和 bootstrap 给的任务范围一致（最近 24 小时结束的）：更早的任务不混进来。 */
export const RECENT_MS = 24 * 3600 * 1000;

/**
 * 「对话」里的一行：助手或群。两种东西混在一起按最近消息排，
 * 位置（order）和置顶用同一套规则，群的位置记在本地（见 store 的 GroupPrefs）。
 */
export type HomeFilter = "all" | "assistants" | "jobs" | "routines";
export type HomeOrder = "recent" | "custom";

/** 首页的一行：助手或群。 */
export type ConversationEntry =
  | { kind: "assistant"; id: string; a: AssistantSummary; pinned: boolean; hidden: boolean; order?: number; listOrder?: number; at?: string; since: string }
  | { kind: "group"; id: string; g: GroupRowData; pinned: boolean; hidden: false; order?: number; listOrder?: number; at?: string; since: string };

/** 首页那行群：综合和各话题合起来——最近一条出自哪个话题、有没有话题在等你回答。 */
export type GroupRowData = GroupSummary & { lastTopic?: string; waiting?: boolean };

/**
 * 助手和群归一成一种行：置顶、位置、最近消息都取出来。
 * 话题不进首页（进群看），但群的未读和忙要把各话题的算进来：首页那行代表整个群。
 */
export function conversations(
  assistants: AssistantSummary[],
  groups: GroupSummary[],
  prefs: Record<string, GroupPrefs>,
  approvals: Record<string, Approval> = {},
): ConversationEntry[] {
  const rows: ConversationEntry[] = assistants.map((a) => ({
    kind: "assistant",
    id: a.id,
    a,
    pinned: a.pinned,
    hidden: a.hidden,
    since: a.createdAt,
    ...(a.pinOrder !== undefined ? { order: a.pinOrder } : {}),
    ...(a.listOrder !== undefined ? { listOrder: a.listOrder } : {}),
    ...(a.last?.at ? { at: a.last.at } : {}),
  }));
  for (const g of groups) {
    if (g.parentId) continue;
    const topics = topicsOf(groups, g.id);
    const pref = prefs[g.id];
    // 最近一条：综合和各话题里最新的那条，出自话题就记下话题名
    const latest = [g, ...topics].filter((x) => x.last).sort((x, y) => y.last!.at.localeCompare(x.last!.at))[0];
    rows.push({
      kind: "group",
      id: g.id,
      g: {
        ...g,
        ...(latest?.last ? { last: latest.last } : {}),
        ...(latest && latest.id !== g.id ? { lastTopic: latest.name } : {}),
        unread: g.unread + topics.reduce((sum, t) => sum + t.unread, 0),
        busy: [...new Set([...g.busy, ...topics.flatMap((t) => t.busy)])],
        waiting: Object.values(approvals).some((a) => a.status === "pending" && a.source !== "job" && (a.groupId === g.id || topics.some((t) => t.id === a.groupId))),
      },
      pinned: Boolean(pref?.pinned),
      hidden: false,
      since: g.createdAt,
      ...(pref?.pinOrder !== undefined ? { order: pref.pinOrder } : {}),
      ...(g.listOrder !== undefined ? { listOrder: g.listOrder } : {}),
      ...(latest?.last?.at ? { at: latest.last.at } : {}),
    });
  }
  return rows;
}

/** 助手能不能被搜索词命中：名字、职责、最后一句。 */
export function matchesAssistant(a: AssistantSummary, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  return a.name.includes(q) || a.duty.includes(q) || (a.last?.text ?? "").includes(q);
}

/** 一行能不能被搜索词命中：助手看名字、职责和最后一句；群看名字、负责什么和最后一句。 */
export function matches(row: ConversationEntry, query: string): boolean {
  if (row.kind === "assistant") return matchesAssistant(row.a, query);
  const q = query.trim();
  if (!q) return true;
  return row.g.name.includes(q) || row.g.purpose.includes(q) || (row.g.last?.text ?? "").includes(q);
}

/** 最近消息新的在前。 */
export function byLast<T extends { at?: string }>(a: T, b: T): number {
  return (b.at ?? "").localeCompare(a.at ?? "");
}

/**
 * 置顶头像的先后：排过的按位置数字从小到大，没排过的排在后面；都没排过就看创建时间（老的在前）。
 * 拖动换位置时把新先后写成 0、1、2…，群和助手共用这条数轴。
 */
export function byPinOrder<T extends { order?: number; since?: string; id: string }>(a: T, b: T): number {
  const at = (x: T) => x.order ?? Number.MAX_SAFE_INTEGER;
  return at(a) - at(b) || (a.since ?? "").localeCompare(b.since ?? "") || a.id.localeCompare(b.id);
}

/** 顶部那排置顶头像：去掉收起的、按搜索词过一遍，再按排好的先后。左栏和手机首页共用这一份。 */
export function pinList(rows: ConversationEntry[], query: string): ConversationEntry[] {
  return rows.filter((row) => row.pinned && !row.hidden && matches(row, query)).sort(byPinOrder);
}

/** 还在跑的（含排队、等确认）。 */
export const isLive = (j: Job) => j.status === "running" || j.status === "queued" || j.status === "waiting";

export function byStarted(a: Job, b: Job): number {
  return (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt);
}

export function byEnded(a: Job, b: Job): number {
  return (b.endedAt ?? b.createdAt).localeCompare(a.endedAt ?? a.createdAt);
}

/** 固定顺序：排过的按用户保存的位置，没排过的按最近活跃。 */
export function byListOrder<T extends { listOrder?: number; at?: string; since?: string; createdAt?: string; id: string }>(a: T, b: T): number {
  const order = (x: T) => x.listOrder ?? Number.MAX_SAFE_INTEGER;
  return order(a) - order(b) || byLast(a, b) || (a.since ?? a.createdAt ?? "").localeCompare(b.since ?? b.createdAt ?? "") || a.id.localeCompare(b.id);
}

/** 定时任务按第一个时间的钟点排。ponytail: 不算真正的下次运行时间，每周/每月的混在每天的中间；要精确再按 cron 推。 */
export function minuteOfDay(r: Routine): number {
  const s = parseCron(r.schedules[0] ?? "");
  return s.kind === "raw" ? 24 * 60 : s.hour * 60 + s.minute;
}

function lastEndedMark(a: AssistantSummary, jobs: Job[], delegations: Delegation[]): "done" | "stuck" | undefined {
  const ended: { at: string; mark: "done" | "stuck" }[] = [];
  for (const job of jobs) {
    if (job.assistantId !== a.id || !job.endedAt) continue;
    const mark = job.status === "done" ? "done" : job.status === "stuck" || job.status === "failed" ? "stuck" : undefined;
    if (mark) ended.push({ at: job.endedAt, mark });
  }
  for (const delegation of delegations) {
    if (delegation.from !== a.id || !delegation.endedAt) continue;
    const mark = delegation.status === "done" ? "done" : delegation.status === "stuck" || delegation.status === "returned" || delegation.status === "interrupted" ? "stuck" : undefined;
    if (mark) ended.push({ at: delegation.endedAt, mark });
  }
  const last = ended.filter((item) => !a.readAt || item.at > a.readAt).sort((a, b) => b.at.localeCompare(a.at))[0];
  return last?.mark;
}

/** 首页第一节：useMark 会挂到头像上的 ask / stuck / done。 */
function needsAttention(a: AssistantSummary, jobs: Job[], approvals: Approval[], delegations: Delegation[]): boolean {
  const status = assistantStatus(a, jobs, approvals, delegations);
  if (status === "等你确认") return true;
  const ended = lastEndedMark(a, jobs, delegations);
  if (a.unread > 0 && ended === "stuck") return true;
  if (status !== "空闲") return false;
  return a.unread > 0 && ended === "done";
}
/** 分组要看的那几份数据（State 里都有）。 */
export interface HomeSource {
  assistants: AssistantSummary[];
  groups: GroupSummary[];
  groupPrefs?: Record<string, GroupPrefs>;
  jobs: Record<string, Job>;
  approvals: Record<string, Approval>;
  routines: Routine[];
  query: string;
  homeFilter?: HomeFilter;
  homeOrder?: HomeOrder;
  delegations?: Record<string, import("../../shared/types.ts").Delegation>;
}

export interface HomeGroups {
  searching: boolean;
  pins: ConversationEntry[];
  /** 等你处理节按最近活跃提上来的助手和群。 */
  attention: ConversationEntry[];
  /** 第 2 节剩下的助手和群。 */
  rows: ConversationEntry[];
  hidden: AssistantSummary[];
  asks: Approval[];
  live: Job[];
  recent: Job[];
  routines: Routine[];
  /** 任务一节：进行中的在前，最近结束的接在后。 */
  tasks: Job[];
  /** 一组内容都没有：用虚线框占位。 */
  empty: boolean;
}

/**
 * 首页：置顶下面依次是等你处理、助手（助手和群）、任务、定时任务。
 * 搜索时只列匹配的助手和群，其它组全隐藏。
 */
export function homeGroups(s: HomeSource, now = Date.now()): HomeGroups {
  const searching = s.query.trim().length > 0;
  const filter: HomeFilter = searching ? "all" : s.homeFilter ?? "all";
  const order: HomeOrder = s.homeOrder ?? "recent";
  const since = new Date(now - RECENT_MS).toISOString();
  const jobs = Object.values(s.jobs);
  const all = conversations(s.assistants ?? [], s.groups ?? [], s.groupPrefs ?? {}, s.approvals ?? {});
  const pins = pinList(all, s.query);
  const statusOf = (row: ConversationEntry): "attention" | "assistant" => {
    if (row.kind === "group") {
      if (row.g.waiting || (!row.g.busy.length && row.g.unread > 0)) return "attention";
      return "assistant";
    }
    return needsAttention(row.a, Object.values(s.jobs), Object.values(s.approvals), Object.values(s.delegations ?? {})) ? "attention" : "assistant";
  };
  const activeRows = all.filter((row) => !row.pinned && matches(row, s.query));
  const attention = searching ? [] : activeRows.filter((row) => statusOf(row) === "attention").sort(byLast);
  const remaining = activeRows.filter((row) => searching || statusOf(row) === "assistant");
  // 最近活跃：正在运行的算「现在」排最前，其余按最近一条消息；置顶时留下的位置数字不再参与（那是置顶区的先后）
  const running = (row: ConversationEntry) =>
    row.kind === "group" ? row.g.busy.length > 0 : ["执行中", "排队中"].includes(assistantStatus(row.a, jobs, Object.values(s.approvals), Object.values(s.delegations ?? {})));
  const byRecent = (a: ConversationEntry, b: ConversationEntry) =>
    Number(running(b)) - Number(running(a)) || byLast(a, b) || (a.since ?? "").localeCompare(b.since ?? "") || a.id.localeCompare(b.id);
  const sortRows = (items: ConversationEntry[]) => [...items].sort(order === "custom" && !searching ? byListOrder : byRecent);
  const rows = sortRows(remaining.filter((row) => !row.hidden));
  const hidden = remaining.filter((row): row is Extract<ConversationEntry, { kind: "assistant" }> => row.kind === "assistant" && row.hidden).map((row) => row.a);
  const asks: Approval[] = searching
    ? []
    : Object.values(s.approvals)
        .filter((a) => a.status === "pending" && a.source !== "job")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const live = searching ? [] : jobs.filter(isLive).sort(byStarted);
  const recent = searching
    ? []
    : jobs
        .filter((j) => !isLive(j) && (j.endedAt ?? j.createdAt) > since)
        .sort(byEnded)
        .slice(0, RECENT);
  const routines = searching ? [] : s.routines.filter((r) => r.active).sort((a, b) => minuteOfDay(a) - minuteOfDay(b));
  const filterRows = (rowsToShow: ConversationEntry[]) => {
    if (searching) return rowsToShow;
    if (filter === "assistants") return rowsToShow;
    return filter === "all" ? rowsToShow : [];
  };
  const filteredAttention = filter === "all" || filter === "assistants" ? attention : [];
  const filteredRows = filterRows(rows);
  const filteredHidden = filter === "all" || filter === "assistants" ? hidden : [];
  const filteredLive = filter === "routines" || filter === "assistants" ? [] : live;
  const filteredRecent = filter === "routines" || filter === "assistants" ? [] : recent;
  const tasks = filter === "routines" || filter === "assistants" ? [] : [...filteredLive, ...filteredRecent];
  const filteredRoutines = filter === "jobs" || filter === "assistants" ? [] : routines;
  const categoryHasContent = searching
    ? Boolean(filteredRows.length || filteredHidden.length)
    : filter === "assistants"
      ? Boolean(filteredAttention.length || filteredRows.length || filteredHidden.length)
      : filter === "jobs"
        ? tasks.length > 0
        : filter === "routines"
          ? filteredRoutines.length > 0
          : Boolean(filteredAttention.length || filteredRows.length || filteredHidden.length || tasks.length || filteredRoutines.length);
  const empty = !categoryHasContent;
  return { searching, pins, attention: filteredAttention, rows: filteredRows, hidden: filteredHidden, asks, live: filteredLive, recent: filteredRecent, tasks, routines: filteredRoutines, empty };
}
