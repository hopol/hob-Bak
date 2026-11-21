import type { HobRuntime } from "./runtime.ts";
import { nowText } from "./time.ts";
import { sessionOrigin } from "./origin.ts";
import { readTodoBook, sessionTodosPath, todosBlockText, todosReminderText } from "./todos.ts";
import type { Job } from "../../shared/types.ts";

/** 还没结束的状态。 */
const ACTIVE = new Set(["running", "queued", "waiting"]);

/**
 * 每条 Router 消息附带的当前状态，不显示在对话里。
 * current 是现在这个会话（群或话题的 id），单聊不传：进行中、等用户选、最近结束只列这个会话自己的，
 * 这个助手在别的会话里的另起两行，写明出处。
 */
export function nowBlock(runtime: HobRuntime, assistantId: string, current?: string): string {
  const now = new Date();
  const timezone = runtime.settings.settings.general.timezone;
  const clock = (value: string) => new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
  const short = (value: string) => Array.from(value).length > 20 ? `${Array.from(value).slice(0, 20).join("")}…` : value;
  const jobs = runtime.store.jobs().filter((job) => job.assistantId === assistantId);
  const lines = [`【现在】${nowText(timezone, now)}`];
  // 手上的这份待办：每轮都带给模型，它自己清或换；收起的（旧的那几份）不带，历史不进上下文
  const book = readTodoBook(sessionTodosPath(runtime.home, assistantId, current));
  if (book.items.length) {
    lines.push(todosBlockText(book.items, book.updatedAt, timezone, now));
    // 好几轮没更新、还有没做完的：接一句事实，做什么由模型判断（提醒过以后要过几轮才再说）
    const reminder = todosReminderText(runtime.router.sessionEntries(assistantId, current), book.items, book.updatedAt);
    if (reminder) lines.push(reminder);
  }
  // 这个会话自己的：单聊就是没有 groupId 的
  const mine = (groupId: string | undefined) => groupId === current;
  // 别处的范围和管得了的范围一致（canManageJob）：群和话题的会话里是同一个群的综合和话题，单聊里是它所在的所有群和话题
  const elsewhere = (groupId: string | undefined) => {
    if (mine(groupId)) return false;
    if (current === undefined) return true;
    return runtime.store.groupMatches(current, groupId);
  };
  const originOf = (where: string | undefined) => sessionOrigin(runtime.store, where, current);
  const stateOf = (job: Job) => {
    if (job.status !== "running") return job.status === "queued" ? "排队中" : "等你回复";
    const minutes = job.startedAt ? Math.floor((now.getTime() - new Date(job.startedAt).getTime()) / 60_000) : 0;
    return minutes < 1 ? "刚开始" : `运行 ${minutes} 分钟`;
  };
  const activeLine = (job: Job) => `${job.id}「${short(job.title)}」，${stateOf(job)}`;
  const active = jobs.filter((job) => mine(job.groupId) && ACTIVE.has(job.status)).map(activeLine);
  if (active.length) lines.push(`进行中：${active.join("；")}`);
  const delegations = runtime.store.delegations().filter((item) => item.from === assistantId && (item.status === "running" || item.status === "waiting"))
    .map((item) => `${runtime.store.assistant(item.to)?.name ?? item.to}「${short(item.text)}」，${clock(item.createdAt)} 起`);
  if (delegations.length) lines.push(`转交中：${delegations.join("；")}`);
  const pending = runtime.store.approvals().filter((item) => item.assistantId === assistantId && item.status === "pending" && item.source !== "job");
  const approvals = pending.filter((item) => mine(item.groupId)).map((item) => item.title);
  if (approvals.length) lines.push(`等用户选：${approvals.join("；")}`);
  const names = { done: "已完成", stuck: "受阻", failed: "失败", stopped: "已停止" } as const;
  const recent = jobs.filter((job) => mine(job.groupId) && job.endedAt && !job.routineId && job.status in names && new Date(job.endedAt).getTime() >= now.getTime() - 86_400_000 && new Date(job.endedAt).getTime() <= now.getTime())
    .sort((a, b) => b.endedAt!.localeCompare(a.endedAt!)).slice(0, 5)
    .map((job) => `${job.id}「${short(job.title)}」${clock(job.endedAt!)} ${names[job.status as keyof typeof names]}`);
  if (recent.length) lines.push(`最近结束：${recent.join("；")}`);
  const elsewhereActive = jobs.filter((job) => elsewhere(job.groupId) && ACTIVE.has(job.status)).map((job) => `${originOf(job.groupId)}里 ${activeLine(job)}`);
  if (elsewhereActive.length) lines.push(`别处进行中：${elsewhereActive.join("；")}`);
  const elsewhereAsk = pending.filter((item) => elsewhere(item.groupId)).map((item) => `${originOf(item.groupId)}里「${item.title}」`);
  if (elsewhereAsk.length) lines.push(`别处等用户选：${elsewhereAsk.join("；")}`);
  return lines.join("\n");
}
