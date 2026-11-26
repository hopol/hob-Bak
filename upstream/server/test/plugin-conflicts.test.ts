import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { pluginToolsForAssistant } from "../src/plugin-host.ts";
import { makeHob, text } from "./helpers.ts";

it("skips only conflicting or long tools and records reasons on their service", async () => {
  const hob = makeHob();
  try {
    const host = hob.runtime.plugins;
    const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
    host.store.addCustom("tool", { command: process.execPath, args: [fixture], env: { HOB_MCP_COLLISIONS: "1" } });
    const path = join(hob.home, "plugins/tool/mcp.json");
    const mcp = JSON.parse(readFileSync(path, "utf8"));
    mcp.mcpServers.other = structuredClone(mcp.mcpServers.tool);
    writeFileSync(path, JSON.stringify(mcp));
    await host.start();
    const tools = pluginToolsForAssistant(host, "hob", new Set(["tool_search"]));
    expect(tools.map(tool => tool.name)).toEqual(["tool_echo", "tool_fail"]);
    expect(host.states("tool").find(state => state.name === "tool")?.toolErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search", reason: expect.stringContaining("冲突") }),
      expect.objectContaining({ reason: expect.stringContaining("64") }),
    ]));
    expect(host.states("tool").find(state => state.name === "other")?.toolErrors).toEqual(expect.arrayContaining([expect.objectContaining({ name: "echo", reason: expect.stringContaining("冲突") })]));
    hob.faux.setResponses([text("已完成。")]);
    await hob.runtime.router.send("hob", { text: "你好" });
    await hob.runtime.router.waitIdle("hob");
    expect(hob.runtime.router.items("hob").items.some(item => item.kind === "assistant" && item.text.includes("已完成"))).toBe(true);
  } finally { await hob.runtime.plugins.close(); hob.close(); }
}, 30_000);
