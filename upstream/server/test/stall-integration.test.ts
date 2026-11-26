import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { call, makeHob, text, waitFor } from "./helpers.ts";

function messages(path: string) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).message).filter(Boolean);
}

describe("工具限时和任务看门狗", () => {
  it("挂住的 MCP 工具超时后模型接着回复，正常插件调用不加提示", async () => {
    const hob = makeHob();
    hob.runtime.router.stallOverrideMs = 300;
    try {
      const dir = join(hob.home, "system/engine"); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { sample: { command: process.execPath, args: [join(process.cwd(), "server/test/fixtures/mcp-fixture.mjs")], env: { HOB_MCP_NEVER: "1" } } } }));
      hob.runtime.plugins.store.migrateLegacy();
      await hob.runtime.plugins.start();
      hob.faux.setResponses([call("sample_hang", {}), text("查询未完成。")]);
      await hob.runtime.router.send("hob", { text: "查询目录" });
      await waitFor(() => !hob.runtime.router.isBusy("hob"), 5000);
      let history = messages(join(hob.home, "assistants/hob/router.jsonl"));
      expect(history.find(m => m.role === "toolResult" && m.toolName === "sample_hang")?.content).toEqual([{ type: "text", text: "「sample_hang」0.005 分钟没有结束，Hob 停掉了这次调用。" }]);
      expect(hob.runtime.router.items("hob").items.some(item => item.kind === "assistant" && item.text === "查询未完成。")).toBe(true);
      hob.faux.setResponses([call("sample_echo", { message: "ok" }), text("收到。")]);
      await hob.runtime.router.send("hob", { text: "验证插件" });
      await waitFor(() => !hob.runtime.router.isBusy("hob"), 5000);
      history = messages(join(hob.home, "assistants/hob/router.jsonl"));
      expect(history.find(m => m.role === "toolResult" && m.toolName === "sample_echo")?.content).toEqual([{ type: "text", text: "echo: ok" }]);
    } finally { await hob.runtime.plugins.close(); hob.close(); }
  }, 10000);

  it("按需搜索激活的插件工具也受同一时限约束", async () => {
    const hob = makeHob();
    hob.runtime.router.stallOverrideMs = 300;
    try {
      const dir = join(hob.home, "system/engine"); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { sample: { command: process.execPath, args: [join(process.cwd(), "server/test/fixtures/mcp-fixture.mjs")], env: { HOB_MCP_NEVER: "1", HOB_MCP_MANY: "1" } } } }));
      hob.runtime.plugins.store.migrateLegacy();
      await hob.runtime.plugins.start();
      hob.faux.setResponses([call("tool_search", { query: "sample hang" }), call("sample_hang", {}), text("查询未完成。")]);
      await hob.runtime.router.send("hob", { text: "查询目录" });
      await waitFor(() => !hob.runtime.router.isBusy("hob"), 5000);
      const history = messages(join(hob.home, "assistants/hob/router.jsonl"));
      expect(history.find(m => m.role === "toolResult" && m.toolName === "sample_hang")?.content).toEqual([{ type: "text", text: "「sample_hang」0.005 分钟没有结束，Hob 停掉了这次调用。" }]);
      expect(hob.runtime.router.items("hob").items.some(item => item.kind === "assistant" && item.text === "查询未完成。")).toBe(true);
    } finally { await hob.runtime.plugins.close(); hob.close(); }
  }, 10000);

  it("输出中的长命令不被任务看门狗判为受阻", async () => {
    const hob = makeHob();
    hob.runtime.jobs.stallOverrideMs = 150;
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("bash", { command: "for i in 1 2 3 4 5; do printf 'step\\n'; sleep 0.1; done", timeout: 3 }), call("report", { outcome: "done", result: "完成" })]);
      const job = await hob.runtime.jobs.start("hob", { title: "处理清单", instruction: "执行命令" });
      await waitFor(() => hob.runtime.jobs.transcript(job.id).some(step => step.name === "bash" && step.running));
      hob.runtime.jobs.checkStalls(Date.now() + 24 * 3600_000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("running");
      await hob.runtime.jobs.waitIdle(5000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
    } finally { hob.close(); }
  }, 10000);

  it("任务安静命令超时后接着提交结果", async () => {
    const hob = makeHob();
    hob.runtime.jobs.stallOverrideMs = 180;
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("bash", { command: "sleep 2" }), call("report", { outcome: "done", result: "命令超时，已记录" })]);
      const job = await hob.runtime.jobs.start("hob", { title: "检查清单", instruction: "执行命令" });
      await hob.runtime.jobs.waitIdle(5000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
      expect(hob.runtime.jobs.transcript(job.id).find(step => step.name === "bash")?.output).toContain("「bash」0.003 分钟没有结束，Hob 停掉了这次调用。要跑得更久");
    } finally { hob.close(); }
  }, 10000);

  it("群话题里的命令超时后仍能继续答复", async () => {
    const hob = makeHob();
    hob.runtime.router.stallOverrideMs = 150;
    try {
      const group = hob.runtime.groups.create({ name: "资料组", purpose: "整理资料", ownerId: "hob", members: ["hob"] });
      const topic = hob.runtime.groups.createTopic(group.id, "目录", "user");
      hob.faux.setResponses([call("bash", { command: "sleep 2" }), text("命令超时，我会换个办法。")]);
      await hob.runtime.groups.send(topic.id, { text: "检查目录" });
      await waitFor(() => hob.runtime.groups.items(topic.id).items.some(item => item.kind === "assistant" && item.text === "命令超时，我会换个办法。"), 5000);
      expect(hob.runtime.groups.items(topic.id).items.some(item => item.kind === "note" && item.text.includes("无响应，已停止"))).toBe(false);
    } finally { hob.close(); }
  }, 10000);

  it("创建任务在模型目录加载时中止，不会迟到创建任务", async () => {
    const hob = makeHob();
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const getModels = hob.runtime.models.get.bind(hob.runtime.models);
    vi.spyOn(hob.runtime.models, "get").mockImplementation(async () => { entered(); await gate; return getModels(); });
    try {
      const pending = hob.runtime.jobs.start("hob", { title: "整理目录", instruction: "检查" }, controller.signal);
      await started;
      controller.abort();
      release();
      await expect(pending).rejects.toThrow();
      expect(hob.runtime.store.jobs()).toHaveLength(0);
    } finally { release(); hob.close(); }
  });

  it("转交在建立记录期间被中止时不会迟到启动目标回合", async () => {
    const hob = makeHob();
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const source = hob.runtime.store.assistant("hob")!;
    hob.runtime.store.saveAssistant({ ...source, id: "archive", name: "资料助手", primary: false });
    const addItem = hob.runtime.router.addItem.bind(hob.runtime.router);
    vi.spyOn(hob.runtime.router, "addItem").mockImplementation(async (...args) => { entered(); await gate; return addItem(...args); });
    vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
    const relay = vi.spyOn(hob.runtime.router, "relay");
    try {
      const pending = hob.runtime.delegations.start("hob", "archive", "整理目录", [], controller.signal);
      await started;
      controller.abort();
      release();
      await expect(pending).rejects.toThrow();
      expect(relay).not.toHaveBeenCalled();
      expect(hob.runtime.store.delegations()[0].status).toBe("stuck");
    } finally { release(); hob.close(); }
  });

  it("创建助手在草稿卡等待时超时，不会迟到自动创建", async () => {
    const hob = makeHob();
    hob.runtime.router.stallOverrideMs = 150;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const addItem = hob.runtime.router.addItem.bind(hob.runtime.router);
    vi.spyOn(hob.runtime.router, "addItem").mockImplementation(async (...args) => {
      if (args[1].kind === "draft") { entered(); await gate; }
      return addItem(...args);
    });
    try {
      hob.faux.setResponses([call("create_assistant", { name: "资料助手", duty: "资料整理", dutyLong: "整理资料", sprite: "page" }), text("创建未完成。")]);
      await hob.runtime.router.send("hob", { text: "创建助手" });
      await started;
      await waitFor(() => !hob.runtime.router.isBusy("hob"), 5000);
      release();
      await waitFor(() => hob.runtime.store.drafts().length > 0, 3000);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(hob.runtime.store.assistants().some(assistant => assistant.name === "资料助手")).toBe(false);
      expect(hob.runtime.store.drafts()[0].status).toBe("pending");
    } finally { release(); hob.close(); }
  });

  it("交给群在话题卡等待时超时，会关闭未接手的话题且不迟到唤醒群主", async () => {
    const hob = makeHob();
    hob.runtime.router.stallOverrideMs = 150;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const group = hob.runtime.groups.create({ name: "资料群", purpose: "资料整理", ownerId: "hob", members: ["hob"] });
    const addItem = hob.runtime.router.addItem.bind(hob.runtime.router);
    vi.spyOn(hob.runtime.router, "addItem").mockImplementation(async (...args) => {
      if (args[1].kind === "topic") { entered(); await gate; }
      return addItem(...args);
    });
    vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
    const deliver = vi.spyOn(hob.runtime.groups, "deliverEvent");
    try {
      hob.faux.setResponses([call("message_group", { groupId: group.id, title: "整理目录", note: "整理档案目录" }), text("交接未完成。")]);
      await hob.runtime.router.send("hob", { text: "交给群处理" });
      await started;
      await waitFor(() => !hob.runtime.router.isBusy("hob"), 5000);
      expect(hob.runtime.groups.topicsOf(group.id)[0].closedAt).toBeTruthy();
      release();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(deliver).not.toHaveBeenCalled();
    } finally { release(); hob.close(); }
  });

  it.each([
    ["ask_user", { title: "选择整理方式", options: [{ label: "按日期" }, { label: "按主题" }] }],
    ["login", { site: "虚构档案站", reason: "查看目录" }],
  ])("%s 在卡片等待时超时，会结束待答状态", async (name, args) => {
    const hob = makeHob();
    hob.runtime.router.stallOverrideMs = 150;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const addItem = hob.runtime.router.addItem.bind(hob.runtime.router);
    vi.spyOn(hob.runtime.router, "addItem").mockImplementation(async (...args) => {
      if (args[1].kind === "question") { entered(); await gate; }
      return addItem(...args);
    });
    try {
      hob.faux.setResponses([call(name, args), text("请求未完成。")]);
      await hob.runtime.router.send("hob", { text: "整理资料" });
      await started;
      await waitFor(() => !hob.runtime.router.isBusy("hob"), 5000);
      expect(hob.runtime.store.approvals()[0].status).toBe("expired");
      release();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(hob.runtime.store.approvals()[0].status).toBe("expired");
    } finally { release(); hob.close(); }
  });

  it.each([
    ["ask_user", { title: "采用哪个方案", options: [{ label: "甲" }, { label: "乙" }] }],
    ["login", { site: "虚构资料站", reason: "查看目录" }],
  ])("任务 %s 等待答复超过时限后仍可继续", async (name, args) => {
    const hob = makeHob();
    hob.runtime.jobs.stallOverrideMs = 250;
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      hob.faux.setResponses([call(name, args), call("report", { outcome: "done", result: "已收到答复" })]);
      const job = await hob.runtime.jobs.start("hob", { title: "整理方案", instruction: "核对" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting", 5000);
      await new Promise(resolve => setTimeout(resolve, 700));
      expect(hob.runtime.store.job(job.id)?.status).toBe("waiting");
      expect(hob.runtime.store.approvals().find(item => item.jobId === job.id)?.status).toBe("pending");
      await hob.runtime.jobs.reply(job.id, "按第一项处理", "user");
      await hob.runtime.jobs.waitIdle(5000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
      expect(hob.runtime.store.approvals().find(item => item.jobId === job.id)?.status).toBe("answered");
      const history = messages(hob.runtime.store.workerFile(job.id));
      expect(history.find(m => m.role === "toolResult" && m.toolName === name)?.content[0].text).toContain("按第一项处理");
    } finally { hob.close(); }
  }, 10000);

  it("任务等待答复时仍可由用户停止", async () => {
    const hob = makeHob();
    hob.runtime.jobs.stallOverrideMs = 200;
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      hob.faux.setResponses([call("ask_user", { title: "选择顺序", options: [{ label: "按日期" }, { label: "按主题" }] })]);
      const job = await hob.runtime.jobs.start("hob", { title: "整理目录", instruction: "等待答复" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting", 5000);
      await hob.runtime.jobs.stop(job.id);
      expect(hob.runtime.store.job(job.id)?.status).toBe("stopped");
    } finally { hob.close(); }
  }, 10000);

  it("任务模型挂住一次后自动重试并提交结果", async () => {
    const hob = makeHob();
    hob.runtime.jobs.stallOverrideMs = 150;
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([() => new Promise<never>(() => undefined), call("report", { outcome: "done", result: "核对完成" })]);
      const job = await hob.runtime.jobs.start("hob", { title: "核对目录", instruction: "核对" });
      await hob.runtime.jobs.waitIdle(5000);
      expect(hob.runtime.store.job(job.id)).toMatchObject({ status: "done", summary: "核对完成" });
      expect(hob.runtime.store.job(job.id)?.activity.some(line => line.text === "模型没有响应，正在重试")).toBe(true);
      expect(hob.faux.state.callCount).toBeGreaterThanOrEqual(2);
    } finally { hob.close(); }
  }, 10000);

  it("模型连续无响应时任务标为受阻", async () => {
    const hob = makeHob();
    hob.runtime.jobs.stallOverrideMs = 100;
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([() => new Promise<never>(() => undefined), () => new Promise<never>(() => undefined)]);
      const job = await hob.runtime.jobs.start("hob", { title: "核对清单", instruction: "核对" });
      await hob.runtime.jobs.waitIdle(5000);
      expect(hob.runtime.store.job(job.id)).toMatchObject({ status: "stuck", statusReason: "模型没有响应" });
    } finally { hob.close(); }
  }, 10000);
});
