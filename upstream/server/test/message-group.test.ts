import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Assistant, Group, GroupItem } from "../../shared/types.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const ISO = "2026-11-08T02:00:00.000Z";

function addAssistant(hob: TestHob, id: string, name: string, duty: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty, primary: false, pinned: false, sprite: "page" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

/** 三人群：Hob、服务器、写作；群主默认是「服务器」，测主助手当群主的另建。 */
function setup(ownerId = "ops"): { hob: TestHob; group: Group } {
  const hob = makeHob({}, { memory: "off" });
  addAssistant(hob, "ops", "服务器", "机器");
  addAssistant(hob, "write", "写作", "周报");
  const group = hob.runtime.groups.create({
    name: "家里机器",
    purpose: "机器上的事",
    ownerId,
    members: ["hob", "ops", "write"],
  });
  return { hob, group };
}

/** 综合里的一条用户消息：不经过模型，直接写进时间线。 */
function appendUser(hob: TestHob, gid: string, text: string, id: string): GroupItem {
  const item: GroupItem = { kind: "user", speaker: "user", id, at: ISO, text };
  hob.runtime.store.appendGroupItem(gid, item);
  return item;
}

function toolOf(hob: TestHob, name: string, gid?: string) {
  const tool = buildRouterTools(hob.runtime, "hob", gid).find((item) => item.name === name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  return tool;
}

const textOf = (result: Awaited<ReturnType<ReturnType<typeof toolOf>["execute"]>>) => (result.content[0] as { text: string }).text;
const isError = (result: { isError?: boolean }) => Boolean(result.isError);

/** 主助手单聊里收到的事件（系统消息）。 */
async function events(hob: TestHob, assistantId = "hob"): Promise<string[]> {
  const state = await hob.runtime.router.ensure(assistantId);
  return state.manager!.getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "hob.event")
    .map((entry) => {
      const content = (entry as { content?: string | { type: string; text?: string }[] }).content;
      if (typeof content === "string") return content;
      return (content ?? []).map((block) => block.text ?? "").join("");
    });
}

/** 群会话文件的最后一条用户输入（去掉「现在时间」那段）。 */
function inputBody(hob: TestHob, gid: string, assistantId: string): string {
  const file = hob.runtime.store.groupMemberFile(gid, assistantId);
  if (!existsSync(file)) return "";
  const texts = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (entry.type !== "message" || entry.message?.role !== "user") return [];
        const content = entry.message.content;
        if (typeof content === "string") return [content];
        if (!Array.isArray(content)) return [];
        return [content.filter((block) => block?.type === "text").map((block) => block.text).join("")];
      } catch {
        return [];
      }
    });
  const last = texts.at(-1) ?? "";
  return last.slice(last.indexOf("\n\n") + 2);
}

/** 等主助手单聊里出现符合条件的事件。 */
async function waitEvents(hob: TestHob, predicate: (lines: string[]) => boolean): Promise<string[]> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const lines = await events(hob);
    if (predicate(lines)) return lines;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等到超时");
}

/** 主助手单聊里先说几句，给「最近的对话」用。 */
async function seedChat(hob: TestHob, lines: string[]): Promise<void> {
  hob.faux.setResponses(lines.map((line) => text(line)));
  for (const line of lines) {
    await hob.runtime.router.send("hob", { text: line });
    await hob.runtime.router.waitIdle("hob");
  }
}

