// 对话条目的纯合并逻辑：SSE 事件和 GET /items 都走这里，保证不刷新和刷新后完全一致。
import type { Item } from "../../shared/types.ts";

/** 一页对话最多留这么多条（和 api.ts 的 limit 一致）。 */
export const ITEM_LIMIT = 60;

function byAt(a: Item, b: Item): number {
  if (a.at === b.at) return 0;
  return a.at < b.at ? -1 : 1;
}

/**
 * 按 id 去重（新的覆盖旧的）、按时间排序、只留最新 limit 条。
 *
 * 排序是因为服务端的条目时间就是会话文件里的落盘顺序，而事件到达前端的先后不保证一致：
 * 助手消息要等这条消息结束才落盘，可能晚于用户紧接着发的下一条消息。
 */
export function mergeItems(current: Item[], incoming: Item | Item[], limit = ITEM_LIMIT): Item[] {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  if (!list.length) return current;
  const merged = current.slice();
  const index = new Map<string, number>();
  merged.forEach((item, i) => index.set(item.id, i));
  for (const item of list) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, merged.length);
      merged.push(item);
    } else {
      merged[at] = item;
    }
  }
  merged.sort(byAt);
  return merged.length > limit ? merged.slice(-limit) : merged;
}

/** 流式追加：条目不存在（或不是助手消息）就原样返回。 */
export function applyDelta(items: Item[], itemId: string, text: string): Item[] {
  const i = items.findIndex((item) => item.id === itemId);
  if (i < 0) return items;
  const item = items[i];
  if (item.kind !== "assistant") return items;
  const next = items.slice();
  next[i] = { ...item, text: item.text + text };
  return next;
}

/** 最后一条是不是还在流式的助手消息（决定底部要不要显示“正在想”）。 */
export function isStreamingTail(items: Item[]): boolean {
  const last = items[items.length - 1];
  return last?.kind === "assistant" && Boolean(last.streaming);
}
