import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { makeHob } from "./helpers.ts";

type Tool = ReturnType<typeof buildRouterTools>[number];

const NOTES = "彩色打印机在 10.20.0.5，耗材柜钥匙在前台";
const settings = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const, searchEnabled: false, imageEnabled: false, desktopEnabled: false };

function toolOf(tools: Tool[], name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

/** 这个助手（单聊，或在 groupId 这个群里）的 edit_notes。 */
function editNotes(hob: ReturnType<typeof makeHob>, assistantId: string, groupId?: string) {
  return toolOf(buildRouterTools(hob.runtime, assistantId, groupId), "edit_notes");
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

/** 一个不归主助手管的助手：补充说明就是建它时写的那段。 */
function secondary(hob: ReturnType<typeof makeHob>, id: string, instructions = NOTES) {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant = { ...base, id, name: id, primary: false, instructions };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

describe("edit_notes：单聊改自己的补充说明", () => {
  it("把一段原文换成新的文字，其余内容原样留着，对话里落一行提示", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      secondary(hob, "print");
      const tool = editNotes(hob, "print")!;
      const result = await tool.execute("call", { edits: [{ old: "10.20.0.5", new: "10.20.0.6" }] });
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toBe("已改好补充说明。现在是：\n彩色打印机在 10.20.0.6，耗材柜钥匙在前台");
      expect(hob.runtime.store.assistant("print")?.instructions).toBe("彩色打印机在 10.20.0.6，耗材柜钥匙在前台");
      expect(hob.runtime.router.items("print").items.at(-1)).toMatchObject({ kind: "note", text: "修改了自己的补充说明" });
    } finally { hob.close(); }
  });

  it("old 填空字符串表示接在最后；补充说明本来是空的也这样用", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      secondary(hob, "print");
      secondary(hob, "empty", "");
      await editNotes(hob, "print")!.execute("call", { edits: [{ old: "", new: "周一闭馆" }] });
      expect(hob.runtime.store.assistant("print")?.instructions).toBe(`${NOTES}\n周一闭馆`);
      await editNotes(hob, "empty")!.execute("call", { edits: [{ old: "", new: "耗材柜在后楼梯" }] });
      expect(hob.runtime.store.assistant("empty")?.instructions).toBe("耗材柜在后楼梯");
    } finally { hob.close(); }
  });

  it("原文没找到时说清现在的补充说明是什么，一个字不改", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      secondary(hob, "print");
      const result = await editNotes(hob, "print")!.execute("call", { edits: [{ old: "10.20.0.7", new: "10.20.0.8" }] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("原文没找到：10.20.0.7");
      expect(textOf(result)).toContain(NOTES);
      expect(hob.runtime.store.assistant("print")?.instructions).toBe(NOTES);
    } finally { hob.close(); }
  });

  it("原文出现多次时不猜是哪一处，让它多带几个字", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      secondary(hob, "print", "东门有牌子，东门也放钥匙");
      const result = await editNotes(hob, "print")!.execute("call", { edits: [{ old: "东门", new: "北门" }] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("这段原文出现了 2 次，多带几个字让它只出现一次。");
      expect(hob.runtime.store.assistant("print")?.instructions).toBe("东门有牌子，东门也放钥匙");
    } finally { hob.close(); }
  });

  it("改完的系统提示词就是新的（下一轮照它说话）", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      secondary(hob, "print");
      await editNotes(hob, "print")!.execute("call", { edits: [{ old: "10.20.0.5", new: "10.20.0.6" }] });
      const prompt = buildSystemPrompt(hob.runtime.store, "print", settings);
      expect(prompt).toContain("## 补充说明\n彩色打印机在 10.20.0.6，耗材柜钥匙在前台");
      expect(prompt).not.toContain("10.20.0.5");
    } finally { hob.close(); }
  });
});

