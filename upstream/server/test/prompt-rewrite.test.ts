import { describe, expect, it, vi } from "vitest";
import { answerApproval } from "../src/actions.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { registerAskTool, registerLoginTool, registerReportTool } from "../src/worker-tools.ts";
import loreEntry from "../src/lore-entry.ts";
import { makeHob } from "./helpers.ts";

describe("工具说明和确认选项", () => {
  it("Router 和 Worker 的 remember 补充规则选项并拒绝超出上限", async () => {
    const hob = makeHob();
    try {
      const router = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "ask_user")!;
      const ask = vi.spyOn(hob.runtime.jobs, "askQuestion").mockResolvedValue("选了");
      const worker = registerAskTool(hob.runtime, "t-test");
      const input = { title: "清理吗", options: [{ label: "清理" }, { label: "不清理" }], remember: "清理临时目录" };
      const expected = { ruleText: "清理临时目录", options: [{ key: "A", label: "清理" }, { key: "B", label: "不清理" }, { key: "C", label: "以后「清理临时目录」直接执行", always: true }] };
      await router.execute("r", input);
      expect(hob.runtime.store.approvals()[0]).toMatchObject(expected);
      await worker.execute("w", input);
      expect(ask).toHaveBeenCalledWith("t-test", { title: "清理吗", options: expected.options.slice(0, 2) });
      expect(worker.parameters.properties).not.toHaveProperty("remember");
      for (const tool of [router, worker]) {
        expect(tool.parameters.properties).not.toHaveProperty("ruleText");
        expect(tool.parameters.properties.options.items.properties).not.toHaveProperty("always");
      }
      const result = await router.execute("x", { ...input, options: [...input.options, { label: "稍后" }] });
      expect(result).toMatchObject({ isError: true, content: [{ text: "带 remember 时最多给 2 个选项。" }] });
    } finally { hob.close(); }
  });

  it("没有凭据提供者时 login 只请用户自己登录：Router 出登录卡，Worker 先把登录请求交给助手", async () => {
    const hob = makeHob();
    try {
      const router = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "login")!;
      const ask = vi.spyOn(hob.runtime.jobs, "askQuestion").mockResolvedValue("用户已完成登录");
      const worker = registerLoginTool(hob.runtime, "t-login");
      const params = { site: "测试站", reason: "需要用户完成两步验证" };
      expect(router.parameters.properties).not.toHaveProperty("account");
      expect(worker.parameters.properties).not.toHaveProperty("account");
      await router.execute("r", params);
      const approval = hob.runtime.store.approvals()[0];
      expect(approval).toMatchObject({ title: "需要登录：测试站", login: params, source: "router", options: [{ key: "A", label: "已登录" }] });
      expect(hob.runtime.router.items("hob").items).toContainEqual(expect.objectContaining({ kind: "question", approvalId: approval.id }));
      await worker.execute("w", params);
      expect(ask.mock.calls[0]).toEqual(["t-login", { title: "需要登录：测试站", detail: params.reason, options: [{ key: "A", label: "已登录" }], login: params }, undefined]);
    } finally { hob.close(); }
  });

  it("login 的完成答案和用户另发消息都会结束登录卡", async () => {
    const hob = makeHob();
    try {
      vi.spyOn(hob.runtime.router, "answerEvent").mockResolvedValue();
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "login")!;
      await tool.execute("login", { site: "测试站", reason: "需要完成验证" });
      const first = hob.runtime.store.approvals()[0];
      expect((await answerApproval(hob.runtime, first.id, { key: "A" })).status).toBe(200);
      expect(hob.runtime.store.approval(first.id)).toMatchObject({ status: "answered", chosen: "A" });
      await tool.execute("login-2", { site: "另一个站", reason: "需要登录" });
      const second = hob.runtime.store.approvals().find((item) => item.status === "pending")!;
      await hob.runtime.router.send("hob", { text: "我先问另一件事" });
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.store.approval(second.id)).toMatchObject({ status: "expired" });
    } finally { hob.close(); }
  });

  it("新建助手不再接收 facts，职责由 dutyLong 提供", async () => {
    const hob = makeHob();
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "create_assistant")!;
      const result = await tool.execute("p", { name: "天气", duty: "天气", dutyLong: "查天气", sprite: "page" });
      expect(result.isError).not.toBe(true);
      const draft = hob.runtime.store.drafts()[0];
      expect(draft).not.toHaveProperty("instructions");
      const created = hob.runtime.store.assistants().find((item) => item.name === "天气");
      expect(created?.dutyLong).toBe("查天气");
    } finally { hob.close(); }
  });

  it("新建助手不能使用主助手火苗", async () => {
    const hob = makeHob();
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "create_assistant")!;
      const result = await tool.execute("p", { name: "助手", duty: "工作", dutyLong: "做事", sprite: "hob" });
      expect(result).toMatchObject({ isError: true, content: [{ text: "hob 火苗是主助手专用的。" }] });
      expect(hob.runtime.store.drafts()).toHaveLength(0);
    } finally { hob.close(); }
  });

  it("工具说明与参数没有结束本轮的提示", () => {
    const hob = makeHob();
    try {
      const tools = [...buildRouterTools(hob.runtime, "hob"), registerAskTool(hob.runtime, "t"), registerReportTool(hob.runtime, "t")];
      const secondary = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...secondary, id: "ops", name: "运维", primary: false });
      tools.push(...buildRouterTools(hob.runtime, "ops"));
      for (const tool of tools) {
        expect(JSON.stringify({ description: tool.description, promptSnippet: tool.promptSnippet, parameters: tool.parameters })).not.toMatch(/本轮|不要再输出/);
      }
    } finally { hob.close(); }
  });
});

describe("Lore 入口", () => {
  it("关闭启动基线注入，保留插件的工具和事件注册", () => {
    const pi = { pluginConfig: { skillsEnabled: false, marker: 1 }, on: vi.fn(), registerTool: vi.fn() };
    loreEntry(pi as never);
    expect(pi.pluginConfig).toMatchObject({ skillsEnabled: false, marker: 1, injectPromptGuidance: false });
    expect(pi.on).toHaveBeenCalled();
    expect(pi.registerTool).toHaveBeenCalled();
  });
});
