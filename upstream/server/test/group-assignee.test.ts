import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Assistant, Group, GroupItem, Job } from "../../shared/types.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const MODELS = [{ id: "faux-1" }, { id: "faux-2" }];
const ROSTER = [{ ref: "hob-faux/faux-1", note: "" }, { ref: "hob-faux/faux-2", note: "" }];

function addAssistant(hob: TestHob, id: string, name: string, duty: string, workModel?: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = {
    ...base,
    id,
    name,
    duty,
    primary: false,
    pinned: false,
    sprite: "page",
    ...(workModel ? { models: { work: { ref: workModel, thinking: "off" as const } } } : {}),
  };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

/** 群里两个成员：Hob（群主）、运维（自己的任务模型）。 */
function setup(): { hob: TestHob; group: Group; topic: Group } {
  const hob = makeHob({}, { memory: "off", models: MODELS, settings: { models: { roster: ROSTER } } });
  addAssistant(hob, "ops", "运维", "机器", "hob-faux/faux-2");
  const group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob", "ops"] });
  const topic = hob.runtime.groups.createTopic(group.id, "清理磁盘", "user");
  return { hob, group, topic };
}

async function runTool(hob: TestHob, assistantId: string, gid: string | undefined, name: string, params: Record<string, unknown>) {
  const tool = buildRouterTools(hob.runtime, assistantId, gid).find((item) => item.name === name)!;
  const handoff = ["start_job", "message_assistant", "message_group", "open_topic"].includes(name) && !("note" in params) ? { ...params, note: "测试交接说明" } : params;
  return tool.execute("call-1", handoff, undefined, undefined, {} as never) as Promise<{ content: { text: string }[] }>;
}

const groupItems = (hob: TestHob, gid: string) => hob.runtime.groups.items(gid).items;

/** 会话文件里的用户消息正文（群会话的输入就是它）。 */
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

describe("群里派任务可以指定成员", () => {
  it("填成员：任务按它的身份和模型跑，卡片算它的，结果回到话题、不进它的单聊", async () => {
    const { hob, topic } = setup();
    try {
      hob.faux.setResponses([call("report", { outcome: "done", result: "清掉了 3 GB" }), text("好了，交结果了。"), text("运维清掉了 3 GB。")]);
      const result = await runTool(hob, "hob", topic.id, "start_job", { title: "查磁盘", assistantId: "ops" });
      const job = hob.runtime.store.jobs().find((item) => item.title === "查磁盘")!;
      expect(result.content[0].text).toBe(`已派给「运维」：查磁盘（${job.id}）。结果会回到这里。`);

      expect(job).toMatchObject({ assistantId: "ops", assistantName: "运维", startedBy: "hob", groupId: topic.id });
      // 用它的默认任务模型，不是派活的人那一套
      expect(job.model).toBe("hob-faux/faux-2");

      // 任务卡进话题的时间线，发言人是那位成员
      const card = groupItems(hob, topic.id).find((item) => item.kind === "job") as Extract<GroupItem, { kind: "job" }>;
      expect(card).toMatchObject({ speaker: "ops", jobId: job.id });

      await hob.runtime.jobs.waitIdle();
      await waitFor(() => userTexts(hob.runtime.store.groupMemberFile(topic.id, "hob")).some((line) => line.includes(`「运维」的任务「查磁盘」`)));
      await waitFor(() => groupItems(hob, topic.id).some((item) => item.kind === "assistant" && item.speaker === "hob"));

      // 结果回到话题里群主的会话，带着执行人这个事实
      const event = userTexts(hob.runtime.store.groupMemberFile(topic.id, "hob")).find((line) => line.includes("[hob-event] 「运维」的任务「查磁盘」"))!;
      expect(event).toContain("已完成");
      // 成员在话题里没有收到这条事件，单聊里也没有这张卡和这次的结果
      expect(userTexts(hob.runtime.store.groupMemberFile(topic.id, "ops"))).toEqual([]);
      expect(existsSync(hob.runtime.store.routerFile("ops"))).toBe(false);
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "job")).toBe(false);
    } finally { hob.close(); }
  });

  it("不填就是自己，和以前一样：任务算调用者的", async () => {
    const { hob, topic } = setup();
    try {
      const result = await runTool(hob, "hob", topic.id, "start_job", { title: "查磁盘" });
      const job = hob.runtime.store.jobs()[0]!;
      expect(result.content[0].text).toContain("已开始");
      expect(job).toMatchObject({ assistantId: "hob", groupId: topic.id });
      expect(job.startedBy).toBeUndefined();
    } finally { hob.close(); }
  });

  it("填不在群里的 id：报错写出群里的成员", async () => {
    const { hob, topic } = setup();
    try {
      addAssistant(hob, "write", "写作", "周报");
      const missing = await runTool(hob, "hob", topic.id, "start_job", { title: "查磁盘", assistantId: "write" });
      expect(missing.content[0].text).toBe("write 不在这个群里。群里的成员：Hob（hob）、运维（ops）");
      const nobody = await runTool(hob, "hob", topic.id, "start_job", { title: "查磁盘", assistantId: "ghost" });
      expect(nobody.content[0].text).toBe("ghost 不在这个群里。群里的成员：Hob（hob）、运维（ops）");
      expect(hob.runtime.store.jobs()).toEqual([]);
    } finally { hob.close(); }
  });

  it("参数说明照原文；单聊里没有这个参数", () => {
    const { hob, topic } = setup();
    try {
      const groupTool = buildRouterTools(hob.runtime, "hob", topic.id).find((item) => item.name === "start_job")!;
      expect(groupTool.parameters.properties.assistantId.description).toBe("谁来做：群里一位成员的 id，任务以它的身份运行，用它的技能和记忆。不填就是你自己。");
      const single = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "start_job")!;
      expect(single.parameters.properties.assistantId).toBeUndefined();
    } finally { hob.close(); }
  });
});

