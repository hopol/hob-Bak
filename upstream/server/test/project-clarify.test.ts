import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Assistant, Group, GroupItem, Job, Project, Subtask } from "../../shared/types.ts";
import { subtaskStatus } from "../../shared/project.ts";
import { createApp } from "../src/http.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

/** 定稿只在开发仓库里（.scratch 不公开），没有就跳过逐字对照 */
const DOC = ".scratch/v2/design-projects.md";
const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";

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
  const group = hob.runtime.groups.create({ name: "开发团队", purpose: "做软件", workflow: "software", ownerId: "hob", members: ["hob", "ops", "write"] });
  return { hob, group };
}

const groupItems = (hob: TestHob, gid: string) => hob.runtime.groups.items(gid).items;
const ownerReplies = (hob: TestHob, gid: string, speaker = "hob") =>
  groupItems(hob, gid).filter((item): item is Extract<GroupItem, { kind: "assistant" }> => item.kind === "assistant" && item.speaker === speaker);

async function settled(hob: TestHob, gid: string, replies: number): Promise<void> {
  await waitFor(() => ownerReplies(hob, gid).length >= replies);
  await waitFor(() => hob.runtime.groups.summary(gid).busy.length === 0);
}

function toolOf(hob: TestHob, name: string, gid?: string) {
  const tool = buildRouterTools(hob.runtime, "hob", gid).find((item) => item.name === name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  return tool;
}

const textOf = (result: Awaited<ReturnType<ReturnType<typeof toolOf>["execute"]>>) => (result.content[0] as { text: string }).text;

/** 造一份事项，直接写进存储（不经过工具）。 */
function seedProject(hob: TestHob, group: Group, patch: Partial<Project> = {}): Project {
  const project = hob.runtime.projects.open({ group, ownerId: "hob", title: "登录页加「记住我」" });
  const next: Project = { ...project, ...patch };
  hob.runtime.store.saveProject(next);
  return next;
}

function prompt(hob: TestHob, assistantId: string, group: Group, projects: Project[] | undefined): string {
  return buildSystemPrompt(hob.runtime.store, assistantId, {
    timezone: "Asia/Shanghai",
    aboutYou: { name: "", language: "", notes: "" },
    memory: "off",
    group,
    ...(projects ? { projects } : {}),
  });
}

describe("事项：只有群主、只在群会话里有的三个工具", () => {
  it("群主的群会话里三个都在，成员和单聊都没有", async () => {
    const { hob, group } = setup();
    try {
      const names = (id: string, gid?: string) => buildRouterTools(hob.runtime, id, gid).map((tool) => tool.name);
      for (const name of ["open_project", "write_requirements", "close_project"]) {
        expect(names("hob", group.id)).toContain(name);
        expect(names("ops", group.id)).not.toContain(name);
        expect(names("hob")).not.toContain(name);
      }
      // 会话里的工具名单也一样：群的工具白名单放行了这三个，单个成员还是拿不到
      const owner = await hob.runtime.router.ensure("hob", group.id);
      expect(owner.session!.getActiveToolNames()).toContain("open_project");
      const member = await hob.runtime.router.ensure("ops", group.id);
      expect(member.session!.getActiveToolNames()).not.toContain("open_project");
      const single = await hob.runtime.router.ensure("hob");
      expect(single.session!.getActiveToolNames()).not.toContain("open_project");
    } finally {
      hob.close();
    }
  });
});

describe("open_project：原话、卡片、记录、下一轮", () => {
  it("定时触发时保存记录为原始需求并传递备注", async () => {
    const { hob, group } = setup();
    try {
      hob.runtime.groups.appendItem(group.id, "user", { kind: "user", text: "无关的旧消息" });
      const note = hob.runtime.groups.appendItem(group.id, "hob", { kind: "note", icon: "routine", text: "定时任务「监听」到点了，检查到：第一条" });
      hob.runtime.groups.triggerOf = () => note;
      const events: string[] = [];
      hob.runtime.groups.deliverEvent = async (_gid, _aid, event) => { events.push(event); };
      const result = await toolOf(hob, "open_project", group.id).execute("c", { title: "修第一条", note: "处理第一条" });
      expect(result.isError).not.toBe(true);
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      const project = hob.runtime.store.projects(topic.id)[0]!;
      expect(project.request.text).toBe("定时任务「监听」到点了，检查到：第一条");
      expect(events[0]).toContain("处理第一条");
      // 一次查到几条要各立一个：定时触发的这一轮不结束，接着立第二个
      expect((result as { terminate?: boolean }).terminate).not.toBe(true);
      const second = await toolOf(hob, "open_project", group.id).execute("d", { title: "修第二条", note: "处理第二条" });
      expect(second.isError).not.toBe(true);
      expect(hob.runtime.groups.topicsOf(group.id)).toHaveLength(2);
    } finally { hob.close(); }
  });
  it("在综合里立：开一个话题，原话转进去（含附件和引用），事项卡落在话题里，话题里马上开的新一轮有 4.2", async () => {
    const { hob, group } = setup();
    try {
      // 每一轮真的请求模型时把系统提示词记下来：话题里那一轮才该有 4.2
      const prompts: string[] = [];
      const openSession = hob.runtime.pi.open.bind(hob.runtime.pi);
      hob.runtime.pi.open = (async (options: Parameters<typeof openSession>[0]) => {
        const opened = await openSession(options);
        const session = opened.session as unknown as { systemPrompt: string; prompt: (...args: unknown[]) => Promise<unknown> };
        const ask = session.prompt.bind(session);
        session.prompt = async (...args: unknown[]) => {
          prompts.push(session.systemPrompt);
          return ask(...args);
        };
        return opened;
      }) as typeof hob.runtime.pi.open;
      hob.faux.setResponses([call("open_project", { title: "登录页加「记住我」" }), text("换设备还要记住登录吗？先定这一条。")]);
      const request = "登录页加一个「记住我」，下周发版前要上";
      await hob.runtime.groups.send(group.id, {
        text: request,
        files: ["/tmp/界面.png"],
        quote: { itemId: "g-404", text: "下周发版" },
      });
      // 综合里的那一轮只调了工具；话题里开的那一轮说完才算完
      await waitFor(() => hob.runtime.groups.topicsOf(group.id).length === 1);
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      await waitFor(() => hob.runtime.store.groupItems(topic.id).some((item) => item.kind === "assistant" && item.speaker === "hob"));
      await waitFor(() => hob.runtime.groups.summary(topic.id).busy.length === 0);

      // 综合里开的那个话题：名字就是事项名，发言人是群主
      expect(topic).toMatchObject({ name: "登录页加「记住我」", parentId: group.id, createdBy: "hob", members: group.members, ownerId: "hob" });
      expect(hob.runtime.store.groupItems(group.id).find((item) => item.kind === "topic")).toMatchObject({ speaker: "hob", topicId: topic.id });

      // 事项挂在话题上，原始需求是转进话题的那条用户消息
      const project = hob.runtime.projects.list(topic.id)[0]!;
      expect(project.stage).toBe("clarify");
      expect(project.groupId).toBe(topic.id);
      const forwarded = hob.runtime.store.groupItems(topic.id).find((item) => item.kind === "user")!;
      expect(forwarded).toMatchObject({ speaker: "user", text: request, files: ["/tmp/界面.png"], forwardedFrom: { groupId: group.id } });
      // 原话、附件、引用原样记下来，不是模型写的文字；itemId 是转进话题后的那条
      expect(project.request).toMatchObject({ text: request, files: ["/tmp/界面.png"], quote: { itemId: "g-404", text: "下周发版" }, itemId: forwarded.id });
      // 事项卡落在话题的时间线里，发言人是群主
      expect(hob.runtime.store.groupItems(topic.id).find((item) => item.kind === "project")).toMatchObject({ speaker: "hob", projectId: project.id, id: project.itemId });

      // 这一轮结束后群主在话题里又开了一轮：这个话题的提示词里有需求澄清这一节
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).not.toContain("：需求澄清");
      expect(prompts[1]).toContain("这里是群「开发团队」的话题「登录页加「记住我」」");
      expect(prompts[1]).toContain(`## 事项「登录页加「记住我」」：需求澄清`);
      expect(prompts[1]).toContain("会改变做法或验收办法的问题都定了，就写需求说明（write_requirements）。");

      // 记录文件写出来了：原话、状态都在里面
      const record = join(hob.home, "groups", topic.id, "projects", `${project.id}.md`);
      expect(existsSync(record)).toBe(true);
      const markdown = readFileSync(record, "utf8");
      expect(markdown).toContain("# 登录页加「记住我」");
      expect(markdown).toContain("状态：需求澄清");
      expect(markdown).toContain(request);
      expect(markdown).toContain("## 原始需求");
      expect(markdown).toContain("附件：/tmp/界面.png");
    } finally {
      hob.close();
    }
  });
});

