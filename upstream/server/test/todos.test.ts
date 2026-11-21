import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Approval, Assistant, Delegation, Group, GroupItem, Item, Job, TodoItem } from "../../shared/types.ts";
import { buildSystemPrompt, buildWorkerPrompt, TODOS_LINE } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { releaseIdleTodos, releaseIdleTodosAtStartup, TODO_REMINDER_ROUNDS } from "../src/todos.ts";
import { registerReportTool } from "../src/worker-tools.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

function addAssistant(hob: TestHob, id: string, name: string, duty: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty, primary: false, pinned: false, sprite: "page" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

function setup(): { hob: TestHob; group: Group } {
  const hob = makeHob({}, { memory: "off" });
  addAssistant(hob, "ops", "服务器", "机器");
  addAssistant(hob, "write", "写作", "周报");
  const group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob", "ops", "write"] });
  return { hob, group };
}

type Tool = ReturnType<typeof buildRouterTools>[number];

function toolOf(hob: TestHob, name: string, groupId?: string, assistantId = "hob"): Tool {
  const tool = buildRouterTools(hob.runtime, assistantId, groupId).find((item) => item.name === name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  return tool;
}

const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const isError = (result: { isError?: boolean }) => Boolean(result.isError);

/** 每项一句话：text + status。 */
const items = (...given: [string, "todo" | "doing" | "done"][]) => given.map(([text, status]) => ({ text, status }));

describe("update_todos", () => {
  it("整份替换，返回做完了几项", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const tool = toolOf(hob, "update_todos");
      const first = await tool.execute("t", { items: items(["查日志", "done"], ["改配置", "doing"], ["再验一遍", "todo"]) });
      expect(isError(first)).toBe(false);
      expect(textOf(first)).toBe("待办 1/3。");
      const second = await tool.execute("t", { items: items(["查日志", "done"], ["改配置", "done"], ["再验一遍", "todo"]) });
      expect(textOf(second)).toBe("待办 2/3。");
      expect(hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos).toEqual(items(["查日志", "done"], ["改配置", "done"], ["再验一遍", "todo"]));
    } finally { hob.close(); }
  });

  it("原来还有没做完的，传空列表就是清掉并记进历史", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const tool = toolOf(hob, "update_todos");
      await tool.execute("t", { items: items(["查日志", "doing"]) });
      const cleared = await tool.execute("t", { items: [] });
      expect(textOf(cleared)).toBe("待办清掉了。");
      expect(hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos).toEqual([]);
    } finally { hob.close(); }
  });

  it("text 空着、status 写错都逐字报错", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const tool = toolOf(hob, "update_todos");
      const empty = await tool.execute("t", { items: [{ text: "  ", status: "todo" }] });
      expect(isError(empty)).toBe(true);
      expect(textOf(empty)).toBe("第 1 项的 text 是空的：写这一项做什么。");
      const bad = await tool.execute("t", { items: [{ text: "查日志", status: "doing" }, { text: "改配置", status: "finished" }] });
      expect(isError(bad)).toBe(true);
      expect(textOf(bad)).toBe("第 2 项的 status 只能是 todo、doing、done，收到「finished」。");
      // 报错时原来的清单不动
      expect(hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos).toEqual([]);
    } finally { hob.close(); }
  });
});

