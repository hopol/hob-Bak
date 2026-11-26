// Local HTTP fake GitHub server for tests (remote MCP + REST API + OAuth device flow).
// Never touches the real GitHub.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export const DEFAULT_REMOTE_TOOLS = [
  {
    name: "list_issues",
    description: "List issues in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_pull_requests",
    description: "List pull requests in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_issue",
    description: "Create a new issue in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "create_pull_request",
    description: "Create a new pull request in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string" },
        base: { type: "string" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "get_me",
    description: "Get details of the authenticated GitHub user.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(data));
}

function sendSse(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "text/event-stream", ...extraHeaders });
  res.end(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function startFakeGitHub(initialConfig = {}) {
  const state = {
    mcpMode: initialConfig.mcpMode || "json", // "json" | "sse"
    validTokens: initialConfig.validTokens ? new Set(initialConfig.validTokens) : null, // null = accept any non-empty bearer
    tools: initialConfig.tools || structuredClone(DEFAULT_REMOTE_TOOLS),
    mcpCalls: [],
    apiCalls: [],
    oauthCalls: [],
    sessions: new Map(), // sessionId -> token
    // Configurable handlers / fixtures for REST & OAuth (used in steps 2-5)
    app: initialConfig.app || null,
    installations: initialConfig.installations || [],
    repoInstallations: initialConfig.repoInstallations || {}, // "owner/repo" -> installation
    ownerInstallations: initialConfig.ownerInstallations || {}, // "owner" -> { type: "user"|"org", installation }
    accessTokenHandler: initialConfig.accessTokenHandler || null,
    usersByToken: initialConfig.usersByToken || {}, // token -> { id, login, name }
    userInstallationsByToken: initialConfig.userInstallationsByToken || {}, // token -> [{ account: { login } }]
    usersByLogin: initialConfig.usersByLogin || {}, // login -> { id, login, name }
    deviceCodeHandler: initialConfig.deviceCodeHandler || null,
    oauthTokenHandler: initialConfig.oauthTokenHandler || null,
    mcpToolHandler: initialConfig.mcpToolHandler || null,
  };

  function bearerFrom(req) {
    const header = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1] : "";
  }

  function tokenAllowed(token) {
    if (!token) return false;
    if (state.validTokens === null) return true;
    return state.validTokens.has(token);
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = url.pathname;
      const bodyText = await readBody(req);

      // 1. Remote MCP endpoint (/mcp or /mcp/)
      if (pathname === "/mcp" || pathname === "/mcp/") {
        if (req.method === "DELETE") {
          const sid = req.headers["mcp-session-id"];
          if (sid) state.sessions.delete(String(sid));
          res.writeHead(204);
          res.end();
          return;
        }
        const token = bearerFrom(req);
        if (!tokenAllowed(token)) {
          sendJson(res, 401, { error: "Bad credentials" });
          return;
        }
        const message = JSON.parse(bodyText || "{}");
        const reply = (payload, extraHeaders = {}) => {
          if (state.mcpMode === "sse") sendSse(res, 200, payload, extraHeaders);
          else sendJson(res, 200, payload, extraHeaders);
        };

        if (message.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }

        if (message.method === "initialize") {
          const sessionId = `sess-${randomUUID()}`;
          state.sessions.set(sessionId, token);
          reply(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: message.params?.protocolVersion || "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-github-mcp", version: "1.0.0" },
              },
            },
            { "mcp-session-id": sessionId },
          );
          return;
        }

        const sid = req.headers["mcp-session-id"];
        if (sid && !state.sessions.has(String(sid))) {
          sendJson(res, 404, { error: "Session not found" });
          return;
        }

        if (message.method === "tools/list") {
          state.mcpCalls.push({ method: "tools/list", token, sessionId: sid || null });
          reply({ jsonrpc: "2.0", id: message.id, result: { tools: state.tools } });
          return;
        }

        if (message.method === "tools/call") {
          const toolName = message.params?.name;
          const args = message.params?.arguments || {};
          const record = { method: "tools/call", name: toolName, args, token, sessionId: sid || null };
          state.mcpCalls.push(record);
          const custom = state.mcpToolHandler ? await state.mcpToolHandler(record) : null;
          const result = custom ?? {
            content: [{ type: "text", text: JSON.stringify({ ok: true, tool: toolName, args, token }) }],
          };
          reply({ jsonrpc: "2.0", id: message.id, result });
          return;
        }

        reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
        return;
      }

      // 2. OAuth / Device Flow endpoints (/login/device/code, /login/oauth/access_token)
      if (pathname === "/login/device/code" && req.method === "POST") {
        const params = parseFormOrJson(bodyText, req.headers["content-type"]);
        state.oauthCalls.push({ path: pathname, params });
        if (state.deviceCodeHandler) {
          const out = await state.deviceCodeHandler(params);
          sendJson(res, out.status || 200, out.body);
          return;
        }
        sendJson(res, 200, {
          device_code: "dev-code-123",
          user_code: "HOB-1234",
          verification_uri: `${baseUrl}/login/device`,
          expires_in: 900,
          interval: 1,
        });
        return;
      }

      if (pathname === "/login/oauth/access_token" && req.method === "POST") {
        const params = parseFormOrJson(bodyText, req.headers["content-type"]);
        state.oauthCalls.push({ path: pathname, params });
        if (state.oauthTokenHandler) {
          const out = await state.oauthTokenHandler(params);
          sendJson(res, out.status || 200, out.body);
          return;
        }
        sendJson(res, 200, { error: "authorization_pending" });
        return;
      }

      // 3. GitHub REST API endpoints
      const token = bearerFrom(req);
      state.apiCalls.push({ method: req.method, path: pathname, token });

      if (pathname === "/app" && req.method === "GET") {
        if (!state.app) return sendJson(res, 404, { message: "Not Found" });
        return sendJson(res, 200, state.app);
      }

      if (pathname === "/app/installations" && req.method === "GET") {
        return sendJson(res, 200, state.installations);
      }

      const repoInstMatch = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(pathname);
      if (repoInstMatch && req.method === "GET") {
        const key = `${decodeURIComponent(repoInstMatch[1])}/${decodeURIComponent(repoInstMatch[2])}`;
        const inst = state.repoInstallations[key];
        if (!inst) return sendJson(res, 404, { message: "Not Found" });
        return sendJson(res, 200, inst);
      }

      const ownerInstMatch = /^\/(users|orgs)\/([^/]+)\/installation$/.exec(pathname);
      if (ownerInstMatch && req.method === "GET") {
        const kind = ownerInstMatch[1] === "orgs" ? "org" : "user";
        const owner = decodeURIComponent(ownerInstMatch[2]);
        const entry = state.ownerInstallations[owner];
        if (!entry || (entry.type && entry.type !== kind)) {
          return sendJson(res, 404, { message: "Not Found" });
        }
        return sendJson(res, 200, entry.installation || entry);
      }

      const tokenMatch = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(pathname);
      if (tokenMatch && req.method === "POST") {
        const installationId = decodeURIComponent(tokenMatch[1]);
        if (state.accessTokenHandler) {
          const out = await state.accessTokenHandler(installationId, token);
          return sendJson(res, out.status || 201, out.body);
        }
        const issued = `ghs_inst_${installationId}_${randomUUID().slice(0, 8)}`;
        if (state.validTokens) state.validTokens.add(issued);
        return sendJson(res, 201, {
          token: issued,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
      }

      if (pathname === "/user" && req.method === "GET") {
        const user = state.usersByToken[token];
        if (!user) return sendJson(res, 401, { message: "Bad credentials" });
        return sendJson(res, 200, user);
      }

      if (pathname === "/user/installations" && req.method === "GET") {
        const list = state.userInstallationsByToken[token];
        if (!list) return sendJson(res, 401, { message: "Bad credentials" });
        return sendJson(res, 200, { total_count: list.length, installations: list });
      }

      const userMatch = /^\/users\/([^/]+)$/.exec(pathname);
      if (userMatch && req.method === "GET") {
        const login = decodeURIComponent(userMatch[1]);
        const user = state.usersByLogin[login];
        if (!user) return sendJson(res, 404, { message: "Not Found" });
        return sendJson(res, 200, user);
      }

      sendJson(res, 404, { message: `Unhandled fake GitHub path: ${req.method} ${pathname}` });
    })().catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: String(error?.message || error) }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    state,
    baseUrl,
    mcpUrl: `${baseUrl}/mcp/`,
    apiUrl: baseUrl,
    webUrl: baseUrl,
    env() {
      return {
        GITHUB_MCP_URL: `${baseUrl}/mcp/`,
        GITHUB_API_URL: baseUrl,
        GITHUB_WEB_URL: baseUrl,
      };
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function parseFormOrJson(bodyText, contentType = "") {
  if (contentType.includes("application/json")) {
    return JSON.parse(bodyText || "{}");
  }
  const params = new URLSearchParams(bodyText);
  return Object.fromEntries(params.entries());
}