describe("write_requirements：阶段往前走，开新的一轮", () => {
  it("需求澄清时写完进入任务拆分并开新的一轮；任务拆分阶段再写只更新内容", async () => {
    const { hob, group } = setup();
    try {
      const project = seedProject(hob, group);
      hob.faux.setResponses([text("拆好了，4 个子任务。")]);
      const tool = toolOf(hob, "write_requirements", group.id);
      const first = await tool.execute("c", { project: project.id, content: "勾选后 30 天免登录。", acceptance: ["勾选后 30 天内免登录"] });
      expect(textOf(first)).toContain("需求说明已写好，现在是任务拆分");
      await settled(hob, group.id, 1);
      expect(hob.runtime.store.project(group.id, project.id)!.stage).toBe("plan");
      expect(hob.runtime.store.project(group.id, project.id)!.requirements?.acceptance).toEqual(["勾选后 30 天内免登录"]);
      // 新的一轮真的开了：群主在时间线上说了一句
      expect(ownerReplies(hob, group.id)).toHaveLength(1);

      const second = await tool.execute("c", { project: project.id, content: "改过的正文。", acceptance: ["一条", "两条"] });
      expect((second as { terminate?: boolean }).terminate).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(ownerReplies(hob, group.id)).toHaveLength(1);
      const saved = hob.runtime.store.project(group.id, project.id)!;
      expect(saved.stage).toBe("plan");
      expect(saved.requirements?.content).toBe("改过的正文。");
      expect(saved.requirements?.acceptance).toEqual(["一条", "两条"]);
    } finally {
      hob.close();
    }
  });

  it("验收标准为空时报错，写清要怎么改", async () => {
    const { hob, group } = setup();
    try {
      const project = seedProject(hob, group);
      const tool = toolOf(hob, "write_requirements", group.id);
      const result = await tool.execute("c", { project: project.id, content: "正文", acceptance: [] });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("acceptance 不能为空");
      expect(hob.runtime.store.project(group.id, project.id)!.stage).toBe("clarify");
    } finally {
      hob.close();
    }
  });
});