describe("待办存在哪", () => {
  it("单聊存在助手目录下的 todos.json，摘要里带出来", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await toolOf(hob, "update_todos").execute("t", { items: items(["写早报", "doing"]) });
      const file = join(hob.home, "assistants", "hob", "todos.json");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(items(["写早报", "doing"]));
      expect(hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos).toEqual(items(["写早报", "doing"]));
    } finally { hob.close(); }
  });

  it("综合和话题各存在自己的群目录下", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "换硬盘", "user");
      await toolOf(hob, "update_todos", group.id).execute("t", { items: items(["问清型号", "todo"]) });
      await toolOf(hob, "update_todos", topic.id).execute("t", { items: items(["拆旧盘", "done"], ["装新盘", "doing"]) });
      expect(hob.runtime.groups.summary(group).todos).toEqual(items(["问清型号", "todo"]));
      expect(hob.runtime.groups.summary(topic).todos).toEqual(items(["拆旧盘", "done"], ["装新盘", "doing"]));
      expect(hob.runtime.store.group(group.id)).toBeDefined();
    } finally { hob.close(); }
  });

  it("同一个话题里两个成员读到的是同一份", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "换硬盘", "user");
      await toolOf(hob, "update_todos", topic.id, "hob").execute("t", { items: items(["拆旧盘", "doing"]) });
      // 另一个成员接着整份替换：后写的为准
      await toolOf(hob, "update_todos", topic.id, "ops").execute("t", { items: items(["拆旧盘", "done"], ["装新盘", "doing"]) });
      expect(hob.runtime.groups.summary(topic).todos).toEqual(items(["拆旧盘", "done"], ["装新盘", "doing"]));
      // 换一个人读也是同一份
      await toolOf(hob, "update_todos", topic.id, "write").execute("t", { items: items(["拆旧盘", "done"], ["装新盘", "done"], ["试机", "todo"]) });
      expect(hob.runtime.groups.summary(topic).todos).toEqual(items(["拆旧盘", "done"], ["装新盘", "done"], ["试机", "todo"]));
    } finally { hob.close(); }
  });
});

describe("删掉的工具和提示词", () => {
  it("任何会话都没有写说明、列待办、开始待办；都有 update_todos", () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "换硬盘", "user");
      for (const [gid, aid] of [[undefined, "hob"], [group.id, "hob"], [group.id, "ops"], [topic.id, "hob"], [topic.id, "ops"]] as const) {
        const names = buildRouterTools(hob.runtime, aid, gid).map((item) => item.name);
        for (const gone of ["write_brief", "plan_todos", "start_todos"]) expect(names, `${aid}@${gid ?? "私聊"}`).not.toContain(gone);
        expect(names, `${aid}@${gid ?? "私聊"}`).toContain("update_todos");
      }
    } finally { hob.close(); }
  });

  it("任务的 report 不再有 checks 参数", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const job: Job = { id: "t-report", assistantId: "hob", title: "整理资料", instruction: "", status: "running", createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
      hob.runtime.store.saveJob(job);
      const report = registerReportTool(hob.runtime, job.id);
      expect(Object.keys(report.parameters.properties)).toEqual(["outcome", "result", "files"]);
    } finally { hob.close(); }
  });

  it("提示词里有两段新的待办说明，没有删掉的几节", () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "换硬盘", "user");
      const settings = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      const single = buildSystemPrompt(hob.runtime.store, "hob", settings);
      expect(single).toContain(TODOS_LINE);
      expect(single).toContain("用 update_todos 列一份");
      // 任务那句：交给任务的一步就是这份里的一项，任务结束、看过结果再勾掉
      expect(single).toContain("待办记的是你自己这一路要做的步骤。交给后台任务的一步，就是你这份里的一项，任务结束、你查看过结果再勾掉。");
      // 转交那份由代码收起，提示词里不写
      expect(single).not.toContain("交给别的助手的那部分");
      const inTopic = buildSystemPrompt(hob.runtime.store, "hob", { ...settings, group: topic });
      for (const gone of ["plan_todos", "write_brief", "start_todos", "分给你的待办", "## 检查", "完成标准"]) expect(inTopic).not.toContain(gone);
      const job = { id: "t-prompt", assistantId: "hob", title: "整理", instruction: "", status: "done" as const, createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
      hob.runtime.store.saveJob(job);
      const worker = buildWorkerPrompt(hob.runtime.store, job.id, settings);
      // 待办只归助手：任务的提示词不讲待办
      expect(worker).not.toContain("update_todos");
      expect(worker).not.toContain("## 待办");
      expect(worker).not.toContain("## 检查");
    } finally { hob.close(); }
  });

  it("综合里的话题清单只写进行中和已关闭，有待办的加 k/n", async () => {
    const { hob, group } = setup();
    try {
      const doing = hob.runtime.groups.createTopic(group.id, "换硬盘", "user");
      const closed = hob.runtime.groups.createTopic(group.id, "相册备份", "user");
      await toolOf(hob, "update_todos", doing.id).execute("t", { items: items(["拆旧盘", "done"], ["装新盘", "doing"]) });
      hob.runtime.groups.closeByOwner(closed.id, "修好了");
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off", group });
      expect(prompt).toContain(`- 「换硬盘」（${doing.id}）· 进行中 · 待办 1/2 · `);
      expect(prompt).toContain(`- 「相册备份」（${closed.id}）· 已关闭 · `);
      expect(prompt).toContain("用户提的事和以前的话题有关，先用 show_group 看那个话题里当时怎么说的。");
    } finally { hob.close(); }
  });
});

