// 票 153：主助手管理助手、群和话题。工具级测试，不走真实模型。
import { describe, expect, it, vi } from "vitest";
import type { Assistant, Group } from "../../shared/types.ts";
import { saveAssistantSkill } from "../src/assistant-skills.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { ADMIN_LINE, buildSystemPrompt } from "../src/prompt.ts";
import { makeHob, type TestHob } from "./helpers.ts";

interface Result {
  content: { type: string; text: string }[];
  isError?: boolean;
  terminate?: boolean;
}

function addAssistant(hob: TestHob, id: string, name: string, duty: string, extra: Partial<Assistant> = {}): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = {
    ...base,
    id,
    name,
    duty,
    primary: false,
    pinned: false,
    sprite: "page",
    instructions: "",
    createdAt: "2026-02-01T00:00:00.000Z",
    ...extra,
  };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

/** 一个群「交付小组」：Hob 是群主，成员还有服务器和写作。首次启动自带的敏捷团队和收起的助手不影响这些断言。 */
function setup(): { hob: TestHob; group: Group } {
  const hob = makeHob({}, { memory: "off" });
  addAssistant(hob, "ops", "服务器", "机器");
  addAssistant(hob, "write", "写作", "周报和文章");
  const group = hob.runtime.groups.create({ name: "交付小组", purpose: "一起做软件", ownerId: "hob", members: ["hob", "ops", "write"], workflow: "software" });
  return { hob, group };
}

async function run(hob: TestHob, assistantId: string, name: string, args: Record<string, unknown>, groupId?: string): Promise<Result> {
  const tool = buildRouterTools(hob.runtime, assistantId, groupId).find((item) => item.name === name);
  if (!tool) throw new Error(`没有工具：${name}`);
  return (await tool.execute("call", args)) as Result;
}

const said = (result: Result) => result.content[0].text;

/** 往群的时间线里直接写一条，不跑模型。 */
function say(hob: TestHob, gid: string, text: string) {
  return hob.runtime.groups.appendItem(gid, "user", { kind: "user", text });
}

const notesOf = (hob: TestHob, gid: string) =>
  hob.runtime.groups.timeline(gid).flatMap((item) => (item.kind === "note" ? [item.text] : []));

/** Hob 单聊里落的提示行。 */
const hobNotes = (hob: TestHob) =>
  hob.runtime.router.items("hob").items.flatMap((item) => (item.kind === "note" ? [item.text] : []));

describe("只有主助手有管理工具", () => {
  it("别的助手的工具列表里没有它们，也没有 assistantId 参数", () => {
    const { hob } = setup();
    try {
      const admin = ["show_assistant", "show_group", "create_assistant", "update_assistant", "create_group", "update_group", "manage_topic"];
      const primary = buildRouterTools(hob.runtime, "hob").map((tool) => tool.name);
      for (const name of admin) expect(primary).toContain(name);
      expect(primary).not.toContain("propose_assistant");
      const other = buildRouterTools(hob.runtime, "ops");
      for (const name of admin) expect(other.map((tool) => tool.name)).not.toContain(name);
      // 七个老工具还在，但没有 assistantId 参数
      for (const name of ["set_rule", "remove_rule", "create_routine", "update_routine", "delete_routine", "edit_skill", "delete_skill"]) {
        const tool = other.find((item) => item.name === name)!;
        expect(tool, name).toBeTruthy();
        expect((tool.parameters as { properties: Record<string, unknown> }).properties.assistantId, name).toBeUndefined();
      }
      // 主助手的这七个都有
      for (const name of ["set_rule", "remove_rule", "create_routine", "update_routine", "delete_routine", "edit_skill", "delete_skill"]) {
        const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === name)!;
        expect((tool.parameters as { properties: Record<string, unknown> }).properties.assistantId, name).toBeTruthy();
      }
    } finally { hob.close(); }
  });

  it("主助手在群里能管理助手和群，成员都能管理群规则", async () => {
    const { hob, group } = setup();
    try {
      const primary = await hob.runtime.router.ensure("hob", group.id);
      const names = primary.session!.getActiveToolNames();
      for (const name of ["show_assistant", "show_group", "create_assistant", "update_assistant", "create_group", "update_group", "manage_topic", "set_rule", "create_routine", "edit_skill", "delete_skill"]) {
        expect(names, name).toContain(name);
      }
      expect(names).not.toContain("message_assistant");
      const member = await hob.runtime.router.ensure("ops", group.id);
      const memberNames = member.session!.getActiveToolNames();
      expect(memberNames).toContain("set_rule");
      expect(memberNames).toContain("remove_rule");
      expect(memberNames).toContain("create_routine");
      expect(memberNames).toContain("edit_skill");
      expect(memberNames).toContain("delete_skill");
      for (const name of ["show_assistant", "create_group", "manage_topic"]) {
        expect(memberNames, name).not.toContain(name);
      }
    } finally { hob.close(); }
  });
});

