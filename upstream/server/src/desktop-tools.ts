import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { HobRuntime } from "./runtime.ts";
import { closePlaywrightSessions } from "./playwright-cli.ts";

const TAKEN = "用户正在操作云桌面，等用户操作完再试；着急的话，用 ask_user 问一声。";
const point = Type.Object({ x: Type.Integer(), y: Type.Integer() });
const action = Type.Object({
  type: Type.Union([Type.Literal("click"), Type.Literal("move"), Type.Literal("drag"), Type.Literal("type"), Type.Literal("key"), Type.Literal("scroll"), Type.Literal("wait")]),
  x: Type.Optional(Type.Integer()), y: Type.Optional(Type.Integer()),
  from: Type.Optional(point), to: Type.Optional(point),
  button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
  count: Type.Optional(Type.Integer()), text: Type.Optional(Type.String()), keys: Type.Optional(Type.String()),
  dy: Type.Optional(Type.Integer()), dx: Type.Optional(Type.Integer()), ms: Type.Optional(Type.Integer()),
});

type Release = () => void;
type Claim = () => Release;

type RelayConnection = {
  client?: WebSocket;
  upstream?: WebSocket;
  socket?: Duplex;
  release: Release;
};

const jobConnections = new WeakMap<HobRuntime, Map<string, Map<DesktopToolSession, string>>>();

/**
 * A local-only CDP WebSocket relay. The child process receives only the local
 * endpoint and a short-lived local token; the cloud desktop token stays here.
 */
class BrowserRelay {
  private readonly server: Server;
  private readonly sockets = new Set<RelayConnection>();
  private readonly pending = new Set<RelayConnection>();
  private readonly token = randomBytes(32).toString("base64url");
  private readonly path = `/cdp/${randomBytes(18).toString("base64url")}`;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private readonly unsubscribe: () => void;
  private port?: number;
  private closed = false;

  constructor(private readonly runtime: HobRuntime, private readonly screen: string, private readonly check: () => void, private readonly claim: Claim) {
    this.server = createServer((request, response) => { void this.status(request, response); });
    this.server.on("upgrade", (request, socket, head) => { void this.upgrade(request, socket, head); });
    this.unsubscribe = runtime.bus.subscribe((event) => {
      if (event.type === "desktop-control" && event.screen === screen && event.taken) this.closeConnections();
    });
  }

  async start(): Promise<{ endpoint: string; token: string }> {
    if (this.port !== undefined) return { endpoint: this.endpoint(), token: this.token };
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("本地浏览器转发入口没有启动。");
    this.port = address.port;
    return { endpoint: this.endpoint(), token: this.token };
  }

  private endpoint(): string {
    if (this.port === undefined) throw new Error("本地浏览器转发入口没有启动。");
    return `ws://127.0.0.1:${this.port}${this.path}`;
  }

  private async status(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== this.path || request.headers.authorization !== `Bearer ${this.token}`) {
      response.writeHead(401).end("浏览器转发凭据无效。");
      return;
    }
    try {
      if (this.closed) throw new Error("浏览器转发会话已结束。");
      this.check();
      await this.runtime.desktop.request("/api/health");
      response.writeHead(200).end("ok");
    } catch (error) {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8" }).end(error instanceof Error ? error.message : String(error));
    }
  }

  private reject(socket: Duplex, status: string, message: string): void {
    if (socket.destroyed) return;
    const body = Buffer.from(message);
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.byteLength}\r\n\r\n`);
    socket.write(body);
    socket.destroy();
  }

  private async upgrade(request: import("node:http").IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== this.path) { socket.destroy(); return; }
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${this.token}`) { this.reject(socket, "401 Unauthorized", "浏览器转发凭据无效。"); return; }
    if (this.closed) { this.reject(socket, "410 Gone", "浏览器转发会话已结束。"); return; }

    let release: Release | undefined;
    let upstream: WebSocket | undefined;
    const pending: RelayConnection = { socket, release: () => release?.() };
    this.pending.add(pending);
    try {
      release = this.claim();
      const started = await (await this.runtime.desktop.request(`/api/screens/${encodeURIComponent(this.screen)}/browser/start`, { method: "POST" })).json() as { cdp?: unknown };
      if (started.cdp !== `/cdp/${this.screen}`) throw new Error("云桌面返回了无效的浏览器地址。");
      const connection = this.runtime.desktop.connection();
      const endpoint = new URL(started.cdp, connection.url);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      upstream = new WebSocket(endpoint.toString(), { headers: { Authorization: `Bearer ${connection.token}` }, perMessageDeflate: false });
      pending.upstream = upstream;
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => { upstream?.off("open", ready); reject(error); };
        const ready = () => { upstream?.off("error", fail); resolve(); };
        upstream!.once("error", fail);
        upstream!.once("open", ready);
      });
      if (this.closed || socket.destroyed) throw new Error("浏览器转发会话已结束。");
      this.check();
      this.pending.delete(pending);
      const connectionState: RelayConnection = { upstream, release };
      this.sockets.add(connectionState);
      this.wss.handleUpgrade(request, socket, head, (client) => {
        connectionState.client = client;
        const close = () => {
          if (!this.sockets.delete(connectionState)) return;
          connectionState.release();
          client.close();
          upstream?.close();
        };
        client.on("message", (data, binary) => {
          if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        });
        upstream?.on("message", (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
        client.once("close", close);
        client.once("error", close);
        upstream?.once("close", close);
        upstream?.once("error", close);
      });
    } catch (error) {
      this.pending.delete(pending);
      release?.();
      upstream?.close();
      if (!socket.destroyed) this.reject(socket, "409 Conflict", error instanceof Error ? error.message : String(error));
    }
  }

  private closeConnections(): void {
    for (const connection of [...this.pending]) {
      connection.release();
      connection.socket?.destroy();
      connection.upstream?.close();
    }
    this.pending.clear();
    for (const connection of [...this.sockets]) {
      connection.release();
      connection.client?.close(4001, TAKEN);
      connection.upstream?.close();
    }
    this.sockets.clear();
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.closeConnections();
    this.wss.close();
    if (this.port !== undefined) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export interface PlaywrightCliEnvironment {
  PLAYWRIGHT_MCP_CDP_ENDPOINT: string;
  PLAYWRIGHT_MCP_CDP_HEADERS: string;
  PLAYWRIGHT_CLI_SESSION: string;
  HOB_PLAYWRIGHT_CACHE_HOME: string;
}

export function browserShellEnv(env: NodeJS.ProcessEnv, cli?: PlaywrightCliEnvironment): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of ["HOB_DESKTOP_URL", "HOB_DESKTOP_TOKEN", "HOB_DESKTOP_TOKEN_FILE", "PLAYWRIGHT_MCP_CDP_ENDPOINT", "PLAYWRIGHT_MCP_CDP_HEADERS", "PLAYWRIGHT_CLI_SESSION", "HOB_PLAYWRIGHT_CACHE_HOME", "PWTEST_DAEMON_SESSION_DIR"]) delete result[key];
  return { ...result, ...cli };
}