describe("close_project：结束事项", () => {
  it("放弃的记下原因，4.1 里显示「已放弃：原因」；结束了再调就报错", async () => {
    const { hob, group } = setup();
    try {
      const project = seedProject(hob, group);
      const tool = toolOf(hob, "close_project", group.id);
      const closed = await tool.execute("c", { project: project.id, outcome: "dropped", summary: "下个版本改用短信验证码登录" });
      expect((closed as { isError?: boolean }).isError).toBeUndefined();
      const saved = hob.runtime.store.project(group.id, project.id)!;
      expect(saved.stage).toBe("dropped");
      expect(saved.summary).toBe("下个版本改用短信验证码登录");
      expect(saved.endedAt).toBeTruthy();

      const list = prompt(hob, "hob", group, hob.runtime.projects.list(group.id));
      expect(list).toContain("已放弃：下个版本改用短信验证码登录");
      expect(list).toContain(`${project.id}.md`);

      const again = await tool.execute("c", { project: project.id, outcome: "done", summary: "再看一眼" });
      expect((again as { isError?: boolean }).isError).toBe(true);
      expect(textOf(again)).toContain("已经结束了");
    } finally {
      hob.close();
    }
  });

  it("事项 id 不存在时报错，并列出这个群进行中的事项", async () => {
    const { hob, group } = setup();
    try {
      seedProject(hob, group);
      const result = await toolOf(hob, "close_project", group.id).execute("c", { project: "p-404", outcome: "done", summary: "完" });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("没有这个事项：p-404");
      expect(textOf(result)).toContain("登录页加「记住我」");
    } finally {
      hob.close();
    }
  });
});

