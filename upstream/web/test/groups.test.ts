import { describe, expect, it } from "vitest";
import type { GroupItem } from "../../shared/types.ts";
import { applyDelta, mergeItems } from "../src/merge.ts";
import { applyMention, filterMembers, mentionAt, stepPick } from "../src/mention.ts";

const members = [
  { id: "hob", name: "Hob", duty: "主助手" },
  { id: "house", name: "家里 NAS", duty: "相册和备份" },
  { id: "server", name: "服务器", duty: "线上和机器" },
];
const names = members.map((m) => m.name);

describe("@ 点名", () => {
  it("打到 @ 就认出在点名；名字写完（后面跟了空格）就不算", () => {
    expect(mentionAt("发到群里，@", 6, names)).toEqual({ start: 5, query: "" });
    expect(mentionAt("@家", 2, names)).toEqual({ start: 0, query: "家" });
    expect(mentionAt("@家里 NAS ", 8, names)).toBeNull();
    expect(mentionAt("没问题", 3, names)).toBeNull();
  });

  it("按名字和职责筛成员，群主排第一", () => {
    expect(filterMembers(members, "hob", "").map((m) => m.id)).toEqual(["hob", "house", "server"]);
    expect(filterMembers(members, "hob", "备份").map((m) => m.id)).toEqual(["house"]);
    expect(filterMembers(members, "server", "").map((m) => m.id)).toEqual(["server", "hob", "house"]);
    expect(filterMembers(members, "hob", "没有这个人")).toEqual([]);
  });

  it("选中后把 @输入 换成 @名字 加一个空格，光标落在空格后面", () => {
    const at = mentionAt("@家", 2, names)!;
    expect(applyMention("@家", at, "家里 NAS")).toEqual({ text: "@家里 NAS ", caret: 8 });
  });

  it("键盘上下选到头会绕回去", () => {
    expect(stepPick(2, 1, 3)).toBe(0);
    expect(stepPick(0, -1, 3)).toBe(2);
    expect(stepPick(0, 1, 0)).toBe(0);
  });
});

const said = (id: string, at: string, extra: Partial<GroupItem> = {}): GroupItem =>
  ({ kind: "assistant", id, at, text: "", speaker: "house", ...extra }) as GroupItem;

describe("群条目的合并", () => {
  it("新条目接在后面，按时间排", () => {
    const first = said("g-1", "2026-11-06T09:12:00Z");
    const second = said("g-2", "2026-11-06T09:14:00Z", { speaker: "server" });
    expect(mergeItems([first], second)).toEqual([first, second]);
    // 事件比下一条消息来得晚：仍然按时间排在前面的位置
    expect(mergeItems([second], first).map((item) => item.id)).toEqual(["g-1", "g-2"]);
  });

  it("同一个 id 的再来一条就整条替换（流式结束、卡片状态变了）", () => {
    const streaming = said("g-1", "2026-11-06T09:12:00Z", { text: "补上了", streaming: true });
    const done = said("g-1", "2026-11-06T09:12:00Z", { text: "补上了：新增 312 张。" });
    expect(mergeItems([streaming], done)).toEqual([done]);
  });

  it("delta 追加到同一个 id 的文字上，别的条目不动", () => {
    const item = said("g-1", "2026-11-06T09:12:00Z", { text: "备份在", streaming: true });
    const other = { kind: "user", id: "g-2", at: "2026-11-06T09:13:00Z", text: "好", speaker: "user" } as GroupItem;
    const next = applyDelta([item, other], "g-1", " 02:14 中断");
    expect(next[0]).toMatchObject({ id: "g-1", text: "备份在 02:14 中断", speaker: "house" });
    expect(next[1]).toBe(other);
    // 找不到这条、或者不是助手说的：原样返回
    const list = [item];
    expect(applyDelta(list, "g-9", "x")).toBe(list);
    expect(applyDelta(list, "g-2", "x")).toBe(list);
  });
});