export class DesktopToolSession {
  private relay?: BrowserRelay;
  private readonly active = new Set<Promise<unknown>>();
  private disposed = false;
  private inUse = false;
  private connectionCount = 0;
  private readonly sessionName = `hob-${randomBytes(12).toString("hex")}`;

  constructor(
    private readonly runtime: HobRuntime,
    private readonly assistantId: string,
    private readonly canSeeImages: boolean | (() => boolean) = false,
    private readonly jobTitle?: string,
    private readonly router = false,
    private readonly screenshotDir = join(runtime.home, "assistants", assistantId, "work", "screenshots"),
  ) {}

  private get screen(): string { return desktopProfile(this.assistantId); }
  private get cacheDir(): string { return join(this.runtime.home, "cache", "playwright", this.sessionName); }

  private check(): void {
    if (this.disposed) throw new Error("任务已结束。");
    const desktop = this.runtime.desktop.view();
    if (!desktop.enabled || !desktop.url || !desktop.tokenConfigured) throw new Error("云桌面没有开启。");
    if (this.runtime.desktopControl.state("", this.screen).taken) throw new Error(TAKEN);
    const sessions = jobConnections.get(this.runtime)?.get(this.screen) ?? [];
    for (const [session, title] of sessions) {
      if (session === this || !session.inUse || !title) continue;
      throw new Error(`任务「${title}」正在用浏览器，等它做完，或者用 reply_job 让它停下来。`);
    }
  }

