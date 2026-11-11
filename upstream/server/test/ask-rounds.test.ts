import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Assistant, Group, GroupItem, Item } from "../../shared/types.ts";
import { answerApproval } from "../src/actions.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { askOptions } from "../src/worker-tools.ts";
import { makeHob, text, waitFor, type TestHob } from "./helpers.ts";

// 定稿只在开发仓库里（.scratch 不随公开版发布），没有就跳过逐字对照
const DOC = ".scratch/v2/design-projects.md";
const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";

/** 一张卡问两个问题：第一个带 why 和推荐，第二个三个选项、推荐第一个。 */
const questions = [
  { title: "筛选放在哪？", why: "决定这一版改哪个页面。", options: [{ label: "导出对话框" }, { label: "页面上" }], recommended: "导出对话框" },
  { title: "默认导出哪段？", options: [{ label: "当前月" }, { label: "最近三月" }, { label: "全部" }], recommended: "当前月" },
];

async function run(hob: TestHob, args: Record<string, unknown>, groupId?: string) {
  const tool = buildRouterTools(hob.runtime, "hob", groupId).find((item) => item.name === "ask_user")!;
  const result = (await tool.execute("tool-call", args)) as { content: { text: string }[]; terminate?: boolean; isError?: boolean };
  return { text: result.content[0].text, terminate: result.terminate, isError: result.isError };
}

/** 会话文件里 [hob-event] 那几段的正文（去掉【现在】前缀）。 */
function events(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const entry = JSON.parse(line) as { type?: string; customType?: string; content?: unknown };
      if (entry.type !== "custom_message" || entry.customType !== "hob.event" || typeof entry.content !== "string") return [];
      const at = entry.content.indexOf("[hob-event] ");
      return at < 0 ? [] : [entry.content.slice(at + "[hob-event] ".length)];
    });
}

function userTexts(file: string): string[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (entry.type !== "message" || entry.message?.role !== "user") return [];
        const content = entry.message.content;
        if (typeof content === "string") return [content];
        if (!Array.isArray(content)) return [];
        return [content.filter((block) => block?.type === "text").map((block) => block.text).join("")];
      });
  } catch {
    return [];
  }
}