describe("show_assistant", () => {
  it("列出全部助手（含收起的），按左栏顺序，带在哪些群", async () => {
    const { hob, group } = setup();
    try {
      addAssistant(hob, "net", "网络", "家庭网络", { hidden: true });
      addAssistant(hob, "pin", "笔记本", "记笔记", { pinned: true, pinOrder: 0, createdAt: "2026-01-04T00:00:00.000Z" });
      const lines = said(await run(hob, "hob", "show_assistant", {})).split("\n");
      const at = (line: string) => lines.indexOf(line);
      expect(at("笔记本（pin）：记笔记")).toBe(0);
      expect(at("服务器（ops）：机器；在群：交付小组")).toBeGreaterThan(0);
      expect(at("写作（write）：周报和文章；在群：交付小组")).toBeGreaterThan(0);
      // 收起的排在最后，并在行尾标出来
      expect(at("网络（net）：家庭网络（收起）")).toBeGreaterThan(at("服务器（ops）：机器；在群：交付小组"));
      expect(lines.at(-1)).toBe(`共 ${hob.runtime.store.assistants().length} 个`);
      expect(lines.filter((line) => line.endsWith("（收起）")).length).toBeGreaterThanOrEqual(6);
    } finally { hob.close(); }
  });

  it("分页 20 条：第一页、最后一页、超出页数", async () => {
    const { hob } = setup();
    try {
      for (let i = 0; i < 21; i += 1) addAssistant(hob, `a${i}`, `助手${i}`, "做事");
      const total = hob.runtime.store.assistants().length;
      const pages = Math.ceil(total / 20);
      expect(total).toBeGreaterThan(21);
      const first = said(await run(hob, "hob", "show_assistant", {})).split("\n");
      expect(first).toHaveLength(21);
      expect(first.at(-1)).toBe(`第 1/${pages} 页，共 ${total} 个；看下一页填 page=2`);
      const last = said(await run(hob, "hob", "show_assistant", { page: pages })).split("\n");
      expect(last).toHaveLength(total - (pages - 1) * 20 + 1);
      expect(last.at(-1)).toBe(`共 ${total} 个`);
      // 超出页数按最后一页给
      expect(said(await run(hob, "hob", "show_assistant", { page: 99 }))).toBe(last.join("\n"));
    } finally { hob.close(); }
  });

  it("query 匹配名字、id、职责和说明，不分大小写；找不到写清楚", async () => {
    const { hob } = setup();
    try {
      const write = hob.runtime.store.assistant("write")!;
      hob.runtime.store.saveAssistant({ ...write, instructions: "标题不超过 20 字" });
      expect(said(await run(hob, "hob", "show_assistant", { query: "OPS" }))).toContain("服务器（ops）：机器");
      expect(said(await run(hob, "hob", "show_assistant", { query: "周报" }))).toContain("写作（write）");
      expect(said(await run(hob, "hob", "show_assistant", { query: "标题" }))).toContain("写作（write）");
      expect(said(await run(hob, "hob", "show_assistant", { query: "没有这个东西" }))).toBe("没有找到含「没有这个东西」的助手");
    } finally { hob.close(); }
  });

  it("看完整资料：职责、说明、模型、能力、知识库、规则、定时、技能", async () => {
    const { hob } = setup();
    try {
      const collection = await hob.runtime.knowledge.createCollection("产品文档");
      const write = hob.runtime.store.assistant("write")!;
      hob.runtime.store.saveAssistant({
        ...write,
        dutyLong: "每周写周报。",
        instructions: "标题不超过 20 字",
        models: { conversation: { ref: "hob-faux/faux-1", thinking: "off" } },
        abilities: { exec: false, write: true, image: true },
        knowledge: [collection.id],
      });
      hob.runtime.store.saveRules("write", [{ id: "r-1", text: "发公众号", mode: "ask", changedAt: write.createdAt }, { id: "r-2", text: "查日志", mode: "allow", changedAt: write.createdAt }]);
      const routine = hob.runtime.routines.create({ assistantId: "write", name: "周报", instruction: "写本周周报", schedules: ["0 17 * * 5"] });
      hob.runtime.routines.update(routine.id, { active: false });
      saveAssistantSkill(hob.home, "write", { name: "weekly", title: "每周周报", description: "写周报", content: "步骤" });

      const text = said(await run(hob, "hob", "show_assistant", { assistantId: "write" }));
      expect(text).toContain("写作（write）");
      expect(text).toContain("职责：周报和文章");
      expect(text).toContain("详细职责：每周写周报。");
      expect(text).toContain("说明：标题不超过 20 字");
      expect(text).toContain("对话模型：hob-faux/faux-1 · 思考 关闭");
      expect(text).toContain("任务模型：跟随设置");
      expect(text).toContain("能力：修改文件、图像生成");
      expect(text).toContain(`知识库：产品文档（${collection.id}）`);
      expect(text).toContain("- r-1 · 执行前确认 · 发公众号");
      expect(text).toContain("- r-2 · 直接执行 · 查日志");
      expect(text).toContain(`- ${routine.id} · 周报 · 每周五 17:00 · 已暂停 · 写本周周报`);
      expect(text).toContain("- weekly「每周周报」· 已启用");
      expect(said(await run(hob, "hob", "show_assistant", { assistantId: "nope" }))).toBe("没有这个助手：nope");
      const plain = said(await run(hob, "hob", "show_assistant", { assistantId: "ops" }));
      expect(plain).toContain("规则：没有");
      expect(plain).toContain("定时任务：没有");
      expect(plain).toContain("技能：没有");
    } finally { hob.close(); }
  });
});

