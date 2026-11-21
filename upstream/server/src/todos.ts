// 待办：一份清单，每项只有「做什么」和「做到哪儿」。
// 单聊存在助手目录下，群的综合和每个话题各存在自己的群目录下（同一个话题里的成员共用一份）。待办只归助手，任务没有。
// 一份待办有头有尾：全做完了、被清掉了、话题关了、一轮结束时手上没活了、转交出去，就清空当前这份；收起的那些不进对话，也不进时间线。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Iso, TodoItem } from "../../shared/types.ts";
import { assistantTodosPath, groupTodosPath } from "./config.ts";
import type { HobRuntime } from "./runtime.ts";
import { agoText } from "./time.ts";

export type TodoStatus = TodoItem["status"];

const STATUSES: TodoStatus[] = ["todo", "doing", "done"];

/** 还没结束的任务状态。 */
const ACTIVE = new Set(["running", "queued", "waiting"]);

/**
 * 几轮没更新提醒一句。
 * ponytail: 8 是经验值（Claude Code 是 10 轮、Cline 是 6 次请求），要按评测调。
 */
export const TODO_REMINDER_ROUNDS = 8;

/** 提醒那句的开头：会话记录里带它，说明那个会话里已经提醒过一次。 */
const TODO_REMINDER_LEAD = "这份待办已经";

/** 一份待办的读法：文件不在就是空的，坏了的原样报错，不当成空清单。 */
export function readTodos(path: string): TodoItem[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return Array.isArray(parsed) ? parsed.flatMap((entry) => (isTodo(entry) ? [{ text: String(entry.text), status: entry.status }] : [])) : [];
}

