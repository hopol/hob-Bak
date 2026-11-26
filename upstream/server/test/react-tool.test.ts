import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { HobEvent } from "../../shared/types.ts";
import { hashPassword } from "../src/password.ts";
import { PiHost } from "../src/pi.ts";
import { createRuntime } from "../src/runtime.ts";
import { buildRouterTools, isSingleEmoji } from "../src/router-tools.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { makeHob, text, waitFor } from "./helpers.ts";

function addMember(hob: ReturnType<typeof makeHob>, id: string, name: string) {
  const base = hob.runtime.store.assistant("hob")!;
  hob.runtime.store.saveAssistant({
    ...base,
    id,
    name,
    duty: `${name}的职责`,
    primary: false,
    pinned: false,
    sprite: "page",
    notify: true,
  });
}

describe("react 工具", () => {
  it("isSingleEmoji 只接受正好一个表情符号", () => {
    for (const valid of ["👍", "✅", "❤️", "😂", "👀", "👍🏻", "👨‍👩‍👧‍👦", "🇨🇳", "1️⃣"]) {
      expect(isSingleEmoji(valid), valid).toBe(true);
    }
    for (const invalid of ["", "   ", "好的", "👍❤️", "👍 👍", "1", "0", "#", "*", "a", "好", "👍a"]) {
      expect(isSingleEmoji(invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  it("单聊和群成员都有 react 工具，任务（Worker）没有", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "研发组", purpose: "开发协作", ownerId: "hob", members: ["hob"] });
      const singleTools = buildRouterTools(hob.runtime, "hob");
      const groupTools = buildRouterTools(hob.runtime, "hob", group.id);

      expect(singleTools.some((tool) => tool.name === "react")).toBe(true);
      expect(groupTools.some((tool) => tool.name === "react")).toBe(true);

      // 群成员会话实际放行的工具里也包含 react
      const memberSession = await hob.runtime.router.ensure("hob", group.id);
      expect(memberSession.session?.getActiveToolNames()).toContain("react");

      // 任务（Worker）会话里没有 react
      let workerToolNames: string[] = [];
      hob.faux.setResponses([
        (ctx) => {
          workerToolNames = (ctx.tools ?? []).map((tool) => tool.name);
          return fauxAssistantMessage([fauxToolCall("report", { outcome: "done", result: "已完成" })], { stopReason: "toolUse" });
        },
        text("好"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "测试任务", prompt: "执行测试" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done");
      expect(workerToolNames).not.toContain("react");
    } finally {
      hob.close();
    }
  });

  it("单聊：点表情、替换、推送、校验错误，重启后仍在", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((entry) => entry.name === "react")!;
      const events: HobEvent[] = [];
      hob.runtime.bus.subscribe((ev) => events.push(ev));

      // 还没有用户消息时报错
      const noMsg = await tool.execute("c0", { emoji: "👍" }, undefined, undefined, undefined as never);
      expect((noMsg as { isError?: boolean }).isError).toBe(true);
      expect((noMsg.content[0] as { text: string }).text).toContain("没有用户的消息");

      // emoji 不合格时报错
      const bad = await tool.execute("c1", { emoji: "好的" }, undefined, undefined, undefined as never);
      expect((bad as { isError?: boolean }).isError).toBe(true);
      expect((bad.content[0] as { text: string }).text).toBe("emoji 要正好一个表情，比如 👍");

      const two = await tool.execute("c2", { emoji: "👍❤️" }, undefined, undefined, undefined as never);
      expect((two as { isError?: boolean }).isError).toBe(true);
      expect((two.content[0] as { text: string }).text).toBe("emoji 要正好一个表情，比如 👍");

      // 发一条用户消息后点表情
      hob.faux.setResponses([text("收到")]);
      const userItem = await hob.runtime.router.send("hob", { text: "明天早上九点开会" });
      await hob.runtime.router.waitIdle("hob");

      const res1 = await tool.execute("c3", { emoji: "👍" }, undefined, undefined, undefined as never);
      expect((res1 as { isError?: boolean; terminate?: boolean }).isError).toBeUndefined();
      expect((res1 as { terminate?: boolean }).terminate).toBeUndefined();
      expect((res1.content[0] as { text: string }).text).toBe("已给用户的消息点了 👍。");

      // 条目上能读到 reactions，且实时推送了更新后的用户条目
      const after1 = hob.runtime.router.items("hob").items.find((item) => item.id === userItem.id);
      expect(after1).toMatchObject({ kind: "user", reactions: [{ by: "hob", emoji: "👍" }] });
      expect(events.some((ev) => ev.type === "item" && ev.assistantId === "hob" && ev.item.id === userItem.id && ev.item.kind === "user" && ev.item.reactions?.[0]?.emoji === "👍")).toBe(true);

      // 再点一次换掉表情
      const res2 = await tool.execute("c4", { emoji: "✅" }, undefined, undefined, undefined as never);
      expect((res2.content[0] as { text: string }).text).toBe("已给用户的消息点了 ✅。");
      const after2 = hob.runtime.router.items("hob").items.find((item) => item.id === userItem.id);
      expect(after2).toMatchObject({ kind: "user", reactions: [{ by: "hob", emoji: "✅" }] });

      // 标记已读不会覆盖 state.json 里的 reactions
      hob.runtime.router.read("hob");
      expect(hob.runtime.router.items("hob").items.find((item) => item.id === userItem.id)).toMatchObject({
        reactions: [{ by: "hob", emoji: "✅" }],
      });

      // 重启（新建 runtime 读同一个 HOB_HOME）后仍在
      const restarted = createRuntime({
        home: hob.home,
        config: { passwordHash: hashPassword("test"), cookieSecret: "cookie-secret", host: "127.0.0.1", port: 30148 },
        pi: new PiHost({ engineDir: join(hob.home, "system", "engine"), nativeProviders: [hob.faux.provider] }),
      });
      try {
        const persisted = restarted.router.items("hob").items.find((item) => item.id === userItem.id);
        expect(persisted).toMatchObject({ kind: "user", reactions: [{ by: "hob", emoji: "✅" }] });
      } finally {
        restarted.desktopEvents.stop();
        restarted.desktopControl.dispose();
        restarted.jobs.disposeAll();
        restarted.router.disposeAll();
      }
    } finally {
      hob.close();
    }
  });

  it("群和话题：两个成员各点一个都在、再点换掉、转进话题的消息也能点、重启后仍在", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addMember(hob, "analyst", "分析员");
      const group = hob.runtime.groups.create({ name: "项目群", purpose: "推进项目", ownerId: "hob", members: ["hob", "analyst"] });
      const hobTool = buildRouterTools(hob.runtime, "hob", group.id).find((entry) => entry.name === "react")!;
      const analystTool = buildRouterTools(hob.runtime, "analyst", group.id).find((entry) => entry.name === "react")!;

      // 群里还没有用户消息时报错
      const empty = await hobTool.execute("g0", { emoji: "👍" }, undefined, undefined, undefined as never);
      expect((empty as { isError?: boolean }).isError).toBe(true);
      expect((empty.content[0] as { text: string }).text).toContain("没有用户的消息");

      hob.faux.setResponses([text("明白")]);
      const userItem = await hob.runtime.groups.send(group.id, { text: "周报放周五下午发" });
      await waitFor(() => hob.faux.state.callCount >= 1);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);

      const events: HobEvent[] = [];
      hob.runtime.bus.subscribe((ev) => events.push(ev));

      await hobTool.execute("g1", { emoji: "👍" }, undefined, undefined, undefined as never);
      await analystTool.execute("g2", { emoji: "❤️" }, undefined, undefined, undefined as never);

      // 两个成员的回应都在
      const both = hob.runtime.groups.items(group.id).items.find((item) => item.id === userItem.id);
      expect(both).toMatchObject({
        kind: "user",
        reactions: [{ by: "hob", emoji: "👍" }, { by: "analyst", emoji: "❤️" }],
      });
      expect(events.some((ev) => ev.type === "group-item" && ev.groupId === group.id && ev.item.id === userItem.id && ev.item.kind === "user" && ev.item.reactions?.length === 2)).toBe(true);

      // 群主再点一次，只换自己的
      await hobTool.execute("g3", { emoji: "✅" }, undefined, undefined, undefined as never);
      const replaced = hob.runtime.groups.items(group.id).items.find((item) => item.id === userItem.id);
      expect(replaced).toMatchObject({
        kind: "user",
        reactions: [{ by: "hob", emoji: "✅" }, { by: "analyst", emoji: "❤️" }],
      });

      // 从综合转进话题的用户消息也能点，且与综合分开存储
      const topic = hob.runtime.groups.createTopic(group.id, "周报节奏", "hob");
      const forwarded = hob.runtime.groups.forwardUserItem(group.id, topic.id, userItem)!;
      const topicTool = buildRouterTools(hob.runtime, "hob", topic.id).find((entry) => entry.name === "react")!;
      await topicTool.execute("t1", { emoji: "👀" }, undefined, undefined, undefined as never);

      expect(hob.runtime.groups.items(topic.id).items.find((item) => item.id === forwarded.id)).toMatchObject({
        kind: "user",
        reactions: [{ by: "hob", emoji: "👀" }],
      });
      expect(hob.runtime.groups.items(group.id).items.find((item) => item.id === userItem.id)).toMatchObject({
        reactions: [{ by: "hob", emoji: "✅" }, { by: "analyst", emoji: "❤️" }],
      });

      // 重启后群和话题的回应都还在
      const restarted = createRuntime({
        home: hob.home,
        config: { passwordHash: hashPassword("test"), cookieSecret: "cookie-secret", host: "127.0.0.1", port: 30148 },
        pi: new PiHost({ engineDir: join(hob.home, "system", "engine"), nativeProviders: [hob.faux.provider] }),
      });
      try {
        expect(restarted.groups.items(group.id).items.find((item) => item.id === userItem.id)).toMatchObject({
          reactions: [{ by: "hob", emoji: "✅" }, { by: "analyst", emoji: "❤️" }],
        });
        expect(restarted.groups.items(topic.id).items.find((item) => item.id === forwarded.id)).toMatchObject({
          reactions: [{ by: "hob", emoji: "👀" }],
        });
      } finally {
        restarted.desktopEvents.stop();
        restarted.desktopControl.dispose();
        restarted.jobs.disposeAll();
        restarted.router.disposeAll();
      }
    } finally {
      hob.close();
    }
  });

  it("单聊：一轮只点表情没出文字时，没有空助手条目、没有失败提示、不推完成通知", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, notify: true });

      const pushedAssistantItems: HobEvent[] = [];
      hob.runtime.bus.subscribe((ev) => {
        if (ev.type === "item" && ev.assistantId === "hob" && ev.item.kind === "assistant") pushedAssistantItems.push(ev);
      });

      hob.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("react", { emoji: "👍" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([], { stopReason: "stop" }),
      ]);
      const userItem = await hob.runtime.router.send("hob", { text: "文档我已经更新好了" });
      await hob.runtime.router.waitIdle("hob");
      await new Promise((resolve) => setTimeout(resolve, 30));

      const items = hob.runtime.router.items("hob").items;
      expect(items.find((item) => item.id === userItem.id)).toMatchObject({
        kind: "user",
        reactions: [{ by: "hob", emoji: "👍" }],
      });
      expect(items.filter((item) => item.kind === "assistant")).toEqual([]);
      expect(items.filter((item) => item.kind === "note")).toEqual([]);
      expect(pushedAssistantItems).toEqual([]);
      expect(push).not.toHaveBeenCalled();
    } finally {
      hob.close();
    }
  });

  it("群：一轮只点表情没出文字时，时间线没有空助手条目、没有失败提示、不推完成通知", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, notify: true });
      const group = hob.runtime.groups.create({ name: "资料群", purpose: "同步资料", ownerId: "hob", members: ["hob"] });

      const pushedAssistantItems: HobEvent[] = [];
      hob.runtime.bus.subscribe((ev) => {
        if (ev.type === "group-item" && ev.groupId === group.id && ev.item.kind === "assistant") pushedAssistantItems.push(ev);
      });

      hob.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("react", { emoji: "✅" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([], { stopReason: "stop" }),
      ]);
      const userItem = await hob.runtime.groups.send(group.id, { text: "会议纪要放进目录了" });
      await waitFor(() => hob.faux.state.callCount >= 2);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const items = hob.runtime.groups.items(group.id).items;
      expect(items.find((item) => item.id === userItem.id)).toMatchObject({
        kind: "user",
        reactions: [{ by: "hob", emoji: "✅" }],
      });
      expect(items.filter((item) => item.kind === "assistant")).toEqual([]);
      // 只有建群时那一条 info，没有失败提示
      expect(items.filter((item) => item.kind === "note").map((item) => item.text)).toEqual(["已创建群「资料群」"]);
      expect(pushedAssistantItems).toEqual([]);
      expect(push).not.toHaveBeenCalled();
    } finally {
      hob.close();
    }
  });

  it("点完表情可以接着说话，表情和文字回复都在", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("react", { emoji: "👍" })], { stopReason: "toolUse" }),
        text("顺便提醒一下，下周二的评审也改到下午了。"),
      ]);
      const userItem = await hob.runtime.router.send("hob", { text: "我把议程发群里了" });
      await hob.runtime.router.waitIdle("hob");

      const items = hob.runtime.router.items("hob").items;
      expect(items.find((item) => item.id === userItem.id)).toMatchObject({
        reactions: [{ by: "hob", emoji: "👍" }],
      });
      expect(items.filter((item) => item.kind === "assistant").map((item) => item.text)).toEqual([
        "顺便提醒一下，下周二的评审也改到下午了。",
      ]);
    } finally {
      hob.close();
    }
  });

  it("工具说明与系统提示词与票 265 原文一致，单聊和群成员都有", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addMember(hob, "analyst", "分析员");
      const group = hob.runtime.groups.create({ name: "项目群", purpose: "推进项目", ownerId: "hob", members: ["hob", "analyst"] });
      const reactTool = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "react")!;
      expect(reactTool.description).toBe("给用户最新的一条消息加一个表情回应，显示在那条消息的右下角，像聊天软件里的点赞。再调一次会换成新的表情。");
      expect((reactTool.parameters as { properties: { emoji: { description: string } } }).properties.emoji.description).toBe("一个 emoji，比如 👍 ✅ ❤️ 😂");

      const expected = "用户的消息可以用 react 点一个表情回应，像聊天软件里朋友之间那样：赞同、开心、好笑、感谢，一个表情让对话有来有回。表情是回复之外的互动，该说的话照常用文字说。";
      const baseOpts = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      const singlePrompt = buildSystemPrompt(hob.runtime.store, "hob", baseOpts);
      const memberPrompt = buildSystemPrompt(hob.runtime.store, "analyst", { ...baseOpts, group });
      expect(singlePrompt).toContain(`几句话能说清的，直接回复。\n\n${expected}`);
      expect(memberPrompt).toContain(`几句话能说清的，直接回复。\n\n${expected}`);
    } finally {
      hob.close();
    }
  });
});
