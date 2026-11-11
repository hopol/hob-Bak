import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Assistant, Group, GroupItem } from "../../shared/types.ts";
import { answerApproval } from "../src/actions.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { buildWorkerPrompt, buildSystemPrompt } from "../src/prompt.ts";
import { writeSecret } from "../src/secrets.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

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
  const group = hob.runtime.groups.create({ name: "家里机器", purpose: "机器上的事", ownerId: "hob", members: ["hob", "ops", "write"] });
  return { hob, group };
}

const groupItems = (hob: TestHob, gid: string) => hob.runtime.groups.items(gid).items;
const assistantItems = (hob: TestHob, gid: string) => groupItems(hob, gid).filter((item): item is Extract<GroupItem, { kind: "assistant" }> => item.kind === "assistant");

/** 等到群里出现这么多条助手回复，并且没有人在说话。 */
async function settled(hob: TestHob, gid: string, replies: number): Promise<void> {
  await waitFor(() => assistantItems(hob, gid).length >= replies);
  await waitFor(() => hob.runtime.groups.summary(gid).busy.length === 0);
}

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

describe("群任务权限", () => {
  it("群成员可接手本群话题里的任务，不能操作别的群或其他助手的单聊任务", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      const other = hob.runtime.groups.create({ name: "别的群", purpose: "测试", ownerId: "hob", members: ["hob", "ops"] });
      const save = (id: string, groupId?: string) => hob.runtime.store.saveJob({ id, assistantId: "write", title: id, instruction: "测试", status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], ...(groupId ? { groupId } : {}) });
      save("t-inside", topic.id); save("t-outside", other.id); save("t-direct");
      const reply = vi.spyOn(hob.runtime.jobs, "reply").mockResolvedValue(undefined as never);
      const stop = vi.spyOn(hob.runtime.jobs, "stop").mockResolvedValue(undefined as never);
      const tools = buildRouterTools(hob.runtime, "ops", group.id);
      const invoke = (name: string, jobId: string) => tools.find((tool) => tool.name === name)!.execute("test", { jobId, text: "继续" });
      expect((await invoke("check_job", "t-inside")).isError).not.toBe(true);
      expect((await invoke("reply_job", "t-inside")).isError).not.toBe(true);
      expect((await invoke("stop_job", "t-inside")).isError).not.toBe(true);
      for (const name of ["check_job", "reply_job", "stop_job"]) expect((await invoke(name, "t-outside")).isError).toBe(true);
      const direct = buildRouterTools(hob.runtime, "ops").find((tool) => tool.name === "reply_job")!;
      expect((await direct.execute("test", { jobId: "t-direct", text: "继续" })).isError).toBe(true);
      expect(reply).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledTimes(1);
    } finally { hob.close(); }
  });
});

