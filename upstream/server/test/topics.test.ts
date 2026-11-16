import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Approval, Assistant, Group, GroupItem, GroupSummary, Job } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { buildSystemPrompt, PROJECT_RECALL_LINE, TOPIC_OPEN_LINE, topicPromptLine } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { CLOSED_TOPIC_REASON, TOPIC_CLOSED, requestText } from "../src/groups.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const ISO = "2026-11-08T02:00:00.000Z";

function addAssistant(hob: TestHob, id: string, name: string, duty: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty, primary: false, pinned: false, sprite: "page", instructions: "" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

/** 三人群：Hob（群主）、服务器、写作。 */
function setup(): { hob: TestHob; group: Group } {
  const hob = makeHob({}, { memory: "off" });
  addAssistant(hob, "ops", "服务器", "机器");
  addAssistant(hob, "write", "写作", "周报");
  const group = hob.runtime.groups.create({
    name: "家里机器",
    purpose: "机器上的事",
    ownerId: "hob",
    members: ["hob", "ops", "write"],
  });
  return { hob, group };
}

const memberFile = (hob: TestHob, gid: string, assistantId: string) => hob.runtime.store.groupMemberFile(gid, assistantId);

/** 会话文件里的用户消息正文（成员收到的输入就是它）。 */
function userTexts(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
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
}

/** 会话输入的正文：去掉前面「现在时间」那段。 */
function inputBody(file: string): string {
  const last = userTexts(file).at(-1)!;
  return last.slice(last.indexOf("\n\n") + 2);
}

async function loggedIn(hob: TestHob) {
  const app = createApp(hob.runtime, { home: hob.home });
  const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const post = (path: string, body?: unknown) =>
    app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const patch = (path: string, body: unknown) => app.request(path, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: { cookie } });
  return { app, cookie, post, patch, get };
}

function toolOf(hob: TestHob, name: string, gid?: string) {
  const tool = buildRouterTools(hob.runtime, "hob", gid).find((item) => item.name === name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  return tool;
}

const textOf = (result: Awaited<ReturnType<ReturnType<typeof toolOf>["execute"]>>) => (result.content[0] as { text: string }).text;
const isError = (result: { isError?: boolean }) => Boolean(result.isError);

function prompt(hob: TestHob, assistantId: string, group: Group): string {
  return buildSystemPrompt(hob.runtime.store, assistantId, {
    timezone: "Asia/Shanghai",
    aboutYou: { name: "", language: "", notes: "" },
    memory: "off",
    group,
  });
}

/** 综合里的一条用户消息：不经过模型，直接写进时间线。 */
function appendUser(hob: TestHob, gid: string, text: string): GroupItem {
  const item: GroupItem = { kind: "user", speaker: "user", id: "g-901", at: ISO, text };
  hob.runtime.store.appendGroupItem(gid, item);
  return item;
}

function job(patch: Partial<Job> & Pick<Job, "id" | "assistantId">): Job {
  return {
    title: "做待办",
    instruction: "",
    status: "running",
    createdAt: ISO,
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
    ...patch,
  };
}

describe("话题的存储", () => {
  it("话题读出来带所属群的成员、群主和负责什么；群改了话题跟着变，group.json 里没有这些字段", () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");
      expect(topic).toMatchObject({
        name: "相册备份出错",
        parentId: group.id,
        createdBy: "user",
        members: group.members,
        ownerId: "hob",
        purpose: group.purpose,
      });

      // 群改了成员、换了群主：话题读到的跟着变
      hob.runtime.groups.update(group.id, { members: ["hob", "ops"], ownerId: "ops" });
      expect(hob.runtime.store.group(topic.id)).toMatchObject({ members: ["hob", "ops"], ownerId: "ops" });

      // group.json 里只有话题自己的字段
      const raw = JSON.parse(readFileSync(join(hob.home, "groups", topic.id, "group.json"), "utf8")) as Record<string, unknown>;
      expect(raw).toMatchObject({ id: topic.id, parentId: group.id, name: "相册备份出错", createdBy: "user" });
      for (const key of ["members", "ownerId", "purpose", "workflow"]) expect(raw[key], key).toBeUndefined();
      // 群那边照旧存着这些
      expect(JSON.parse(readFileSync(join(hob.home, "groups", group.id, "group.json"), "utf8"))).toMatchObject({ ownerId: "ops", members: ["hob", "ops"] });
    } finally {
      hob.close();
    }
  });
  it("旧群文件的 workflow 读改名保存；接口带旧字段，新群文件不写回", async () => {
    const { hob, group } = setup();
    try {
      const file = join(hob.home, "groups", group.id, "group.json");
      const original = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...original, workflow: "software" }) + "\n");
      expect(hob.runtime.store.group(group.id)?.workflow).toBe("software");
      hob.runtime.groups.update(group.id, { name: "改过名字" });
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ name: "改过名字", workflow: "software" });

      const { app, cookie } = await loggedIn(hob);
      const created = await app.request("/api/groups", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "接口兼容", purpose: "测试", ownerId: "hob", members: ["hob"], workflow: "software" }) });
      expect(created.status).toBe(201);
      const newGroup = (await created.json()) as Group;
      const newFile = JSON.parse(readFileSync(join(hob.home, "groups", newGroup.id, "group.json"), "utf8")) as Record<string, unknown>;
      expect(newFile.workflow).toBeUndefined();
    } finally { hob.close(); }
  });
});

