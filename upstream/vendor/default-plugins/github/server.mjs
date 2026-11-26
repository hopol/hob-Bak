// Stdio MCP server for the Hob GitHub 2.0 plugin.
// Proxies GitHub's official remote MCP server while managing authentication, login, attribution, and command credentials.

import { fileURLToPath } from "node:url";
import { appendAttribution, appendCoAuthor, commitMessageArg, shouldAttributeToolCall } from "./attribution.mjs";
import { AuthError, createAuthManager, extractScopeFromArgs } from "./auth.mjs";
import { RemoteMcpClient } from "./remote-mcp.mjs";

const SERVER_INFO = { name: "github", version: "2.0.6" };
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

function errorToolResult(message) {
  return {
    content: [{ type: "text", text: String(message) }],
    isError: true,
  };
}

function structuredToolResult(structuredContent) {
  return {
    content: [],
    structuredContent,
  };
}

const LOGIN_TOOLS = [
  {
    name: "hob_login_status",
    description: "Check GitHub hob-bot sign-in status.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["app"] }, "hob/login": "status" },
  },
  {
    name: "hob_login_start",
    description: "Start GitHub hob-bot device-code sign-in.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["app"] }, "hob/login": "start" },
  },
  {
    name: "hob_login_poll",
    description: "Poll GitHub hob-bot device-code sign-in.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["app"] }, "hob/login": "poll" },
  },
  {
    name: "hob_login_logout",
    description: "Sign out of GitHub hob-bot.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["app"] }, "hob/login": "logout" },
  },
];

const COMMAND_TOOLS = [
  {
    name: "command_credentials",
    description: "Resolve GitHub token, commit author, and attribution settings for plugin CLI wrappers.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Optional repository owner (user or organization)." },
        repo: { type: "string", description: "Optional repository name." },
      },
    },
    _meta: { ui: { visibility: ["app"] }, "hob/command": true },
  },
];

export function createGitHubServer(options = {}) {
  const env = options.env || process.env;
  const notify = options.notify || null;
  const auth = options.auth || createAuthManager(env, {
    fetch: options.fetch,
    onAuthChanged: () => {
      notify?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    },
  });
  const remote = options.remote || new RemoteMcpClient({ url: auth.config.mcpUrl, fetch: options.fetch });
  const internalTools = [...LOGIN_TOOLS, ...COMMAND_TOOLS, ...(options.internalTools || [])];
  const internalHandlers = new Map([
    ["hob_login_status", async () => structuredToolResult(await auth.loginStatus())],
    ["hob_login_start", async () => structuredToolResult(await auth.loginStart())],
    ["hob_login_poll", async () => structuredToolResult(await auth.loginPoll())],
    ["hob_login_logout", async () => structuredToolResult(await auth.loginLogout())],
    ["command_credentials", async (args) => {
      const scope = extractScopeFromArgs(args);
      return structuredToolResult(await auth.resolveCommandCredentials(scope));
    }],
    ...(options.internalHandlers ? options.internalHandlers.entries() : []),
  ]);
  let cachedRemoteTools = [];

  async function listTools() {
    let remoteTools = [];
    let tokenResult = null;
    try {
      tokenResult = await auth.resolveToken({});
    } catch (error) {
      if (!(error instanceof AuthError)) {
        console.error(`[github-mcp] failed to resolve auth for tools/list: ${error?.message || error}`);
      }
    }

    if (tokenResult?.token) {
      try {
        remoteTools = await remote.listTools(tokenResult.token);
        cachedRemoteTools = remoteTools;
      } catch (error) {
        console.error(`[github-mcp] failed to list remote tools: ${error?.message || error}`);
        remoteTools = cachedRemoteTools;
      }
    } else {
      cachedRemoteTools = [];
    }

    return [...remoteTools, ...internalTools];
  }

  async function callTool(name, args = {}) {
    if (internalHandlers.has(name)) {
      try {
        return await internalHandlers.get(name)(args || {});
      } catch (error) {
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    }

    let tokenResult;
    try {
      const scope = extractScopeFromArgs(args);
      tokenResult = await auth.resolveToken(scope);
    } catch (error) {
      return errorToolResult(error instanceof Error ? error.message : String(error));
    }

    const forwardArgs = args && typeof args === "object" ? { ...args } : {};
    if (auth.config.attribution && shouldAttributeToolCall(name, forwardArgs)) {
      forwardArgs.body = appendAttribution(forwardArgs.body);
    }
    // Commits made through the API carry the same co-author as commits from bin/git,
    // except when the commit is already authored by hob-bot itself.
    const messageArg = commitMessageArg(name);
    if (auth.config.attribution && messageArg && !(tokenResult.source === "app" && (await auth.getAppInfo().catch(() => null))?.slug === "hob-bot")) {
      // A merge without a message keeps GitHub's default text rather than becoming just a trailer.
      if (name !== "merge_pull_request" || typeof forwardArgs[messageArg] === "string") {
        forwardArgs[messageArg] = appendCoAuthor(forwardArgs[messageArg]);
      }
    }

    try {
      const result = await remote.callTool(tokenResult.token, name, forwardArgs);
      return result && typeof result === "object"
        ? (result.content === undefined ? { ...result, content: [] } : result)
        : { content: [] };
    } catch (error) {
      return errorToolResult(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleMessage(message) {
    if (!message || typeof message !== "object") return null;
    const { id, method, params } = message;
    const isNotification = id === undefined;

    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return null;
    }

    try {
      if (method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: SERVER_INFO,
          },
        };
      }
      if (method === "ping") {
        return { jsonrpc: "2.0", id, result: {} };
      }
      if (method === "tools/list") {
        const tools = await listTools();
        return { jsonrpc: "2.0", id, result: { tools } };
      }
      if (method === "tools/call") {
        const name = params?.name;
        if (typeof name !== "string" || !name) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params: tool name is required" },
          };
        }
        const result = await callTool(name, params?.arguments);
        return { jsonrpc: "2.0", id, result };
      }
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (error) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  return { auth, remote, listTools, callTool, handleMessage };
}

export function startStdioServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const server = createGitHubServer({ ...options, notify: write });

  let buffer = "";
  let inFlight = 0;
  let ended = false;

  const maybeExit = () => {
    if (ended && inFlight === 0 && input === process.stdin) {
      process.exit(0);
    }
  };

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${error.message}` },
      });
      return;
    }

    inFlight++;
    void server.handleMessage(message).then((reply) => {
      if (reply) write(reply);
    }).catch((error) => {
      if (message?.id !== undefined) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }).finally(() => {
      inFlight--;
      maybeExit();
    });
  };

  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      processLine(line);
    }
  });
  input.on("end", () => {
    if (buffer.trim()) {
      processLine(buffer);
      buffer = "";
    }
    ended = true;
    maybeExit();
  });

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startStdioServer();
}