describe("老数据", () => {
  it("群目录里有老的事项文件、时间线里有 kind 是 project 的条目，接口和界面都不报错", async () => {
    const { hob, group } = setup();
    try {
      mkdirSync(join(hob.home, "groups", group.id, "projects"), { recursive: true });
      writeFileSync(join(hob.home, "groups", group.id, "projects", "p-old.json"), JSON.stringify({ id: "p-old", groupId: group.id, title: "老的待办", stage: "doing", subtasks: [] }));
      const legacy: GroupItem = { kind: "project", speaker: "hob", id: "g-777", at: "", projectId: "p-old" } as unknown as GroupItem;
      hob.runtime.store.appendGroupItem(group.id, legacy);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(hob.runtime.groups.summary(group).todos).toEqual([]);
      expect(hob.runtime.groups.items(group.id).items).toContainEqual(expect.objectContaining({ kind: "project" }));
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    } finally { hob.close(); }
  });
});

describe("产品负责人的详细职责", () => {
  const OLD = "把用户的想法问清楚，写成需求说明和验收标准，拆成子任务分给合适的成员；做完以后对照验收标准验收。拿不准用户要什么时先问用户。";
  const NEW = "接住用户和定时任务带来的事，按分量安排：一个任务能完成的，自己分派任务或者请合适的成员执行，结果回来核对后再告诉用户；要几个人接力的，创建一个话题，在里面安排，完成后给用户一个结论。";;

  it("启动时把一字不差的旧默认职责换成新的，用户改过的不动", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "po", name: "产品负责人", primary: false, pinned: false, dutyLong: OLD });
      hob.runtime.store.saveAssistant({ ...base, id: "mine", name: "自定义", primary: false, pinned: false, dutyLong: "我自己写的职责" });
      // 启动时由 createRuntime 调用，这里直接跑一遍
      const { migrateProductOwnerDuty } = await import("../src/dev-team.ts");
      migrateProductOwnerDuty(hob.runtime.store);
      expect(hob.runtime.store.assistant("po")?.dutyLong).toBe(NEW);
      expect(hob.runtime.store.assistant("mine")?.dutyLong).toBe("我自己写的职责");
    } finally { hob.close(); }
  });

  it("新装的敏捷团队产品负责人就是新的一句", async () => {
    const { DEV_TEAM_ROLES } = await import("../src/dev-team.ts");
    expect(DEV_TEAM_ROLES[0]!.dutyLong).toBe(NEW);
  });
});

/** 会话文件里发给模型的用户消息（文字拉平）。 */
function userPrompts(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (entry.type !== "message" || entry.message?.role !== "user") return [];
      const content = entry.message.content;
      if (typeof content === "string") return [content];
      return [Array.isArray(content) ? content.map((part: { type?: string; text?: string }) => (part?.type === "text" ? part.text ?? "" : "")).join("") : ""];
    } catch {
      return [];
    }
  });
}

/** 时间线里收起的那几条待办。 */
function archivedTodos(items: Item[]): Extract<Item, { kind: "todos" }>[] {
  return items.filter((item): item is Extract<Item, { kind: "todos" }> => item.kind === "todos");
}

const todosFile = (hob: TestHob, assistantId = "hob") => join(hob.home, "assistants", assistantId, "todos.json");

function putTodos(path: string, items: [string, TodoItem["status"]][]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(items.map(([text, status]) => ({ text, status }))));
}