describe("show_group", () => {
  it("列出全部群，带群主、成员、工作方式和进行中的话题数；query 按群名、成员和话题名找", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "导出筛选", "user");
      hob.runtime.groups.closeByOwner(topic.id, undefined);
      hob.runtime.groups.createTopic(group.id, "相册备份", "user");
      const lines = said(await run(hob, "hob", "show_group", {})).split("\n");
      expect(lines).toContain(`交付小组（${group.id}）：群主 Hob；成员 Hob、服务器、写作；工作方式 软件开发；进行中的话题 1 个`);
      expect(lines.at(-1)).toMatch(/^共 \d+ 个$/);
      expect(said(await run(hob, "hob", "show_group", { query: "服务器" }))).toContain("交付小组");
      expect(said(await run(hob, "hob", "show_group", { query: "相册" }))).toContain("交付小组");
      expect(said(await run(hob, "hob", "show_group", { query: "不存在的" }))).toBe("没有找到含「不存在的」的群");
      // 没工作方式、没进行中的话题，就不写那两段
      hob.runtime.groups.create({ name: "闲聊", purpose: "闲聊", ownerId: "hob", members: ["hob"] });
      expect(said(await run(hob, "hob", "show_group", { query: "闲聊" }))).toMatch(/^闲聊（g-\w+）：群主 Hob；成员 Hob\n共 1 个$/);
    } finally { hob.close(); }
  });

  it("群详情：负责什么、群主、成员、工作方式、话题和事项进度、消息", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "导出筛选", "user");
      say(hob, topic.id, "导出要能按月筛选");
      const project = hob.runtime.projects.open({ group: hob.runtime.store.group(topic.id)!, ownerId: "hob", title: "按月筛选导出" });
      hob.runtime.projects.writeRequirements(topic.id, project.id, { content: "加一个月筛选", acceptance: ["能按月筛选"] });
      hob.runtime.projects.plan(topic.id, project.id, [
        { title: "加筛选", assignee: "ops", brief: "加一个月份筛选" },
        { title: "验收", assignee: "write", brief: "验一遍", after: [1], check: true },
      ]);
      say(hob, group.id, "大家好");
      say(hob, group.id, "这个月先做导出");
      const text = said(await run(hob, "hob", "show_group", { groupId: group.id }));
      expect(text).toContain(`交付小组（${group.id}）`);
      expect(text).toContain("负责什么：一起做软件");
      expect(text).toContain("群主：Hob");
      expect(text).toContain("成员：Hob、服务器、写作");
      expect(text).toContain("工作方式：软件开发");
      expect(text).toContain(`- 导出筛选（${topic.id}）· 进行中 · 事项「按月筛选导出」· 任务拆分 · 子任务 0/2`);
      expect(text).toContain("消息：");
      expect(text).toMatch(/\[\d+月\d+日 \d{2}:\d{2}\] 用户：这个月先做导出/);
      expect(text.split("\n").at(-1)).toBe("共 3 条");
      // 话题详情
      const topicText = said(await run(hob, "hob", "show_group", { groupId: topic.id }));
      expect(topicText).toContain(`导出筛选（${topic.id}）`);
      expect(topicText).toContain(`所属的群：交付小组（${group.id}）`);
      expect(topicText).toContain("状态：进行中");
      expect(topicText).toContain("事项：「按月筛选导出」· 任务拆分 · 子任务 0/2");
      expect(topicText).toContain("用户：导出要能按月筛选");
      expect(said(await run(hob, "hob", "show_group", { groupId: "nope" }))).toBe("没有这个群：nope");
    } finally { hob.close(); }
  });

  it("消息第 1 页是最近的 20 条，往后越来越早", async () => {
    const { hob, group } = setup();
    try {
      for (let i = 0; i < 25; i += 1) say(hob, group.id, `第 ${i} 条`);
      const first = said(await run(hob, "hob", "show_group", { groupId: group.id })).split("\n");
      expect(first.at(-1)).toBe("第 1/2 页，共 25 条；看下一页填 page=2");
      expect(first.join("\n")).toContain("用户：第 24 条");
      expect(first.join("\n")).toContain("用户：第 5 条");
      expect(first.join("\n")).not.toContain("用户：第 4 条");
      const older = said(await run(hob, "hob", "show_group", { groupId: group.id, page: 2 })).split("\n");
      expect(older.join("\n")).toContain("用户：第 0 条");
      expect(older.join("\n")).not.toContain("用户：第 24 条");
      expect(older.at(-1)).toBe("共 25 条");
    } finally { hob.close(); }
  });

  it("跨话题搜消息：新的在前，每行带综合或话题名", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "相册备份", "user");
      say(hob, group.id, "综合里提的备份");
      await new Promise((resolve) => setTimeout(resolve, 5));
      say(hob, topic.id, "话题里的备份");
      await new Promise((resolve) => setTimeout(resolve, 5));
      say(hob, topic.id, "别的话");
      const lines = said(await run(hob, "hob", "show_group", { groupId: group.id, query: "备份" })).split("\n");
      expect(lines).toHaveLength(4);
      expect(lines[0]).toMatch(/\] 用户（相册备份）：话题里的备份$/);
      expect(lines[1]).toMatch(/\] 用户（综合）：综合里提的备份$/);
      // 卡片类条目写一句它是什么
      expect(lines[2]).toMatch(/\] 用户（综合）：开了话题「相册备份」$/);
      expect(lines[3]).toBe("共 3 条");
      expect(said(await run(hob, "hob", "show_group", { groupId: group.id, query: "没有" }))).toBe("没有找到含「没有」的消息");
      // 话题 id 只找这个话题
      const only = said(await run(hob, "hob", "show_group", { groupId: topic.id, query: "备份" }));
      expect(only).toContain("（相册备份）");
      expect(only).not.toContain("（综合）");
    } finally { hob.close(); }
  });
});

