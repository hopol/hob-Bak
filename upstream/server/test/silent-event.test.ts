import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Item } from "../../shared/types.ts";
import { deriveItems } from "../src/router.ts";
import { makeHob, text, waitFor, type TestHob } from "./helpers.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** 前端口子上能看到的东西：实时条目和流式增量。 */
function watch(hob: TestHob, assistantId = "hob"): { items: Item[]; deltas: string[] } {
  const items: Item[] = [];
  const deltas: string[] = [];
  hob.runtime.bus.subscribe((event) => {
    if (event.type === "item" && event.assistantId === assistantId && event.item.kind === "assistant") items.push(event.item);
    if (event.type === "delta" && event.assistantId === assistantId) deltas.push(event.text);
  });
  return { items, deltas };
}

/** 刷新后（重新从会话文件推导）的对话条目。 */
function fileItems(hob: TestHob): Item[] {
  const entries = readFileSync(hob.runtime.store.routerFile("hob"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEntry)
    .filter((entry) => entry.type !== "session");
  return deriveItems(entries);
}

const assistantItems = (items: Item[]) => items.filter((item) => item.kind === "assistant");

/** 带一句开口、调一次工具、再说最后一句的模型回复。 */
const opening = (words: string) => fauxAssistantMessage(
  [fauxText(words), fauxToolCall("set_rule", { text: "发周报前先问我", mode: "ask" })],
  { stopReason: "toolUse" },
);

describe("系统事件那一轮可以只回 NO_REPLY", () => {
  it("单聊：事件那一轮以 NO_REPLY 收尾，这一轮的文字一段都不出，卡片还在", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const bus = watch(hob);
      hob.faux.setResponses([opening("我先看一下进度。"), text("NO_REPLY")]);
      await hob.runtime.router.event("hob", "任务超过预计时间", undefined);
      await hob.runtime.router.waitIdle("hob");

      const items = hob.runtime.router.items("hob").items;
      expect(assistantItems(items)).toEqual([]);
      // 这一轮调工具产生的卡片照常显示
      expect(items.filter((item) => item.kind === "note")).toMatchObject([{ text: "已记入Hob的规则 · 发周报前先问我" }]);
      // 用户那边既没有流式条目，也没有增量
      expect(bus.items).toEqual([]);
      expect(bus.deltas).toEqual([]);
    } finally { hob.close(); }
  });

  it("单聊：事件那一轮写上正文，两段都在，卡片也在", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([opening("我先看一下进度。"), text("检查完了，它还在按原计划跑。")]);
      await hob.runtime.router.event("hob", "任务超过预计时间", undefined);
      await hob.runtime.router.waitIdle("hob");

      const items = hob.runtime.router.items("hob").items;
      expect(assistantItems(items).map((item) => (item as { text: string }).text)).toEqual([
        "我先看一下进度。",
        "检查完了，它还在按原计划跑。",
      ]);
      expect(items.some((item) => item.kind === "note")).toBe(true);
    } finally { hob.close(); }
  });

  it("单聊：事件那一轮不边写边推，这一轮结束时推的条目和刷新后推导的一致", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const bus = watch(hob);
      hob.faux.setResponses([opening("我先看一下进度。"), text("检查完了，它还在按原计划跑。")]);
      await hob.runtime.router.event("hob", "任务超过预计时间", undefined);
      await hob.runtime.router.waitIdle("hob");

      // 事件那一轮一个字都不流式出去（开头那句也不行：这一轮可能以 NO_REPLY 收尾）
      expect(bus.deltas).toEqual([]);
      const pushed = bus.items.filter((item) => !item.streaming).map((item) => ({ id: item.id, text: (item as { text: string }).text, lead: item.lead ?? false }));
      const walked = assistantItems(fileItems(hob)).map((item) => ({ id: item.id, text: (item as { text: string }).text, lead: item.lead ?? false }));
      expect(pushed).toEqual(walked);
      expect(walked).toHaveLength(2);
    } finally { hob.close(); }
  });

  it("单聊：用户那一轮里的 NO_REPLY 去掉再显示，去掉后是空的就不出这一段", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const bus = watch(hob);
      hob.faux.setResponses([text("这句我先改一版。\n\nNO_REPLY"), text("NO_REPLY")]);
      await hob.runtime.router.send("hob", { text: "帮我把那段通知改得客气些" });
      await hob.runtime.router.waitIdle("hob");
      await hob.runtime.router.send("hob", { text: "再想想还有别的说法吗" });
      await hob.runtime.router.waitIdle("hob");

      const items = hob.runtime.router.items("hob").items;
      expect(assistantItems(items).map((item) => (item as { text: string }).text)).toEqual(["这句我先改一版。"]);
      // 只写了 NO_REPLY 的那一条被收成空条目（前端不留气泡），这个词本身一处都不出现
      expect(bus.items.filter((item) => item.streaming)).toHaveLength(2);
      expect(JSON.stringify([...items, ...bus.items])).not.toContain("NO_REPLY");
    } finally { hob.close(); }
  });

  it("单聊：事件那一轮中途插进用户消息，从那条用户消息起照常显示", () => {
    const assistant = (id: string, words: string) => ({ type: "message", id, timestamp: "2026-11-13T10:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: words }] } });
    const user = (id: string, words: string) => ({ type: "custom", customType: "hob.user", id, timestamp: "2026-11-13T10:00:00.000Z", data: { text: words } });
    const event = (id: string) => ({ type: "custom_message", customType: "hob.event", id, timestamp: "2026-11-13T10:00:00.000Z", content: "[hob-event] 任务超过预计时间", display: false });

    const split = deriveItems([
      event("e1"), assistant("a", "NO_REPLY"),
      user("u1", "又想起一件事，还有别的要说"),
      assistant("b", "这件事我记下了，回头一起办。"),
    ] as unknown as SessionEntry[]);
    expect(split.map((item) => (item.kind === "user" ? `用户：${item.text}` : `${item.kind}：${(item as { text: string }).text}`))).toEqual([
      "用户：又想起一件事，还有别的要说",
      "assistant：这件事我记下了，回头一起办。",
    ]);

    const kept = deriveItems([
      event("e1"), assistant("a", "我先看看它在做什么。"),
      user("u1", "又想起一件事，还有别的要说"),
      assistant("b", "这件事我记下了，回头一起办。"),
    ] as unknown as SessionEntry[]);
    expect(kept.map((item) => (item.kind === "user" ? `用户：${item.text}` : `${item.kind}：${(item as { text: string }).text}`))).toEqual([
      "assistant：我先看看它在做什么。",
      "用户：又想起一件事，还有别的要说",
      "assistant：这件事我记下了，回头一起办。",
    ]);
  });

  it("单聊：用户在事件那一轮还没跑完时发了消息，刷新后和实时一样整轮收起", () => {
    // 真实的会话：hob.user 在按发送时就写了，夹在事件那一轮中间；模型读到用户消息（message user）才算用户那一轮
    const at = "2026-11-13T10:00:00.000Z";
    const assistant = (id: string, words: string) => ({ type: "message", id, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: words }] } });
    const hobUser = (id: string, words: string) => ({ type: "custom", customType: "hob.user", id, timestamp: at, data: { text: words } });
    const modelUser = (id: string, words: string) => ({ type: "message", id, timestamp: at, message: { role: "user", content: [{ type: "text", text: words }] } });
    const event = (id: string, details?: object) => ({ type: "custom_message", customType: "hob.event", id, timestamp: at, content: "[hob-event] 任务超过预计时间", display: false, ...(details ? { details } : {}) });

    const items = deriveItems([
      event("e1"), assistant("a", "我先看一下进度。"),
      hobUser("u1", "顺便把周报也发我"),
      assistant("b", "NO_REPLY"),
      modelUser("m1", "顺便把周报也发我"),
      assistant("c", "周报在这里。"),
    ] as unknown as SessionEntry[]);
    expect(items.map((item) => (item.kind === "user" ? `用户：${item.text}` : `${item.kind}：${(item as { text: string }).text}`))).toEqual([
      "用户：顺便把周报也发我",
      "assistant：周报在这里。",
    ]);

  });

  it("单聊：定时任务那一轮一个字没出，「⏱ 名字」不挂到用户下一轮的回复上", () => {
    const at = "2026-11-13T10:00:00.000Z";
    const assistant = (id: string, words: string) => ({ type: "message", id, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: words }] } });
    const hobUser = (id: string, words: string) => ({ type: "custom", customType: "hob.user", id, timestamp: at, data: { text: words } });
    const modelUser = (id: string, words: string) => ({ type: "message", id, timestamp: at, message: { role: "user", content: [{ type: "text", text: words }] } });
    const event = (id: string, details?: object) => ({ type: "custom_message", customType: "hob.event", id, timestamp: at, content: "[hob-event] 定时任务到点了", display: false, ...(details ? { details } : {}) });
    const routine = deriveItems([
      event("e2", { routine: { id: "r1", name: "每日巡检" } }), assistant("a", "NO_REPLY"),
      hobUser("u2", "今天天气怎么样"), modelUser("m2", "今天天气怎么样"),
      assistant("b", "我查一下。"),
    ] as unknown as SessionEntry[]);
    expect(routine.filter((item) => item.kind === "assistant")).toMatchObject([{ text: "我查一下。" }]);
    expect(routine.find((item) => item.kind === "assistant")).not.toHaveProperty("routine");
  });

  it("群：事件那一轮里用户插话进来，前面的照常收尾，回用户的话照常写进时间线", async () => {
    // 一个字一个字地吐，才有「这一轮还在跑」的窗口插话
    const hob = makeHob({}, { memory: "off", tokensPerSecond: 20 });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "ops", name: "服务器", duty: "机器", primary: false, pinned: false, sprite: "page" });
      const group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob", "ops"] });
      hob.faux.setResponses([
        fauxAssistantMessage([fauxText("我先看一下它在做什么，这一步要一会儿。"), fauxToolCall("set_rule", { text: "重启前先问我", mode: "ask" })], { stopReason: "toolUse" }),
        text("磁盘还剩一半，够用。"),
      ]);
      const deltas: string[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "group-delta" && event.groupId === group.id) deltas.push(event.text); });
      void hob.runtime.groups.deliverEvent(group.id, "ops", "任务超过预计时间");
      await waitFor(() => hob.faux.state.callCount === 1);
      await hob.runtime.groups.send(group.id, { text: "@服务器 磁盘还够吗" });
      await waitFor(() => hob.faux.state.callCount === 2);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 只跑了一轮（插进同一轮），开口那句和回用户的话都在
      expect(assistantItems(hob.runtime.groups.items(group.id).items).map((item) => (item as { text: string }).text)).toEqual([
        "我先看一下它在做什么，这一步要一会儿。",
        "磁盘还剩一半，够用。",
      ]);
      // 插话之前那段是事件那一轮的，不流式；回用户的话照常边写边推
      expect(deltas.join("")).not.toContain("我先看一下");
      expect(deltas.join("")).toContain("磁盘还剩一半");
    } finally { hob.close(); }
  });

  it("群：事件那一轮中途出错，已经写好的那段照常出，再写失败原因", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob"] });
      vi.spyOn(hob.runtime.router, "deliverMember").mockImplementation(async (gid, assistantId) => {
        hob.runtime.groups.settle(gid, assistantId, "任务做完了：三台机器的磁盘都还有一半以上。");
        throw new Error("连接断了");
      });
      await hob.runtime.groups.deliverEvent(group.id, "hob", "任务做完了");
      await waitFor(() => hob.runtime.groups.items(group.id).items.some((item) => item.kind === "note"));

      const items = hob.runtime.groups.items(group.id).items;
      expect(assistantItems(items).map((item) => (item as { text: string }).text)).toEqual(["任务做完了：三台机器的磁盘都还有一半以上。"]);
      expect(items.filter((item) => item.kind === "note").map((item) => (item as { text: string }).text).join("")).toContain("连接断了");
    } finally { hob.close(); }
  });

  it("群：事件那一轮以 NO_REPLY 收尾，不写时间线，也不按里面的 @ 叫人", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "ops", name: "服务器", duty: "机器", primary: false, pinned: false, sprite: "page" });
      const group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob", "ops"] });
      hob.faux.setResponses([
        fauxAssistantMessage([fauxText("@服务器 先看一眼"), fauxToolCall("set_rule", { text: "重启前先问我", mode: "ask" })], { stopReason: "toolUse" }),
        text("@服务器 NO_REPLY"),
      ]);
      await hob.runtime.groups.deliverEvent(group.id, "hob", "任务超过预计时间");
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const items = hob.runtime.groups.items(group.id).items;
      expect(assistantItems(items)).toEqual([]);
      expect(items.some((item) => item.kind === "note")).toBe(true);
      // 只跑了自己这一轮里的两次模型调用，没按 @ 把别人叫起来
      expect(hob.faux.state.callCount).toBe(2);
    } finally { hob.close(); }
  });

  it("群：事件那一轮不以 NO_REPLY 收尾，照常写进时间线", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob"] });
      hob.faux.setResponses([
        fauxAssistantMessage([fauxText("我看一下它在做什么。"), fauxToolCall("set_rule", { text: "重启前先问我", mode: "ask" })], { stopReason: "toolUse" }),
        text("看过了，任务还在按原计划跑，我不动它。"),
      ]);
      await hob.runtime.groups.deliverEvent(group.id, "hob", "任务超过预计时间");
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);

      const items = hob.runtime.groups.items(group.id).items;
      expect(assistantItems(items).map((item) => (item as { text: string }).text)).toEqual([
        "我看一下它在做什么。",
        "看过了，任务还在按原计划跑，我不动它。",
      ]);
    } finally { hob.close(); }
  });
});