/** 手上还有一个在跑的任务：这份待办会一轮一轮留着（看提醒、看每轮带不带）。 */
function busyJob(hob: TestHob): void {
  const job: Job = { id: "t-busy", assistantId: "hob", title: "整理单据", instruction: "", status: "running", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
  hob.runtime.store.saveJob(job);
}

describe("转交时待办跟着走", () => {
  it("有没做完的：清空，并把待办附在交接说明后", async () => {
    const { hob } = setup();
    try {
      await toolOf(hob, "update_todos").execute("t", { items: items(["清点单据", "done"], ["按日期成表", "doing"], ["挑出重复的", "todo"]) });
      const result = await toolOf(hob, "message_assistant").execute("t", { assistantId: "ops", note: "继续整理单据。" });
      expect(textOf(result)).toBe("已转交给「服务器」。你手上那份待办（没做完 2 项）一起交过去了，已经清掉。");
      expect(hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos).toEqual([]);
      expect(JSON.parse(readFileSync(todosFile(hob), "utf8"))).toEqual([]);
      expect(archivedTodos(hob.runtime.router.items("hob").items)).toEqual([]);
      expect(hob.runtime.store.delegations()[0]!.text).toBe("继续整理单据。\n\n「Hob」转交前列过的待办，没做完的：\n· 按日期成表\n· 挑出重复的");
    } finally { hob.close(); }
  });

  it("没有待办：只传交接说明", async () => {
    const { hob } = setup();
    try {
      const result = await toolOf(hob, "message_assistant").execute("t", { assistantId: "ops", note: "没有额外背景。" });
      expect(textOf(result)).toBe("已转交给「服务器」。");
      expect(archivedTodos(hob.runtime.router.items("hob").items)).toEqual([]);
      expect(hob.runtime.store.delegations()[0]!.text).toBe("没有额外背景。");
    } finally { hob.close(); }
  });

  it("全做完了：那份已经清过，转交返回不变", async () => {
    const { hob } = setup();
    try {
      await toolOf(hob, "update_todos").execute("t", { items: items(["清点单据", "done"]) });
      const result = await toolOf(hob, "message_assistant").execute("t", { assistantId: "ops", note: "按已经约定的方式处理。" });
      expect(textOf(result)).toBe("已转交给「服务器」。");
      expect(archivedTodos(hob.runtime.router.items("hob").items)).toEqual([]);
    } finally { hob.close(); }
  });
});

describe("好几轮没更新的待办", () => {
  const lastPrompt = (hob: TestHob) => userPrompts(hob.runtime.store.routerFile("hob")).at(-1)!;
  const send = async (hob: TestHob, said: string) => {
    hob.faux.setResponses([text(`好：${said}`)]);
    await hob.runtime.router.send("hob", { text: said });
    await hob.runtime.router.waitIdle("hob");
  };

  it("到了 N 轮才在「手上的待办」后面接一句，之前不出", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      busyJob(hob);
      await toolOf(hob, "update_todos").execute("t", { items: items(["查日志", "doing"], ["改配置", "todo"]) });
      for (let i = 1; i < TODO_REMINDER_ROUNDS; i += 1) {
        await send(hob, `第 ${i} 句`);
        expect(lastPrompt(hob)).not.toContain("这份待办已经");
      }
      // 第 8 句这一轮之前已经回了 7 轮，还不够；第 9 句这一轮之前是 8 轮
      await send(hob, "第 8 句");
      expect(lastPrompt(hob)).not.toContain("这份待办已经");
      await send(hob, "第 9 句");
      const prompt = lastPrompt(hob);
      expect(prompt).toContain("手上的待办 0/2");
      expect(prompt).toContain(`这份待办已经 ${TODO_REMINDER_ROUNDS} 轮没更新了：做完的标成 done；这件事不做了或者换了一件，传空列表清掉，或者换成新的一份。`);
      // 提醒在待办那一段后面，不进系统提示词
      expect(prompt.indexOf("这份待办已经")).toBeGreaterThan(prompt.indexOf("手上的待办"));
      expect((await hob.runtime.router.ensure("hob")).session!.systemPrompt).not.toContain("这份待办已经");
    } finally { hob.close(); }
  });

  it("提醒过一次，再过 N 轮还没更新才再提醒", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      busyJob(hob);
      await toolOf(hob, "update_todos").execute("t", { items: items(["查日志", "doing"]) });
      for (let i = 1; i <= TODO_REMINDER_ROUNDS + 1; i += 1) await send(hob, `第 ${i} 句`);
      expect(lastPrompt(hob)).toContain("这份待办已经");
      for (let i = 1; i <= TODO_REMINDER_ROUNDS; i += 1) {
        await send(hob, `再来 ${i} 句`);
        expect(lastPrompt(hob)).not.toContain("这份待办已经");
      }
      await send(hob, "又一句");
      expect(lastPrompt(hob)).toContain("这份待办已经");
    } finally { hob.close(); }
  });

  it("没有没做完的项就不提醒", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      for (let i = 1; i <= TODO_REMINDER_ROUNDS + 1; i += 1) await send(hob, `第 ${i} 句`);
      expect(lastPrompt(hob)).not.toContain("这份待办已经");
    } finally { hob.close(); }
  });

  it("更新过就不再提醒", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      busyJob(hob);
      await toolOf(hob, "update_todos").execute("t", { items: items(["查日志", "doing"]) });
      for (let i = 1; i <= TODO_REMINDER_ROUNDS + 1; i += 1) await send(hob, `第 ${i} 句`);
      expect(lastPrompt(hob)).toContain("这份待办已经");
      await toolOf(hob, "update_todos").execute("t", { items: items(["查日志", "done"], ["改配置", "doing"]) });
      await send(hob, "接着做");
      expect(lastPrompt(hob)).not.toContain("这份待办已经");
    } finally { hob.close(); }
  });
});