  private claim(): Release {
    this.check();
    this.connectionCount += 1;
    this.inUse = true;
    let sessions = jobConnections.get(this.runtime);
    if (!sessions) jobConnections.set(this.runtime, sessions = new Map());
    let screenSessions = sessions.get(this.screen);
    if (!screenSessions) sessions.set(this.screen, screenSessions = new Map());
    screenSessions.set(this, this.jobTitle ?? "");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.connectionCount -= 1;
      if (this.connectionCount) return;
      this.inUse = false;
      const current = jobConnections.get(this.runtime)?.get(this.screen);
      current?.delete(this);
      if (current && !current.size) jobConnections.get(this.runtime)?.delete(this.screen);
    };
  }

  /** Prepare the per-session environment injected into every bash invocation. */
  async preparePlaywrightCli(): Promise<PlaywrightCliEnvironment> {
    if (this.disposed) throw new Error("任务已结束。");
    const desktop = this.runtime.desktop.view();
    if (!desktop.enabled || !desktop.url || !desktop.tokenConfigured) throw new Error("云桌面没有开启。");
    this.relay ??= new BrowserRelay(this.runtime, this.screen, () => this.check(), () => this.claim());
    const relay = await this.relay.start();
    return {
      PLAYWRIGHT_MCP_CDP_ENDPOINT: relay.endpoint,
      PLAYWRIGHT_MCP_CDP_HEADERS: `Authorization: Bearer ${relay.token}`,
      PLAYWRIGHT_CLI_SESSION: this.sessionName,
      HOB_PLAYWRIGHT_CACHE_HOME: this.cacheDir,
    };
  }

  /** 非网页设备操作仍由任务使用桌面工具。 */
  tools(canSeeImages = this.canSeeImages): ToolDefinition<any, any>[] {
    const make = (name: string, label: string, description: string, parameters: any, run: (params: any) => Promise<string | Buffer>): ToolDefinition<any, any> => ({
      name, label, description, parameters,
      execute: async (_id, params) => {
        const operation = (async () => {
          try {
            this.check();
            const value = await run(params ?? {});
            if (!Buffer.isBuffer(value)) return { content: [{ type: "text" as const, text: value }], details: undefined };
            const dir = resolve(this.screenshotDir);
            mkdirSync(dir, { recursive: true });
            const files = readdirSync(dir).filter((name) => /^\d{8}T\d{9}\.png$/.test(name)).sort();
            const last = files.at(-1);
            const lastTime = last ? Date.parse(`${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}T${last.slice(9, 11)}:${last.slice(11, 13)}:${last.slice(13, 15)}.${last.slice(15, 18)}Z`) : 0;
            let time = Math.max(Date.now(), lastTime + 1);
            let path: string;
            while (true) {
              path = join(dir, `${new Date(time++).toISOString().replace(/[-:.Z]/g, "")}.png`);
              try { writeFileSync(path, value, { flag: "wx" }); break; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
            }
            const saved = readdirSync(dir).filter((name) => /^\d{8}T\d{9}\.png$/.test(name)).sort();
            for (const name of saved.slice(0, -20)) unlinkSync(join(dir, name));
            const send = this.router ? "使用 send_file 发送" : "在 report 时放进 files";
            if (!(typeof canSeeImages === "function" ? canSeeImages() : canSeeImages)) return { content: [{ type: "text" as const, text: `当前模型无法查看图片。截图已保存到 ${path}：要发送给用户，${send}。` }], details: undefined };
            return { content: [{ type: "image" as const, data: value.toString("base64"), mimeType: "image/png" }, { type: "text" as const, text: `截图已保存到 ${path}。要发送给用户，${send}。` }], details: undefined };
          } catch (error) {
            return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
          }
        })();
        this.active.add(operation);
        try { return await operation; } finally { this.active.delete(operation); }
      },
    });
    return [
      make("desktop_screenshot", "桌面截图", "截取整个云桌面。", Type.Object({}), async () => {
        await this.runtime.desktop.request(`/api/screens/${this.screen}/start`, { method: "POST" });
        this.check();
        return Buffer.from(await (await this.runtime.desktop.request(`/api/screens/${this.screen}/screenshot`)).arrayBuffer());
      }),
      make("desktop_action", "操作桌面", "按顺序执行桌面动作：click、move、drag、type、key、scroll、wait。", Type.Object({ actions: Type.Array(action, { minItems: 1, maxItems: 100 }) }), async ({ actions }) => {
        await this.runtime.desktop.request(`/api/screens/${this.screen}/start`, { method: "POST" });
        const health = await (await this.runtime.desktop.request("/api/health")).json() as { screens: { id: string; browserRunning: boolean }[] };
        this.check();
        if (health.screens.some((item) => item.id === this.screen && item.browserRunning)) await this.runtime.desktop.request(`/api/screens/${this.screen}/browser/focus`, { method: "POST" });
        this.check();
        await this.runtime.desktop.request(`/api/screens/${this.screen}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actions }), signal: AbortSignal.timeout(60_000) });
        return "桌面操作已完成。";
      }),
    ];
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.active]);
    await this.relay?.dispose();
    await closePlaywrightSessions(this.cacheDir).catch((error) => console.error("关闭浏览器命令会话失败：", error));
    this.relay = undefined;
  }
}

/** 无效或过长的助手 id 用稳定哈希。 */
export function desktopProfile(assistantId: string): string {
  return /^[a-z0-9-]{1,64}$/.test(assistantId) ? assistantId : `p-${createHash("sha256").update(assistantId).digest("hex").slice(0, 62)}`;
}

/** 在云桌面里打开（或提到最前）这个助手的浏览器，供用户接管并手动登录。 */
export async function openDesktopBrowser(runtime: HobRuntime, assistantId: string): Promise<void> {
  const profile = encodeURIComponent(desktopProfile(assistantId));
  await runtime.desktop.request(`/api/screens/${profile}/browser/start`, { method: "POST" });
  await runtime.desktop.request(`/api/screens/${profile}/browser/focus`, { method: "POST" });
}

export async function availableDesktopTools(
  runtime: HobRuntime,
  profile: string,
  canSeeImages: boolean,
  jobTitle?: string,
  screenshotDir?: string,
): Promise<DesktopToolSession | undefined> {
  const desktop = runtime.desktop.view();
  if (!desktop.enabled || !desktop.url || !desktop.tokenConfigured) return undefined;
  return new DesktopToolSession(runtime, profile, canSeeImages, jobTitle, false, screenshotDir);
}