describe("收到用户消息却回了 NO_REPLY：系统替助手挂 👀", () => {
  const reactionsOf = (items: Item[], id?: string) => items.find((item) => item.kind === "user" && (!id || item.id === id)) as Extract<Item, { kind: "user" }> | undefined;

  it("单聊：用户消息那一轮回 NO_REPLY，那条消息挂上助手的 👀", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([text("NO_REPLY")]);
      const sent = await hob.runtime.router.send("hob", { text: "周四的会改到下午三点了" });
      await hob.runtime.router.waitIdle("hob");
      expect(reactionsOf(hob.runtime.router.items("hob").items, sent.id)?.reactions).toEqual([{ by: "hob", emoji: "👀" }]);
    } finally { hob.close(); }
  });

  it("单聊：自己点过表情就不再挂；正常回话不挂；纯事件那一轮回 NO_REPLY 也不挂", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("react", { emoji: "👍" })], { stopReason: "toolUse" }), text("NO_REPLY"),
        text("好，周四下午三点。"),
        text("NO_REPLY"),
      ]);
      const first = await hob.runtime.router.send("hob", { text: "周四的会改到下午三点了" });
      await hob.runtime.router.waitIdle("hob");
      const second = await hob.runtime.router.send("hob", { text: "记一下" });
      await hob.runtime.router.waitIdle("hob");
      await hob.runtime.router.event("hob", "任务超过预计时间", undefined);
      await hob.runtime.router.waitIdle("hob");
      const items = hob.runtime.router.items("hob").items;
      expect(reactionsOf(items, first.id)?.reactions).toEqual([{ by: "hob", emoji: "👍" }]);
      expect(reactionsOf(items, second.id)?.reactions).toBeUndefined();
    } finally { hob.close(); }
  });

  it("群：收到用户消息的那一轮回 NO_REPLY，那条消息挂上它的 👀；纯事件那一轮不挂", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob"] });
      hob.faux.setResponses([text("NO_REPLY"), text("NO_REPLY")]);
      const sent = hob.runtime.groups.send(group.id, { text: "备份盘换好了" });
      await waitFor(() => hob.faux.state.callCount === 1 && hob.runtime.groups.summary(group.id).busy.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const item = (await sent) as { id: string };
      expect(reactionsOf(hob.runtime.groups.items(group.id).items, item.id)?.reactions).toEqual([{ by: "hob", emoji: "👀" }]);

      hob.runtime.store.saveGroupState(group.id, { reactions: {} });
      await hob.runtime.groups.deliverEvent(group.id, "hob", "任务超过预计时间");
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reactionsOf(hob.runtime.groups.items(group.id).items, item.id)?.reactions).toBeUndefined();
    } finally { hob.close(); }
  });
});
