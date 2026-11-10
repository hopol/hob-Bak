import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { formatKnowledge, searchKnowledgeTool } from "../src/knowledge-tools.ts";
import { activityLabel } from "../src/router-activity.ts";
import { toolTitle } from "../src/transcript.ts";
import { writeSecret } from "../src/secrets.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

async function setup() {
  const hob = makeHob();
  const collection = await hob.runtime.knowledge.createCollection("运维");
  const path = join(hob.home, "手册.md");
  writeFileSync(path, "# 备份\n每日巡检需要检查备份状态。");
  const entry = (await hob.runtime.knowledge.upload({ path, name: "手册.md" }, collection.id))!;
  await hob.runtime.knowledge.whenIndexed();
  const bind = (ids: string[]) => hob.runtime.store.saveAssistant({ ...hob.runtime.store.assistant("hob")!, knowledge: ids });
  return { hob, collection, entry, bind };
}

function vectorOn(hob: Awaited<ReturnType<typeof setup>>["hob"]) {
  hob.runtime.settings.setEmbedding(hob.runtime.settings.get().revision, { source: "openai", baseUrl: "http://localhost:9999/v1", model: "fake" });
}

describe("知识库查内容", () => {
  it("只查绑定的库，名称匹配或退回全部绑定，支持关键词和空结果", async () => {
    const { hob, collection, entry, bind } = await setup();
    try {
      const other = await hob.runtime.knowledge.createCollection("写作");
      bind([collection.id]);
      const tool = searchKnowledgeTool(hob.runtime, "hob");
      const result = await tool.execute("x", { query: "每日巡检", collection: "不存在" });
      expect(result.content[0].text).toContain("（只按关键词查）\n（知识库里可能相关的内容。用得上就引用，并照抄出处链接；用不上就忽略。）\n1. 手册.md › 备份（[手册.md](#k/" + entry.id + "/0)）");
      expect(result.content[0].text).toContain("每日巡检需要检查备份状态");
      expect((await tool.execute("x", { query: "绝对不存在" })).content[0].text).toBe("（只按关键词查）\n知识库里没有找到相关内容。");
      bind([other.id]);
      expect((await tool.execute("x", { query: "每日巡检", collection: "运维" })).content[0].text).toBe("（只按关键词查）\n知识库里没有找到相关内容。");
      expect(activityLabel("search_knowledge", { query: "每日巡检" })).toBe("正在查知识库：每日巡检");
      expect(toolTitle("search_knowledge", { query: "每日巡检" })).toBe("查知识库：每日巡检");
    } finally { hob.close(); }
  });

  it("结果限制段数并控制总长度", async () => {
    const { hob, collection, entry, bind } = await setup();
    try {
      bind([collection.id]);
      const results = Array.from({ length: 6 }, (_, index) => ({ entry, chunk: { index, heading: "手册.md", text: "甲".repeat(1500) }, score: 1 }));
      const search = vi.spyOn(hob.runtime.knowledge, "search").mockResolvedValue(results);
      const output = (await searchKnowledgeTool(hob.runtime, "hob").execute("x", { query: "备份" })).content[0].text;
      expect(search).toHaveBeenCalledWith("备份", [collection.id], { limit: 6 });
      expect([...output].length).toBeLessThanOrEqual(6000);
      expect([...formatKnowledge(results.slice(0, 3), 2400)].length).toBeLessThanOrEqual(2400);
    } finally { vi.restoreAllMocks(); hob.close(); }
  });

  it("同一 Router 每轮按最新绑定和名称启停工具，Worker 也能调用", async () => {
    const { hob, collection, bind } = await setup();
    try {
      const state = await hob.runtime.router.ensure("hob");
      expect(state.session!.getActiveToolNames()).not.toContain("search_knowledge");
      hob.faux.setResponses([text("好")]);
      await hob.runtime.router.send("hob", { text: "你好" }); await hob.runtime.router.waitIdle("hob");
      expect(state.session!.systemPrompt).not.toContain("能查的知识库");
      bind([collection.id]);
      hob.faux.setResponses([call("search_knowledge", { query: "每日巡检" }), text("找到了")]);
      await hob.runtime.router.send("hob", { text: "找资料" }); await hob.runtime.router.waitIdle("hob");
      expect(state.session!.getActiveToolNames()).toContain("search_knowledge");
      expect(state.session!.systemPrompt).toContain("能查的知识库：运维。问到可能写在这些库里的内容，先用 search_knowledge 查；用到的内容照抄出处链接");
      expect(JSON.stringify(state.session!.messages)).toContain("每日巡检需要检查备份状态");
      const opened: { tools: string[]; prompt: string }[] = [];
      const open = hob.runtime.pi.open.bind(hob.runtime.pi);
      vi.spyOn(hob.runtime.pi, "open").mockImplementation(async (options) => { opened.push({ tools: options.tools, prompt: options.systemPrompt() }); return open(options); });
      hob.faux.setResponses([call("search_knowledge", { query: "每日巡检" }), call("report", { outcome: "done", result: "找到" }), text("好")]);
      const job = await hob.runtime.jobs.start("hob", { title: "查资料", instruction: "查资料" });
      await hob.runtime.jobs.waitIdle(); await hob.runtime.router.waitIdle("hob");
      expect(opened[0].tools).toContain("search_knowledge");
      expect(opened[0].prompt).toContain("能查的知识库：运维。");
      expect(hob.runtime.jobs.transcript(job.id)).toContainEqual(expect.objectContaining({ name: "search_knowledge", output: expect.stringContaining("每日巡检") }));
      await hob.runtime.knowledge.renameCollection(collection.id, "新运维");
      hob.faux.setResponses([text("好")]);
      await hob.runtime.router.send("hob", { text: "继续" }); await hob.runtime.router.waitIdle("hob");
      expect(state.session!.systemPrompt).toContain("能查的知识库：新运维。");
      bind([]);
      hob.faux.setResponses([text("好")]);
      await hob.runtime.router.send("hob", { text: "继续" }); await hob.runtime.router.waitIdle("hob");
      expect(state.session!.getActiveToolNames()).not.toContain("search_knowledge");
      expect(state.session!.systemPrompt).not.toContain("能查的知识库");
    } finally { vi.restoreAllMocks(); hob.close(); }
  });

  it("自动检索只处理符合条件的用户原话和转交，事件不查", async () => {
    const { hob, collection, entry, bind } = await setup();
    try {
      const search = vi.spyOn(hob.runtime.knowledge, "search");
      const events: string[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "router-activity" && event.activity) events.push(event.activity.label); });
      bind([collection.id]);
      hob.faux.setResponses([text("好")]);
      await hob.runtime.router.send("hob", { text: "每日巡检怎么做" }); await hob.runtime.router.waitIdle("hob");
      expect(search).not.toHaveBeenCalled(); expect(events).not.toContain("正在查知识库");
      vectorOn(hob);
      const result = { entry, chunk: { index: 0, heading: "手册.md › 备份", text: "每日巡检需要检查备份状态。" }, score: 0.9 };
      search.mockImplementation(async (query) => query.includes("巡检") ? [result] : []);
      hob.faux.setResponses([text("好")]);
      const item = await hob.runtime.router.send("hob", { text: "每日巡检怎么做" }); await hob.runtime.router.waitIdle("hob");
      const state = await hob.runtime.router.ensure("hob");
      expect(JSON.stringify(state.session!.messages)).toContain(`#k/${entry.id}/0`);
      expect(hob.runtime.router.items("hob").items).toContainEqual(expect.objectContaining({ id: item.id, text: "每日巡检怎么做" }));
      expect(search).toHaveBeenCalledWith("每日巡检怎么做", [collection.id], { limit: 3, gate: true });
      expect(events).toContain("正在查知识库");
      search.mockClear();
      hob.faux.setResponses([text("好"), text("好")]);
      await hob.runtime.router.send("hob", { text: "继续" }); await hob.runtime.router.waitIdle("hob");
      await hob.runtime.router.send("hob", { text: "今天天气真好" }); await hob.runtime.router.waitIdle("hob");
      expect(search).toHaveBeenCalledTimes(1);
      const original = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...original, id: "ops", name: "运维", primary: false });
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([text("收到")]);
      search.mockClear();
      const delegation = await hob.runtime.delegations.start("ops", "每日巡检怎么做");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
      expect(search).toHaveBeenCalledWith("每日巡检怎么做", [collection.id], { limit: 3, gate: true });
      const ops = await hob.runtime.router.ensure("ops");
      expect(JSON.stringify(ops.session!.messages)).toContain(`#k/${entry.id}/0`);
      search.mockClear();
      hob.faux.setResponses([text("好")]);
      await hob.runtime.router.relay("ops", "任务结果：每日巡检", delegation.id);
      expect(search).not.toHaveBeenCalled();
      bind([]); search.mockClear(); hob.faux.setResponses([text("好")]);
      await hob.runtime.router.send("hob", { text: "每日巡检怎么做" }); await hob.runtime.router.waitIdle("hob");
      expect(search).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); hob.close(); }
  });

  it("假向量服务经真实索引和门槛检索，相关时附出处、闲聊时不附", async () => {
    const { hob, collection, entry, bind } = await setup();
    try {
      bind([collection.id]); vectorOn(hob); writeSecret(hob.home, "embedding", "fake-key");
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const { input } = JSON.parse(String(init.body)) as { input: string[] };
        return Response.json({ data: input.map((value, index) => ({ index, embedding: value.includes("天气") ? [0, 1] : [1, 0] })) });
      });
      await hob.runtime.knowledge.refreshIndexes(true); await hob.runtime.knowledge.whenIndexed();
      hob.faux.setResponses([text("好"), text("好")]);
      await hob.runtime.router.send("hob", { text: "每日巡检怎么做" }); await hob.runtime.router.waitIdle("hob");
      await hob.runtime.router.send("hob", { text: "今天天气真好" }); await hob.runtime.router.waitIdle("hob");
      const state = await hob.runtime.router.ensure("hob");
      const users = state.session!.messages.filter((message) => message.role === "user");
      expect(JSON.stringify(users[0])).toContain(`#k/${entry.id}/0`);
      expect(JSON.stringify(users[1])).not.toContain("知识库里可能相关的内容");
    } finally { vi.unstubAllGlobals(); hob.close(); }
  });

  it("并发发消息时检索先慢后快，仍按原顺序交给模型", async () => {
    const { hob, collection, bind } = await setup();
    let release = () => {};
    try {
      bind([collection.id]); vectorOn(hob);
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(hob.runtime.knowledge, "search").mockImplementation(async (query) => { if (query === "第一个问题") await gate; return []; });
      hob.faux.setResponses([text("收到"), text("好")]);
      await hob.runtime.router.send("hob", { text: "第一个问题" });
      await hob.runtime.router.send("hob", { text: "第二个问题" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(hob.faux.state.callCount).toBe(0);
      release();
      await hob.runtime.router.waitIdle("hob");
      const state = await hob.runtime.router.ensure("hob");
      const messages = JSON.stringify(state.session!.messages);
      expect(messages.indexOf("第一个问题")).toBeLessThan(messages.indexOf("第二个问题"));
    } finally { release(); vi.restoreAllMocks(); hob.close(); }
  });

  it("检索超时后照常发送原文", async () => {
    const { hob, collection, bind } = await setup();
    try {
      bind([collection.id]); vectorOn(hob);
      vi.spyOn(hob.runtime.knowledge, "search").mockImplementation(() => new Promise((resolve) => { setTimeout(() => resolve([]), 5000).unref(); }));
      hob.faux.setResponses([text("收到")]);
      await hob.runtime.router.send("hob", { text: "每日巡检怎么做" });
      await hob.runtime.router.waitIdle("hob");
      const state = await hob.runtime.router.ensure("hob");
      expect(JSON.stringify(state.session!.messages)).toContain("每日巡检怎么做");
      expect(JSON.stringify(state.session!.messages)).not.toContain("知识库里可能相关的内容");
    } finally { vi.restoreAllMocks(); hob.close(); }
  }, 10000);
});