describe("话题的接口", () => {
  it("用户开话题：综合里落一张话题卡，返回 201；不能在话题里再开话题，建群也不接受 parentId", async () => {
    const { hob, group } = setup();
    try {
      const { post } = await loggedIn(hob);
      const created = await post(`/api/groups/${group.id}/topics`, { title: "相册备份出错" });
      expect(created.status).toBe(201);
      const topic = (await created.json()) as Group;
      expect(topic).toMatchObject({ name: "相册备份出错", parentId: group.id, createdBy: "user" });
      expect(hob.runtime.store.groupItems(group.id).find((item) => item.kind === "topic")).toMatchObject({ speaker: "user", topicId: topic.id });

      const nested = await post(`/api/groups/${topic.id}/topics`, { title: "再开一个" });
      expect(nested.status).toBe(400);
      expect(await nested.json()).toMatchObject({ error: "话题挂在群下面：话题里不能再开话题。" });

      expect((await post(`/api/groups/${group.id}/topics`, { title: "  " })).status).toBe(400);
      expect((await post(`/api/groups/${group.id}/topics`, { title: "字".repeat(41) })).status).toBe(400);

      const asGroup = await post("/api/groups", { name: "x", purpose: "y", ownerId: "hob", members: ["hob"], parentId: group.id });
      expect(asGroup.status).toBe(400);
    } finally {
      hob.close();
    }
  });

  it("关闭、重新打开；关了以后发消息回 400，文字照票上写的", async () => {
    const { hob, group } = setup();
    try {
      const { post } = await loggedIn(hob);
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");

      const closed = await post(`/api/groups/${topic.id}/close`, { note: "办完了" });
      expect(closed.status).toBe(200);
      expect((await closed.json()) as Group).toMatchObject({ closeNote: "办完了" });
      expect(hob.runtime.store.group(topic.id)?.closedAt).toBeTruthy();

      const sent = await post(`/api/groups/${topic.id}/messages`, { text: "还在吗" });
      expect(sent.status).toBe(400);
      expect(await sent.json()).toMatchObject({ error: TOPIC_CLOSED });

      const reopened = await post(`/api/groups/${topic.id}/reopen`);
      expect(reopened.status).toBe(200);
      expect((await reopened.json()) as Group).toMatchObject({ name: "相册备份出错" });
      expect(hob.runtime.store.group(topic.id)?.closedAt).toBeUndefined();
      expect(hob.runtime.store.group(topic.id)?.closeNote).toBeUndefined();

      hob.faux.setResponses([text("收到")]);
      expect((await post(`/api/groups/${topic.id}/messages`, { text: "还在吗" })).status).toBe(202);
      await waitFor(() => hob.runtime.groups.summary(topic.id).busy.length === 0);

      // 群不走关闭：群用归档
      expect((await post(`/api/groups/${group.id}/close`, {})).status).toBe(400);
    } finally {
      hob.close();
    }
  });

  it("关闭话题：记录用户给的结论", async () => {
    const { hob, group } = setup();
    try {
      const { post } = await loggedIn(hob);
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");

      expect((await post(`/api/groups/${topic.id}/close`, { note: "先不弄了" })).status).toBe(200);
      expect(hob.runtime.store.group(topic.id)).toMatchObject({ closeNote: "先不弄了" });
    } finally {
      hob.close();
    }
  });

  it("PATCH：话题只能改名；旧字段忽略；有无关字段也不影响", async () => {
    const { hob, group } = setup();
    try {
      const { patch, post } = await loggedIn(hob);
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");

      const renamed = await patch(`/api/groups/${topic.id}`, { name: "相册备份好了" });
      expect(renamed.status).toBe(200);
      expect((await renamed.json()) as Group).toMatchObject({ name: "相册备份好了" });

      for (const body of [{ members: ["hob"] }, { ownerId: "ops" }, { purpose: "别的事" }]) {
        const result = await patch(`/api/groups/${topic.id}`, body);
        expect(result.status, JSON.stringify(body)).toBe(400);
        expect(await result.json()).toMatchObject({ error: "话题的成员、群主、负责什么跟着所属的群，在群里改" });
      }

    } finally { hob.close(); }
  });
  it("开新话题：综合里有话题卡，话题里有带 forwardedFrom 的用户消息，群主在话题里开了一轮", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([call("open_topic", { title: "相册备份出错", note: "备份目录是 /vol/photo" }), text("看到了，接着说")]);
      await hob.runtime.groups.send(group.id, { text: "相册备份一直报错", files: ["/tmp/截图.png"] });
      await waitFor(() => hob.runtime.groups.topicsOf(group.id).length === 1);
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      await waitFor(() => hob.runtime.store.groupItems(topic.id).some((item) => item.kind === "assistant"));
      await waitFor(() => hob.runtime.groups.summary(topic.id).busy.length === 0);

      // 综合里：话题卡是群主落的，这一轮没有别的话
      expect(hob.runtime.store.groupItems(group.id).find((item) => item.kind === "topic")).toMatchObject({ speaker: "hob", topicId: topic.id });
      expect(hob.runtime.store.groupItems(group.id).filter((item) => item.kind === "assistant")).toHaveLength(0);
      expect(topic).toMatchObject({ name: "相册备份出错", createdBy: "hob", parentId: group.id });

      // 话题里：用户的原话和附件原样转过去，记着从哪来
      const forwarded = hob.runtime.store.groupItems(topic.id).find((item) => item.kind === "user")!;
      expect(forwarded).toMatchObject({ speaker: "user", text: "相册备份一直报错", files: ["/tmp/截图.png"], forwardedFrom: { groupId: group.id } });

      // 话题里那一轮的输入：先是用户原话，再是事件（带综合里前面几句）和备注
      expect(inputBody(memberFile(hob, topic.id, "hob")).split("\n\n")).toEqual([
        "用户：相册备份一直报错（附件：/tmp/截图.png）",
        "[hob-event] 这个话题是你从综合开的，上面是用户在综合里的原话。",
        expect.stringMatching(/^用户原话（[^）]*，在群「家里机器」里）：\n相册备份一直报错$/),
        "附件：/tmp/截图.png",
        "Hob 的备注：备份目录是 /vol/photo",
      ]);
    } finally {
      hob.close();
    }
  });

  it("开话题：交给群主的那条带着综合里前面几句，转进话题的只有触发的那一条", async () => {
    const { hob, group } = setup();
    try {
      // 综合里先说两句，再交代要办的事
      hob.faux.setResponses([text("先记一下"), call("open_topic", { title: "相册备份" }), text("我来安排")]);
      await hob.runtime.groups.send(group.id, { text: "这周整理相册" });
      await waitFor(() => hob.runtime.store.groupItems(group.id).some((item) => item.kind === "assistant" && item.text === "先记一下"));
      const delivered: string[] = [];
      const deliver = hob.runtime.groups.deliverEvent.bind(hob.runtime.groups);
      hob.runtime.groups.deliverEvent = async (gid, _aid, words, trigger) => {
        if (hob.runtime.store.group(gid)?.parentId) delivered.push(words);
        else await deliver(gid, _aid, words, trigger);
      };
      await hob.runtime.groups.send(group.id, { text: "相册备份一直报错", files: ["/tmp/截图.png"] });
      await waitFor(() => hob.runtime.groups.topicsOf(group.id).length === 1);
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;

      // 事件：来由的原文 + 综合里前面那一句
      expect(delivered.at(-1)).toContain("最近的对话：");
      expect(delivered.at(-1)).toContain("这周整理相册");
      expect(delivered.at(-1)).toContain("相册备份一直报错");

      // 话题里只转进触发这一轮的那一条，前面那句不当条目转过去
      const carried = hob.runtime.store.groupItems(topic.id).filter((item) => item.kind === "user");
      expect(carried).toHaveLength(1);
      expect(carried[0]).toMatchObject({ text: "相册备份一直报错", files: ["/tmp/截图.png"] });
      expect(hob.runtime.store.groupItems(topic.id).some((item) => item.text.includes("这周整理相册"))).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("转到已有的、关了的话题：重新打开，综合里有那行 note，事件文字对", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "打印机连不上", "user");
      hob.runtime.groups.closeByUser(topic.id, "先不弄了");
      expect(hob.runtime.store.group(topic.id)?.closedAt).toBeTruthy();
      appendUser(hob, group.id, "打印机又连不上了");

      hob.faux.setResponses([text("接着办")]);
      const result = await toolOf(hob, "open_topic", group.id).execute("c", { topic: topic.id });
      expect(isError(result)).toBe(false);
      expect(textOf(result)).toBe(`已转到话题「打印机连不上」（${topic.id}），接下来在话题里办。`);
      expect(hob.runtime.store.group(topic.id)?.closedAt).toBeUndefined();
      expect(hob.runtime.store.groupItems(group.id).find((item) => item.kind === "note" && item.text.startsWith("转到了话题"))).toMatchObject({
        speaker: "hob",
        text: "转到了话题「打印机连不上」",
      });
      await waitFor(() => userTexts(memberFile(hob, topic.id, "hob")).length > 0);
      const body = inputBody(memberFile(hob, topic.id, "hob"));
      expect(body).toContain("[hob-event] 上面是用户在综合里的原话。");
      expect(body).toMatch(/用户原话（[^）]*，在群「家里机器」里）：\n打印机又连不上了/);
    } finally {
      hob.close();
    }
  });

  it("综合的时间线把话题卡写成一行：谁开的就写谁", async () => {
    const { hob, group } = setup();
    try {
      hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");
      hob.faux.setResponses([text("看到话题了")]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 顺便看下相册备份" });
      await waitFor(() => userTexts(memberFile(hob, group.id, "ops")).length > 0);
      expect(inputBody(memberFile(hob, group.id, "ops")).split("\n")).toContain("用户：开了话题「相册备份出错」");
    } finally {
      hob.close();
    }
  });

  it("用错时说清怎么改", async () => {
    const { hob, group } = setup();
    try {
      appendUser(hob, group.id, "相册备份一直报错");
      const other = hob.runtime.groups.create({ name: "别的群", purpose: "别的事", ownerId: "hob", members: ["hob", "ops"] });
      const elsewhere = hob.runtime.groups.createTopic(other.id, "别的话题", "user");
      const active = hob.runtime.groups.createTopic(group.id, "打印机连不上", "user");
      const tool = toolOf(hob, "open_topic", group.id);

      const both = await tool.execute("c", { title: "相册备份出错", topic: active.id });
      expect(isError(both)).toBe(true);
      expect(textOf(both)).toContain("只能填一个");
      const neither = await tool.execute("c", {});
      expect(textOf(neither)).toContain("要填一个");
      const long = await tool.execute("c", { title: "字".repeat(41) });
      expect(textOf(long)).toContain("title 最多 40 字");
      const foreign = await tool.execute("c", { topic: elsewhere.id });
      expect(isError(foreign)).toBe(true);
      expect(textOf(foreign)).toContain("不是这个群的话题");
      expect(textOf(foreign)).toContain("打印机连不上");
      expect(textOf(foreign)).not.toContain("别的话题");
    } finally {
      hob.close();
    }
  });
});