describe("create_assistant", () => {
  it("直接建好，卡片是已创建，返回不结束这一轮；建失败说清原因", async () => {
    const { hob } = setup();
    try {
      const result = await run(hob, "hob", "create_assistant", {
        name: "记账管家", duty: "账单和预算", dutyLong: "记流水，月底出报表。", sprite: "coin", facts: ["记在 ~/账本"], conversations: 0,
      });
      const draft = hob.runtime.store.drafts().find((item) => item.name === "记账管家")!;
      expect(draft.status).toBe("created");
      expect(result.terminate).toBeUndefined();
      expect(said(result)).toBe(`已建好助手「记账管家」（${draft.createdAssistantId}）。`);
      expect(hob.runtime.store.assistant(draft.createdAssistantId!)?.instructions).toBe("记在 ~/账本");
      // 同名的已经有了（id 撞上）：把原因返回，草稿留着让用户在卡上点
      const dup = await run(hob, "hob", "create_assistant", { name: "ops", duty: "周报", dutyLong: "写周报。", sprite: "page", facts: ["负责周报"] });
      expect(dup.isError).toBe(true);
      expect(said(dup)).toBe("创建失败：已存在名称为「ops」的助手。草稿卡还在，可以在卡上点「创建」。");
      expect(hob.runtime.store.drafts().find((item) => item.name === "ops")).toMatchObject({ status: "pending" });
    } finally { hob.close(); }
  });
});

