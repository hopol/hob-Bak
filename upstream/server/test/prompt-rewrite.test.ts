import { describe, expect, it, vi } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { registerAskTool, registerReportTool } from "../src/worker-tools.ts";
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
      const expected = { ruleText: "清理临时目录", options: [{ key: "A", label: "清理" }, { key: "B", label: "不清理" }, { key: "C", label: "以后「清理临时目录」直接做", always: true }] };
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

  it("facts 非空才能建草稿，事实进入助手补充说明", async () => {
    const hob = makeHob();
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "propose_assistant")!;
      const input = { name: "天气", duty: "天气", dutyLong: "查天气", sprite: "page" };
      for (const facts of [undefined, [], [" ", ""]]) {
        expect(await tool.execute("p", { ...input, facts })).toMatchObject({ isError: true, content: [{ text: "facts 至少写一条：这个助手管什么、不管什么。" }] });
      }
      await tool.execute("p", { ...input, facts: ["  负责天气  "] });
      expect(hob.runtime.store.drafts()[0].instructions).toEqual(["负责天气"]);
      const { createFromDraft } = await import("../src/actions.ts");
      const result = await createFromDraft(hob.runtime, hob.runtime.store.drafts()[0].id);
      const id = (result.body as { assistant: { id: string } }).assistant.id;
      expect(hob.runtime.store.assistant(id)?.instructions).toBe("负责天气");
    } finally { hob.close(); }
  });

  it("草稿头像不能使用主助手火苗", async () => {
    const hob = makeHob();
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "propose_assistant")!;
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