describe("edit_notes：群主改本群的补充说明", () => {
  it("群主带 group 改本群的，对话里落一行提示，各成员下一轮的提示词跟着变", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      secondary(hob, "owner");
      secondary(hob, "helper");
      const group = hob.runtime.groups.create({ name: "周末市集", purpose: "筹备市集", ownerId: "owner", members: ["owner", "helper"] });
      hob.runtime.groups.update(group.id, { instructions: "集合点在东门" });
      const result = await editNotes(hob, "owner", group.id)!.execute("call", { edits: [{ old: "东门", new: "北门停车场" }], group: true });
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toBe("已改好补充说明。现在是：\n集合点在北门停车场");
      expect(hob.runtime.store.group(group.id)?.instructions).toBe("集合点在北门停车场");
      // 自己的补充说明没被顺手改掉
      expect(hob.runtime.store.assistant("owner")?.instructions).toBe(NOTES);
      expect(hob.runtime.groups.items(group.id).items.at(-1)).toMatchObject({ kind: "note", text: "修改了本群的补充说明" });
      const prompt = buildSystemPrompt(hob.runtime.store, "helper", { ...settings, group: hob.runtime.store.group(group.id)! });
      expect(prompt).toContain("## 本群的补充说明\n集合点在北门停车场");
    } finally { hob.close(); }
  });

  it("不填 group 时改的是自己的，不是本群的", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      secondary(hob, "owner");
      const group = hob.runtime.groups.create({ name: "周末市集", purpose: "筹备市集", ownerId: "owner", members: ["owner"] });
      hob.runtime.groups.update(group.id, { instructions: "集合点在东门" });
      await editNotes(hob, "owner", group.id)!.execute("call", { edits: [{ old: "耗材柜", new: "仓库" }] });
      expect(hob.runtime.store.assistant("owner")?.instructions).toBe("彩色打印机在 10.20.0.5，仓库钥匙在前台");
      expect(hob.runtime.store.group(group.id)?.instructions).toBe("集合点在东门");
    } finally { hob.close(); }
  });

  it("话题里改的是所属群的，不是话题自己的", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      secondary(hob, "owner");
      const group = hob.runtime.groups.create({ name: "周末市集", purpose: "筹备市集", ownerId: "owner", members: ["owner"] });
      hob.runtime.groups.update(group.id, { instructions: "集合点在东门" });
      const topic = hob.runtime.groups.createTopic(group.id, "摊位排布", "user");
      await editNotes(hob, "owner", topic.id)!.execute("call", { edits: [{ old: "东门", new: "北门停车场" }], group: true });
      expect(hob.runtime.store.group(group.id)?.instructions).toBe("集合点在北门停车场");
      // 话题自己的文件里不存补充说明：改的是所属的那个群
      expect(readFileSync(join(hob.home, "groups", topic.id, "group.json"), "utf8")).not.toContain("instructions");
      expect(readFileSync(join(hob.home, "groups", group.id, "group.json"), "utf8")).toContain("集合点在北门停车场");
      // 提示行落在话题里
      expect(hob.runtime.groups.items(topic.id).items.at(-1)).toMatchObject({ kind: "note", text: "修改了本群的补充说明" });
    } finally { hob.close(); }
  });

  it("不是群主的成员没有 group 这个参数，也改不动本群", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      secondary(hob, "owner");
      secondary(hob, "helper");
      const group = hob.runtime.groups.create({ name: "周末市集", purpose: "筹备市集", ownerId: "owner", members: ["owner", "helper"] });
      hob.runtime.groups.update(group.id, { instructions: "集合点在东门" });
      const tool = editNotes(hob, "helper", group.id)!;
      expect(Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {})).not.toContain("group");
      const result = await tool.execute("call", { edits: [{ old: "东门", new: "北门停车场" }], group: true });
      expect(result.isError).toBe(true);
      expect(hob.runtime.store.group(group.id)?.instructions).toBe("集合点在东门");
      // 单聊里也没有 group 参数：群主只在群里多这一项
      expect(Object.keys((editNotes(hob, "owner")!.parameters as { properties?: Record<string, unknown> }).properties ?? {})).not.toContain("group");
    } finally { hob.close(); }
  });
});

describe("edit_notes：只给非主助手", () => {
  it("主助手没有这个工具，单聊和群里都没有", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "周末市集", purpose: "筹备市集", ownerId: "hob", members: ["hob"] });
      expect(editNotes(hob, "hob")).toBeUndefined();
      expect(editNotes(hob, "hob", group.id)).toBeUndefined();
    } finally { hob.close(); }
  });

  it("工具说明按票里的原文写", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      secondary(hob, "print");
      expect(editNotes(hob, "print")!.description).toBe("改你自己的补充说明：把一段原文换成新的文字。补充说明记的是一直成立、你做事要知道的事实：它每轮都在你的提示词里，你派出去的任务也带着它，写进来的会一直被拿去用。");
    } finally { hob.close(); }
  });
});