describe("每轮带上手上的待办", () => {
  it("有待办时逐字带进用户消息，没有就不带，系统提示词里没有", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      // 手上还有一个在跑的任务：这份待办留到下一轮
      busyJob(hob);
      hob.faux.setResponses([call("update_todos", { items: items(["查日志", "done"], ["改配置", "doing"]) }), text("列好了")]);
      await hob.runtime.router.send("hob", { text: "帮我查" });
      await hob.runtime.router.waitIdle("hob");
      const state = await hob.runtime.router.ensure("hob");
      // 系统提示词每轮都一样，待办不进提示词
      expect(state.session!.systemPrompt).not.toContain("手上的待办");
      // 这一轮调工具时待办才建出来
      expect(userPrompts(hob.runtime.store.routerFile("hob")).at(-1)).not.toContain("手上的待办");

      hob.faux.setResponses([text("接着做")]);
      await hob.runtime.router.send("hob", { text: "继续" });
      await hob.runtime.router.waitIdle("hob");
      const prompt = userPrompts(hob.runtime.store.routerFile("hob")).at(-1)!;
      expect(prompt).toContain("手上的待办 1/2，刚刚更新：\n✓ 查日志\n→ 改配置");
      expect(prompt.indexOf("手上的待办")).toBeGreaterThan(prompt.indexOf("【现在】"));

      // 收起的进历史，不进上下文：清掉以后下一轮就不带了
      await toolOf(hob, "update_todos").execute("t", { items: [] });
      hob.faux.setResponses([text("好")]);
      await hob.runtime.router.send("hob", { text: "换一件事" });
      await hob.runtime.router.waitIdle("hob");
      expect(userPrompts(hob.runtime.store.routerFile("hob")).at(-1)).not.toContain("手上的待办");
    } finally { hob.close(); }
  });

  it("群里的成员这一轮也带同一份", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "换硬盘", "user");
      await toolOf(hob, "update_todos", topic.id).execute("t", { items: items(["拆旧盘", "done"], ["装新盘", "doing"]) });
      hob.faux.setResponses([text("接着装")]);
      await hob.runtime.groups.appendItem(topic.id, "user", { kind: "user", text: "装好了吗" });
      await hob.runtime.groups.deliverEvent(topic.id, "hob", "用户问了一句");
      await hob.runtime.router.waitIdle("hob", 15_000, topic.id);
      const prompt = userPrompts(hob.runtime.store.groupMemberFile(topic.id, "hob")).at(-1)!;
      expect(prompt).toContain("手上的待办 1/2，刚刚更新：\n✓ 拆旧盘\n→ 装新盘");
    } finally { hob.close(); }
  });

  it("任务没有待办：补充要求那一轮也不带", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "第一轮" }), text("做完一轮")]);
      const job = await hob.runtime.jobs.start("hob", { title: "整理资料", instruction: "整理资料" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      hob.faux.setResponses([call("report", { outcome: "done", result: "第二轮" }), text("做完第二轮")]);
      await hob.runtime.jobs.reply(job.id, "再查一遍");
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      const prompt = userPrompts(hob.runtime.store.workerFile(job.id)).at(-1)!;
      expect(prompt).toContain("再查一遍");
      expect(prompt).not.toContain("手上的待办");
    } finally { hob.close(); }
  });
});

