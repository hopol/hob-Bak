import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { ConversationRef, GroupItem, HistoryMatch, HistorySearchResult } from "../../shared/types.ts";
import { saysNoReply, stripNoReply } from "../../shared/no-reply.ts";
import { textOfContent } from "./transcript.ts";
import type { Store } from "./store.ts";

const key = (ref: ConversationRef, id: string) => JSON.stringify([ref.kind, ref.id, id]);

export function historySnippet(text: string, words: string[], context: number): string {
  const lower = text.toLocaleLowerCase();
  const position = words.length ? Math.min(...words.map((word) => lower.indexOf(word)).filter((at) => at >= 0)) : 0;
  const start = Math.max(0, position - context);
  const end = Math.min(text.length, position + (words.find((word) => lower.indexOf(word) === position)?.length ?? 0) + context);
  return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

async function* lines(file: string): AsyncGenerator<any> {
  if (!existsSync(file)) return;
  const input = createReadStream(file, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      try { yield JSON.parse(line); } catch { /* 中断留下的半行 */ }
    }
  } finally { reader.close(); input.destroy(); }
}

/** 逐行扫描所有可见对话。收藏筛选使用快照，原消息不在时仍能查到。 */
export async function searchHistory(store: Store, options: { query?: string; starred?: boolean; limit?: number; context?: number } = {}): Promise<HistorySearchResult> {
  const words = (options.query ?? "").trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const stars = store.stars();
  const marked = new Set(stars.map((star) => key(star.conversation, star.itemId)));
  const found: HistoryMatch[] = [];
  const names = new Map(store.assistants().map((assistant) => [assistant.id, assistant.name]));
  const groups = store.groups();
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const add = (ref: ConversationRef, item: { id: string; speaker: string; at: string; text: string }) => {
    if (!item.text.trim() || !words.every((word) => item.text.toLocaleLowerCase().includes(word))) return;
    const starred = marked.has(key(ref, item.id));
    if (options.starred && !starred) return;
    found.push({ conversation: ref, conversationName: (ref.kind === "assistant" ? names : groupNames).get(ref.id) ?? ref.id, itemId: item.id, speaker: item.speaker, speakerName: item.speaker === "user" ? "用户" : names.get(item.speaker) ?? item.speaker, at: item.at, snippet: historySnippet(item.text, words, options.context ?? 60), starred });
  };
  if (options.starred) {
    for (const star of stars) add(star.conversation, { id: star.itemId, speaker: star.speaker, at: star.at, text: star.text });
  } else {
    // ponytail: 每次逐行扫全部历史，结果最多返回 50 条；记录变大后可换增量索引。
    for (const assistant of store.assistants()) {
      const ref: ConversationRef = { kind: "assistant", id: assistant.id };
      let assistantIndex = 0;
      let event = false;
      let held: { id: string; speaker: string; at: string; text: string }[] = [];
      const flush = () => { if (held.length && !saysNoReply(held.at(-1)!.text)) held.forEach((item) => add(ref, { ...item, text: stripNoReply(item.text) })); held = []; };
      for await (const entry of lines(store.routerFile(assistant.id))) {
        if (entry.type === "custom" && entry.customType === "hob.user") {
          if (typeof entry.data?.text === "string") add(ref, { id: entry.id, speaker: "user", at: entry.timestamp, text: entry.data.text });
        } else if (entry.type === "custom_message" && entry.customType === "hob.event") {
          flush(); event = true;
        } else if (entry.type === "message" && entry.message?.role === "user") {
          flush(); event = false;
        } else if (entry.type === "message" && entry.message?.role === "assistant") {
          assistantIndex++;
          const text = textOfContent(entry.message.content).trim();
          const error = entry.message.errorMessage?.trim();
          if ((entry.message.stopReason === "error" || entry.message.stopReason === "aborted") && error && text.includes(error)) continue;
          const item = { id: `a-${assistantIndex}`, speaker: assistant.id, at: entry.timestamp, text };
          if (event) held.push(item); else add(ref, { ...item, text: stripNoReply(text) });
        }
      }
      flush();
    }
    for (const group of groups) {
      const ref: ConversationRef = { kind: "group", id: group.id };
      const latest = new Map<string, GroupItem>();
      for await (const item of lines(store.groupTimelineFile(group.id))) if (typeof item?.id === "string") latest.set(item.id, item);
      for (const item of latest.values()) if (item.kind === "user" || (item.kind === "assistant" && !item.streaming)) add(ref, item);
    }
  }
  found.sort((a, b) => b.at.localeCompare(a.at));
  return { results: found.slice(0, Math.max(0, Math.min(options.limit ?? 50, 50))), total: found.length };
}