describe("提示词 4.1、4.2 的出现条件", () => {
  it("群主才有 4.1，成员没有；没有事项时也没有", async () => {
    const { hob, group } = setup();
    try {
      expect(prompt(hob, "hob", group, [])).not.toContain("## 这个群的事项");
      const project = seedProject(hob, group);
      const list = hob.runtime.projects.list(group.id);
      expect(prompt(hob, "hob", group, list)).toContain("## 这个群的事项");
      expect(prompt(hob, "ops", group, list)).not.toContain("## 这个群的事项");
      expect(prompt(hob, "hob", group, list)).toContain(project.id);
    } finally {
      hob.close();
    }
  });

  it("4.2 只在需求澄清时出现，两件事项都在这一步时标题连起来、正文只出一次", async () => {
    const { hob, group } = setup();
    try {
      const a = seedProject(hob, group, { title: "登录页加「记住我」" });
      const b = hob.runtime.projects.open({ group, ownerId: "hob", title: "导出加按月筛选" });
      const list = hob.runtime.projects.list(group.id);
      const both = prompt(hob, "hob", group, list);
      // 几件事项同时在这一步：标题用「、」连起来（先后不重要），正文只出一次
      const header = /## 事项(.+)：需求澄清/.exec(both)?.[1];
      expect(header).toBeDefined();
      expect(header!.split("、")).toHaveLength(2);
      for (const title of [a.title, b.title]) expect(header).toContain(`「${title}」`);
      const body = "这一步要做到：你和用户对做出来是什么样子，看法一致。";
      expect(both.split(body)).toHaveLength(2);

      hob.runtime.projects.writeRequirements(group.id, a.id, { content: "正文", acceptance: ["一条"] });
      const planned = prompt(hob, "hob", group, hob.runtime.projects.list(group.id));
      expect(planned).not.toContain(`${a.title}」：需求澄清`);
      expect(planned).toContain(`${b.title}」：需求澄清`);
    } finally {
      hob.close();
    }
  });
});