describe("update_assistant", () => {
  it("只改填了的项，返回改了哪几项，对话里落一行", async () => {
    const { hob } = setup();
    try {
      const result = await run(hob, "hob", "update_assistant", {
        assistantId: "write",
        name: "写稿搭子",
        duty: "写稿和文章一样长的小字",
        instructions: "标题不超过 20 字",
        pinned: true,
        hidden: false,
        notify: false,
      });
      expect(said(result)).toBe("已修改助手「写稿搭子」：名字、职责、说明、置顶、需要确认时通知。");
      expect(hob.runtime.store.assistant("write")).toMatchObject({ name: "写稿搭子", duty: "写稿和文章一样长", instructions: "标题不超过 20 字", pinned: true, notify: false });
      expect(hobNotes(hob)).toContain("已修改助手「写稿搭子」：名字、职责、说明、置顶、需要确认时通知");
      // 没填、或者和现在一样的项不算改动
      expect(said(await run(hob, "hob", "update_assistant", { assistantId: "write", name: "写稿搭子" }))).toBe("没有要改的项：至少填一项和现在不一样的。");
      expect(said(await run(hob, "hob", "update_assistant", { assistantId: "nope", name: "x" }))).toBe("没有这个助手：nope");
    } finally { hob.close(); }
  });

  it("模型填 ref 沿用现在的思考档，default 跟随设置；不在名单里的列出能填的", async () => {
    const { hob } = setup();
    try {
      const release = vi.spyOn(hob.runtime.router, "releaseSessions");
      expect(said(await run(hob, "hob", "update_assistant", { assistantId: "write", conversationModel: "hob-faux/faux-1" }))).toBe("已修改助手「写作」：对话模型。");
      expect(hob.runtime.store.assistant("write")?.models?.conversation).toEqual({ ref: "hob-faux/faux-1", thinking: "off" });
      expect(release).toHaveBeenCalled();
      expect(said(await run(hob, "hob", "update_assistant", { assistantId: "write", conversationModel: "default" }))).toBe("已修改助手「写作」：对话模型。");
      expect(hob.runtime.store.assistant("write")?.models?.conversation).toBeUndefined();
      const bad = await run(hob, "hob", "update_assistant", { assistantId: "write", workModel: "nope/nope" });
      expect(bad.isError).toBe(true);
      expect(said(bad)).toBe("模型 nope/nope 不在模型列表中。能填的模型：hob-faux/faux-1");
    } finally { hob.close(); }
  });

  it("能力、知识库整体替换；知识库不存在时原样报错", async () => {
    const { hob } = setup();
    try {
      const collection = await hob.runtime.knowledge.createCollection("产品文档");
      expect(said(await run(hob, "hob", "update_assistant", { assistantId: "write", abilities: { exec: false, write: true, image: false }, knowledge: [collection.id] }))).toBe("已修改助手「写作」：能力、知识库。");
      expect(hob.runtime.store.assistant("write")).toMatchObject({ abilities: { exec: false, write: true, image: false }, knowledge: [collection.id] });
      expect(said(await run(hob, "hob", "update_assistant", { assistantId: "write", knowledge: ["kc-nope"] }))).toBe("知识库不存在。");
      expect(hob.runtime.store.assistant("write")?.knowledge).toEqual([collection.id]);
    } finally { hob.close(); }
  });
});

describe("create_group", () => {
  it("建好群，返回名字和 id；校验报错原话照旧", async () => {
    const { hob } = setup();
    try {
      const result = await run(hob, "hob", "create_group", { name: "家里设备", purpose: "NAS 和设备", members: ["ops"], ownerId: "ops", workflow: "software" });
      const created = hob.runtime.store.groups().find((group) => group.name === "家里设备")!;
      expect(said(result)).toBe(`已建好群「家里设备」（${created.id}）。`);
      expect(created).toMatchObject({ ownerId: "ops", members: ["ops"], workflow: "software" });
      expect(hobNotes(hob)).toContain("已建好群「家里设备」");
      expect(hob.runtime.router.items("hob").items).toContainEqual(expect.objectContaining({ kind: "note", text: "已建好群「家里设备」", targetGroupId: created.id }));
      expect(said(await run(hob, "hob", "create_group", { name: "空群", purpose: "没人", members: [], ownerId: "ops" }))).toBe("群里至少要有一个助手");
      expect(said(await run(hob, "hob", "create_group", { name: "错群主", purpose: "不在里面", members: ["ops"], ownerId: "write" }))).toBe("群主要在成员里");
    } finally { hob.close(); }
  });
  it("模型把没用的项填成空串或 none：当没填，建成普通群；乱填的工作方式说清怎么填", async () => {
    const { hob } = setup();
    try {
      for (const [name, workflow] of [["空串群", ""], ["无群", "none"]] as const) {
        expect(said(await run(hob, "hob", "create_group", { name, purpose: "试试", members: ["ops"], ownerId: "ops", workflow }))).toContain("已建好群");
        expect(hob.runtime.store.groups().find((group) => group.name === name)?.workflow).toBeUndefined();
      }
      expect(said(await run(hob, "hob", "create_group", { name: "错的", purpose: "试试", members: ["ops"], ownerId: "ops", workflow: "agile" }))).toBe("workflow 要填 software（软件开发），普通群不填，收到「agile」。");
      const plain = hob.runtime.store.groups().find((group) => group.name === "无群")!;
      const result = await run(hob, "hob", "update_group", { groupId: plain.id, name: "", purpose: "", addMembers: [], removeMembers: [], ownerId: "", workflow: "software" });
      expect(said(result)).toBe("已修改群「无群」：工作方式。");
      expect(said(await run(hob, "hob", "update_group", { groupId: plain.id, name: "", workflow: "" }))).toBe("没有要改的项：至少填一项和现在不一样的。");
    } finally { hob.close(); }
  });
});

