// Minimal zero-dependency stdio MCP test client for testing github/server.mjs.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

export async function startMcpTestClient(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  let buffer = "";
  let stderr = "";
  const pending = new Map();
  const notifications = [];

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`));
        else entry.resolve(msg.result);
      } else if (msg.id === undefined) {
        notifications.push(msg);
      }
    }
  });

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      for (const entry of pending.values()) {
        entry.reject(new Error(`MCP server exited (code=${code}, signal=${signal}): ${stderr}`));
      }
      pending.clear();
      resolve({ code, signal });
    });
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })}\n`);
  }

  const initResult = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "github-plugin-test", version: "1.0.0" },
  });
  notify("notifications/initialized");

  return {
    initResult,
    notifications,
    get stderr() { return stderr; },
    async listTools() {
      const res = await request("tools/list", {});
      return res.tools;
    },
    async callTool(name, args = {}) {
      return await request("tools/call", { name, arguments: args });
    },
    async close() {
      if (child.exitCode === null && !child.killed) {
        child.stdin.end();
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGTERM");
        }, 2000);
        await exited;
        clearTimeout(timer);
      }
    },
  };
}