function addAssistant(hob: TestHob, id: string, name: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, duty: "机器", primary: false, pinned: false, sprite: "server", instructions: "" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

describe("一张卡问几个问题", () => {
  it("ask_user 带 questions 出一张卡：外层 title 是卡片标题，每题选项 key 照旧 A、B、C", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const result = await run(hob, { title: "导出加筛选，几处定一下", detail: "定完就开工", questions });
      expect(result).toMatchObject({ text: "问题卡已显示给用户。", terminate: true });

      const approval = hob.runtime.store.approvals()[0]!;
      expect(approval).toMatchObject({ title: "导出加筛选，几处定一下", detail: "定完就开工", status: "pending", source: "router", options: [] });
      expect(approval.questions).toEqual([
        {
          title: "筛选放在哪？",
          why: "决定这一版改哪个页面。",
          options: [{ key: "A", label: "导出对话框" }, { key: "B", label: "页面上" }],
          recommended: "A",
        },
        {
          title: "默认导出哪段？",
          options: [{ key: "A", label: "当前月" }, { key: "B", label: "最近三月" }, { key: "C", label: "全部" }],
          recommended: "A",
        },
      ]);
      const items = hob.runtime.router.items("hob").items;
      expect(items.some((item) => item.kind === "question" && item.approvalId === approval.id)).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("卡片自己给问题编号：每题都带的序号去掉", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const numbered = questions.map((question, index) => ({ ...question, title: `${index + 1}. ${question.title}` }));
      await run(hob, { title: "定几处", questions: numbered });
      expect(hob.runtime.store.approvals()[0]!.questions!.map((question) => question.title)).toEqual(["筛选放在哪？", "默认导出哪段？"]);
    } finally {
      hob.close();
    }
  });

  it("questions 不合规时就说哪里要改，坏卡不落盘", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const bad = async (args: Record<string, unknown>) => (await run(hob, { title: "问几句", ...args })).text;
      const many = Array.from({ length: 9 }, (_, index) => ({ title: `问题${index + 1}`, options: [{ label: "甲" }, { label: "乙" }] }));

      expect(await bad({ questions: many })).toBe("一张卡最多问 8 个问题，现在有 9 个：拆成几张卡，一轮问眼下能定的。");
      expect(await bad({ questions: [{ title: "只有一个选项", options: [{ label: "甲" }] }] })).toBe(
        "第 1 个问题的选项要 2 到 3 个，现在有 1 个：合并相近的选项，或者把它拆成两个问题。",
      );
      expect(await bad({ questions: [{ title: "推荐不在选项里", options: [{ label: "甲" }, { label: "乙" }], recommended: "丙" }] })).toBe(
        "第 1 个问题的 recommended 要和其中一个选项的文字一字不差，现在填的是「丙」：填「甲」或「乙」。",
      );
      expect(
        await bad({ questions: [{ title: "问题", options: [{ label: "甲" }, { label: "乙" }] }], remember: "导出" }),
      ).toBe("带 questions 时不能带 remember：要记规则就用 set_rule，或者另出一张不带 questions 的卡问。");
      expect(await bad({ questions: [{ options: [{ label: "甲" }, { label: "乙" }] }] })).toBe("第 1 个问题缺 title：每个问题都要写清问什么。");
      expect(await bad({ questions: [{ title: "问题", options: [{ label: "甲" }, { label: "乙" }] }, { title: "第二个", options: [{ label: "甲" }] }] })).toBe(
        "第 2 个问题的选项要 2 到 3 个，现在有 1 个：合并相近的选项，或者把它拆成两个问题。",
      );

      expect(hob.runtime.store.approvals()).toEqual([]);
    } finally {
      hob.close();
    }
  });

  it("不带 questions 的老用法行为不变", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      expect((await run(hob, { title: "发吗", options: [{ label: "发" }, { label: "不发" }] })).text).toBe("问题卡已显示给用户。");
      expect(hob.runtime.store.approvals()[0]).toMatchObject({
        options: [{ key: "A", label: "发" }, { key: "B", label: "不发" }],
      });
      expect(hob.runtime.store.approvals()[0]?.questions).toBeUndefined();

      await run(hob, { title: "发吗", options: [{ label: "发" }, { label: "不发" }], remember: "发公众号" });
      const remembered = hob.runtime.store.approvals()[1]!;
      expect(remembered.options).toEqual([
        { key: "A", label: "发" },
        { key: "B", label: "不发" },
        { key: "C", label: "以后「发公众号」直接做", always: true },
      ]);
      expect(remembered.ruleText).toBe("发公众号");

      expect((await run(hob, { title: "发吗", options: [{ label: "只有一个" }] })).text).toBe("选项要 2 到 3 个。");
      expect((await run(hob, { title: "发吗" })).text).toBe("选项要 2 到 3 个。");
      expect(
        (await run(hob, { title: "发吗", options: [{ label: "甲" }, { label: "乙" }, { label: "丙" }], remember: "导出" })).text,
      ).toBe("带 remember 时最多给 2 个选项。");
      expect(hob.runtime.store.approvals()).toHaveLength(2);
    } finally {
      hob.close();
    }
  });

  it("回答：缺一个问题的答案就报 400 并说第几个；答完的事件一行一个问题", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await run(hob, { title: "导出加筛选，几处定一下", questions });
      const approval = hob.runtime.store.approvals()[0]!;

      const missing = await answerApproval(hob.runtime, approval.id, { answers: [{ key: "A" }] });
      expect(missing.status).toBe(400);
      expect(missing.body).toEqual({ error: "第 2 个问题还没答：「默认导出哪段？」要选一个选项，或者自己写一句。" });

      const unknown = await answerApproval(hob.runtime, approval.id, { answers: [{ key: "A" }, { key: "D" as never }] });
      expect(unknown.status).toBe(400);
      expect(unknown.body).toEqual({ error: "第 2 个问题没有这个选项：D" });
      expect(hob.runtime.store.approval(approval.id)?.status).toBe("pending");

      hob.faux.setResponses([text("好，按这个来。")]);
      // 第一题没按推荐选（推荐 A 选了 B），第二题自己写了一句
      expect((await answerApproval(hob.runtime, approval.id, { answers: [{ key: "B" }, { text: "按季度给" }], text: "先按这个做" })).status).toBe(200);
      await hob.runtime.router.waitIdle("hob");

      expect(hob.runtime.store.approval(approval.id)).toMatchObject({
        status: "answered",
        answers: [{ key: "B" }, { text: "按季度给" }],
        answerText: "先按这个做",
      });
      expect(events(join(hob.home, "assistants", "hob", "router.jsonl")).at(-1)).toBe(
        [
          "用户回答了「导出加筛选，几处定一下」：",
          "1. 筛选放在哪？：选了 B：页面上（推荐的是 A）",
          "2. 默认导出哪段？：没有选给出的选项，而是回复：按季度给",
          "补充：先按这个做",
        ].join("\n"),
      );
    } finally {
      hob.close();
    }
  });

  it("按推荐答的不写推荐，补充说明没有就不出那行", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await run(hob, { title: "导出加筛选，几处定一下", questions });
      const approval = hob.runtime.store.approvals()[0]!;
      hob.faux.setResponses([text("好，就按推荐来。")]);
      expect((await answerApproval(hob.runtime, approval.id, { answers: [{ key: "A" }, { key: "A" }] })).status).toBe(200);
      await hob.runtime.router.waitIdle("hob");

      expect(hob.runtime.store.approval(approval.id)?.answerText).toBeUndefined();
      expect(events(join(hob.home, "assistants", "hob", "router.jsonl")).at(-1)).toBe(
        [
          "用户回答了「导出加筛选，几处定一下」：",
          "1. 筛选放在哪？：选了 A：导出对话框",
          "2. 默认导出哪段？：选了 A：当前月",
        ].join("\n"),
      );
    } finally {
      hob.close();
    }
  });

  it("群里的多问题卡答完，答案回到群会话", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      addAssistant(hob, "ops", "服务器");
      const group: Group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob", "ops"] });
      await run(hob, { title: "下载目录怎么清", questions }, group.id);

      const groupItems = hob.runtime.groups.items(group.id).items;
      const card = groupItems.find((item): item is Extract<GroupItem, { kind: "question" }> => item.kind === "question")!;
      expect(card.speaker).toBe("hob");
      const approval = hob.runtime.store.approval(card.approvalId)!;
      expect(approval).toMatchObject({ groupId: group.id, status: "pending" });
      expect(hob.runtime.router.items("hob").items).toEqual([]);

      hob.faux.setResponses([text("好，按这个清。")]);
      expect((await answerApproval(hob.runtime, approval.id, { answers: [{ key: "A" }, { key: "B" }] })).status).toBe(200);
      await waitFor(() => userTexts(hob.runtime.store.groupMemberFile(group.id, "hob")).length > 0);
      expect(userTexts(hob.runtime.store.groupMemberFile(group.id, "hob")).at(-1)).toContain(
        "1. 筛选放在哪？：选了 A：导出对话框",
      );
      await waitFor(() => hob.runtime.groups.items(group.id).items.some((item: Item) => item.kind === "assistant"));
    } finally {
      hob.close();
    }
  });

  it("用户没答卡、直接在对话里发消息：卡片标为已结束", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await run(hob, { title: "导出加筛选，几处定一下", questions });
      const approval = hob.runtime.store.approvals()[0]!;
      hob.faux.setResponses([text("好，先按默认来。")]);
      await hob.runtime.router.send("hob", { text: "算了，先按默认来" });
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.store.approval(approval.id)?.status).toBe("expired");
    } finally {
      hob.close();
    }
  });
});