describe("一份待办有头有尾", () => {
  it("全做完了：清空当前那份，不往时间线写", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const tool = toolOf(hob, "update_todos");
      await tool.execute("t", { items: items(["查日志", "done"], ["改配置", "doing"]) });
      const result = await tool.execute("t", { items: items(["查日志", "done"], ["改配置", "done"]) });
      expect(textOf(result)).toBe("待办 2/2，都做完了，已经清掉。");
      expect(hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos).toEqual([]);
      expect(JSON.parse(readFileSync(todosFile(hob), "utf8"))).toEqual([]);
      // 收起的待办不进对话：时间线里一条也没有
      expect(archivedTodos(hob.runtime.router.items("hob").items)).toEqual([]);
    } finally { hob.close(); }
  });

  it("清掉了：清空当前那份，不往时间线写", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const tool = toolOf(hob, "update_todos");
      await tool.execute("t", { items: items(["查日志", "done"], ["改配置", "doing"], ["再验一遍", "todo"]) });
      const result = await tool.execute("t", { items: [] });
      expect(textOf(result)).toBe("待办清掉了。");
      expect(hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos).toEqual([]);
      expect(archivedTodos(hob.runtime.router.items("hob").items)).toEqual([]);
    } finally { hob.close(); }
  });

  it("全做完以后再传空列表：不另记一条", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const tool = toolOf(hob, "update_todos");
      await tool.execute("t", { items: items(["查日志", "done"]) });
      const empty = await tool.execute("t", { items: [] });
      expect(textOf(empty)).toBe("待办清掉了。");
      expect(archivedTodos(hob.runtime.router.items("hob").items)).toHaveLength(0);
    } finally { hob.close(); }
  });

  it("话题关了：没做完的直接清掉，不进时间线", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "换硬盘", "user");
      await toolOf(hob, "update_todos", topic.id).execute("t", { items: items(["拆旧盘", "done"], ["装新盘", "doing"]) });
      hob.runtime.groups.closeByOwner(topic.id, "换完了");
      expect(hob.runtime.groups.summary(topic).todos).toEqual([]);
      expect(archivedTodos(hob.runtime.store.groupItems(topic.id))).toEqual([]);
    } finally { hob.close(); }
  });

  it("工具返回四种文字", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const tool = toolOf(hob, "update_todos");
      expect(textOf(await tool.execute("t", { items: items(["查日志", "doing"]) }))).toBe("待办 0/1。");
      expect(textOf(await tool.execute("t", { items: items(["查日志", "done"]) }))).toBe("待办 1/1，都做完了，已经清掉。");
      expect(textOf(await tool.execute("t", { items: items(["改配置", "doing"], ["再验一遍", "todo"]) }))).toBe("待办 0/2。");
      expect(textOf(await tool.execute("t", { items: [] }))).toBe("待办清掉了。");
      expect(textOf(await tool.execute("t", { items: [] }))).toBe("待办清掉了。");
    } finally { hob.close(); }
  });
});