describe("message_group", () => {
  it("非主助手交接时，综合提示使用交接方的名字", () => {
    const { hob, group } = setup();
    try {
      const { topic } = hob.runtime.groups.handOver(group.id, "打印机连不上", "ops", { text: "请检查打印机", files: [] });
      expect(topic.handover).toMatchObject({ by: "ops" });
      expect(hob.runtime.store.groupItems(group.id).find((item) => item.kind === "note" && item.text === "服务器 已将「打印机连不上」交由这个群处理")).toMatchObject({ speaker: "ops" });
    } finally {
      hob.close();
    }
  });

  it("把原话和前面几句交给群：开话题、转来的条目、群主那一轮、话题卡、综合那一行", async () => {
    const { hob, group } = setup();
    try {
      await seedChat(hob, ["先看下日报", "再看下这张图"]);
      hob.faux.setResponses([text("接手了")]);
      const result = await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "相册备份出错", note: "备份目录在 /vol/photo" });
      expect(isError(result)).toBe(false);
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      expect(textOf(result)).toBe(`已交给群「家里机器」：创建了话题「相册备份出错」（${topic.id}），群主「服务器」接手。有了结论会回到这里。`);
      expect(result).toMatchObject({ terminate: true });

      // 话题（群记录）上记着是主助手交来的
      expect(hob.runtime.store.group(topic.id)?.handover).toMatchObject({ by: "hob" });
      expect(hob.runtime.store.group(topic.id)?.handover?.at).toBeTruthy();

      // 第一条是转来的原话：用户原话 + 前面几句 + 备注，附件跟着带上
      const forwarded = hob.runtime.store.groupItems(topic.id).find((item) => item.kind === "user")!;
      expect(forwarded).toMatchObject({ speaker: "user", forwardedFrom: { assistantId: "hob" } });
      expect(forwarded.kind === "user" ? forwarded.text : "").toBe("备份目录在 /vol/photo");

      // 群主在话题里开了一轮，先看到转来的原话，再看到这条系统消息
      await waitFor(() => inputBody(hob, topic.id, "ops").includes("[hob-event]"));
      const body = inputBody(hob, topic.id, "ops");
      expect(body).toContain("备份目录在 /vol/photo");
      expect(body).toContain("[hob-event] 这个话题是 Hob 交给这个群的，上面是 Hob 写的交接说明。完成后用 close_topic 写结论，结论会转给 Hob，由它告诉用户。");

      // 主助手的对话里有话题卡；群的综合里有那一行
      expect(hob.runtime.router.items("hob").items.find((item) => item.kind === "topic" && item.topicId === topic.id)).toBeTruthy();
      expect(hob.runtime.store.groupItems(group.id).find((item) => item.kind === "note" && item.text === "Hob 已将「相册备份出错」交由这个群处理")).toMatchObject({ speaker: "hob" });
    } finally {
      hob.close();
    }
  });

  it("交给群时附件也带过去", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("看"), text("好"), text("接手了")]);
      await hob.runtime.router.send("hob", { text: "看这张截图" });
      await hob.runtime.router.waitIdle("hob");
      await hob.runtime.router.send("hob", { text: "列表页错位，见截图", files: ["/tmp/截图.png"] });
      await hob.runtime.router.waitIdle("hob");
      const result = await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "列表错位", note: "请检查列表页错位。", files: ["/tmp/截图.png"] });
      expect(isError(result)).toBe(false);
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      const forwarded = hob.runtime.store.groupItems(topic.id).find((item) => item.kind === "user")!;
      expect(forwarded).toMatchObject({ files: ["/tmp/截图.png"] });
    } finally {
      hob.close();
    }
  });

  it("报错：群不存在、填的是话题、就在这个群里、title 空或太长、备注超上限", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "打印机连不上", "user");
      const missing = await toolOf(hob, "message_group").execute("c", { groupId: "g-none", title: "做事" });
      expect(isError(missing)).toBe(true);
      expect(textOf(missing)).toContain("没有这个群：g-none。现有的群：");
      expect(textOf(missing)).toContain(`家里机器（${group.id}）`);

      const asTopic = await toolOf(hob, "message_group").execute("c", { groupId: topic.id, title: "做事" });
      expect(isError(asTopic)).toBe(true);
      expect(textOf(asTopic)).toBe(`${topic.id} 是话题，不是群：groupId 填群 id，会在群里创建一个新话题。`);

      const here = await toolOf(hob, "message_group", group.id).execute("c", { groupId: group.id, title: "做事" });
      expect(isError(here)).toBe(true);
      expect(textOf(here)).toBe("你就在群「家里机器」里，不用交给它。");

      const empty = await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "  " });
      expect(isError(empty)).toBe(true);
      expect(textOf(empty)).toBe("title 不能为空：写这件事，如「相册备份出错」。");

      const long = await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "字".repeat(41) });
      expect(isError(long)).toBe(true);
      expect(textOf(long)).toBe("title 最多 40 字，现在 41 字：写成一句话，如「相册备份出错」。");

      const note = await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "做事", note: "字".repeat(401) });
      expect(isError(note)).toBe(false);
      expect(textOf(note)).toContain("已交给群");
      const emptyNote = await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "做事", note: "  " });
      expect(isError(emptyNote)).toBe(true);
      expect(textOf(emptyNote)).toBe("note 不能为空：写清交接说明后再调用一次。");

      // 报错之后什么都没开
      expect(hob.runtime.groups.topicsOf(group.id)).toHaveLength(2);
    } finally {
      hob.close();
    }
  });

  it("主助手建群时当群主：话题里的群主会话是主助手，能列待办、关话题，结论回到单聊", async () => {
    const { hob, group } = setup();
    try {
      await seedChat(hob, ["报销这件事要走群里", "两个人的活"]);
      // 综合里先放几条别的话：交给群时不能把它们当成原话转过去
      appendUser(hob, group.id, "综合里聊的是别的事：打印机换墨盒", "g-901");
      appendUser(hob, group.id, "还有，周五下午不在", "g-902");
      hob.faux.setResponses([text("接手了"), text("写完了"), text("收到结论")]);
      const created = await toolOf(hob, "create_group").execute("c", { name: "票据小组", purpose: "整理票据", members: ["hob", "write"], ownerId: "hob" });
      expect(isError(created)).toBe(false);
      const target = hob.runtime.store.groups().find((item) => item.name === "票据小组")!;
      expect(target).toMatchObject({ ownerId: "hob", members: ["hob", "write"] });

      await hob.runtime.router.send("hob", { text: "把这两张票据整理成一张表" });
      await hob.runtime.router.waitIdle("hob");
      const result = await toolOf(hob, "message_group").execute("c", { groupId: target.id, title: "整理票据", note: "把两张票据整理成一张表。" });
      expect(isError(result)).toBe(false);
      const topic = hob.runtime.groups.topicsOf(target.id)[0]!;

      // 转进话题的是单聊里的原话和前面几句，不是综合里那几条
      const forwarded = hob.runtime.store.groupItems(topic.id).find((item) => item.kind === "user")!;
      const forwardedText = forwarded.kind === "user" ? forwarded.text : "";
      expect(forwardedText).toBe("把两张票据整理成一张表。");

      // 群主会话是主助手：话题里能关话题
      const tools = buildRouterTools(hob.runtime, "hob", topic.id).map((item) => item.name);
      expect(tools).toContain("close_topic");
      await waitFor(() => inputBody(hob, topic.id, "hob").includes("[hob-event]"));

      const close = buildRouterTools(hob.runtime, "hob", topic.id).find((item) => item.name === "close_topic")!;
      const closed = await close.execute("c", { note: "整理成了一列，缺一张等用户补" });
      expect(isError(closed)).toBe(false);

      const lines = await waitEvents(hob, (all) => all.some((line) => line.includes("交给群「票据小组」的话题「整理票据」关了")));
      expect(lines.find((line) => line.includes("交给群「票据小组」"))).toContain("结论：整理成了一列，缺一张等用户补");
      await hob.runtime.router.waitIdle("hob");
    } finally {
      hob.close();
    }
  });
});

