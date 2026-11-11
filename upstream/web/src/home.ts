// 首页各组的数据筛选：手机首页（Mobile）和桌面左栏（Sidebar）共用一份规则，渲染在
// components/HomeSections.tsx。这里只算数据，不碰界面，好单测。
import type { Approval, AssistantSummary, GroupSummary, Job, Project, Routine, Subtask } from "../../shared/types.ts";
import { projectEnded, subtaskStatus } from "../../shared/project.ts";
import type { GroupPrefs } from "./store.ts";
import { topicsOf } from "./topics.ts";
import { parseCron } from "./util.ts";

/** 最近任务最多列几条，其余去任务记录看。 */
export const RECENT = 5;
/** 和 bootstrap 给的任务范围一致（最近 24 小时结束的）：更早的任务不混进来。 */
export const RECENT_MS = 24 * 3600 * 1000;

/**
 * 「对话」里的一行：助手或群。两种东西混在一起按最近消息排，
 * 位置（order）和置顶用同一套规则，群的位置记在本地（见 store 的 GroupPrefs）。
 */
export type ConversationEntry =
  | { kind: "assistant"; id: string; a: AssistantSummary; pinned: boolean; hidden: boolean; order?: number; at?: string; since: string }
  | { kind: "group"; id: string; g: GroupRowData; pinned: boolean; hidden: false; order?: number; at?: string; since: string };

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
): ConversationEntry[] {
  const rows: ConversationEntry[] = assistants.map((a) => ({
    kind: "assistant",
    id: a.id,
    a,
    pinned: a.pinned,
    hidden: a.hidden,
    since: a.createdAt,
    ...(a.pinOrder !== undefined ? { order: a.pinOrder } : {}),
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
        waiting: topics.some((t) => !t.closedAt && t.project?.waitingUser),
      },
      pinned: Boolean(pref?.pinned),
      hidden: false,
      since: g.createdAt,
      ...(pref?.pinOrder !== undefined ? { order: pref.pinOrder } : {}),
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

/** 对话那一列的先后：拖过的按位置排在前，没拖过的按最近消息，一条消息都没有的按创建时间。 */
export function byRowOrder<T extends { order?: number; at?: string; since?: string; id: string }>(a: T, b: T): number {
  const at = (x: T) => x.order ?? Number.MAX_SAFE_INTEGER;
  return at(a) - at(b) || byLast(a, b) || (a.since ?? "").localeCompare(b.since ?? "") || a.id.localeCompare(b.id);
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

/** 定时任务按第一个时间的钟点排。ponytail: 不算真正的下次运行时间，每周/每月的混在每天的中间；要精确再按 cron 推。 */
export function minuteOfDay(r: Routine): number {
  const s = parseCron(r.schedules[0] ?? "");
  return s.kind === "raw" ? 24 * 60 : s.hour * 60 + s.minute;
}

/** 分组要看的那几份数据（State 里都有）。 */
export interface HomeSource {
  assistants: AssistantSummary[];
  groups: GroupSummary[];
  groupPrefs: Record<string, GroupPrefs>;
  jobs: Record<string, Job>;
  approvals: Record<string, Approval>;
  projects: Record<string, Project[]>;
  routines: Routine[];
  query: string;
}

/** 等用户动手的一条：「待你执行」的子任务。 */
export interface MineRow {
  project: Project;
  subtask: Subtask;
}

export interface HomeGroups {
  searching: boolean;
  pins: ConversationEntry[];
  rows: ConversationEntry[];
  hidden: AssistantSummary[];
  asks: Approval[];
  /** 用户的子任务轮到了：点了去事项页 */
  mine: MineRow[];
  live: Job[];
  recent: Job[];
  routines: Routine[];
  /** 一组内容都没有：用虚线框占位。 */
  empty: boolean;
}

/**
 * 首页：置顶下面依次是待确认、进行中、对话（助手和群混在一起）、收起的助手、最近任务、定时任务。
 * 搜索时只列匹配的助手和群，其它组全隐藏。
 */
export function homeGroups(s: HomeSource, now = Date.now()): HomeGroups {
  const searching = s.query.trim().length > 0;
  const since = new Date(now - RECENT_MS).toISOString();
  const jobs = Object.values(s.jobs);
  const all = conversations(s.assistants ?? [], s.groups ?? [], s.groupPrefs ?? {});
  const pins = pinList(all, s.query);
  const rows = all.filter((row) => !row.pinned && !row.hidden && matches(row, s.query)).sort(byRowOrder);
  const hidden = (s.assistants ?? []).filter((a) => a.hidden && matchesAssistant(a, s.query)).sort((x, y) => (y.last?.at ?? "").localeCompare(x.last?.at ?? ""));
  const asks: Approval[] = searching
    ? []
    : Object.values(s.approvals)
        .filter((a) => a.status === "pending")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const mine: MineRow[] = searching
    ? []
    : Object.values(s.projects ?? {})
        .flatMap((list) => list)
        .filter((project) => !projectEnded(project) && project.startedAt)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .flatMap((project) =>
          project.subtasks
            .filter((subtask) => subtask.assignee === "user" && subtaskStatus(project, subtask, undefined, (other) => (other.jobId ? s.jobs[other.jobId] : undefined)) === "待你执行")
            .map((subtask) => ({ project, subtask })),
        );
  const live = searching ? [] : jobs.filter(isLive).sort(byStarted);
  const recent = searching
    ? []
    : jobs
        .filter((j) => !isLive(j) && (j.endedAt ?? j.createdAt) > since)
        .sort(byEnded)
        .slice(0, RECENT);
  const routines = searching ? [] : s.routines.filter((r) => r.active).sort((a, b) => minuteOfDay(a) - minuteOfDay(b));
  const empty = !searching && !asks.length && !mine.length && !live.length && !rows.length && !hidden.length && !recent.length && !routines.length;
  return { searching, pins, rows, hidden, asks, mine, live, recent, routines, empty };
}
