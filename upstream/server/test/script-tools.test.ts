import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { ScriptToolCredentials, scriptToolList } from "../src/script-tools.ts";
import { searchTools } from "../src/search.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { buildSystemPrompt, buildWorkerPrompt } from "../src/prompt.ts";
import { makeHob } from "./helpers.ts";

const run = promisify(execFile);

describe("script tools", () => {
  it("loads tools in node, keeps NODE_OPTIONS, and revokes credentials", async () => {
    const service = new ScriptToolCredentials();
    await service.start();
    const calls: string[] = [];
    const tool = { name: "web_search", label: "搜索", description: "搜索", parameters: Type.Object({ query: Type.String() }), execute: async (_id: string, args: { query: string }) => ({ content: [{ type: "text" as const, text: args.query }], details: undefined }) };
    const credential = service.issue({ tools: async () => [tool], onCall: (item) => calls.push(item.label) });
    const env = service.environment({ ...process.env, NODE_OPTIONS: "--no-warnings" }, credential.token);
    try {
      expect(env.NODE_OPTIONS).toContain("--no-warnings");
      const result = await run(process.execPath, ["--input-type=module", "-e", "console.log(JSON.stringify([await tools.$list(), await tools.web_search({query:'hello'})]))"], { env });
      expect(JSON.parse(result.stdout)).toMatchObject([[{ name: "web_search" }], "hello"]);
      expect(calls).toEqual(["搜索"]);
      credential.revoke();
      await expect(run(process.execPath, ["--input-type=module", "-e", "await tools.$list()"], { env })).rejects.toThrow("这次运行已经结束，tools 不可用");
      const outside = { ...env }; delete outside.HOB_TOOLS_TOKEN; delete outside.HOB_TOOLS_URL;
      await expect(run(process.execPath, ["--input-type=module", "-e", "await tools.$list()"], { env: outside })).rejects.toThrow("不在 Hob 里运行，tools 不可用");
    } finally { service.close(); }
  });

  it("calls the built-in search through a bash-launched node process", async () => {
    const hob = makeHob();
    const fake = createServer((request, response) => {
      const query = new URL(request.url!, "http://localhost").searchParams.get("q");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results: [{ title: `标题 ${query}`, url: "https://example.test/", content: "摘要" }] }));
    });
    const service = new ScriptToolCredentials();
    try {
      await new Promise<void>((resolve, reject) => { fake.once("error", reject); fake.listen(31823, "127.0.0.1", resolve); });
      await service.start();
      const tools = searchTools(hob.home, () => [{ name: "searxng", enabled: true, baseUrl: "http://127.0.0.1:31823" }]);
      const credential = service.issue({ tools: async () => tools });
      const script = "node -e 'tools.web_search({query:\"海风\"}).then(x => console.log(x))'";
      const result = await run("/bin/bash", ["-c", script], { env: service.environment(process.env, credential.token) });
      expect(JSON.parse(result.stdout).results[0].title).toBe("标题 海风");
      credential.revoke();
    } finally {
      service.close();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
      hob.close();
    }
  });

  it("includes the exact script guidance in assistant and worker prompts", () => {
    const hob = makeHob();
    try {
      const settings = { timezone: "UTC", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const, searchEnabled: false, imageEnabled: false, desktopEnabled: false };
      const job = { id: "t-test", assistantId: "hob", cwd: hob.home };
      const store = Object.create(hob.runtime.store) as typeof hob.runtime.store;
      store.job = () => job as never;
      const text = "在 Hob 里运行的 node 脚本可以用全局对象 tools 调用你能用的工具，包括插件的：await tools.名字({ 参数 })，tools.$list() 列出有哪些。一次要调很多次、要从大量结果里筛出一部分、或者要写成定时检查时，写成脚本：中间结果不进对话，只有你输出的内容回来。只调一两次，直接调工具。";
      expect(buildSystemPrompt(store, "hob", settings)).toContain(text);
      expect(buildWorkerPrompt(store, "t-test", settings)).toContain(text);
      expect(buildSystemPrompt(store, "hob", { ...settings, abilities: { exec: false, write: true, image: true } })).not.toContain(text);
    } finally { hob.close(); }
  });

  it("limits the list for private and group sessions and records check calls", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "研究", purpose: "研究资料", ownerId: "hob", members: ["hob"] });
      for (const groupId of [undefined, group.id]) {
        const names = scriptToolList(buildRouterTools(hob.runtime, "hob", groupId), false).map((tool) => tool.name);
        expect(names).toContain("find_knowledge");
        expect(names).not.toContain("search_knowledge");
        expect(names).not.toContain("start_job");
        expect(names).not.toContain("ask_user");
        const routineTool = buildRouterTools(hob.runtime, "hob", groupId).find((tool) => tool.name === "create_routine")!;
        expect(JSON.stringify(routineTool.parameters)).toContain("脚本里要调用你的工具（包括插件），用 node 运行 JS，全局对象 tools 就是你能用的工具。");
      }
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "检查", instruction: "检查", schedules: ["0 9 * * *"], check: { script: "node -e 'tools.find_knowledge({}).then(() => {})'", then: "notify" } });
      expect(await hob.runtime.routines.runNow(routine.id)).toEqual({ outcome: "quiet" });
      expect(hob.runtime.store.routine(routine.id)?.checks?.history?.[0]).toMatchObject({ outcome: "quiet", tools: ["找资料"] });
    } finally { hob.runtime.scriptTools.close(); hob.close(); }
  });
});