describe("话题的结论回到主助手", () => {
  it("群主带结论关：主助手收到写了结论的那条；关了的再开再关不再送", async () => {
    const { hob, group } = setup();
    try {
      await seedChat(hob, ["整理一下票据"]);
      hob.faux.setResponses([text("接手了"), text("收到结论")]);
      await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "整理票据", note: "请整理票据并回报结论。" });
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      await waitFor(() => inputBody(hob, topic.id, "ops").includes("[hob-event]"));

      const close = buildRouterTools(hob.runtime, "ops", topic.id).find((item) => item.name === "close_topic")!;
      expect(isError(await close.execute("c", { note: "整理成 6 行，合计 1224.50" }))).toBe(false);
      const lines = await waitEvents(hob, (all) => all.length > 0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("交给群「家里机器」的话题「整理票据」关了。结论：整理成 6 行，合计 1224.50");
      // 送到的标记在主助手那一轮跑完才记（handoverResult 等这一轮），事件进会话时还没有
      await waitFor(() => Boolean(hob.runtime.store.group(topic.id)?.handover?.deliveredAt));
      expect(hob.runtime.store.group(topic.id)?.handover).toMatchObject({ result: expect.any(String), deliveredAt: expect.any(String) });
      await hob.runtime.router.waitIdle("hob");

      // 重新打开再关：不再送
      hob.runtime.groups.reopen(topic.id);
      expect(isError(await close.execute("c", { note: "又关了" }))).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await events(hob)).toHaveLength(1);
    } finally {
      hob.close();
    }
  });

  it("用户在界面上不写结论关：收到另一条", async () => {
    const { hob, group } = setup();
    try {
      await seedChat(hob, ["整理一下票据"]);
      hob.faux.setResponses([text("接手了"), text("收到结论")]);
      await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "整理票据", note: "请整理票据并回报结论。" });
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      await waitFor(() => inputBody(hob, topic.id, "ops").includes("[hob-event]"));

      hob.runtime.groups.closeByUser(topic.id, "");
      const lines = await waitEvents(hob, (all) => all.length > 0);
      expect(lines[0]).toContain("交给群「家里机器」的话题「整理票据」被用户关了，没有写结论。");
      await hob.runtime.router.waitIdle("hob");
    } finally {
      hob.close();
    }
  });

  it("用户写了结论关：收到带结论的那条", async () => {
    const { hob, group } = setup();
    try {
      await seedChat(hob, ["整理一下票据"]);
      hob.faux.setResponses([text("接手了"), text("收到结论")]);
      await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "整理票据", note: "请整理票据并回报结论。" });
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      await waitFor(() => inputBody(hob, topic.id, "ops").includes("[hob-event]"));
      hob.runtime.groups.closeByUser(topic.id, "我自己弄好了");
      const lines = await waitEvents(hob, (all) => all.length > 0);
      expect(lines[0]).toContain("交给群「家里机器」的话题「整理票据」关了。结论：我自己弄好了");
      await hob.runtime.router.waitIdle("hob");
    } finally {
      hob.close();
    }
  });

  it("主助手的会话出错时先记下，恢复后补送一次，不重复", async () => {
    const { hob, group } = setup();
    try {
      await seedChat(hob, ["整理一下票据"]);
      hob.faux.setResponses([text("接手了"), text("收到结论")]);
      await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "整理票据", note: "请整理票据并回报结论。" });
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      await waitFor(() => inputBody(hob, topic.id, "ops").includes("[hob-event]"));

      const ensure = vi.spyOn(hob.runtime.router, "ensure").mockRejectedValueOnce(new Error("模型不可用"));
      hob.runtime.groups.closeByUser(topic.id, "办完了");
      await waitFor(() => ensure.mock.calls.length > 0);
      expect(hob.runtime.store.group(topic.id)?.handover).toMatchObject({ result: expect.stringContaining("办完了") });
      expect(hob.runtime.store.group(topic.id)?.handover?.deliveredAt).toBeUndefined();

      // 进程重启：补送（先把上一次投递收尾）
      ensure.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 50));
      hob.faux.setResponses([text("收到结论")]);
      hob.runtime.groups.recoverHandovers();
      await waitFor(() => Boolean(hob.runtime.store.group(topic.id)?.handover?.deliveredAt));
      await hob.runtime.router.waitIdle("hob");
      expect((await events(hob)).filter((line) => line.includes("交给群「家里机器」"))).toHaveLength(1);

      // 已送过的再补一次也不重复（会话条目就是去重依据）
      const current = hob.runtime.store.group(topic.id)!;
      hob.runtime.store.saveGroup({ ...current, handover: { ...current.handover!, deliveredAt: undefined } });
      hob.runtime.groups.recoverHandovers();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await events(hob)).filter((line) => line.includes("交给群「家里机器」"))).toHaveLength(1);
    } finally {
      hob.close();
    }
  });

  it("主助手交来的话题，close_topic 不带 note 报错；别的话题照旧能不带 note 关", async () => {
    const { hob, group } = setup();
    try {
      await seedChat(hob, ["整理一下票据"]);
      hob.faux.setResponses([text("接手了")]);
      await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "整理票据", note: "请整理票据并回报结论。" });
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      await waitFor(() => inputBody(hob, topic.id, "ops").includes("[hob-event]"));
      const close = buildRouterTools(hob.runtime, "ops", topic.id).find((item) => item.name === "close_topic")!;
      const failed = await close.execute("c", {});
      expect(isError(failed)).toBe(true);
      expect(textOf(failed)).toBe("note 不能为空：这个话题是 Hob 交给这个群的，结论会转给 Hob，由它告诉用户；不做了的写明原因。");
      expect(hob.runtime.store.group(topic.id)?.closedAt).toBeUndefined();

      // 没列待办、也不是交来的话题：不带 note 照旧能关
      const plain = hob.runtime.groups.createTopic(group.id, "打印机连不上", "user");
      const plainClose = buildRouterTools(hob.runtime, "ops", plain.id).find((item) => item.name === "close_topic")!;
      expect(isError(await plainClose.execute("c", {}))).toBe(false);
      expect(hob.runtime.store.group(plain.id)?.closedAt).toBeTruthy();
    } finally {
      hob.close();
    }
  });
});

