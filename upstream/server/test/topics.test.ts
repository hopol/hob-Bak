import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Approval, Assistant, Group, GroupItem, GroupSummary, Job, Project } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { buildSystemPrompt, PROJECT_OPEN_LINE, PROJECT_RECALL_LINE, TOPIC_OPEN_LINE, topicPromptLine } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { CLOSED_TOPIC_REASON, TOPIC_CLOSED } from "../src/groups.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const ISO = "2026-11-08T02:00:00.000Z";

function addAssistant(hob: TestHob, id: string, name: string, duty: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty, primary: false, pinned: false, sprite: "page", instructions: "" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

/** 三人群：Hob（群主）、服务器、写作。默认是「软件开发」。 */
function setup(workflow?: "none"): { hob: TestHob; group: Group } {
  const hob = makeHob({}, { memory: "off" });
  addAssistant(hob, "ops", "服务器", "机器");
  addAssistant(hob, "write", "写作", "周报");
  const group = hob.runtime.groups.create({
    name: "家里机器",
    purpose: "机器上的事",
    ownerId: "hob",
    members: ["hob", "ops", "write"],
    ...(workflow === "none" ? {} : { workflow: "software" }),
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

function prompt(hob: TestHob, assistantId: string, group: Group, projects?: Project[]): string {
  return buildSystemPrompt(hob.runtime.store, assistantId, {
    timezone: "Asia/Shanghai",
    aboutYou: { name: "", language: "", notes: "" },
    memory: "off",
    group,
    ...(projects ? { projects } : {}),
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
    title: "做子任务",
    instruction: "",
    status: "running",
    createdAt: ISO,
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
    ...patch,
  };
}

describe("话题的存储", () => {
  it("话题读出来带所属群的成员、群主、负责什么和工作方式；群改了话题跟着变，group.json 里没有这些字段", () => {
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
        workflow: "software",
      });

      // 群改了成员、换了群主：话题读到的跟着变
      hob.runtime.groups.update(group.id, { members: ["hob", "ops"], ownerId: "ops" });
      expect(hob.runtime.store.group(topic.id)).toMatchObject({ members: ["hob", "ops"], ownerId: "ops" });

      // group.json 里只有话题自己的字段
      const raw = JSON.parse(readFileSync(join(hob.home, "groups", topic.id, "group.json"), "utf8")) as Record<string, unknown>;
      expect(raw).toMatchObject({ id: topic.id, parentId: group.id, name: "相册备份出错", createdBy: "user" });
      for (const key of ["members", "ownerId", "purpose", "workflow"]) expect(raw[key], key).toBeUndefined();
      // 群那边照旧存着这些
      expect(JSON.parse(readFileSync(join(hob.home, "groups", group.id, "group.json"), "utf8"))).toMatchObject({ ownerId: "ops", members: ["hob", "ops"], workflow: "software" });
    } finally {
      hob.close();
    }
  });
  it("群成员、群主和工作方式变化后，下一轮在群和话题里使用新的权限", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");
      const single = (await hob.runtime.router.ensure("ops")).session;
      const turn = async (gid: string, message: string) => {
        hob.faux.setResponses([text("收到")]);
        await hob.runtime.groups.send(gid, { text: message });
        await waitFor(() => hob.runtime.groups.summary(gid).busy.length === 0);
      };
      for (const gid of [group.id, topic.id]) {
        await turn(gid, "先看一下");
        expect((await hob.runtime.router.ensure("hob", gid)).session!.getActiveToolNames()).toContain("open_project");
        await turn(gid, "@写作 看一下");
      }
      hob.runtime.groups.update(group.id, { members: ["hob", "ops"] });
      for (const gid of [group.id, topic.id]) {
        const before = userTexts(memberFile(hob, gid, "write")).length;
        await turn(gid, "@写作 再看一下");
        expect(userTexts(memberFile(hob, gid, "write"))).toHaveLength(before);
      }
      hob.runtime.groups.update(group.id, { ownerId: "ops" });
      for (const gid of [group.id, topic.id]) {
        await turn(gid, "现在请群主处理");
        expect((await hob.runtime.router.ensure("ops", gid)).session!.getActiveToolNames()).toContain("open_project");
        await turn(gid, "@Hob 也看看");
        expect((await hob.runtime.router.ensure("hob", gid)).session!.getActiveToolNames()).not.toContain("open_project");
      }
      hob.runtime.groups.update(group.id, { workflow: null });
      for (const gid of [group.id, topic.id]) {
        await turn(gid, "再请群主处理");
        expect((await hob.runtime.router.ensure("ops", gid)).session!.getActiveToolNames()).not.toContain("open_project");
      }
      expect((await hob.runtime.router.ensure("ops")).session).toBe(single);
    } finally {
      hob.close();
    }
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
      expect(topic).toMatchObject({ name: "相册备份出错", parentId: group.id, createdBy: "user", workflow: "software" });
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

  it("关闭有事项的话题：事项按放弃处理，原因写「用户关闭了这个话题」", async () => {
    const { hob, group } = setup();
    try {
      const { post } = await loggedIn(hob);
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");
      const project = hob.runtime.projects.open({ group: topic, ownerId: "hob", title: "相册备份出错" });

      expect((await post(`/api/groups/${topic.id}/close`, { note: "先不弄了" })).status).toBe(200);
      expect(hob.runtime.store.project(topic.id, project.id)).toMatchObject({ stage: "dropped", summary: CLOSED_TOPIC_REASON });
      expect(hob.runtime.store.group(topic.id)).toMatchObject({ closeNote: "先不弄了" });
    } finally {
      hob.close();
    }
  });

  it("PATCH：话题只能改名；工作方式只收 software 和空；有没结束的事项时不能改成「无」", async () => {
    const { hob, group } = setup();
    try {
      const { patch, post } = await loggedIn(hob);
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");

      const renamed = await patch(`/api/groups/${topic.id}`, { name: "相册备份好了" });
      expect(renamed.status).toBe(200);
      expect((await renamed.json()) as Group).toMatchObject({ name: "相册备份好了" });

      for (const body of [{ members: ["hob"] }, { ownerId: "ops" }, { purpose: "别的事" }, { workflow: "software" }]) {
        const result = await patch(`/api/groups/${topic.id}`, body);
        expect(result.status, JSON.stringify(body)).toBe(400);
        expect(await result.json()).toMatchObject({ error: "话题的成员、群主、负责什么和工作方式跟着所属的群，在群里改" });
      }

      const bogus = await patch(`/api/groups/${group.id}`, { workflow: "dev" });
      expect(bogus.status).toBe(400);
      expect(await bogus.json()).toMatchObject({ error: "工作方式只能填 software（软件开发），或者不填" });
      expect((await post("/api/groups", { name: "x", purpose: "y", ownerId: "hob", members: ["hob"], workflow: "dev" })).status).toBe(400);

      // 有没结束的事项：不能改成「无」
      const project = hob.runtime.projects.open({ group: topic, ownerId: "hob", title: "相册备份" });
      const none = await patch(`/api/groups/${group.id}`, { workflow: null });
      expect(none.status).toBe(400);
      expect(await none.json()).toMatchObject({ error: "这个群还有没结束的事项，结束以后才能改工作方式" });

      // 事项结束以后可以改；群和话题读到的跟着变
      hob.runtime.projects.close(topic.id, project.id, "done", "处理完了");
      const cleared = await patch(`/api/groups/${group.id}`, { workflow: null });
      expect(cleared.status).toBe(200);
      expect(((await cleared.json()) as Group).workflow).toBeUndefined();
      expect(hob.runtime.store.group(topic.id)?.workflow).toBeUndefined();
    } finally {
      hob.close();
    }
  });

  it("归档群：话题目录一起搬进 archive，每个话题都发 group_removed；话题本身不走归档", async () => {
    const { hob, group } = setup();
    try {
      const { post } = await loggedIn(hob);
      const first = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");
      const second = hob.runtime.groups.createTopic(group.id, "打印机连不上", "hob");
      expect((await post(`/api/groups/${first.id}/archive`)).status).toBe(400);

      const removed: string[] = [];
      hob.runtime.bus.subscribe((event) => {
        if (event.type === "group_removed") removed.push(event.id);
      });
      expect((await post(`/api/groups/${group.id}/archive`)).status).toBe(200);

      expect(hob.runtime.store.group(group.id)).toBeUndefined();
      expect(hob.runtime.store.group(first.id)).toBeUndefined();
      expect(hob.runtime.store.group(second.id)).toBeUndefined();
      expect(removed).toEqual(expect.arrayContaining([group.id, first.id, second.id]));

      const archived = readdirSync(join(hob.home, "archive", "groups"));
      expect(archived).toHaveLength(1);
      const folder = join(hob.home, "archive", "groups", archived[0]!);
      expect(existsSync(join(folder, "group.json"))).toBe(true);
      expect(existsSync(join(folder, "topics", first.id, "group.json"))).toBe(true);
      expect(existsSync(join(folder, "topics", second.id, "group.json"))).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("GET /api/groups：话题带 parentId 和 project，done / total / waitingUser / current 算得对", async () => {
    const { hob, group } = setup();
    try {
      const { get } = await loggedIn(hob);
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");
      hob.runtime.store.saveJob(job({ id: "t-topic", assistantId: "ops", groupId: topic.id, status: "running" }));
      const project: Project = {
        id: "p-topic",
        groupId: topic.id,
        title: "相册备份出错",
        ownerId: "hob",
        stage: "doing",
        request: { text: "相册备份出错", at: ISO },
        clarify: [],
        subtasks: [
          { n: 1, title: "改备份脚本", assignee: "ops", brief: "", after: [], jobId: "t-topic" },
          { n: 2, title: "你去手机上点一次", assignee: "user", brief: "", after: [1], notifiedAt: ISO },
          { n: 3, title: "你已经点过的", assignee: "user", brief: "", after: [], doneAt: ISO },
        ],
        startedAt: ISO,
        itemId: "g-1",
        createdAt: ISO,
        updatedAt: ISO,
      };
      hob.runtime.store.saveProject(project);

      const listed = async () => ((await get("/api/groups")).json() as Promise<GroupSummary[]>);
      const found = async () => (await listed()).find((item) => item.id === topic.id)!;
      expect((await found()).parentId).toBe(group.id);
      expect((await found()).project).toMatchObject({ id: "p-topic", title: "相册备份出错", stage: "doing", done: 1, total: 3, waitingUser: true, current: "ops" });

      // 提问卡没答也算等你；任务跑完、还没轮到下一批时 current 是负责人
      const approval: Approval = {
        id: "q-topic",
        assistantId: "hob",
        title: "用哪个目录",
        options: [{ key: "A", label: "老目录" }, { key: "B", label: "新目录" }],
        status: "pending",
        source: "router",
        groupId: topic.id,
        createdAt: ISO,
      };
      hob.runtime.store.saveApproval(approval);
      hob.runtime.store.saveJob(job({ id: "t-topic", assistantId: "ops", groupId: topic.id, status: "done" }));
      hob.runtime.store.saveProject({ ...project, subtasks: project.subtasks.map((subtask) => (subtask.n === 2 ? { ...subtask, doneAt: ISO } : subtask)), stage: "plan", updatedAt: ISO });
      expect((await found()).project).toMatchObject({ waitingUser: true, current: "hob", done: 3 });

      // 提问卡答了：子任务拆好了等你点开始，也算等你；还在澄清就不算
      hob.runtime.store.saveApproval({ ...approval, status: "answered" });
      expect((await found()).project).toMatchObject({ waitingUser: true });
      hob.runtime.store.saveProject({ ...project, stage: "clarify", subtasks: [], updatedAt: ISO });
      expect((await found()).project).toMatchObject({ waitingUser: false });

      // 事项结束以后不填 current
      hob.runtime.store.saveProject({ ...project, stage: "done", updatedAt: ISO });
      const ended = (await found()).project!;
      expect(ended.current).toBeUndefined();
      expect(ended.stage).toBe("done");
    } finally {
      hob.close();
    }
  });
});

describe("open_topic：把综合里的原话转到话题里", () => {
  it("定时记录是触发项时转发记录而不是最后的用户消息", async () => {
    const { hob, group } = setup();
    try {
      appendUser(hob, group.id, "无关的旧消息");
      const note = hob.runtime.groups.appendItem(group.id, "hob", { kind: "note", icon: "routine", text: "定时任务「监听」到点了，检查到：新问题" });
      hob.runtime.groups.triggerOf = () => note;
      const events: string[] = [];
      hob.runtime.groups.deliverEvent = async (_gid, _aid, event) => { events.push(event); };
      const result = await toolOf(hob, "open_topic", group.id).execute("c", { title: "新问题", note: "处理第一条" });
      expect(isError(result)).toBe(false);
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      expect(hob.runtime.store.groupItems(topic.id)).toContainEqual(expect.objectContaining({ kind: "note", text: "定时任务「监听」到点了，检查到：新问题", forwardedFrom: { groupId: group.id, itemId: note.id } }));
      expect(events[0]).toContain("处理第一条");
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

      // 话题里那一轮的输入：先是用户原话，再是事件和备注
      expect(inputBody(memberFile(hob, topic.id, "hob")).split("\n\n")).toEqual([
        "用户：相册备份一直报错（附件：/tmp/截图.png）",
        "[hob-event] 这个话题是你从综合开的，上面是用户在综合里的原话。\n你留的备注：备份目录是 /vol/photo",
      ]);
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
      expect(inputBody(memberFile(hob, topic.id, "hob")).split("\n\n").at(-1)).toBe("[hob-event] 上面是用户在综合里的原话。");
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

describe("close_topic：群主关话题", () => {
  it("在话题里不填 topic 就关这个话题；综合里要填；有没结束的事项时不关", async () => {
    const { hob, group } = setup();
    try {
      const inside = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");
      const outside = hob.runtime.groups.createTopic(group.id, "打印机连不上", "user");
      const project = hob.runtime.projects.open({ group: outside, ownerId: "hob", title: "打印机连不上" });

      // 话题里有没结束的事项：让群主用 close_project
      const blocked = await toolOf(hob, "close_topic", outside.id).execute("c", {});
      expect(isError(blocked)).toBe(true);
      expect(textOf(blocked)).toBe("话题「打印机连不上」里的事项「打印机连不上」还没结束：用 close_project 结束事项，话题会跟着关。");

      const closed = await toolOf(hob, "close_topic", inside.id).execute("c", { note: "办完了" });
      expect(isError(closed)).toBe(false);
      expect(textOf(closed)).toBe("话题「相册备份出错」已关闭。");
      expect(hob.runtime.store.group(inside.id)).toMatchObject({ closeNote: "办完了" });

      // 综合里没填 topic：列进行中的话题
      const missing = await toolOf(hob, "close_topic", group.id).execute("c", {});
      expect(isError(missing)).toBe(true);
      expect(textOf(missing)).toContain("topic 不能为空");
      expect(textOf(missing)).toContain(`打印机连不上（${outside.id}）`);
      expect(textOf(missing)).not.toContain(`相册备份出错（${inside.id}）`);

      // 填了别的群的话题也不行
      const other = hob.runtime.groups.create({ name: "别的群", purpose: "别的事", ownerId: "hob", members: ["hob", "ops"] });
      const elsewhere = hob.runtime.groups.createTopic(other.id, "别的话题", "user");
      expect(textOf(await toolOf(hob, "close_topic", inside.id).execute("c", { topic: elsewhere.id }))).toContain("不是这个群的话题");
      expect(hob.runtime.store.project(outside.id, project.id)?.stage).toBe("clarify");
    } finally {
      hob.close();
    }
  });
});

describe("open_project：在话题里立", () => {
  it("话题里立的事项挂在话题上；一个话题只放一件；close_project 结束以后话题跟着关", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([text("先问一句"), text("改好了")]);
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");
      const open = toolOf(hob, "open_project", topic.id);
      const first = await open.execute("c", { title: "相册备份出错" });
      expect(isError(first)).toBe(false);
      const project = hob.runtime.projects.list(topic.id)[0]!;
      expect(project.groupId).toBe(topic.id);
      expect(hob.runtime.store.groupItems(topic.id).find((item) => item.kind === "project")).toMatchObject({ speaker: "hob", projectId: project.id });
      expect(textOf(first)).toContain(`事项「相册备份出错」（${project.id}）已立，现在是需求澄清。记录：`);

      const second = await open.execute("c", { title: "另一件事" });
      expect(isError(second)).toBe(true);
      expect(textOf(second)).toContain(`这个话题已经有事项「相册备份出错」（${project.id}）：一个话题只放一件事项。`);

      // close_project 结束事项：话题跟着关，关闭说明就是结论
      const closed = await toolOf(hob, "close_project", topic.id).execute("c", { project: project.id, outcome: "done", summary: "备份恢复正常，验证过了" });
      expect(isError(closed)).toBe(false);
      expect(hob.runtime.store.group(topic.id)).toMatchObject({ closeNote: "备份恢复正常，验证过了" });
      expect(hob.runtime.store.group(topic.id)?.closedAt).toBeTruthy();
      expect(hob.runtime.groups.summary(group.id).project).toBeUndefined();
    } finally {
      hob.close();
    }
  });
});

describe("工具和提示词按工作方式和会话分开", () => {
  it("「无」的群：群主只有 open_topic / close_topic，没有事项的工具和提示词", () => {
    const { hob, group } = setup("none");
    try {
      const names = buildRouterTools(hob.runtime, "hob", group.id).map((tool) => tool.name);
      expect(names).toContain("open_topic");
      expect(names).toContain("close_topic");
      for (const name of ["open_project", "write_requirements", "plan_subtasks", "start_subtasks", "close_project"]) expect(names).not.toContain(name);

      const shown = prompt(hob, "hob", group, []);
      expect(shown).toContain(TOPIC_OPEN_LINE);
      expect(shown).not.toContain(PROJECT_OPEN_LINE);
      expect(shown).not.toContain("## 这个群的事项");
      // 成员也没有话题的工具
      expect(buildRouterTools(hob.runtime, "ops", group.id).map((tool) => tool.name)).not.toContain("open_topic");
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
      expect(overview).toContain(PROJECT_OPEN_LINE);

      const inside = prompt(hob, "hob", topic, hob.runtime.projects.list(topic.id));
      expect(inside).toContain(topicPromptLine(group.name, topic.name));
      expect(inside).toContain(`你在群「${group.name}」里`);
      expect(inside).not.toContain(TOPIC_OPEN_LINE);
      expect(inside).not.toContain("## 这个群的话题");
      // 群主的工具：话题里没有 open_topic，close_topic 照旧
      const names = buildRouterTools(hob.runtime, "hob", topic.id).map((tool) => tool.name);
      expect(names).not.toContain("open_topic");
      expect(names).toContain("close_topic");

      // 成员在话题里也有开头那段，没有群主那两段
      const member = prompt(hob, "ops", topic, hob.runtime.projects.list(topic.id));
      expect(member).toContain(topicPromptLine(group.name, topic.name));
      expect(member).not.toContain(TOPIC_OPEN_LINE);
      expect(member).not.toContain(PROJECT_OPEN_LINE);
    } finally {
      hob.close();
    }
  });

  it("以前直接立在群里的事项照旧出现，PROJECT_RECALL_LINE 只出一次", () => {
    const { hob, group } = setup();
    try {
      // 以前的群级事项：项目记在群上，不在话题里
      const legacy = hob.runtime.projects.open({ group, ownerId: "hob", title: "导出加按月筛选" });
      expect(legacy.groupId).toBe(group.id);
      const withProject = prompt(hob, "hob", group, hob.runtime.projects.list(group.id));
      expect(withProject).toContain("## 这个群的事项");
      expect(withProject).toContain(`- 「导出加按月筛选」· 需求澄清 · `);
      expect(withProject.split(PROJECT_RECALL_LINE)).toHaveLength(2);

      // 有了话题：两节都在，召回那句还是只有一次、放在最后
      hob.runtime.groups.createTopic(group.id, "相册备份出错", "user");
      const both = prompt(hob, "hob", group, hob.runtime.projects.list(group.id));
      expect(both).toContain("## 这个群的话题");
      expect(both).toContain("## 这个群的事项");
      expect(both.split(PROJECT_RECALL_LINE)).toHaveLength(2);
      expect(both.indexOf("## 这个群的话题")).toBeLessThan(both.indexOf("## 这个群的事项"));
      expect(both.indexOf(PROJECT_RECALL_LINE)).toBeGreaterThan(both.lastIndexOf("## 这个群的事项"));
    } finally {
      hob.close();
    }
  });
});