describe("一轮结束时手上没活就收", () => {
  const todosOf = (hob: TestHob) => hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos ?? [];

  it("没有活：这一轮说完就收起，不进时间线，下一轮不再带", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      putTodos(todosFile(hob), [["盘一下日志", "done"], ["改成按天切", "todo"]]);
      hob.faux.setResponses([text("弄好了")]);
      await hob.runtime.router.send("hob", { text: "怎么样" });
      await hob.runtime.router.waitIdle("hob");
      expect(todosOf(hob)).toEqual([]);
      expect(JSON.parse(readFileSync(todosFile(hob), "utf8"))).toEqual([]);
      // 收起的待办不进对话
      expect(archivedTodos(hob.runtime.router.items("hob").items)).toEqual([]);
      // 下一轮不再带
      hob.faux.setResponses([text("换一件事")]);
      await hob.runtime.router.send("hob", { text: "再帮个忙" });
      await hob.runtime.router.waitIdle("hob");
      expect(userPrompts(hob.runtime.store.routerFile("hob")).at(-1)).not.toContain("手上的待办");
    } finally { hob.close(); }
  });

  it("事件那一轮也一样：事件说完手上没活就收", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      putTodos(todosFile(hob), [["等对方回话", "doing"]]);
      hob.faux.setResponses([text("知道了")]);
      await hob.runtime.router.event("hob", "任务「整理单据」做完了");
      await waitFor(() => todosOf(hob).length === 0);
    } finally { hob.close(); }
  });

  it("出错结束的那一轮不清，下一轮正常结束才收", async () => {
    const hob = makeHob({}, { memory: "off", retry: { maxRetries: 2, baseDelayMs: 1 } });
    try {
      putTodos(todosFile(hob), [["盘一下日志", "done"], ["改成按天切", "todo"]]);
      hob.faux.setResponses([0, 1, 2, 3].map(() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "上游 502" })));
      await hob.runtime.router.send("hob", { text: "在吗" });
      // 留了那行说明，就说明这一轮已经收尾了
      await waitFor(() => hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.text.includes("未能回复")));
      expect(todosOf(hob)).toEqual(items(["盘一下日志", "done"], ["改成按天切", "todo"]));
      hob.faux.setResponses([text("弄好了")]);
      await hob.runtime.router.send("hob", { text: "再试一次" });
      await hob.runtime.router.waitIdle("hob");
      expect(todosOf(hob)).toEqual([]);
    } finally { hob.close(); }
  });
});

describe("手上还有活就留着", () => {
  const todosOf = (hob: TestHob) => hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos ?? [];
  const topicTodos = (hob: TestHob, gid: string) => hob.runtime.groups.summary(gid).todos ?? [];
  const at = new Date().toISOString();

  it("在跑、排队或等待中的任务：任务结束就收", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const job: Job = { id: "t-busy", assistantId: "hob", title: "切日志", instruction: "", status: "running", createdAt: at, startedAt: at, stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
      hob.runtime.store.saveJob(job);
      for (const status of ["running", "queued", "waiting"] as const) {
        hob.runtime.store.saveJob({ ...job, status });
        putTodos(todosFile(hob), [["改成按天切", "doing"]]);
        releaseIdleTodos(hob.runtime, "hob");
        expect(todosOf(hob), status).toEqual(items(["改成按天切", "doing"]));
      }
      hob.runtime.store.saveJob({ ...job, status: "done", endedAt: at });
      releaseIdleTodos(hob.runtime, "hob");
      expect(todosOf(hob)).toEqual([]);
      // 别的助手单聊里的任务不是这个会话的
      putTodos(todosFile(hob), [["改成按天切", "doing"]]);
      hob.runtime.store.saveJob({ ...job, id: "t-other", assistantId: "ops", status: "running" });
      releaseIdleTodos(hob.runtime, "hob");
      expect(todosOf(hob)).toEqual([]);
    } finally { hob.close(); }
  });

  it("从这个会话发出、还没结束的转交：转交结束就收", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      for (const status of ["running", "waiting"] as const) {
        const record: Delegation = { id: `dg-${status}`, from: "hob", to: "ops", text: "整理单据", createdAt: at, status, jobIds: [] };
        hob.runtime.store.saveDelegation(record);
        putTodos(todosFile(hob), [["等对方回话", "doing"]]);
        releaseIdleTodos(hob.runtime, "hob");
        expect(todosOf(hob), status).toEqual(items(["等对方回话", "doing"]));
        hob.runtime.store.saveDelegation({ ...record, status: "done", endedAt: at, reportedAt: at });
        releaseIdleTodos(hob.runtime, "hob");
        expect(todosOf(hob), status).toEqual([]);
      }
    } finally { hob.close(); }
  });

  it("交给群、话题还没关的：话题关了才收", () => {
    const { hob, group } = setup();
    try {
      const { topic } = hob.runtime.groups.handOver(group.id, "对账出错", "hob", { text: "对账出错", files: [] });
      putTodos(todosFile(hob), [["等群的结论", "doing"]]);
      releaseIdleTodos(hob.runtime, "hob");
      expect(todosOf(hob)).toEqual(items(["等群的结论", "doing"]));
      hob.runtime.groups.closeByOwner(topic.id, "对上了");
      releaseIdleTodos(hob.runtime, "hob");
      expect(todosOf(hob)).toEqual([]);
    } finally { hob.close(); }
  });

  it("这个会话里还在等用户回答的提问卡：答了就收", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const approval: Approval = { id: "ap-1", assistantId: "hob", title: "发不发", options: [{ key: "A", label: "发" }, { key: "B", label: "不发" }], status: "pending", source: "router", createdAt: at };
      hob.runtime.store.saveApproval(approval);
      putTodos(todosFile(hob), [["等用户选", "doing"]]);
      releaseIdleTodos(hob.runtime, "hob");
      expect(todosOf(hob)).toEqual(items(["等用户选", "doing"]));
      hob.runtime.store.saveApproval({ ...approval, status: "answered", chosen: "A", answeredAt: at });
      releaseIdleTodos(hob.runtime, "hob");
      expect(todosOf(hob)).toEqual([]);
      // 别的助手单聊里的提问卡不是这个会话的
      putTodos(todosFile(hob), [["等用户选", "doing"]]);
      hob.runtime.store.saveApproval({ ...approval, id: "ap-2", assistantId: "ops", status: "pending" });
      releaseIdleTodos(hob.runtime, "hob");
      expect(todosOf(hob)).toEqual([]);
    } finally { hob.close(); }
  });

  it("群会话里别的成员还在这一轮：那一轮完了才收", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "换硬盘", "user");
      putTodos(join(hob.home, "groups", topic.id, "todos.json"), [["装新盘", "doing"]]);
      // 另一个成员这一轮还没说完
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([async () => { await gate; return text("我说完了"); }]);
      const running = hob.runtime.groups.deliverEvent(topic.id, "ops", "用户问了一句");
      await waitFor(() => hob.runtime.router.busyMembers(topic.id).includes("ops"));
      releaseIdleTodos(hob.runtime, "hob", topic.id);
      expect(topicTodos(hob, topic.id)).toEqual(items(["装新盘", "doing"]));
      release();
      await running;
      releaseIdleTodos(hob.runtime, "ops", topic.id);
      expect(topicTodos(hob, topic.id)).toEqual([]);
    } finally { hob.close(); }
  });
});

