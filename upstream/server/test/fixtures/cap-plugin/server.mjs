// Minimal stdio MCP fixture for plugin login (_meta["hob/login"]) and command tools (_meta["hob/command"]).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.CAP_DATA_DIR;
if (!dataDir) throw new Error("CAP_DATA_DIR is required");

const sessionPath = () => join(dataDir, "session.json");
const failPath = () => join(dataDir, "fail.txt");
const pendingPath = () => join(dataDir, "pending.txt");
const startDonePath = () => join(dataDir, "start-done");

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (structuredContent, text = "") => ({
  content: text ? [{ type: "text", text }] : [],
  structuredContent,
});
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

function readFail(step) {
  if (!existsSync(failPath())) return null;
  const raw = readFileSync(failPath(), "utf8").trim();
  const prefix = `${step}:`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
}

function readSession() {
  if (!existsSync(sessionPath())) return null;
  try { return JSON.parse(readFileSync(sessionPath(), "utf8")); } catch { return null; }
}

function saveSession(account = "alice") {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    sessionPath(),
    `${JSON.stringify({ account, token: "fixture-token-267" }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

const TOOLS = [
  {
    name: "ping",
    description: "Check fixture connectivity",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "auth_status",
    description: "Check login status",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["app"] }, "hob/login": "status" },
  },
  {
    name: "auth_start",
    description: "Start device code login",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["app"] }, "hob/login": "start" },
  },
  {
    name: "auth_poll",
    description: "Poll device code login",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["app"] }, "hob/login": "poll" },
  },
  {
    name: "auth_logout",
    description: "Log out",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["app"] }, "hob/login": "logout" },
  },
  {
    name: "command_token",
    description: "Return token for plugin commands",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["app"] }, "hob/command": true },
  },
  {
    name: "internal_secret",
    description: "App-only tool not exposed to commands",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["app"] } },
  },
];

function callTool(name) {
  if (name === "ping") {
    return { content: [{ type: "text", text: "pong" }] };
  }
  if (name === "auth_status") {
    const err = readFail("status");
    if (err !== null) return fail(err);
    const session = readSession();
    if (!session) return ok({ signedIn: false });
    return ok({
      signedIn: true,
      account: session.account,
      detail: `已登录 ${session.account} · [管理授权](https://example.invalid/apps)`,
    });
  }
  if (name === "auth_start") {
    const err = readFail("start");
    if (err !== null) return fail(err);
    if (existsSync(startDonePath())) {
      saveSession("alice");
      return ok({ kind: "done" });
    }
    return ok({
      kind: "device_code",
      url: "https://example.invalid/device",
      userCode: "WXYZ-2670",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      interval: 1,
    });
  }
  if (name === "auth_poll") {
    const toolErr = readFail("poll-tool-error");
    if (toolErr !== null) return fail(toolErr);
    const pollErr = readFail("poll");
    if (pollErr !== null) return ok({ state: "error", message: pollErr });
    if (existsSync(pendingPath())) {
      const remaining = Number(readFileSync(pendingPath(), "utf8").trim()) || 0;
      if (remaining > 0) {
        writeFileSync(pendingPath(), String(remaining - 1));
        return ok({ state: "pending" });
      }
    }
    saveSession("alice");
    return ok({ state: "done" });
  }
  if (name === "auth_logout") {
    const err = readFail("logout");
    if (err !== null) return fail(err);
    rmSync(sessionPath(), { force: true });
    return ok({ ok: true });
  }
  if (name === "command_token") {
    const session = readSession();
    return ok({ token: session?.token ?? "fixture-token-267" });
  }
  if (name === "internal_secret") {
    return ok({ secret: "must-not-be-accessible-from-command" });
  }
  return fail(`unknown tool ${name}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "cap-plugin-fixture", version: "1.0.0" },
        },
      });
    } else if (message.method === "tools/list") {
      // 登录后才多出一个工具，用来测登录、退出后 Hob 重新列工具
      const tools = readSession() ? [...TOOLS, { name: "whoami", description: "Signed-in account", inputSchema: { type: "object", properties: {} } }] : TOOLS;
      write({ jsonrpc: "2.0", id: message.id, result: { tools } });
    } else if (message.method === "tools/call") {
      write({ jsonrpc: "2.0", id: message.id, result: callTool(message.params?.name) });
    } else if (message.id !== undefined) {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    }
  }
});