describe("逐字对照设计稿", () => {
  const section = (start: string, end: string) => doc.split(start)[1]!.split(end)[0]!;
  /** 工具说明草稿：每个工具 FIRST 行是说明，后面 - `参数`：… 是参数说明 */
  const tools = new Map<string, string[]>();
  for (const line of doc ? section("### 工具说明草稿", "## 六、评测").split("\n") : []) {
    const head = /^\*\*(\w+)\*\*(?:（群主）)?：(.+)$/.exec(line);
    if (head) {
      tools.set(head[1]!, [head[2]!]);
      continue;
    }
    if (line.startsWith("- `")) tools.get([...tools.keys()].at(-1)!)?.push(line);
  }
  const param = (name: string, key: string) => tools.get(name)!.find((line) => line.startsWith(`- \`${key}\`：`))!.slice(`- \`${key}\`：`.length);

  it.skipIf(!doc)("4.0、4.1、4.2 与设计稿一字不差", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "ops", "服务器", "机器");
      const group = hob.runtime.groups.create({ name: "开发团队", purpose: "做软件", workflow: "software", ownerId: "hob", members: ["hob", "ops"] });
      const block = (start: string) => section(start, "\n```\n").trim();
      // 4.0
      const openLine = block("### 4.0 群主：什么时候立事项 【群主才有，接在群主那段后面】\n\n```\n");
      const bare = prompt(hob, "hob", group, []);
      expect(bare).toContain(openLine);
      expect(prompt(hob, "ops", group, [])).not.toContain(openLine);
      // 4.1
      const project = seedProject(hob, group);
      const listBlock = block("### 4.1 这个群的事项 【群主才有，群里有事项才有】\n\n```\n");
      const [listHead, listBullet, ...listRest] = listBlock.split("\n");
      const shown = prompt(hob, "hob", group, hob.runtime.projects.list(group.id));
      expect(shown).toContain(listHead!);
      expect(shown).toContain(listRest.join("\n"));
      expect(shown).toContain(`- 「${project.title}」· 需求澄清 · `);
      expect(listBullet).toContain("：{记录路径}");
      // 4.2
      const clarify = block("### 4.2 需求澄清和需求说明 【你负责的事项在需求澄清时才有】\n\n```\n");
      expect(prompt(hob, "hob", group, hob.runtime.projects.list(group.id))).toContain(clarify.replace("{标题}", project.title));
    } finally {
      hob.close();
    }
  });

  it.skipIf(!doc)("三个工具的说明和参数说明与设计稿一字不差", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "ops", "服务器", "机器");
      const group = hob.runtime.groups.create({ name: "开发团队", purpose: "做软件", workflow: "software", ownerId: "hob", members: ["hob", "ops"] });
      for (const name of ["open_project", "write_requirements", "close_project"]) {
        const tool = toolOf(hob, name, group.id);
        const expected = name === "open_project" ? tools.get(name)![0].replace("触发这一轮的用户原话和附件会原样记成原始需求", "触发这一轮的消息（用户原话和附件，或者定时任务到点的那条）会原样记成原始需求") : tools.get(name)![0];
        expect(tool.description, name).toBe(expected);
      }
      expect(toolOf(hob, "open_project", group.id).parameters.properties.title.description).toBe(param("open_project", "title"));
      const requirements = toolOf(hob, "write_requirements", group.id).parameters.properties;
      for (const key of ["project", "content", "acceptance"]) expect(requirements[key].description, key).toBe(param("write_requirements", key));
      const close = toolOf(hob, "close_project", group.id).parameters.properties;
      for (const key of ["project", "outcome", "summary"]) expect(close[key].description, key).toBe(param("close_project", key));
    } finally {
      hob.close();
    }
  });
});

describe("子任务状态由数据推出来", () => {
  const job = (status: Job["status"]): Job => ({
    id: "t-1",
    assistantId: "ops",
    title: "做",
    instruction: "",
    status,
    createdAt: "2026-11-08T01:00:00.000Z",
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
  });
  const project = (patch: Partial<Project> = {}): Project => ({
    id: "p-1",
    groupId: "g-1",
    title: "事项",
    ownerId: "hob",
    stage: "doing",
    request: { text: "原话", at: "2026-11-08T01:00:00.000Z" },
    clarify: [],
    subtasks: [
      { n: 1, title: "一", assignee: "ops", brief: "", after: [] },
      { n: 2, title: "二", assignee: "ops", brief: "", after: [1] },
      { n: 3, title: "三", assignee: "user", brief: "", after: [2] },
    ],
    startedAt: "2026-11-08T01:10:00.000Z",
    itemId: "g-1",
    createdAt: "2026-11-08T01:00:00.000Z",
    updatedAt: "2026-11-08T01:00:00.000Z",
    ...patch,
  });
  const subtask = (n: number, patch: Partial<Subtask> = {}): Subtask => ({ n, title: "x", assignee: "ops", brief: "", after: [], ...patch });

  it("没开始、等待前置、待开始、进行中、已完成、受阻、待你执行", () => {
    const fresh = project({ subtasks: [] });
    expect(subtaskStatus({ ...fresh, startedAt: undefined }, subtask(1))).toBe("未开始");

    const first = subtask(1);
    const second = subtask(2, { after: [1] });
    const list = project({ subtasks: [first, second] });
    expect(subtaskStatus(list, second, undefined, () => job("running"))).toBe("等待前置任务");
    expect(subtaskStatus(list, second, undefined, () => job("done"))).toBe("待开始");
    expect(subtaskStatus(list, second, job("queued"), (other) => (other.n === 1 ? job("done") : undefined))).toBe("进行中");
    expect(subtaskStatus(list, second, job("waiting"), () => job("done"))).toBe("进行中");
    expect(subtaskStatus(list, second, job("done"))).toBe("已完成");
    expect(subtaskStatus(list, second, job("failed"), () => job("done"))).toBe("受阻");
    expect(subtaskStatus(list, second, job("stuck"), () => job("done"))).toBe("受阻");
    expect(subtaskStatus(list, second, job("stopped"), () => job("done"))).toBe("受阻");

    const mine = subtask(3, { assignee: "user", after: [2] });
    const withMine = project({ subtasks: [first, second, mine] });
    expect(subtaskStatus(withMine, mine, undefined, (other) => (other.n === 2 ? job("done") : undefined))).toBe("待你执行");
    expect(subtaskStatus(withMine, mine, undefined, () => job("running"))).toBe("等待前置任务");
    expect(subtaskStatus(withMine, { ...mine, doneAt: "2026-11-08T02:00:00.000Z" })).toBe("已完成");
  });
});

