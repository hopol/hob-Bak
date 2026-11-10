// 首页各组的数据筛选：手机首页（Mobile）和桌面左栏（Sidebar）共用一份规则，渲染在
// components/HomeSections.tsx。这里只算数据，不碰界面，好单测。
import type { Approval, AssistantSummary, Job, Routine } from "../../shared/types.ts";
import { parseCron } from "./util.ts";

/** 最近任务最多列几条，其余去任务记录看。 */
export const RECENT = 5;
/** 和 bootstrap 给的任务范围一致（最近 24 小时结束的）：更早的任务不混进来。 */
export const RECENT_MS = 24 * 3600 * 1000;

/** 助手匹配搜索词：名字、职责、最后一句。 */
export function matches(a: AssistantSummary, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  return a.name.includes(q) || a.duty.includes(q) || (a.last?.text ?? "").includes(q);
}

export function byLast(a: AssistantSummary, b: AssistantSummary): number {
  return (b.last?.at ?? "").localeCompare(a.last?.at ?? "");
}

/**
 * 置顶头像的先后：排过的按位置数字从小到大，没排过的排在后面，都还没排过就看创建时间（老的在前）。
 * 拖动头像换位置时把新先后写成 0、1、2…，所以后来才置顶的助手总在最后，拖过一次就跟着走。
 */
export function byPinOrder(a: AssistantSummary, b: AssistantSummary): number {
  const at = (x: AssistantSummary) => x.pinOrder ?? Number.MAX_SAFE_INTEGER;
  return at(a) - at(b) || a.createdAt.localeCompare(b.createdAt);
}

/** 日常的先后：拖过的按拖好的位置，没拖过的排在后面、按最近消息。 */
export function byRowOrder(a: AssistantSummary, b: AssistantSummary): number {
  const at = (x: AssistantSummary) => x.pinOrder ?? Number.MAX_SAFE_INTEGER;
  return at(a) - at(b) || byLast(a, b);
}

/** 顶部那排置顶头像：去掉收起的、按搜索词过一遍，再按排好的先后。左栏和手机首页共用这一份。 */
export function pinList(assistants: AssistantSummary[], query: string): AssistantSummary[] {
  return assistants.filter((a) => a.pinned && !a.hidden && matches(a, query)).sort(byPinOrder);
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
  jobs: Record<string, Job>;
  approvals: Record<string, Approval>;
  routines: Routine[];
  query: string;
}

export interface HomeGroups {
  searching: boolean;
  pins: AssistantSummary[];
  rows: AssistantSummary[];
  hidden: AssistantSummary[];
  asks: Approval[];
  live: Job[];
  recent: Job[];
  routines: Routine[];
  /** 一组内容都没有：用虚线框占位。 */
  empty: boolean;
}

/**
 * 首页：置顶下面依次是待确认、进行中、日常助手、收起的助手、最近任务、定时任务。
 * 搜索时只列匹配的助手，其它组全隐藏。
 */
export function homeGroups(s: HomeSource, now = Date.now()): HomeGroups {
  const searching = s.query.trim().length > 0;
  const since = new Date(now - RECENT_MS).toISOString();
  const jobs = Object.values(s.jobs);
  const pins = pinList(s.assistants, s.query);
  const rows = s.assistants.filter((a) => !a.pinned && !a.hidden && matches(a, s.query)).sort(byRowOrder);
  const hidden = s.assistants.filter((a) => a.hidden && matches(a, s.query)).sort(byLast);
  const asks: Approval[] = searching
    ? []
    : Object.values(s.approvals)
        .filter((a) => a.status === "pending")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const live = searching ? [] : jobs.filter(isLive).sort(byStarted);
  const recent = searching
    ? []
    : jobs
        .filter((j) => !isLive(j) && (j.endedAt ?? j.createdAt) > since)
        .sort(byEnded)
        .slice(0, RECENT);
  const routines = searching ? [] : s.routines.filter((r) => r.active).sort((a, b) => minuteOfDay(a) - minuteOfDay(b));
  const empty = !searching && !asks.length && !live.length && !rows.length && !hidden.length && !recent.length && !routines.length;
  return { searching, pins, rows, hidden, asks, live, recent, routines, empty };
}