describe("update_group", () => {
  it("加减成员、换群主：返回改了哪几项，对话和群各落一行", async () => {
    const { hob, group } = setup();
    try {
      expect(said(await run(hob, "hob", "update_group", { groupId: group.id, addMembers: ["net"], removeMembers: ["write"], ownerId: "ops" }))).toBe("助手不存在或已归档：net");
      addAssistant(hob, "net", "网络", "家庭网络");
      expect(said(await run(hob, "hob", "update_group", { groupId: group.id, addMembers: ["net"], removeMembers: ["write"], ownerId: "ops" }))).toBe("已修改群「交付小组」：成员、群主。");
      expect(hob.runtime.store.group(group.id)).toMatchObject({ members: ["hob", "ops", "net"], ownerId: "ops" });
      expect(hobNotes(hob)).toContain("已把网络拉进交付小组；把写作移出交付小组；把交付小组的群主换成服务器");
      expect(notesOf(hob, group.id)).toContain("Hob 把网络拉进了群；把写作移出了群；群主换成服务器");
      expect(hob.runtime.router.items("hob").items).toContainEqual(expect.objectContaining({ kind: "note", targetGroupId: group.id, text: "已把网络拉进交付小组；把写作移出交付小组；把交付小组的群主换成服务器" }));
      expect(hob.runtime.store.groupItems(group.id)).toContainEqual(expect.objectContaining({ kind: "note", targetGroupId: group.id, text: "Hob 把网络拉进了群；把写作移出了群；群主换成服务器" }));
    } finally { hob.close(); }
  });

  it("同一条时间线只落一行：在本群会话说改这个群", async () => {
    const { hob, group } = setup();
    try {
      await run(hob, "hob", "update_group", { groupId: group.id, name: "敏捷小团队" }, group.id);
      expect(hobNotes(hob).filter((text) => text.includes("群名改成"))).toHaveLength(0);
      expect(notesOf(hob, group.id).filter((text) => text.includes("群名改成"))).toEqual(["Hob 把群名改成「敏捷小团队」"]);
      expect(hob.runtime.store.groupItems(group.id)).toContainEqual(expect.objectContaining({ kind: "note", text: "Hob 把群名改成「敏捷小团队」", targetGroupId: group.id }));
      // 在群会话里改群：只有群时间线那一行；在自己的对话里改：两边各一行，对话那行带群名
      addAssistant(hob, "net", "网络", "家庭网络");
      await run(hob, "hob", "update_group", { groupId: group.id, addMembers: ["net"] });
      expect(hobNotes(hob)).toEqual(["已把网络拉进敏捷小团队"]);
      expect(notesOf(hob, group.id)).toContain("Hob 把网络拉进了群");
    } finally { hob.close(); }
  });

  it("话题 id 说清楚不是群；workflow 能改成 none，有没结束的事项时拦住", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "导出筛选", "user");
      expect(said(await run(hob, "hob", "update_group", { groupId: topic.id, name: "改名" }))).toBe(`${topic.id} 是话题，不是群；改话题名用 manage_topic。`);
      expect(said(await run(hob, "hob", "update_group", { groupId: group.id, workflow: "none" }))).toBe("已修改群「交付小组」：工作方式。");
      expect(hob.runtime.store.group(group.id)?.workflow).toBeUndefined();
      expect(said(await run(hob, "hob", "update_group", { groupId: group.id, workflow: "nope" }))).toBe("workflow 要填 software（软件开发）或 none（普通群），收到「nope」。");
      expect(said(await run(hob, "hob", "update_group", { groupId: "nope", name: "x" }))).toBe("没有这个群：nope");
      // 有没结束的事项时不能改工作方式
      hob.runtime.groups.update(group.id, { workflow: "software" });
      hob.runtime.projects.open({ group: hob.runtime.store.group(topic.id)!, ownerId: "hob", title: "按月筛选导出" });
      expect(said(await run(hob, "hob", "update_group", { groupId: group.id, workflow: "none" }))).toBe("这个群还有没结束的事项，结束以后才能改工作方式");
    } finally { hob.close(); }
  });
});

