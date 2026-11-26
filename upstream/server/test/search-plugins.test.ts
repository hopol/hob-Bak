import { describe, expect, it, vi } from "vitest";
import { PluginHost, type PluginServiceState } from "../src/plugin-host.ts";
import { searchPluginsTool } from "../src/search-plugins.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { buildSystemPrompt, buildWorkerPrompt } from "../src/prompt.ts";
import { call, makeHob, seedPluginSource, text } from "./helpers.ts";

const sentence = "你能用的工具之外，Hob 还有插件市场，装上插件就能连 GitHub、邮箱这类外部服务。用户问你能不能连某个服务，或者要做一件你手上的工具做不到的事，先用 search_plugins 查一下再回答：有合适的插件，告诉用户它叫什么、怎么装；市场里也没有，再说做不到。";

describe("search_plugins", () => {
  it("查询官方市场、自定义插件及其助手范围和连接状态", async () => {
    const hob = makeHob();
    try {
      const host = hob.runtime.plugins;
      seedPluginSource(hob.home);
      const run = async (query?: string) => (await searchPluginsTool(host, "hob").execute("call", { query })).content[0].text;
      expect(await run("GiThUb")).toContain("状态：没安装。用户在「插件 → 市场」里安装，再填配置。");
      expect(await run("DEVELOPMENT")).toContain("GitHub");
      expect(await run("personal ACCESS token")).toContain("GitHub");
      expect(await run("GitHub 查看仓库 Pull Request")).toContain("GitHub");
      expect(await run("GitHub 查看仓库 Pull Request")).not.toContain("没有匹配");
      const all = await run();
      expect(all).toContain("GitHub");
      const missing = await run("没有这种插件xyz");
      expect(missing).toBe(`没有匹配「没有这种插件xyz」的插件\n${all}`);
      host.store.install("github");
      host.store.patch("github", { assistants: ["other"] });
      expect(await run("github")).toContain("已安装但没给你用。用户在「插件 → GitHub」里把它给你用。");
      host.store.patch("github", { enabled: false });
      expect(await run("github")).toContain("已安装但没给你用。用户在「插件 → GitHub」里启用它。");
      host.store.patch("github", { enabled: true, assistants: null });
      await host.reload("github");
      expect(await run("github")).toContain("待配置。用户在「插件 → GitHub」里填配置。");
      const original = host.states.bind(host);
      const state = (status: PluginServiceState["status"], error?: string): PluginServiceState[] => [{ pluginId: "github", name: "github", status, tools: [], error }];
      host.states = (id?: string) => id === "github" ? state("error", "连接失败的原文") : original(id);
      expect(await run("github")).toContain("填配置。 连接失败的原文");
      host.states = (id?: string) => id === "github" ? state("connected") : original(id);
      expect(await run("github")).toContain("已经能用。它的工具名以 github_ 开头。");
      host.store.addCustom("my-mcp", { command: "node", args: ["fake.js"], enabled: false });
      expect(await run("MY-MCP")).toContain("my-mcp：");
    } finally { hob.close(); }
  });

  it("实际任务会话的工具名单不含插件搜索", async () => {
    const hob = makeHob();
    try {
      const open = vi.spyOn(hob.runtime.pi, "open");
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      hob.faux.appendResponses([text("完成")]);
      await hob.runtime.jobs.start("hob", { title: "测试", instruction: "完成测试" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      const worker = open.mock.calls.map(([options]) => options).find(options => options.customTools.some(tool => tool.name === "report"));
      expect(worker).toBeDefined();
      expect(worker!.tools).not.toContain("search_plugins");
      expect(worker!.customTools.map(tool => tool.name)).not.toContain("search_plugins");
    } finally { hob.close(); }
  });

  it("助手有工具和原文，任务提示词没有", () => {
    const hob = makeHob();
    try {
      const settings = { timezone: "UTC", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      expect(buildRouterTools(hob.runtime, "hob").map(t => t.name)).toContain("search_plugins");
      expect(buildSystemPrompt(hob.runtime.store, "hob", settings)).toContain(sentence);
      hob.runtime.store.saveJob({ id: "t-test", assistantId: "hob", title: "测试", instruction: "测试", status: "queued", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      expect(buildWorkerPrompt(hob.runtime.store, "t-test", settings)).not.toContain("search_plugins");
    } finally { hob.close(); }
  });
});
