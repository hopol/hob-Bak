import { describe, expect, it } from "vitest";
import type { Item } from "../../shared/types.ts";
import { applyDelta, isStreamingTail, mergeItems } from "../src/merge.ts";

function user(id: string, at: string, text = "在吗"): Item {
  return { kind: "user", id, at, text };
}

function assistant(id: string, at: string, text: string, streaming?: boolean): Item {
  return { kind: "assistant", id, at, text, ...(streaming ? { streaming } : {}) };
}

describe("对话条目合并", () => {
  it("按时间排序：晚到的事件落到正确位置", () => {
    // 服务器里 a-1 排在 u-2 前面（助手消息先落盘），但事件是 u-2 先到
    const live = mergeItems([], [user("u-1", "2026-11-01T01:00:00.000Z")]);
    const afterUser2 = mergeItems(live, user("u-2", "2026-11-01T01:00:02.000Z"));
    const late = mergeItems(afterUser2, assistant("a-1", "2026-11-01T01:00:01.000Z", "记住了"));
    expect(late.map((item) => item.id)).toEqual(["u-1", "a-1", "u-2"]);
  });

  it("同一个 id 覆盖，不会出两条", () => {
    const live = mergeItems([], [assistant("a-1", "2026-11-01T01:00:00.000Z", "", true)]);
    const done = mergeItems(live, assistant("a-1", "2026-11-01T01:00:00.500Z", "记住了"));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: "a-1", text: "记住了" });
    expect(done[0]).not.toHaveProperty("streaming");
  });

  it("页面拉回来的一整页和已有的合并，按 id 去重", () => {
    const live = [user("u-1", "2026-11-01T01:00:00.000Z")];
    const page = [user("u-1", "2026-11-01T01:00:00.000Z"), assistant("a-1", "2026-11-01T01:00:01.000Z", "记住了")];
    expect(mergeItems(live, page).map((item) => item.id)).toEqual(["u-1", "a-1"]);
  });

  it("只留最新 limit 条", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      user(`u-${i}`, `2026-11-01T01:00:0${i}.000Z`),
    );
    const kept = mergeItems([], many, 3);
    expect(kept.map((item) => item.id)).toEqual(["u-2", "u-3", "u-4"]);
  });

  it("时间相同时按到达顺序，后到的在后面", () => {
    const at = "2026-11-01T01:00:00.000Z";
    const live = mergeItems(mergeItems([], user("u-1", at)), user("u-2", at));
    expect(live.map((item) => item.id)).toEqual(["u-1", "u-2"]);
  });
});

describe("流式追加", () => {
  it("追加到最后一条助手消息里", () => {
    const live = mergeItems([], [user("u-1", "2026-11-01T01:00:00.000Z"), assistant("a-1", "2026-11-01T01:00:01.000Z", "记住", true)]);
    const next = applyDelta(live, "a-1", "了。");
    expect(next.map((item) => (item.kind === "assistant" ? item.text : ""))).toEqual(["", "记住了。"]);
  });

  it("条目不存在或者不是助手消息就原样返回", () => {
    const live = [user("u-1", "2026-11-01T01:00:00.000Z")];
    expect(applyDelta(live, "a-9", "？")).toBe(live);
    expect(applyDelta(live, "u-1", "？")).toBe(live);
  });

  it("最后一条还在流式就说明助手正在说", () => {
    expect(isStreamingTail([user("u-1", "2026-11-01T01:00:00.000Z"), assistant("a-1", "2026-11-01T01:00:01.000Z", "记", true)])).toBe(true);
    expect(isStreamingTail([assistant("a-1", "2026-11-01T01:00:01.000Z", "记住了")])).toBe(false);
    expect(isStreamingTail([])).toBe(false);
  });
});