describe("close_topic：结论", () => {
  it("没有 note 的话题也能关闭", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "直接结束", "user");
      const result = await toolOf(hob, "close_topic", topic.id).execute("c", {});
      expect(isError(result)).toBe(false);
      expect(hob.runtime.store.group(topic.id)?.closedAt).toBeTruthy();
    } finally { hob.close(); }
  });
});

describe("工具和提示词按话题会话分开", () => {
  it("普通群：群主有开话题和关闭话题工具，人人都有 update_todos", () => {
    const { hob, group } = setup();
    try {
      const names = buildRouterTools(hob.runtime, "hob", group.id).map((tool) => tool.name);
      expect(names).toContain("open_topic");
      expect(names).toContain("close_topic");
      expect(names).toContain("update_todos");
      for (const name of ["write_brief", "plan_todos", "start_todos"]) expect(names).not.toContain(name);

      const shown = prompt(hob, "hob", group);
      expect(shown).toContain(TOPIC_OPEN_LINE);
      expect(shown).not.toContain("## 这个群的话题");
      // 成员没有开话题的工具，但有 update_todos
      const member = buildRouterTools(hob.runtime, "ops", group.id).map((tool) => tool.name);
      expect(member).not.toContain("open_topic");
      expect(member).toContain("update_todos");
    } finally {
      hob.close();
    }
  });

  it("综合会话有开话题那段和话题清单；话题会话有开头那段、没有开话题那段、也没有 open_topic", () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");
      const overview = prompt(hob, "hob", group, []);
      expect(overview).toContain(TOPIC_OPEN_LINE);
      expect(overview).toContain("## 这个群的话题");
      expect(overview).toContain(`- 「相册备份出错」（${topic.id}）· 进行中 · `);
      expect(overview).toContain(PROJECT_RECALL_LINE);

      const inside = prompt(hob, "hob", topic);
      expect(inside).toContain(topicPromptLine(group.name, topic.name));
      expect(inside).toContain(`你在群「${group.name}」里`);
      expect(inside).not.toContain(TOPIC_OPEN_LINE);
      expect(inside).not.toContain("## 这个群的话题");
      // 群主的工具：话题里有 open_topic，close_topic 照旧
      const names = buildRouterTools(hob.runtime, "hob", topic.id).map((tool) => tool.name);
      expect(names).not.toContain("open_topic");
      expect(names).toContain("close_topic");

      // 成员在话题里也有开头那段，没有群主那两段
      const member = prompt(hob, "ops", topic);
      expect(member).toContain(topicPromptLine(group.name, topic.name));
      expect(member).not.toContain(TOPIC_OPEN_LINE);
    } finally {
      hob.close();
    }
  });

});