describe("群规则", () => {
  it("话题记的规则归群，其他话题和任务能看到，单聊规则不受影响", async () => {
    const { hob, group } = setup();
    try {
      const first = hob.runtime.groups.createTopic(group.id, "第一件事", "user");
      const second = hob.runtime.groups.createTopic(group.id, "第二件事", "user");
      const tool = buildRouterTools(hob.runtime, "ops", first.id).find((item) => item.name === "set_rule")!;
      await tool.execute("rule", { text: "发布前确认", mode: "ask" });
      expect(hob.runtime.store.rules("ops")).toEqual([]);
      expect(hob.runtime.store.groupRules(second.id)).toMatchObject([{ text: "发布前确认", mode: "ask" }]);
      const options = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      const onlyGroup = buildSystemPrompt(hob.runtime.store, "ops", { ...options, group: second });
      expect(onlyGroup).toContain("本群的规则：");
      expect(onlyGroup).not.toContain("你自己的规则：");
      expect(onlyGroup).not.toContain("本群的规则和你自己的规则说法不一样时");
      hob.runtime.store.saveRules("ops", [{ id: "own-ask", text: "个人先问", mode: "ask", changedAt: new Date().toISOString() }, { id: "own-allow", text: "个人直接做", mode: "allow", changedAt: new Date().toISOString() }]);
      const prompt = buildSystemPrompt(hob.runtime.store, "ops", { ...options, group: second });
      expect(prompt).toContain("本群的规则：\n- 执行前确认：发布前确认\n你自己的规则：");
      expect(prompt).toContain("本群的规则和你自己的规则说法不一样时，在这个群里按本群的办。");
      hob.runtime.store.saveJob({ id: "t-rules", assistantId: "ops", title: "规则测试", instruction: "测试", groupId: second.id, status: "done", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      const worker = buildWorkerPrompt(hob.runtime.store, "t-rules", options);
      expect(worker).toContain("发布前确认");
      expect(worker).toContain("个人先问");
      expect(worker).not.toContain("个人直接做");
    } finally { hob.close(); }
  });

  it("群内确认卡的 always 选项写入群规则", async () => {
    const { hob, group } = setup();
    try {
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      hob.runtime.store.saveApproval({ id: "a-group-rule", assistantId: "ops", groupId: topic.id, title: "发布？", options: [{ key: "A", label: "以后直接发布", always: true }], status: "pending", source: "router", createdAt: new Date().toISOString() });
      await answerApproval(hob.runtime, "a-group-rule", { key: "A" });
      expect(hob.runtime.store.groupRules(group.id)).toMatchObject([{ text: "以后直接发布", mode: "allow" }]);
      expect(hob.runtime.store.rules("ops")).toEqual([]);
    } finally { hob.close(); }
  });
});

describe("群里的卡片和结果回流", () => {
  it("群里派任务：卡片进群、任务做完结果进群会话、它在群里说，@ 了就接着叫人", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([
        call("start_job", { title: "数文件" }),
        call("report", { outcome: "done", result: "/tmp/x 里有 3 个文件" }),
        text("好"),
        text("查完了：3 个文件。@Hob 你看要不要留"),
        text("留着吧"),
      ]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 查一下 /tmp/x 里有几个文件" });
      await settled(hob, group.id, 2);

      // 任务卡进群的时间线，发言人是派活的成员
      const card = groupItems(hob, group.id).find((item) => item.kind === "job")!;
      expect(card).toMatchObject({ speaker: "ops" });
      const job = hob.runtime.store.job((card as { jobId: string }).jobId)!;
      expect(job.groupId).toBe(group.id);
      // 用户原话取自群的时间线
      expect(job.instruction).toContain("查一下 /tmp/x 里有几个文件");

      // 结果进了它的群会话，它说的话写在时间线上；回复里 @ 了 Hob，接着轮到 Hob
      expect(userTexts(hob.runtime.store.groupMemberFile(group.id, "ops")).at(-1)).toContain("[hob-event] 任务「数文件」");
      expect(assistantItems(hob, group.id).map((item) => item.speaker)).toEqual(["ops", "hob"]);
      expect(assistantItems(hob, group.id)[0]!.text).toContain("查完了：3 个文件。");

      // 单聊里没有这张卡，也没有这次的结果
      expect(hob.runtime.router.items("ops").items.some((item) => item.kind === "job")).toBe(false);
      expect(userTexts(hob.runtime.store.routerFile("ops"))).toEqual([]);
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "job")).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("群里提问：卡片进群，回答后答案回到群会话", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([call("ask_user", { title: "要不要重启", options: [{ label: "重启" }, { label: "先不动" }] }), text("好，等你定")]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 要不要重启机器" });
      await settled(hob, group.id, 0);
      await waitFor(() => groupItems(hob, group.id).some((item) => item.kind === "question"));

      const card = groupItems(hob, group.id).find((item) => item.kind === "question")!;
      expect(card).toMatchObject({ speaker: "ops" });
      const approval = hob.runtime.store.approval((card as { approvalId: string }).approvalId)!;
      expect(approval).toMatchObject({ groupId: group.id, status: "pending" });
      expect(hob.runtime.router.items("ops").items).toEqual([]);

      expect((await answerApproval(hob.runtime, approval.id, { key: "A" })).status).toBe(200);
      await settled(hob, group.id, 1);
      expect(userTexts(hob.runtime.store.groupMemberFile(group.id, "ops")).at(-1)).toContain("用户选择了 A：重启");
      expect(assistantItems(hob, group.id)[0]!.text).toBe("好，等你定");
    } finally {
      hob.close();
    }
  });

  it("单聊转交进行时群任务和提问不挂转交", async () => {
    const { hob, group } = setup();
    try {
      const state = await hob.runtime.router.ensure("ops");
      state.currentDelegationId = "dg-test";
      const tools = buildRouterTools(hob.runtime, "ops", group.id);
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("好")]);
      await tools.find((tool) => tool.name === "start_job")!.execute("call", { title: "测试任务" });
      const job = hob.runtime.store.jobs().find((item) => item.title === "测试任务")!;
      expect(job.delegationId).toBeUndefined();
      const addApproval = vi.spyOn(hob.runtime.delegations, "addApproval");
      await tools.find((tool) => tool.name === "ask_user")!.execute("call", { title: "确认", options: [{ label: "是" }, { label: "否" }] });
      expect(addApproval).not.toHaveBeenCalled();
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("单聊发消息不结束群里的待答提问", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([call("ask_user", { title: "要重启吗", options: [{ label: "是" }, { label: "否" }] })]);
      await hob.runtime.groups.send(group.id, { text: "@服务器 看一下" });
      await waitFor(() => groupItems(hob, group.id).some((item) => item.kind === "question"));
      const card = groupItems(hob, group.id).find((item) => item.kind === "question")!;
      if (card.kind !== "question") throw new Error("提问卡不存在");
      hob.faux.appendResponses([text("收到")]);
      await hob.runtime.router.send("ops", { text: "你好" });
      await hob.runtime.router.waitIdle("ops");
      expect(hob.runtime.store.approval(card.approvalId)?.status).toBe("pending");
    } finally {
      hob.close();
    }
  });

  it("发文件、生图的条目进群，生图完成后同 id 更新", async () => {
    const { hob, group } = setup();
    let respond: (() => void) | undefined;
    const server = createServer((_req, res) => {
      respond = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })); };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const tools = buildRouterTools(hob.runtime, "ops", group.id);
      const file = join(hob.home, "报告.txt");
      writeFileSync(file, "内容");
      const sent = await tools.find((tool) => tool.name === "send_file")!.execute("call", { path: file });
      expect((sent.content[0] as { text: string }).text).toBe("已发送。");
      expect(groupItems(hob, group.id).at(-1)).toMatchObject({ kind: "file", speaker: "ops", path: file });
      expect(hob.runtime.router.items("ops").items).toEqual([]);

      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      hob.runtime.settings.setImage(hob.runtime.settings.get().revision, { source: "openai", baseUrl, model: "fake", size: "1024x1024" });
      writeSecret(hob.home, "imageApiKey", "fake");
      const events: GroupItem[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "group-item" && event.item.kind === "image") events.push(event.item); });
      const image = buildRouterTools(hob.runtime, "ops", group.id).find((tool) => tool.name === "generate_image")!.execute("call", { prompt: "猫" });
      await waitFor(() => !!respond);
      expect(events[0]).toMatchObject({ kind: "image", speaker: "ops", status: "pending", prompt: "猫" });
      respond!();
      await image;
      expect(events.at(-1)).toMatchObject({ id: events[0]!.id, status: "done", path: expect.stringContaining("/images/") });
      const images = groupItems(hob, group.id).filter((item) => item.kind === "image");
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ status: "done" });
    } finally {
      hob.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("群归档以后任务才结束：结果落回单聊，不报错", async () => {
    const { hob, group } = setup();
    try {
      hob.faux.setResponses([call("bash", { command: "sleep 0.3" })]);
      const job = await hob.runtime.jobs.start("ops", { title: "清理旧快照", instruction: "清理一下", groupId: group.id });
      await hob.runtime.groups.archive(group.id);
      hob.faux.appendResponses([call("report", { outcome: "done", result: "清掉了 3 个" }), text("好"), text("清掉了 3 个旧快照")]);
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("ops");

      expect(hob.runtime.store.job(job.id)).toMatchObject({ status: "done", groupId: group.id });
      // 卡片在归档前就进了群；结果回不到群里，落回单聊
      expect(readFileSync(hob.runtime.store.routerFile("ops"), "utf8")).toContain("[hob-event] 任务「清理旧快照」");
      expect(hob.runtime.router.items("ops").items.filter((item) => item.kind === "assistant").map((item) => item.text)).toEqual(["清掉了 3 个旧快照"]);
    } finally {
      hob.close();
    }
  });

  it("成员被移出群以后：卡片和事件落回单聊", async () => {
    const { hob, group } = setup();
    try {
      hob.runtime.groups.update(group.id, { members: ["hob", "write"] });
      const card = await hob.runtime.router.addItem("ops", { kind: "note", icon: "info", text: "给用户的一句话" }, group.id);
      expect(card.id.startsWith("g-")).toBe(false);
      expect(hob.runtime.router.items("ops").items.at(-1)).toMatchObject({ kind: "note", text: "给用户的一句话" });

      hob.faux.setResponses([text("收到")]);
      await hob.runtime.router.event("ops", "结果回来了", undefined, group.id);
      await hob.runtime.router.waitIdle("ops");
      expect(readFileSync(hob.runtime.store.routerFile("ops"), "utf8")).toContain("[hob-event] 结果回来了");
      expect(groupItems(hob, group.id).some((item) => item.kind === "note" && item.text === "给用户的一句话")).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("群会话跑完一轮后保留本地记忆工具", async () => {
    const hob = makeHob({}, { memory: "local" });
    const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
    try {
      hob.faux.setResponses([text("收到")]);
      await hob.runtime.groups.send(group.id, { text: "你好" });
      await settled(hob, group.id, 1);
      const state = await hob.runtime.router.ensure("hob", group.id);
      expect(state.session!.getActiveToolNames()).toContain("memory_read");
    } finally {
      hob.close();
    }
  });

  it("群会话的工具里没有 show_page，也没有改档案和规矩的；能把自己的任务沉淀成技能", async () => {
    const { hob, group } = setup();
    try {
      const state = await hob.runtime.router.ensure("ops", group.id);
      const names = state.session!.getActiveToolNames();
      expect(names).toContain("start_job");
      expect(names).toContain("ask_user");
      expect(names).toContain("save_job_as_skill");
      expect(names).not.toContain("show_page");
      expect(names).toContain("set_rule");
      expect(names).toContain("create_routine");
    } finally {
      hob.close();
    }
  });

  it("busy 带上有任务在跑的成员", async () => {
    const { hob, group } = setup();
    try {
      expect(hob.runtime.groups.summary(group.id).busy).toEqual([]);
      hob.faux.setResponses([call("bash", { command: "sleep 0.4" }), call("report", { outcome: "done", result: "好了" }), text("好"), text("好了")]);
      const job = await hob.runtime.jobs.start("ops", { title: "慢慢做", instruction: "做吧", groupId: group.id });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "running");
      expect(hob.runtime.groups.summary(group.id).busy).toContain("ops");

      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("ops", 15_000, group.id);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0);
    } finally {
      hob.close();
    }
  });
});