describe("message_assistant", () => {
  it("转过去的正文里带着前面几句对话", async () => {
    const { hob, group } = setup();
    try {
      void group;
      hob.faux.setResponses([text("一"), text("二"), text("三")]);
      for (const line of ["先把材料放到桌面", "标题按客户分开"]) {
        await hob.runtime.router.send("hob", { text: line });
        await hob.runtime.router.waitIdle("hob");
      }
      await hob.runtime.router.send("hob", { text: "把周报发出去" });
      await hob.runtime.router.waitIdle("hob");
      const result = await toolOf(hob, "message_assistant").execute("c", { assistantId: "write", note: "把周报发出去，并按客户分开标题。" });
      await waitFor(() => hob.runtime.store.delegations().length > 0);
      await hob.runtime.router.waitIdle("write");
      expect(isError(result)).toBe(false);
      const delegation = hob.runtime.store.delegations()[0]!;
      expect(delegation.text).toBe("把周报发出去，并按客户分开标题。");
    } finally {
      hob.close();
    }
  });
});

describe("主助手的提示词", () => {
  const settings = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };

  it("有群时「群」一节写负责什么，后面接交给群那一段", () => {
    const { hob } = setup();
    try {
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", settings);
      const group = hob.runtime.store.groups().find((item) => item.name === "家里机器")!;
      expect(prompt).toContain(`- 家里机器（${group.id}）：职责：机器上的事；群主 服务器；成员 Hob、服务器、写作`);
      expect(prompt).toContain("一件事要几个助手接力，又有管这类事的群，用 message_group 交给那个群：群里会创建一个话题，群主接手，按群里的分工安排成员，有了结论会回到你这里，这期间同一件事你这边不再另行分派。群里记着分工和本群的技能，成员在同一个话题里交接，彼此可以查看做到哪儿；一个个转给成员，这些都用不上。");
    } finally {
      hob.close();
    }
  });

  it("建群时挑群主那一段接在管理那一段后面", () => {
    const { hob } = setup();
    try {
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", settings);
      expect(prompt).toContain("创建群时选择最能统筹的当群主：群主接没点名的消息和群里的定时任务，安排成员，最后给用户结论，要知道这件事要完成什么、能够理解各个成员的任务。成员里有职责就是统筹这类事的，让它担任群主；成员各管一摊、没有谁能看到全局的，你自己进群当群主。");
      // 接在 ADMIN_LINE 后面
      const admin = "助手、群和话题，你都能直接创建和修改，和用户在界面上操作一样。用户要你修改的，直接修改，完成后说一句修改了什么。你自己觉得该修改的，比如同类的事反复出现又没有合适的助手管、某个群缺了该在的成员，先跟用户说你的想法，用户同意了再修改。归档助手和群、助手能用的能力（运行命令、修改文件、生成图片），由用户在界面上操作。";
      expect(prompt.indexOf(admin)).toBeGreaterThan(-1);
      expect(prompt.indexOf("创建群时选择最能统筹的当群主")).toBe(prompt.indexOf(admin) + admin.length + 1);
    } finally {
      hob.close();
    }
  });
});
