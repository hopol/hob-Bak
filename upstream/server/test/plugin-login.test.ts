import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pluginToolsForAssistant } from "../src/plugin-host.ts";
import { makeHob } from "./helpers.ts";

let server: Server | undefined;
afterEach(async () => { await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()); server = undefined; });

// 不登录也能列出工具的远程 MCP（和 Gmail 一样）
async function listsToolsWithoutLogin(port: number): Promise<void> {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body || "{}");
      if (message.id === undefined) { response.statusCode = 202; response.end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mail", version: "1" } }
        : message.method === "tools/list" ? { tools: [{ name: "list_labels", description: "List labels.", inputSchema: { type: "object", properties: {} } }] } : {};
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(port, "127.0.0.1", resolve); });
}

it("声明了 OAuth 但还没登录：不算连上，工具不交给助手，插件页照样列出工具", async () => {
  await listsToolsWithoutLogin(31807);
  const hob = makeHob();
  try {
    const dir = join(hob.home, "plugins/mail");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "mail", displayName: "Mail", version: "1.0.0" }));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { mail: { type: "http", url: "http://127.0.0.1:31807/mcp", oauth: { clientId: "client", clientSecret: "secret" } } } }));
    writeFileSync(join(hob.home, "system/plugins.json"), JSON.stringify({ plugins: [{ id: "mail", version: "1.0.0", source: "custom", enabled: true, tools: {}, config: {} }] }));
    await hob.runtime.plugins.start();
    const [state] = hob.runtime.plugins.states("mail");
    expect(state.status).toBe("needs_login");
    expect(state.tools.map((tool) => tool.name)).toEqual(["list_labels"]);
    expect(pluginToolsForAssistant(hob.runtime.plugins, "hob")).toEqual([]);
    await expect(hob.runtime.plugins.call("mail", "mail", "list_labels", {})).rejects.toThrow();
  } finally { await hob.runtime.plugins.close(); hob.close(); }
}, 30_000);