describe("接口和事件", () => {
  it("事项列出来（新的在前）、单个能打开，每次变化推一个 project 事件", async () => {
    const { hob, group } = setup();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

      const events: { type: string; id?: string }[] = [];
      hob.runtime.bus.subscribe((event) => {
        if (event.type === "project") events.push({ type: event.type, id: event.project.id });
      });

      const empty = await app.request(`/api/groups/${group.id}/projects`, { headers: { cookie } });
      expect(await empty.json()).toEqual([]);

      const older = seedProject(hob, group, { title: "老的一件事" });
      const newer = seedProject(hob, group, { title: "新的一件事" });
      hob.runtime.projects.writeRequirements(group.id, older.id, { content: "正文", acceptance: ["一条"] });
      // 更新时间固定成能比较的值，顺序不靠时钟
      hob.runtime.store.saveProject({ ...hob.runtime.store.project(group.id, older.id)!, updatedAt: "2020-01-01T00:00:00.000Z" });
      hob.runtime.store.saveProject({ ...hob.runtime.store.project(group.id, newer.id)!, updatedAt: "2030-01-01T00:00:00.000Z" });

      const list = await app.request(`/api/groups/${group.id}/projects`, { headers: { cookie } });
      expect(list.status).toBe(200);
      const projects = (await list.json()) as Project[];
      expect(projects.map((item) => item.id)).toEqual([newer.id, older.id]);

      const one = await app.request(`/api/groups/${group.id}/projects/${newer.id}`, { headers: { cookie } });
      expect(one.status).toBe(200);
      expect(((await one.json()) as Project).title).toBe("新的一件事");

      const missing = await app.request(`/api/groups/${group.id}/projects/p-404`, { headers: { cookie } });
      expect(missing.status).toBe(404);
      const noGroup = await app.request(`/api/groups/g-404/projects`, { headers: { cookie } });
      expect(noGroup.status).toBe(404);
      expect(events.map((event) => event.id)).toContain(newer.id);
    } finally {
      hob.close();
    }
  });
});

describe("记录文件", () => {
  it("按顺序写原始需求、问答、需求说明、验收标准、子任务和结论", () => {
    const { hob, group } = setup();
    try {
      const project = seedProject(hob, group, {
        clarify: [{ title: "勾选后多久免登录？", why: "太长了设备丢了麻烦", options: ["7 天", "30 天"], recommended: "30 天", answer: "30 天", askedBy: "hob", at: new Date().toISOString() }],
      });
      hob.runtime.projects.writeRequirements(group.id, project.id, { content: "勾选后 30 天内免登录。", acceptance: ["勾选后关掉浏览器再打开仍是登录状态"] });
      hob.runtime.projects.close(group.id, project.id, "done", "上线了，三条验收标准都通过。");
      const markdown = readFileSync(join(hob.home, "groups", group.id, "projects", `${project.id}.md`), "utf8");
      const order = ["# 登录页加「记住我」", "## 原始需求", "## 需求澄清", "## 需求说明", "## 验收标准", "## 结论"];
      const positions = order.map((head) => markdown.indexOf(head));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(markdown).toContain("[ ] 勾选后关掉浏览器再打开仍是登录状态");
      expect(markdown).toContain("上线了，三条验收标准都通过。");
    } finally {
      hob.close();
    }
  });
});
