// Minimal Streamable HTTP MCP client for GitHub's remote MCP server.
// Uses only Node.js built-ins (fetch, TextDecoder) and maintains per-token sessions.

const DEFAULT_MCP_URL = "https://api.githubcopilot.com/mcp/";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const MAX_SESSIONS = 16;

function parseSseMessages(text) {
  const messages = [];
  const lines = text.split(/\r\n|\r|\n/);
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const raw = dataLines.join("\n").trim();
    dataLines = [];
    if (!raw) return;
    try {
      messages.push(JSON.parse(raw));
    } catch {
      // Ignore non-JSON SSE events (comments/pings)
    }
  };
  for (const line of lines) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
  }
  flush();
  return messages;
}

export class RemoteMcpError extends Error {
  constructor(message, { status, code, data } = {}) {
    super(message);
    this.name = "RemoteMcpError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export class RemoteMcpClient {
  constructor(options = {}) {
    this.url = (options.url || DEFAULT_MCP_URL).trim();
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.clientInfo = options.clientInfo || { name: "hob-github-plugin", version: "2.0.0" };
    this.sessions = new Map();
    this.nextId = 1;
  }

  _rememberSession(token, session) {
    if (this.sessions.has(token)) this.sessions.delete(token);
    this.sessions.set(token, session);
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
    }
  }

  _headers(token, session) {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": `${this.clientInfo.name}/${this.clientInfo.version}`,
    };
    if (session?.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
    if (session?.protocolVersion) headers["MCP-Protocol-Version"] = session.protocolVersion;
    return headers;
  }

  async _post(token, session, payload) {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: this._headers(token, session),
      body: JSON.stringify(payload),
    });

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId && session) session.sessionId = sessionId;

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim();
      const snippet = body.length > 500 ? `${body.slice(0, 497)}...` : body;
      throw new RemoteMcpError(
        `GitHub MCP 请求失败（HTTP ${response.status}）${snippet ? `：${snippet}` : ""}`,
        { status: response.status },
      );
    }

    // Notifications (no id) typically receive 202 Accepted with empty body.
    if (payload.id === undefined) {
      await response.body?.cancel?.().catch(() => {});
      return undefined;
    }

    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    const rawText = await response.text();
    let messages;
    if (contentType === "text/event-stream") {
      messages = parseSseMessages(rawText);
    } else if (contentType === "application/json" || rawText.trim().startsWith("{") || rawText.trim().startsWith("[")) {
      const parsed = JSON.parse(rawText);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      throw new RemoteMcpError(`GitHub MCP 返回了不支持的内容类型：${contentType || "unknown"}`, { status: response.status });
    }

    const reply = messages.find((msg) => msg && msg.id === payload.id);
    if (!reply) {
      throw new RemoteMcpError(`GitHub MCP 没有返回 ${payload.method} 的响应`);
    }
    if (reply.error) {
      throw new RemoteMcpError(reply.error.message || `GitHub MCP 返回错误（${reply.error.code}）`, {
        code: reply.error.code,
        data: reply.error.data,
      });
    }
    return reply.result;
  }

  async _ensureSession(token) {
    const existing = this.sessions.get(token);
    if (existing?.initialized) return existing;
    if (existing?.initializing) return existing.initializing;

    const session = { sessionId: undefined, protocolVersion: undefined, initialized: false, initializing: null };
    this._rememberSession(token, session);

    session.initializing = (async () => {
      try {
        const result = await this._post(token, session, {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: DEFAULT_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: this.clientInfo,
          },
        });
        session.protocolVersion = result?.protocolVersion || DEFAULT_PROTOCOL_VERSION;
        await this._post(token, session, {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }).catch(() => {});
        session.initialized = true;
        return session;
      } catch (error) {
        this.sessions.delete(token);
        throw error;
      } finally {
        session.initializing = null;
      }
    })();

    return session.initializing;
  }

  async _request(token, method, params) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = await this._ensureSession(token);
      try {
        return await this._post(token, session, {
          jsonrpc: "2.0",
          id: this.nextId++,
          method,
          ...(params !== undefined ? { params } : {}),
        });
      } catch (error) {
        // Retry once if the remote MCP session expired (HTTP 404 with a cached session id).
        if (attempt === 0 && error instanceof RemoteMcpError && error.status === 404 && session.sessionId) {
          this.sessions.delete(token);
          continue;
        }
        throw error;
      }
    }
  }

  async listTools(token) {
    const tools = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this._request(token, "tools/list", cursor ? { cursor } : {});
      if (Array.isArray(result?.tools)) tools.push(...result.tools);
      const next = result?.nextCursor;
      if (!next || typeof next !== "string") break;
      cursor = next;
    }
    return tools;
  }

  async callTool(token, name, args = {}) {
    return await this._request(token, "tools/call", { name, arguments: args });
  }
}