describe("交接：来由只从 requestItem 取", () => {
  const routineOf = (hob: TestHob, group: Group) => hob.runtime.routines.create({
    assistantId: "hob",
    groupId: group.id,
    name: "看 PR",
    instruction: "看看有没有新 PR",
    schedules: ["0 9 * * *"],
  });
  const fullText = "定时任务「看 PR」到点了，要做的事：看看有没有新 PR";

  it("定时到点的记录带着交给群主的全文，转进话题以后还在", async () => {
    const { hob, group } = setup();
    try {
      const routine = routineOf(hob, group);
      const delivered: { gid: string; text: string; trigger?: string }[] = [];
      hob.runtime.groups.deliverEvent = async (gid, _aid, text, trigger) => { delivered.push({ gid, text, trigger }); };
      expect(await hob.runtime.routines.runNow(routine.id)).toMatchObject({ outcome: "handed" });

      const note = hob.runtime.store.groupItems(group.id).find((item) => item.kind === "note" && item.icon === "routine")!;
      expect(note).toMatchObject({ text: "定时任务「看 PR」到点了", request: fullText });
      expect(delivered[0]).toMatchObject({ gid: group.id, trigger: note.id, text: fullText });

      // 事件回合（时间线上最近一条是定时记录）：取到的是它
      expect(hob.runtime.groups.requestItem(group.id, "hob")?.id).toBe(note.id);

      // 转进话题：记着从哪来，全文还在
      hob.faux.setResponses([text("看到了")]);
      await toolOf(hob, "open_topic", group.id).execute("c", { title: "回 PR" });
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      const forwarded = hob.runtime.store.groupItems(topic.id).find((item) => item.kind === "note")!;
      expect(forwarded).toMatchObject({ request: fullText, forwardedFrom: { groupId: group.id, itemId: note.id } });

      // 话题里这一轮没在跑时，取到的也是它
      const request = hob.runtime.groups.requestItem(topic.id, "hob")!;
      expect(request.id).toBe(forwarded.id);
      expect(requestText(request)).toBe(fullText);
    } finally { hob.close(); }
  });

  it("定时触发的回合：转进话题的是到点的记录，不是更早的用户消息", async () => {
    const { hob, group } = setup();
    try {
      appendUser(hob, group.id, "昨天的旧消息");
      const routine = routineOf(hob, group);
      hob.faux.setResponses([call("open_topic", { title: "回 PR" }), text("接着办")]);
      await hob.runtime.routines.runNow(routine.id);
      await waitFor(() => hob.runtime.groups.topicsOf(group.id).length === 1);
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      expect(hob.runtime.store.groupItems(topic.id).some((item) => item.kind === "user")).toBe(false);
      await waitFor(() => userTexts(memberFile(hob, topic.id, "hob")).length > 0);
      expect(inputBody(memberFile(hob, topic.id, "hob"))).toMatch(/上面是定时任务到点的记录。\n\n定时任务到点的记录（[^）]*，在群「家里机器」里）：\n定时任务「看 PR」到点了，要做的事：看看有没有新 PR/);
      // 定时来由不带前面几句对话
      expect(inputBody(memberFile(hob, topic.id, "hob"))).not.toContain("最近的对话");
      expect(inputBody(memberFile(hob, topic.id, "hob"))).not.toContain("昨天的旧消息");
    } finally { hob.close(); }
  });

  it("定时触发的 open_topic：返回说交给了话题，事件带全文", async () => {
    const { hob, group } = setup();
    try {
      const routine = routineOf(hob, group);
      const delivered: string[] = [];
      hob.runtime.groups.deliverEvent = async (_gid, _aid, text) => { delivered.push(text); };
      await hob.runtime.routines.runNow(routine.id);
      const result = await toolOf(hob, "open_topic", group.id).execute("c", { title: "回 PR", note: "先看标题" });
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      expect(textOf(result)).toBe(`话题「回 PR」（${topic.id}）已开，定时任务到点的记录已转过去，话题里的你已经接手，这一件在综合里不用再管。这次定时查到的其他条目，接着按分量办；都安排完了，在综合里说一句这次各是怎么安排的。`);
      expect(delivered.at(-1)).toMatch(/^这个话题是你从综合开的，上面是定时任务到点的记录。\n\n定时任务到点的记录（[^）]*，在群「家里机器」里）：\n定时任务「看 PR」到点了，要做的事：看看有没有新 PR\n\nHob 的备注：先看标题$/);

      // 转到已有话题：事件第一句换成「上面是…」
      await hob.runtime.routines.runNow(routine.id);
      await toolOf(hob, "open_topic", group.id).execute("c2", { topic: topic.id, note: "再看一次" });
      expect(delivered.at(-1)).toMatch(/^上面是定时任务到点的记录。\n\n定时任务到点的记录（[^）]*，在群「家里机器」里）：\n定时任务「看 PR」到点了，要做的事：看看有没有新 PR\n\nHob 的备注：再看一次$/);
    } finally { hob.close(); }
  });


});