export function writeTodos(path: string, items: TodoItem[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`);
  renameSync(tmp, path);
}

/** 当前这一份和它最后一次更新的时间（只有 update_todos 写这个文件，所以就是文件时间）。 */
export function readTodoBook(path: string): { items: TodoItem[]; updatedAt?: Iso } {
  const items = readTodos(path);
  try {
    return { items, updatedAt: statSync(path).mtime.toISOString() };
  } catch {
    return { items };
  }
}

/** 收起当前这一份：清空文件。收进时间线由调用方做（先记进时间线，再清，记不下就留着下次）。 */
export function clearTodos(path: string): void {
  writeTodos(path, []);
}

/**
 * 模型交上来的整份清单：不对就退回，说清第几项哪里不对。
 * 空列表是清掉，合法。
 */
export function parseTodos(given: unknown): TodoItem[] {
  if (given === undefined) return [];
  if (!Array.isArray(given)) throw new Error("items 要是一份列表：没有待办就传空列表。");
  return given.map((entry, index) => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const text = String(raw.text ?? "").trim();
    if (!text) throw new Error(`第 ${index + 1} 项的 text 是空的：写这一项做什么。`);
    const status = String(raw.status ?? "");
    if (!STATUSES.includes(status as TodoStatus)) {
      throw new Error(`第 ${index + 1} 项的 status 只能是 todo、doing、done，收到「${status}」。`);
    }
    return { text, status: status as TodoStatus };
  });
}

/** 做完了几项、一共几项。 */
export function todoProgress(items: TodoItem[]): { done: number; total: number } {
  return { done: items.filter((item) => item.status === "done").length, total: items.length };
}

/** 还没做完的几项。 */
export function todoUnfinishedCount(items: TodoItem[]): number {
  return items.filter((item) => item.status !== "done").length;
}

/** 工具返回给模型的那一句。 */
export function todosText(items: TodoItem[]): string {
  if (!items.length) return "待办清掉了。";
  const { done, total } = todoProgress(items);
  return `待办 ${done}/${total}。`;
}

/**
 * 这一轮带给模型的那一段：手上这份待办、多久以前更新、每一项做到哪儿。
 * 收起的和以前的都不带，所以聊多久上下文里也只有当前这一份。
 */
export function todosBlockText(items: TodoItem[], updatedAt: string | undefined, timezone: string, now: Date = new Date()): string {
  const { done, total: count } = todoProgress(items);
  const ago = agoText(timezone, new Date(updatedAt ?? ""), now);
  const lines = [`手上的待办 ${done}/${count}，${ago}更新：`];
  for (const item of items) lines.push(`${item.status === "done" ? "✓" : item.status === "doing" ? "→" : "·"} ${item.text}`);
  return lines.join("\n");
}

/** 会话记录里，发给模型的一轮（pi 的 user 消息）：用户说的和系统送来的都在里面。 */
function userTurns(entries: SessionEntry[]): { at: string; text: string }[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (message?.role !== "user") return [];
    const content = message.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string } | undefined)?.text ?? "").join("") : "";
    return [{ at: entry.timestamp, text }];
  });
}

/**
 * 好几轮没更新、还有没做完的项，在「手上的待办」后面接一句提醒。
 * 轮数从这个会话的记录里数：上次更新以后的用户消息（含系统送来的）有几条，就是助手已经回了几轮。
 * 提醒过一次，再过 TODO_REMINDER_ROUNDS 轮还没更新才再提醒；记录数不出来（读不到）就不提醒。
 */
export function todosReminderText(entries: SessionEntry[], items: TodoItem[], updatedAt: string | undefined): string | undefined {
  if (!updatedAt || !todoUnfinishedCount(items)) return undefined;
  const turns = userTurns(entries);
  const since = (at: string) => turns.filter((turn) => new Date(turn.at).getTime() > new Date(at).getTime()).length;
  const rounds = since(updatedAt);
  if (rounds < TODO_REMINDER_ROUNDS) return undefined;
  const last = turns.findLast((turn) => turn.text.includes(TODO_REMINDER_LEAD));
  if (last && since(last.at) < TODO_REMINDER_ROUNDS) return undefined;
  return `${TODO_REMINDER_LEAD} ${rounds} 轮没更新了：做完的标成 done；这件事不做了或者换了一件，传空列表清掉，或者换成新的一份。`;
}

/**
 * 转交给别的助手时，把手上的待办交出去：还有没做完的项就清空当前这份（不进时间线）。
 * 全做完了的已经清过，没有待办就什么都不做。返回交出去的那几项，写进转交给对方的内容里。
 */
export async function handOffTodos(runtime: HobRuntime, assistantId: string, groupId: string | undefined): Promise<TodoItem[]> {
  const path = sessionTodosPath(runtime.home, assistantId, groupId);
  const items = readTodos(path);
  const unfinished = items.filter((item) => item.status !== "done");
  if (!unfinished.length) return [];
  clearTodos(path);
  publishTodos(runtime, assistantId, groupId);
  return unfinished;
}

function isTodo(value: unknown): value is TodoItem {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.text === "string" && STATUSES.includes(entry.status as TodoStatus);
}

/** 一个会话的待办在哪：群会话（综合、话题）在群目录下，单聊在助手目录下。 */
export function sessionTodosPath(home: string, assistantId: string, groupId?: string): string {
  return groupId ? groupTodosPath(home, groupId) : assistantTodosPath(home, assistantId);
}

/** 待办变了：告诉界面（左栏、输入框上方那一条看它）。 */
function publishTodos(runtime: HobRuntime, assistantId: string, groupId?: string): void {
  if (groupId) {
    runtime.groups.publish(groupId);
    return;
  }
  const assistant = runtime.store.assistant(assistantId);
  if (assistant) runtime.bus.emit({ type: "assistant", assistant: runtime.router.summary(assistant) });
}

/** 这个会话里还有没有在跑的任务。 */
function busyHere(runtime: HobRuntime, assistantId: string, groupId?: string): boolean {
  return runtime.store.jobs().some((job) => job.groupId === groupId && ACTIVE.has(job.status) && (groupId !== undefined || job.assistantId === assistantId));
}

/**
 * 这个会话手上还有没有活。有活就留着这份待办；没有就收掉。
 * 算有活的是这几样：
 * - 在跑、排队或等待中的任务（这个会话里的）；
 * - 从这个会话发出、还没结束的转交；
 * - 从这个会话交给群、话题还没关的（message_group 开出来的话题，等群给结论）；
 * - 这个会话里还在等用户回答的提问卡；
 * - 群会话里，还有别的成员在这个会话里跑着一轮。
 */
export function todosBusy(runtime: HobRuntime, assistantId: string, groupId?: string): boolean {
  if (busyHere(runtime, assistantId, groupId)) return true;
  // 转交和交给群只从单聊发出（群会话里没有 message_assistant、message_group），群会话不算这两样
  const delegating = groupId === undefined && runtime.store
    .delegations()
    .some((record) => record.from === assistantId && !record.reportedAt && (record.status === "running" || record.status === "waiting"));
  if (delegating) return true;
  const handedOver = groupId === undefined && runtime.store.groups().some((group) => group.parentId !== undefined && !group.closedAt && group.handover?.by === assistantId);
  if (handedOver) return true;
  const asking = runtime.store.approvals().some((approval) => approval.status === "pending" && (groupId ? approval.groupId === groupId : approval.assistantId === assistantId && !approval.groupId));
  if (asking) return true;
  return groupId !== undefined && runtime.router.busyMembers(groupId).some((id) => id !== assistantId);
}

/**
 * 一轮结束、或者服务启动时：这个会话手上没活了，就把这份待办收起（不进时间线）。
 * 一轮出错结束的那一轮调用方不清，留到下一轮。
 */
export function releaseIdleTodos(runtime: HobRuntime, assistantId: string, groupId?: string): void {
  const path = sessionTodosPath(runtime.home, assistantId, groupId);
  if (!readTodos(path).length) return;
  if (todosBusy(runtime, assistantId, groupId)) return;
  clearTodos(path);
  publishTodos(runtime, assistantId, groupId);
}

/** 启动时把各会话手上已经没活的待办收起：任务和转交都按中断处理过了，再没有手上的活。 */
export function releaseIdleTodosAtStartup(runtime: HobRuntime): void {
  for (const assistant of runtime.store.assistants()) releaseIdleTodos(runtime, assistant.id);
  for (const group of runtime.store.groups()) releaseIdleTodos(runtime, group.ownerId, group.id);
}

/** 待办工具的落点：会话（单聊、综合、话题）。待办只归助手，任务没有。 */
export interface TodosTarget {
  assistantId: string;
  groupId?: string;
}

/**
 * 待办工具：每次传完整的一份，替换原来的。所有会话都有它，任务没有。
 * ponytail: 两个成员同时写同一份，后写的整个覆盖前一份，不做合并；一份清单里谁最后调谁说了算。
 */
export function updateTodosTool(runtime: HobRuntime, target: TodosTarget): ToolDefinition<any, any> {
  /** 会话里的一份做完或清掉时就清空（不进时间线）。 */
  const saveSession = async (items: TodoItem[]): Promise<string> => {
    const path = sessionTodosPath(runtime.home, target.assistantId, target.groupId);
    const before = readTodos(path);
    const allDone = items.length > 0 && todoProgress(items).done === items.length;
    const cleared = items.length === 0 && todoUnfinishedCount(before) > 0;
    if (!allDone && !cleared) {
      writeTodos(path, items);
      publishTodos(runtime, target.assistantId, target.groupId);
      return todosText(items);
    }
    clearTodos(path);
    publishTodos(runtime, target.assistantId, target.groupId);
    if (allDone) {
      const { total } = todoProgress(items);
      return `待办 ${total}/${total}，都做完了，已经清掉。`;
    }
    return "待办清掉了。";
  };
  return {
    name: "update_todos",
    label: "更新待办",
    description: "列出或更新手上这件事的待办，用户在界面上看得到每一项做到哪儿。每次传完整的一份，替换原来的；传空列表就是清掉。清单只在你手上还有活时留着：这一轮结束时，如果没有在跑的任务、没有等结果的转交或交给群的话题，也没有等用户回答的提问，它会自动收起；下一件事重新列。",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          text: Type.String({ description: "这一项做什么，一句话。" }),
          status: Type.Unsafe<TodoItem["status"]>(Type.String({ description: "todo 还没做，doing 在做，done 做完了。" })),
        }),
        { description: "待办，按做的先后排。" },
      ),
    }),
    execute: async (_id, params: any) => {
      try {
        const items = parseTodos(params.items);
        const text = await saveSession(items);
        return { content: [{ type: "text" as const, text }], details: undefined };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  };
}