describe("启动时", () => {
  it("手上没活的收起来，还没结束的转交留着", () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "换硬盘", "user");
      putTodos(todosFile(hob), [["盘一下日志", "done"], ["改成按天切", "todo"]]);
      putTodos(join(hob.home, "groups", topic.id, "todos.json"), [["拆旧盘", "doing"]]);
      releaseIdleTodosAtStartup(hob.runtime);
      expect(hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos ?? []).toEqual([]);
      expect(hob.runtime.groups.summary(topic).todos ?? []).toEqual([]);
      // 还在等对方回话的那份留着
      putTodos(todosFile(hob), [["等对方回话", "doing"]]);
      hob.runtime.store.saveDelegation({ id: "dg-1", from: "hob", to: "ops", text: "整理单据", createdAt: new Date().toISOString(), status: "running", jobIds: [] });
      putTodos(join(hob.home, "groups", topic.id, "todos.json"), [["拆旧盘", "doing"]]);
      releaseIdleTodosAtStartup(hob.runtime);
      expect(hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos ?? []).toEqual(items(["等对方回话", "doing"]));
      // 单聊里发出的转交不按住群会话那份
      expect(hob.runtime.groups.summary(topic).todos ?? []).toEqual([]);
    } finally { hob.close(); }
  });
});

describe("老数据", () => {
  it("只有清单、没有更新时间的 todos.json 照常读成当前那份", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      putTodos(todosFile(hob), [["盘一下日志", "done"], ["改成按天切", "doing"]]);
      expect(hob.runtime.router.summary(hob.runtime.store.assistant("hob")!).todos).toEqual(items(["盘一下日志", "done"], ["改成按天切", "doing"]));
      hob.faux.setResponses([text("接着切")]);
      await hob.runtime.router.send("hob", { text: "继续" });
      await hob.runtime.router.waitIdle("hob");
      expect(userPrompts(hob.runtime.store.routerFile("hob")).at(-1)).toContain("手上的待办 1/2");
    } finally { hob.close(); }
  });
});