describe("manage_topic", () => {
  it("open：不是群主也能开，不转消息；在本群会话说开这个群的话题时让用 open_topic", async () => {
    const { hob, group } = setup();
    try {
      const other = hob.runtime.groups.create({ name: "家里设备", purpose: "设备", ownerId: "ops", members: ["ops"] });
      const result = await run(hob, "hob", "manage_topic", { action: "open", groupId: other.id, title: "NAS 备份" });
      const topic = hob.runtime.store.groups().find((item) => item.name === "NAS 备份")!;
      expect(said(result)).toBe(`已开话题「NAS 备份」（${topic.id}）。`);
      expect(topic.parentId).toBe(other.id);
      // 没有把用户的话转进去
      expect(hob.runtime.groups.timeline(other.id).filter((item) => item.kind === "user")).toHaveLength(0);
      expect(notesOf(hob, other.id)).toContain("Hob 开了话题「NAS 备份」");
      expect(hobNotes(hob)).toContain("已开话题「NAS 备份」");
      expect(hob.runtime.router.items("hob").items).toContainEqual(expect.objectContaining({ kind: "note", text: "已开话题「NAS 备份」", targetGroupId: other.id }));
      expect(hob.runtime.store.groupItems(other.id)).toContainEqual(expect.objectContaining({ kind: "note", text: "Hob 开了话题「NAS 备份」", targetGroupId: other.id }));
      // Hob 是这个群的群主，又在这个群的会话里
      expect(said(await run(hob, "hob", "manage_topic", { action: "open", groupId: group.id, title: "新话题" }, group.id))).toBe("在这个群开话题用 open_topic，它会把用户的原话转进话题。");
    } finally { hob.close(); }
  });

  it("close / reopen / rename，以及有没结束事项不能关", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "导出筛选", "user");
      const project = hob.runtime.projects.open({ group: hob.runtime.store.group(topic.id)!, ownerId: "hob", title: "按月筛选导出" });
      expect(said(await run(hob, "hob", "manage_topic", { action: "close", topicId: topic.id }))).toBe("话题「导出筛选」里的事项「按月筛选导出」还没结束，事项由群主「Hob」结束。");
      hob.runtime.projects.close(topic.id, project.id, "done", "做完了");
      expect(said(await run(hob, "hob", "manage_topic", { action: "close", topicId: topic.id, note: "筛选做完了" }))).toBe("已关闭话题「导出筛选」。");
      expect(hob.runtime.store.group(topic.id)).toMatchObject({ closeNote: "筛选做完了" });
      expect(notesOf(hob, group.id)).toContain("Hob 关闭了话题「导出筛选」");
      expect(said(await run(hob, "hob", "manage_topic", { action: "reopen", topicId: topic.id }))).toBe("已重开话题「导出筛选」。");
      expect(hob.runtime.store.group(topic.id)?.closedAt).toBeUndefined();
      expect(notesOf(hob, group.id)).toContain("Hob 重开了话题「导出筛选」");
      expect(said(await run(hob, "hob", "manage_topic", { action: "rename", topicId: topic.id, title: "导出按月筛选" }))).toBe("已把话题改名为「导出按月筛选」。");
      expect(hob.runtime.store.group(topic.id)?.name).toBe("导出按月筛选");
      expect(notesOf(hob, group.id)).toContain("Hob 把话题改名为「导出按月筛选」");
      for (const text of ["已关闭话题「导出筛选」", "已重开话题「导出筛选」", "已把话题改名为「导出按月筛选」"]) {
        expect(hob.runtime.router.items("hob").items).toContainEqual(expect.objectContaining({ kind: "note", text, targetGroupId: group.id }));
      }
      for (const text of ["Hob 关闭了话题「导出筛选」", "Hob 重开了话题「导出筛选」", "Hob 把话题改名为「导出按月筛选」"]) {
        expect(hob.runtime.store.groupItems(group.id)).toContainEqual(expect.objectContaining({ kind: "note", text, targetGroupId: group.id }));
      }
      expect(said(await run(hob, "hob", "manage_topic", { action: "close", topicId: "nope" }))).toBe("没有这个话题：nope");
      expect(said(await run(hob, "hob", "manage_topic", { action: "open", groupId: "nope", title: "x" }))).toBe("没有这个群：nope");
      expect(said(await run(hob, "hob", "manage_topic", { action: "rename", topicId: group.id, title: "改名" }))).toBe(`${group.id} 是群，不是话题；改群名用 update_group。`);
      expect(said(await run(hob, "hob", "manage_topic", { action: "啥", topicId: topic.id }))).toBe("action 要填 open、close、reopen 或 rename，收到「啥」。");
    } finally { hob.close(); }
  });
});

