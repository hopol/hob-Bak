// 动效的时间调度：哪些条目标是“新到的”、状态切走之后还要留多久、列表增删怎么过渡。
import { useEffect, useRef, useState } from "react";

/** 入场类名留这么久再摘掉，中间重渲染（流式追加）不会把动画掐断。 */
const FRESH_MS = 900;

const fresh = new Map<string, number>();

/** 标记为“新到的”：只有这些条目播入场动画。 */
export function markFresh(ids: string[]) {
  for (const id of ids) {
    if (fresh.has(id)) continue;
    fresh.set(
      id,
      window.setTimeout(() => fresh.delete(id), FRESH_MS),
    );
  }
}

export function isFresh(id: string): boolean {
  return fresh.has(id);
}

/** 重新拉对话、切换助手时清掉：历史消息不播入场。 */
export function clearFresh() {
  for (const t of fresh.values()) window.clearTimeout(t);
  fresh.clear();
}

/** 滚到对话里的那一条并闪一下：消息行闪气泡，卡片闪自己。 */
export function flashItem(row: HTMLElement) {
  const target = row.querySelector<HTMLElement>(".hov.msg > .u, .hov.msg > .b") ?? row;
  target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
  target.classList.remove("quote-flash");
  void target.offsetWidth;
  target.classList.add("quote-flash");
  window.setTimeout(() => target.classList.remove("quote-flash"), 1100);
}

/** show 变 false 之后再多留 ms，用来播退场。 */
export function useLeave(show: boolean, ms = 180): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [show, ms]);
  return { mounted, leaving: mounted && !show };
}

export interface Row<T> {
  item: T;
  key: string;
  state: "still" | "enter" | "leave";
}

/**
 * 列表增删的过渡：新出现的 key 播入场，消失的 key 先留 exitMs 播退场再摘掉。
 * 首次渲染、或 resetTag 变了（换了助手）不播，避免整列一起动。keyOf 要是稳定的函数。
 */
export function useRows<T>(
  items: T[],
  keyOf: (item: T) => string,
  resetTag = "",
  exitMs = 200,
): Row<T>[] {
  const [enter, setEnter] = useState<string[]>([]);
  const [gone, setGone] = useState<Row<T>[]>([]);
  const known = useRef<Set<string> | null>(null);
  const tag = useRef(resetTag);
  const prev = useRef<T[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const keys = items.map(keyOf);
    if (known.current === null || tag.current !== resetTag) {
      known.current = new Set(keys);
      tag.current = resetTag;
      prev.current = items;
      return;
    }
    const added = keys.filter((k) => !known.current!.has(k));
    const removed = prev.current.filter((it) => !keys.includes(keyOf(it)));
    known.current = new Set(keys);
    prev.current = items;
    if (added.length) {
      setEnter((cur) => [...cur, ...added]);
      timers.current.push(
        window.setTimeout(() => setEnter((cur) => cur.filter((k) => !added.includes(k))), 1000),
      );
    }
    if (removed.length) {
      const rows = removed.map((item) => ({ item, key: keyOf(item), state: "leave" as const }));
      setGone((cur) => [...cur, ...rows]);
      timers.current.push(
        window.setTimeout(() => setGone((cur) => cur.filter((r) => !rows.some((x) => x.key === r.key))), exitMs),
      );
    }
  }, [items, keyOf, resetTag, exitMs]);

  useEffect(() => {
    const list = timers.current;
    return () => {
      for (const t of list) window.clearTimeout(t);
    };
  }, []);

  const rows: Row<T>[] = items.map((item) => {
    const key = keyOf(item);
    return { item, key, state: enter.includes(key) ? "enter" : "still" };
  });
  return [...rows, ...gone];
}