describe("交给群的话题关掉时，结论后面附任务记录", () => {
  function handoverTopic(hob: TestHob, group: Group, title: string): Group {
    const { topic } = hob.runtime.groups.handOver(group.id, title, "hob", { text: "用户原话：把这个办一下", files: [] });
    return topic;
  }

  it("有任务：一行一条，写清谁做了什么", async () => {
    const { hob, group } = setup();
    try {
      vi.spyOn(hob.runtime.router, "handoverResult").mockResolvedValue(true);
      const topic = handoverTopic(hob, group, "清理磁盘");
      hob.runtime.store.saveJob({ id: "t-a", assistantId: "ops", assistantName: "运维", title: "查磁盘", instruction: "", status: "done", createdAt: "2026-11-13T01:00:00.000Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [], groupId: topic.id } satisfies Job);
      hob.runtime.store.saveJob({ id: "t-b", assistantId: "hob", assistantName: "Hob", title: "写结论", instruction: "", status: "stuck", statusReason: "缺权限", createdAt: "2026-11-13T02:00:00.000Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [], groupId: topic.id } satisfies Job);

      hob.runtime.groups.closeByOwner(topic.id, "清掉了 3 GB");
      const result = hob.runtime.store.group(topic.id)!.handover!.result!;
      expect(result).toBe(`交给群「家里机器」的话题「清理磁盘」关了。结论：清掉了 3 GB\n话题里的任务：运维「查磁盘」已完成；Hob「写结论」受阻`);
    } finally { hob.close(); }
  });

  it("没有任务：不附这一行", () => {
    const { hob, group } = setup();
    try {
      vi.spyOn(hob.runtime.router, "handoverResult").mockResolvedValue(true);
      const topic = handoverTopic(hob, group, "清理磁盘");
      hob.runtime.groups.closeByOwner(topic.id, "没什么要做的");
      const result = hob.runtime.store.group(topic.id)!.handover!.result!;
      expect(result).toBe("交给群「家里机器」的话题「清理磁盘」关了。结论：没什么要做的");
    } finally { hob.close(); }
  });
});
