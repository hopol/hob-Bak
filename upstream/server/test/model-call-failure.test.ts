import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Assistant, Group, GroupItem, Item } from "../../shared/types.ts";
import { makeHob, waitFor, type TestHob } from "./helpers.ts";

const UPSTREAM = 'my-gateway API error (502): {"message":"Bad Gateway"}';
const failed = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: UPSTREAM });
const LINE = "没能回复：调用模型失败（模型服务返回 502：Bad Gateway）。可以再发一次。";

/** 重试三次再放弃，但间隔调成 1 毫秒：要验的是放弃以后留下什么，不是退避多久。 */
const options = { memory: "off" as const, retry: { maxRetries: 2, baseDelayMs: 1 } };

function addAssistant(hob: TestHob, id: string, name: string): Assistant {
  const base = hob.runtime.store.assistant("hob")!;
  const assistant: Assistant = { ...base, id, name, primary: false, pinned: false, sprite: "page", instructions: "" };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

const notes = (items: Item[]) => items.filter((item) => item.kind === "note");

describe("调用模型失败要说出来", () => {
  it("单聊：重试放弃以后留一行给用户，下一轮模型也看得到", async () => {
    const hob = makeHob({}, options);
    try {
      hob.faux.setResponses([failed(), failed(), failed(), failed()]);
      await hob.runtime.router.send("hob", { text: "在吗" });
      await waitFor(() => notes(hob.runtime.router.items("hob").items).some((item) => item.text === LINE));
      // 先重试了三次（第一次 + 两次重试），都失败才放弃
      expect(hob.faux.state.callCount).toBe(3);

      // 下一轮把上一轮没回出去这件事带进上下文
      let seen: unknown[] = [];
      hob.faux.setResponses([(context: { messages?: unknown[] }) => { seen = context.messages ?? []; return fauxAssistantMessage("上一轮没回出去，我这次接着说。"); }]);
      await hob.runtime.router.send("hob", { text: "再试一次" });
      await hob.runtime.router.waitIdle("hob");
      expect(JSON.stringify(seen)).toContain(LINE);
    } finally { hob.close(); }
  });

  it("群里的成员：写在那位成员说话的位置", async () => {
    const hob = makeHob({}, options);
    try {
      addAssistant(hob, "ops", "运维");
      const group: Group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob", "ops"] });
      const topic = hob.runtime.groups.createTopic(group.id, "清理磁盘", "user");
      hob.faux.setResponses([failed(), failed(), failed()]);
      await hob.runtime.groups.send(topic.id, { text: "@运维 查一下磁盘" });
      await waitFor(() => hob.runtime.groups.items(topic.id).items.some((item) => item.kind === "note" && item.text === LINE));

      const note = hob.runtime.groups.items(topic.id).items.find((item) => item.kind === "note" && item.text === LINE) as Extract<GroupItem, { kind: "note" }>;
      expect(note.speaker).toBe("ops");
      // 下一轮它自己看得到：群里那行本来就在它的输入里
      let seen: unknown[] = [];
      hob.faux.setResponses([(context: { messages?: unknown[] }) => { seen = context.messages ?? []; return fauxAssistantMessage("好，我重来一遍。"); }]);
      await hob.runtime.groups.send(topic.id, { text: "@运维 再来一次" });
      await waitFor(() => seen.length > 0);
      expect(JSON.stringify(seen)).toContain(LINE);
    } finally { hob.close(); }
  });

  it("任务：状态是失败，原因写在卡上", async () => {
    const hob = makeHob({}, options);
    try {
      hob.faux.setResponses(Array.from({ length: 8 }, () => failed()));
      const job = await hob.runtime.jobs.start("hob", { title: "查磁盘", instruction: "查磁盘" });
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)).toMatchObject({ status: "failed", statusReason: "调用模型失败（模型服务返回 502：Bad Gateway）" });
    } finally { hob.close(); }
  });
});