describe.skipIf(!doc)("工具说明和设计稿逐字一致", () => {
  it("ask_user 的 questions 参数说明与第五节一字不差", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const line = doc.split("\n").find((item) => item.startsWith("- `questions`："));
      expect(line, "design-projects.md 第五节里找不到 questions 那条").toBeTruthy();
      const described = line!.split("：").slice(1).join("：");
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "ask_user")!;
      expect(tool.parameters.properties.questions.description).toBe(described);
    } finally {
      hob.close();
    }
  });

  it("选项文字里的序号和「（推荐）」去掉，推荐记到卡片上", async () => {
    expect(askOptions(["① 保留 gpt-image-2，53 只去掉 2.5（推荐）", "② gpt-image-2 也映射到 2.6，停用 53", "③ 下线"])).toEqual({
      options: [{ key: "A", label: "保留 gpt-image-2，53 只去掉 2.5" }, { key: "B", label: "gpt-image-2 也映射到 2.6，停用 53" }, { key: "C", label: "下线" }],
      recommended: "A",
    });
    expect(askOptions(["1. 先改", "2、(推荐) 后改"])).toEqual({ options: [{ key: "A", label: "先改" }, { key: "B", label: "后改" }], recommended: "B" });
    expect(askOptions(["A. 甲 [Recommended]", "B) 乙", "（C）丙（推荐）"])).toEqual({
      options: [{ key: "A", label: "甲" }, { key: "B", label: "乙" }, { key: "C", label: "丙" }],
      recommended: "A",
    });
    // 只有部分选项带序号、数字后面接着数字（版本号、小数），都不当序号
    expect(askOptions(["2.5 继续用", "换成 2.6"]).options.map((option) => option.label)).toEqual(["2.5 继续用", "换成 2.6"]);
    expect(askOptions(["1. 先改", "以后再说"]).options.map((option) => option.label)).toEqual(["1. 先改", "以后再说"]);
    expect(askOptions(["推荐给朋友", "不推荐"])).toEqual({ options: [{ key: "A", label: "推荐给朋友" }, { key: "B", label: "不推荐" }] });

    const hob = makeHob({}, { memory: "off" });
    try {
      await run(hob, { title: "怎么改", options: [{ label: "A. 先改（推荐）" }, { label: "B. 后改" }] });
      await run(hob, { title: "问几句", questions: [
        { title: "放哪", options: [{ label: "1. 对话框" }, { label: "2. 页面上（推荐）" }] },
        { title: "导出哪段", options: [{ label: "① 当前月" }, { label: "② 全部" }], recommended: "② 全部（推荐）" },
      ] });
      const [single, multi] = hob.runtime.store.approvals();
      expect(single).toMatchObject({ options: [{ key: "A", label: "先改" }, { key: "B", label: "后改" }], recommended: "A" });
      expect(multi.questions).toEqual([
        { title: "放哪", options: [{ key: "A", label: "对话框" }, { key: "B", label: "页面上" }], recommended: "B" },
        { title: "导出哪段", options: [{ key: "A", label: "当前月" }, { key: "B", label: "全部" }], recommended: "B" },
      ]);
    } finally {
      hob.close();
    }
  });
});
