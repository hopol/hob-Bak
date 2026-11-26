import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { buildAdminTools } from "../src/admin-tools.ts";
import { MAX_WAVE_TURNS } from "../src/groups.ts";
import { buildSystemPrompt, GROUP_ALL_REPLY_LINE, GROUP_NO_REPLY_LINE, groupPromptLine } from "../src/prompt.ts";
import { makeHob, text, waitFor } from "./helpers.ts";

function addMember(hob: ReturnType<typeof makeHob>, id: string, name: string, duty = `${name}视角`) {
  const base = hob.runtime.store.assistant("hob")!;
  hob.runtime.store.saveAssistant({
    ...base,
    id,
    name,
    duty,
    primary: false,
    pinned: false,
    sprite: "page",
  });
}

describe("群和话题的「全员回应」（replyMode）", () => {
  it("群主回应（默认）照旧只由群主接手", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addMember(hob, "m1", "产品");
      addMember(hob, "m2", "法务");
      const group = hob.runtime.groups.create({ name: "评审群", purpose: "方案评审", ownerId: "hob", members: ["hob", "m1", "m2"] });
      expect(hob.runtime.groups.targetsOf(group, "大家怎么看这个计划？")).toEqual(["hob"]);

      hob.faux.setResponses([text("群主已收下。")]);
      await hob.runtime.groups.send(group.id, { text: "大家怎么看这个计划？" });
      await waitFor(() => hob.faux.state.callCount >= 1);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(hob.faux.state.callCount).toBe(1);
      const speakers = hob.runtime.groups.items(group.id).items.filter((item) => item.kind === "assistant").map((item) => item.speaker);
      expect(speakers).toEqual(["hob"]);
    } finally {
      hob.close();
    }
  });

  it("全员回应：群主先回，其余成员按成员顺序依次轮到，看得到前面说的话且触发条目为用户消息", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addMember(hob, "m1", "产品");
      addMember(hob, "m2", "研发");
      // 故意把群主放在成员列表中间，验证仍由群主先回，再按成员列表顺序依次轮到 m1、m2
      const group = hob.runtime.groups.create({
        name: "顾问群",
        purpose: "多角度建议",
        ownerId: "hob",
        members: ["m1", "hob", "m2"],
        replyMode: "all",
      });

      const order: string[] = [];
      const activeAtStart: number[] = [];
      const triggerIds: Record<string, string | undefined> = {};
      const seenPrompts: Record<string, string> = {};
      let inFlight = 0;

      const userItemPromise = new Promise<string>((resolve) => {
        hob.faux.setResponses([
          async (ctx) => {
            activeAtStart.push(inFlight);
            inFlight += 1;
            order.push("hob");
            triggerIds.hob = hob.runtime.groups.triggerOf(group.id, "hob")?.id;
            seenPrompts.hob = JSON.stringify(ctx.messages);
            await new Promise((r) => setTimeout(r, 20));
            inFlight -= 1;
            return text("群主先给框架：重点看交付周期。");
          },
          async (ctx) => {
            activeAtStart.push(inFlight);
            inFlight += 1;
            order.push("m1");
            triggerIds.m1 = hob.runtime.groups.triggerOf(group.id, "m1")?.id;
            seenPrompts.m1 = JSON.stringify(ctx.messages);
            await new Promise((r) => setTimeout(r, 20));
            inFlight -= 1;
            return text("产品补充：首期可以砍掉导出功能。");
          },
          async (ctx) => {
            activeAtStart.push(inFlight);
            inFlight += 1;
            order.push("m2");
            triggerIds.m2 = hob.runtime.groups.triggerOf(group.id, "m2")?.id;
            seenPrompts.m2 = JSON.stringify(ctx.messages);
            await new Promise((r) => setTimeout(r, 20));
            inFlight -= 1;
            return text("研发补充：接口两天能落地。");
          },
        ]);
        void hob.runtime.groups.send(group.id, { text: "这个版本该怎么排期？" }).then((item) => resolve(item.id));
      });

      const userItemId = await userItemPromise;
      await waitFor(() => order.length === 3);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);

      expect(order).toEqual(["hob", "m1", "m2"]);
      // 严格依次运行，前一个跑完才轮到下一个
      expect(activeAtStart).toEqual([0, 0, 0]);
      // 每个人的触发条目都是用户那条消息
      expect(triggerIds).toEqual({ hob: userItemId, m1: userItemId, m2: userItemId });
      // 后面的成员能看到前面所有人说的话
      expect(seenPrompts.m1).toContain("群主先给框架：重点看交付周期。");
      expect(seenPrompts.m2).toContain("群主先给框架：重点看交付周期。");
      expect(seenPrompts.m2).toContain("产品补充：首期可以砍掉导出功能。");
    } finally {
      hob.close();
    }
  });

  it("全员回应：群主 @ 了某成员时先跑完接力，且该成员不再重复排", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addMember(hob, "m1", "产品");
      addMember(hob, "m2", "研发");
      addMember(hob, "m3", "测试");
      const group = hob.runtime.groups.create({
        name: "项目群",
        purpose: "版本评审",
        ownerId: "hob",
        members: ["hob", "m1", "m2", "m3"],
        replyMode: "all",
      });

      const order: string[] = [];
      hob.faux.setResponses([
        () => { order.push("hob"); return text("先请 @研发 评估下风险。"); },
        () => { order.push("m2"); return text("研发：核心改动可控。"); },
        () => { order.push("m1"); return text("产品：需求范围没问题。"); },
        () => { order.push("m3"); return fauxAssistantMessage([fauxToolCall("react", { emoji: "👍" })], { stopReason: "toolUse" }); },
        () => fauxAssistantMessage([], { stopReason: "stop" }),
      ]);

      const userItem = await hob.runtime.groups.send(group.id, { text: "周四发版可行吗？" });
      await waitFor(() => hob.faux.state.callCount >= 5);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 40));

      // 群主 -> @研发 -> 其余没说过话的按成员顺序：产品、测试（研发不再重复排）
      expect(order).toEqual(["hob", "m2", "m1", "m3"]);
      // 测试只点表情不出文字：时间线里没有它的空条目，用户消息上有它的 👍
      const items = hob.runtime.groups.items(group.id).items;
      expect(items.filter((item) => item.kind === "assistant").map((item) => item.speaker)).toEqual(["hob", "m2", "m1"]);
      expect(items.find((item) => item.id === userItem.id)).toMatchObject({
        reactions: [{ by: "m3", emoji: "👍" }],
      });
    } finally {
      hob.close();
    }
  });

  it("全员回应下 @ 了人或引用了谁，照旧只轮到被点名的成员", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addMember(hob, "m1", "产品");
      addMember(hob, "m2", "研发");
      const group = hob.runtime.groups.create({
        name: "讨论群",
        purpose: "日常讨论",
        ownerId: "hob",
        members: ["hob", "m1", "m2"],
        replyMode: "all",
      });

      // @ 点名
      hob.faux.setResponses([text("产品收到。")]);
      await hob.runtime.groups.send(group.id, { text: "@产品 帮我确认一下字段名" });
      await waitFor(() => hob.faux.state.callCount >= 1);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const afterMention = hob.runtime.groups.items(group.id).items.filter((item) => item.kind === "assistant");
      expect(afterMention.map((item) => item.speaker)).toEqual(["m1"]);

      // 引用某成员的消息
      hob.faux.setResponses([text("字段名叫 order_code。")]);
      await hob.runtime.groups.send(group.id, { text: "具体叫什么？", quote: { itemId: afterMention[0]!.id, text: "产品收到。" } });
      await waitFor(() => hob.faux.state.callCount >= 2);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(hob.faux.state.callCount).toBe(2);
      const allReplies = hob.runtime.groups.items(group.id).items.filter((item) => item.kind === "assistant");
      expect(allReplies.map((item) => item.speaker)).toEqual(["m1", "m1"]);
    } finally {
      hob.close();
    }
  });

  it("全员回应途中按停止，后面没轮到的成员不再排", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addMember(hob, "m1", "产品");
      addMember(hob, "m2", "研发");
      const group = hob.runtime.groups.create({
        name: "评审群",
        purpose: "方案评审",
        ownerId: "hob",
        members: ["hob", "m1", "m2"],
        replyMode: "all",
      });

      let releaseOwner!: () => void;
      const ownerStarted = new Promise<void>((resolve) => {
        hob.faux.setResponses([
          async () => {
            resolve();
            await new Promise<void>((done) => { releaseOwner = done; });
            return text("群主回复");
          },
          text("不该轮到产品"),
          text("不该轮到研发"),
        ]);
      });

      await hob.runtime.groups.send(group.id, { text: "聊聊方案" });
      await ownerStarted;
      const stopping = hob.runtime.groups.stop(group.id);
      releaseOwner();
      await stopping;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(hob.faux.state.callCount).toBe(1);
    } finally {
      hob.close();
    }
  });

  it("成员超过 MAX_WAVE_TURNS 时，全员依次回应仍能全部轮完", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const count = MAX_WAVE_TURNS + 2;
      const members = ["hob"];
      for (let i = 1; i < count; i++) {
        const id = `m${i}`;
        addMember(hob, id, `成员${i}`);
        members.push(id);
      }
      const group = hob.runtime.groups.create({
        name: "大群",
        purpose: "大群同步",
        ownerId: "hob",
        members,
        replyMode: "all",
      });

      hob.faux.setResponses(members.map((id) => text(`来自 ${id}`)));
      await hob.runtime.groups.send(group.id, { text: "每人说一句" });
      await waitFor(() => hob.faux.state.callCount === count, 15_000);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);

      const speakers = hob.runtime.groups.items(group.id).items.filter((item) => item.kind === "assistant").map((item) => item.speaker);
      expect(speakers).toEqual(members);
    } finally {
      hob.close();
    }
  });

  it("新话题沿用所属群当时的 replyMode，之后群和话题可以各自单独修改", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({
        name: "顾问群",
        purpose: "建议",
        ownerId: "hob",
        members: ["hob"],
        replyMode: "all",
      });
      const topic1 = hob.runtime.groups.createTopic(group.id, "预算讨论", "user");
      expect(topic1.replyMode).toBe("all");
      expect(hob.runtime.store.group(topic1.id)?.replyMode).toBe("all");

      // 群改回群主回应，已有话题保持全员回应，之后新开的话题沿用群的新设置
      hob.runtime.groups.update(group.id, { replyMode: "owner" });
      expect(hob.runtime.store.group(group.id)?.replyMode).toBe("owner");
      expect(hob.runtime.store.group(topic1.id)?.replyMode).toBe("all");

      const topic2 = hob.runtime.groups.createTopic(group.id, "排期讨论", "user");
      expect(topic2.replyMode).toBe("owner");

      // 话题单独改成全员回应，不影响所属群
      hob.runtime.groups.update(topic2.id, { replyMode: "all" });
      expect(hob.runtime.store.group(topic2.id)?.replyMode).toBe("all");
      expect(hob.runtime.store.group(group.id)?.replyMode).toBe("owner");

      // 话题非法 replyMode 报错
      expect(() => hob.runtime.groups.update(topic2.id, { replyMode: "nobody" })).toThrow("owner 或 all");
    } finally {
      hob.close();
    }
  });

  it("create_group 和 update_group 支持 replyMode 参数、说明逐字一致、非法值报错", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addMember(hob, "m1", "产品");
      const tools = buildAdminTools(hob.runtime, "hob");
      const createGroup = tools.find((tool) => tool.name === "create_group")!;
      const updateGroup = tools.find((tool) => tool.name === "update_group")!;
      const expectedDesc = "用户没点名的消息谁来回应：owner 群主回应（默认），all 全员回应，群主先回，其他成员依次轮到。";
      expect((createGroup.parameters as any).properties.replyMode.description).toBe(expectedDesc);
      expect((updateGroup.parameters as any).properties.replyMode.description).toBe(expectedDesc);

      // 非法值报错
      const badCreate = await createGroup.execute("c1", {
        name: "非法群",
        purpose: "测试",
        members: ["hob", "m1"],
        ownerId: "hob",
        replyMode: "everyone",
      }, undefined, undefined, undefined as never);
      expect((badCreate as { isError?: boolean }).isError).toBe(true);
      expect((badCreate.content[0] as { text: string }).text).toContain("owner 或 all");

      // 合法创建
      const okCreate = await createGroup.execute("c2", {
        name: "评审团",
        purpose: "方案评审",
        members: ["hob", "m1"],
        ownerId: "hob",
        replyMode: "all",
      }, undefined, undefined, undefined as never);
      expect((okCreate as { isError?: boolean }).isError).toBeUndefined();
      const created = hob.runtime.store.groups().find((group) => group.name === "评审团")!;
      expect(created.replyMode).toBe("all");

      // update_group 非法值报错
      const badUpdate = await updateGroup.execute("u1", { groupId: created.id, replyMode: "invalid" }, undefined, undefined, undefined as never);
      expect((badUpdate as { isError?: boolean }).isError).toBe(true);
      expect((badUpdate.content[0] as { text: string }).text).toContain("owner 或 all");

      // update_group 合法修改，changes 里写「回应方式」
      const okUpdate = await updateGroup.execute("u2", { groupId: created.id, replyMode: "owner" }, undefined, undefined, undefined as never);
      expect((okUpdate as { isError?: boolean }).isError).toBeUndefined();
      expect((okUpdate.content[0] as { text: string }).text).toBe("已修改群「评审团」：回应方式。");
      expect(hob.runtime.store.group(created.id)?.replyMode).toBe("owner");
    } finally {
      hob.close();
    }
  });

  it("系统提示词：全员回应的群和话题含完整提示段（群主和成员都有），群主回应的不含", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addMember(hob, "m1", "产品");
      const ownerGroup = hob.runtime.groups.create({ name: "默认群", purpose: "协作", ownerId: "hob", members: ["hob", "m1"] });
      const allGroup = hob.runtime.groups.create({ name: "全员群", purpose: "集思广益", ownerId: "hob", members: ["hob", "m1"], replyMode: "all" });
      const allTopicInOwnerGroup = hob.runtime.groups.createTopic(ownerGroup.id, "全员话题", "user");
      hob.runtime.groups.update(allTopicInOwnerGroup.id, { replyMode: "all" });
      const ownerTopicInAllGroup = hob.runtime.groups.createTopic(allGroup.id, "群主话题", "user");
      hob.runtime.groups.update(ownerTopicInAllGroup.id, { replyMode: "owner" });

      const base = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      const verbatim = "这个群设成了全员回应：用户没点名的消息，群主先回，其他成员按成员顺序依次轮到，前面的人说过什么你都看得到。";
      expect(GROUP_ALL_REPLY_LINE).toBe(verbatim);

      // 全员回应群：群主和普通成员都紧接在 groupPromptLine 后面
      for (const member of ["hob", "m1"]) {
        const prompt = buildSystemPrompt(hob.runtime.store, member, { ...base, group: hob.runtime.store.group(allGroup.id)! });
        expect(prompt).toContain(`${groupPromptLine(hob.runtime.store, allGroup)}\n\n${GROUP_NO_REPLY_LINE}\n\n${verbatim}`);
      }

      // 群主回应群：不含
      for (const member of ["hob", "m1"]) {
        const prompt = buildSystemPrompt(hob.runtime.store, member, { ...base, group: hob.runtime.store.group(ownerGroup.id)! });
        expect(prompt).not.toContain(verbatim);
      }

      // 话题各自按自己的 replyMode 判断
      const topicAllPrompt = buildSystemPrompt(hob.runtime.store, "m1", { ...base, group: hob.runtime.store.group(allTopicInOwnerGroup.id)! });
      expect(topicAllPrompt).toContain(`${groupPromptLine(hob.runtime.store, ownerGroup)}\n\n${GROUP_NO_REPLY_LINE}\n\n${verbatim}`);

      const topicOwnerPrompt = buildSystemPrompt(hob.runtime.store, "m1", { ...base, group: hob.runtime.store.group(ownerTopicInAllGroup.id)! });
      expect(topicOwnerPrompt).not.toContain(verbatim);
    } finally {
      hob.close();
    }
  });
});
