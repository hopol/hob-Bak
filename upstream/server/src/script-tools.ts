import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { delimiter } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { strictTools } from "./pi.ts";

export type ScriptTool = ToolDefinition<any, any> & { hidden?: boolean };

/** A single allowlist keeps conversation-only tools out; plugin host can append its tools here. */
export function scriptToolList(tools: ScriptTool[], knowledgeEnabled: boolean, pluginTools: ScriptTool[] = [], commandTools: ScriptTool[] = []): ScriptTool[] {
  const names = new Set(["web_search", "web_fetch", "find_knowledge", "generate_image", ...(knowledgeEnabled ? ["search_knowledge"] : [])]);
  return [...strictTools(tools.filter((tool) => names.has(tool.name))), ...pluginTools, ...commandTools];
}

export function prependPath(env: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
  const prefix = [...new Set(dirs.filter(Boolean))];
  if (!prefix.length) return env;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const existing = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  const prefixSet = new Set(prefix);
  const merged = [...prefix, ...existing.filter((entry) => !prefixSet.has(entry))];
  return { ...env, [pathKey]: merged.join(delimiter) };
}
export interface ScriptToolContext {
  tools: () => Promise<ScriptTool[]>;
  onCall?: (tool: ScriptTool) => void;
}

/** Credentials are private to a running session or check and never contain plugin secrets. */
export class ScriptToolCredentials {
  private readonly contexts = new Map<string, ScriptToolContext>();
  url = "";
  private server?: Server;
  private starting?: Promise<void>;

  async start(): Promise<void> {
    if (this.url) return;
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void (async () => {
          const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
          const context = this.get(token);
          const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
          if (!context) return send(401, { error: "这次运行已经结束，tools 不可用" });
          if (request.method !== "POST" || request.url !== "/") return send(404, { error: "接口不存在" });
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 1_000_000) return send(413, { error: "请求过大" });
          }
          try {
            const input = JSON.parse(body) as { name: string; args?: unknown };
            const tools = await context.tools();
            if (input.name === "$list") return send(200, tools.filter((item) => !item.hidden).map(({ name, label, description, parameters }) => ({ name, label, description, parameters })));
            const tool = tools.find((item) => item.name === input.name);
            if (!tool) return send(404, { error: `工具不可用：${input.name}` });
            let args: unknown;
            try { args = validateToolArguments(tool as never, { type: "toolCall", id: "script", name: input.name, arguments: (tool.prepareArguments ? tool.prepareArguments(input.args ?? {}) : input.args ?? {}) as never }); }
            catch (error) { return send(400, { error: error instanceof Error ? error.message : String(error) }); }
            context.onCall?.(tool);
            const result = await tool.execute(randomUUID(), args, undefined, undefined, undefined as never);
            const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
            if (result.isError) return send(400, { error: text });
            return send(200, { value: result.structuredContent ?? text });
          } catch (error) { return send(500, { error: error instanceof Error ? error.message : String(error) }); }
        })().catch((error) => { response.writeHead(500); response.end(String(error)); });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("脚本工具服务未能启动"));
        this.server = server;
        this.url = `http://127.0.0.1:${address.port}/`;
        server.unref();
        resolve();
      });
    });
    return this.starting;
  }

  close(): void { this.contexts.clear(); this.server?.close(); this.url = ""; this.starting = undefined; this.server = undefined; }

  issue(context: ScriptToolContext): { token: string; revoke: () => void } {
    const token = randomBytes(32).toString("hex");
    this.contexts.set(token, context);
    return { token, revoke: () => { this.contexts.delete(token); } };
  }

  get(token: string): ScriptToolContext | undefined { return this.contexts.get(token); }

  environment(env: NodeJS.ProcessEnv, token: string, binDirs: string[] = []): NodeJS.ProcessEnv {
    const preload = fileURLToPath(new URL("./script-tools-preload.mjs", import.meta.url));
    const quoted = JSON.stringify(preload);
    const withPath = prependPath(env, binDirs);
    return { ...withPath, HOB_TOOLS_URL: this.url, HOB_TOOLS_TOKEN: token, NODE_OPTIONS: `${withPath.NODE_OPTIONS ?? ""} --import ${quoted}`.trim() };
  }
}