describe("七个老工具带 assistantId", () => {
  it("规则、定时、技能改的是那个助手的", async () => {
    const { hob } = setup();
    try {
      expect(said(await run(hob, "hob", "set_rule", { text: "发公众号", mode: "ask", assistantId: "write" }))).toBe("已记录规则。");
      expect(hob.runtime.store.rules("write")).toMatchObject([{ text: "发公众号", mode: "ask" }]);
      expect(hob.runtime.store.rules("hob")).toEqual([]);
      expect(hobNotes(hob)).toContain("已记入写作的规则 · 发公众号");

      await run(hob, "hob", "create_routine", { name: "周报", instruction: "写周报", schedules: ["0 17 * * 5"], assistantId: "write" });
      const created = hob.runtime.store.routines().find((item) => item.name === "周报")!;
      expect(created.assistantId).toBe("write");
      expect(said(await run(hob, "hob", "update_routine", { routineId: created.id, name: "每周周报", assistantId: "write" }))).toContain("已修改");
      expect(hob.runtime.store.routine(created.id)?.name).toBe("每周周报");
      expect(said(await run(hob, "hob", "delete_routine", { routineId: created.id, assistantId: "write" }))).toBe("已删除「每周周报」。「写作」现在没有定时任务了。");
      expect(hob.runtime.store.routine(created.id)).toBeUndefined();

      saveAssistantSkill(hob.home, "write", { name: "weekly", title: "每周周报", description: "写周报", content: "步骤一" });
      expect(said(await run(hob, "hob", "edit_skill", { name: "weekly", edits: [{ old: "步骤一", new: "步骤二" }], assistantId: "write" }))).toBe("已更新技能「每周周报」，第 2 版。");
      expect(said(await run(hob, "hob", "delete_skill", { name: "weekly", assistantId: "write" }))).toContain("已删除技能");
      expect(await run(hob, "hob", "set_rule", { text: "别的", mode: "ask", assistantId: "nope" })).toMatchObject({ isError: true, content: [{ text: "没有这个助手：nope" }] });
      expect(said(await run(hob, "hob", "remove_rule", { ruleId: "r-x", assistantId: "write" }))).toBe("没有这条规则。");
    } finally { hob.close(); }
  });

  it("不填 assistantId 还是自己的", async () => {
    const { hob } = setup();
    try {
      await run(hob, "hob", "set_rule", { text: "重启服务", mode: "allow" });
      expect(hob.runtime.store.rules("hob")).toMatchObject([{ text: "重启服务", mode: "allow" }]);
      expect(hob.runtime.store.rules("write")).toEqual([]);
      expect(hobNotes(hob)).toContain("已记入Hob的规则 · 重启服务");
    } finally { hob.close(); }
  });
});

describe("系统提示词", () => {
  it("「助手」每行不带详细职责，最后是管理那段；「群」一节列群主和成员", () => {
    const { hob, group } = setup();
    try {
      const write = hob.runtime.store.assistant("write")!;
      hob.runtime.store.saveAssistant({ ...write, dutyLong: "每周写周报。" });
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", { timezone, aboutYou, memory: "off" });
      expect(prompt).toContain("\n- 服务器（ops）：机器\n");
      expect(prompt).toContain("\n- 写作（write）：周报和文章\n");
      expect(prompt).not.toContain("周报和文章。每周写周报。");
      expect(prompt).toContain(ADMIN_LINE);
      expect(ADMIN_LINE).toBe("助手、群和话题，你都能直接建和改，和用户在界面上操作一样。用户要你改的，直接改，改完说一句改了什么。你自己觉得该改的，比如同类的事反复出现又没有合适的助手管、某个群缺了该在的成员，先跟用户说你的想法，用户同意了再改。归档助手和群由用户在界面上操作。");
      expect(prompt).toContain(`\n## 群\n`);
      expect(prompt).toContain(`- 交付小组（${group.id}）：群主 Hob；成员 Hob、服务器、写作`);
      expect(prompt).not.toContain("propose_assistant");
      // 话题不列；别的助手的提示词里没有这两节
      hob.runtime.groups.createTopic(group.id, "导出筛选", "user");
      expect(buildSystemPrompt(hob.runtime.store, "hob", { timezone, aboutYou, memory: "off" })).not.toContain("导出筛选");
      expect(buildSystemPrompt(hob.runtime.store, "ops", { timezone, aboutYou, memory: "off" })).not.toContain("## 群");
    } finally { hob.close(); }
  });
});
