import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { serve } from "@hono/node-server";
import type { Duplex } from "node:stream";
import type { HobRuntime } from "./runtime.ts";
import { validCookie } from "./http.ts";
import { desktopProfile } from "./desktop-tools.ts";

const CLIENT = /^[a-f0-9-]{36}$/;

export class DesktopControl {
  private screens = new Map<string, { owner: string | null; connections: Map<string, number>; timer?: NodeJS.Timeout }>();
  constructor(private runtime: HobRuntime) {}
  private screen(id: string) {
    let screen = this.screens.get(id);
    if (!screen) { screen = { owner: null, connections: new Map() }; this.screens.set(id, screen); }
    return screen;
  }
  state(client: string, id = "hob") { const screen = this.screen(id); return { taken: screen.owner !== null, mine: screen.owner === client }; }
  private emit(id: string) { this.runtime.bus.emit({ type: "desktop-control", screen: id, taken: this.screen(id).owner !== null }); }
  take(client: string, id = "hob") {
    const screen = this.screen(id);
    if (!CLIENT.test(client) || !screen.connections.has(client)) throw new Error("请先打开云桌面。");
    if (screen.owner && screen.owner !== client) throw new Error("另一位用户正在操作云桌面。");
    screen.owner = client;
    if (screen.timer) clearTimeout(screen.timer);
    screen.timer = undefined;
    this.emit(id);
  }
  release(client: string, id = "hob") {
    const screen = this.screen(id);
    if (screen.owner !== client) throw new Error("当前设备没有接管云桌面。");
    screen.owner = null;
    if (screen.timer) clearTimeout(screen.timer);
    screen.timer = undefined;
    this.emit(id);
  }
  connected(client: string, id = "hob") {
    const screen = this.screen(id);
    screen.connections.set(client, (screen.connections.get(client) ?? 0) + 1);
    if (screen.owner === client && screen.timer) { clearTimeout(screen.timer); screen.timer = undefined; }
  }
  disconnected(client: string, id = "hob") {
    const screen = this.screen(id);
    const count = (screen.connections.get(client) ?? 1) - 1;
    if (count > 0) screen.connections.set(client, count);
    else {
      screen.connections.delete(client);
      if (screen.owner === client) {
        screen.timer = setTimeout(() => { if (screen.owner === client && !screen.connections.has(client)) { screen.owner = null; this.emit(id); } }, 60_000);
        screen.timer.unref();
      }
    }
  }
  get taken() { return this.screen("hob").owner !== null; }
  dispose() { for (const screen of this.screens.values()) if (screen.timer) clearTimeout(screen.timer); this.screens.clear(); }
}

// RFB 3.8: version, security type and ClientInit, then length-delimited client messages.
// Parse the stream rather than trusting WebSocket frame boundaries so view-only cannot inject input.
export class RfbClientFilter {
  private data = Buffer.alloc(0);
  private phase = 0;
  constructor(private allowed: () => boolean) {}
  push(input: Buffer): Buffer[] {
    this.data = Buffer.concat([this.data, input]);
    if (this.data.length > 1_048_576) throw new Error("RFB 消息过大");
    const output: Buffer[] = [];
    while (this.data.length) {
      let size: number;
      let isInput = false;
      if (this.phase === 0) {
        size = 12;
        if (this.data.length < size) break;
        if (this.data.subarray(0, 12).toString() !== "RFB 003.008\n") throw new Error("不支持的 RFB 协议");
      } else if (this.phase === 1 || this.phase === 2) {
        size = 1;
        if (this.phase === 1 && this.data[0] !== 1) throw new Error("不支持的 RFB 认证方式");
      } else {
        const type = this.data[0];
        switch (type) {
          case 0: size = 20; break;
          case 2: if (this.data.length < 4) return output; size = 4 + this.data.readUInt16BE(2) * 4; break;
          case 3: size = 10; break;
          case 4: size = 8; isInput = true; break;
          case 5: if (this.data.length < 2) return output; size = (this.data[1] & 0x80) ? 7 : 6; isInput = true; break;
          case 6: if (this.data.length < 8) return output; size = 8 + Math.abs(this.data.readInt32BE(4)); isInput = true; break;
          case 150: size = 10; break;
          case 248: if (this.data.length < 9) return output; size = 9 + this.data[8]; break;
          case 251: if (this.data.length < 8) return output; size = 8 + this.data[6] * 16; isInput = true; break;
          case 255: size = 12; isInput = true; break;
          default: throw new Error(`不支持的 RFB 消息 ${type}`);
        }
      }
      if (size > 1_048_576) throw new Error("RFB 消息过大");
      if (this.data.length < size) break;
      const message = this.data.subarray(0, size);
      this.data = this.data.subarray(size);
      if (this.phase < 3) this.phase++;
      if (!isInput || this.allowed()) output.push(message);
    }
    return output;
  }
}

export function attachDesktopWebSocket(server: ReturnType<typeof serve>, runtime: HobRuntime): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (requestUrl.pathname !== "/api/desktop/vnc") return;
    const reject = (status: string) => { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    const cookie = req.headers.cookie?.split(";").map((s) => s.trim()).find((s) => s.startsWith("hob="))?.slice(4);
    if (!validCookie(runtime.config, cookie)) return reject("401 Unauthorized");
    const origin = req.headers.origin;
    const forwardedHeader = req.headers["x-forwarded-host"];
    const forwardedHost = (Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader)?.split(",")[0].trim();
    try { if (origin && ![req.headers.host, forwardedHost].includes(new URL(origin).host)) return reject("403 Forbidden"); }
    catch { return reject("403 Forbidden"); }
    const client = requestUrl.searchParams.get("client") ?? "";
    const screen = requestUrl.searchParams.get("screen") ?? "";
    if (!CLIENT.test(client) || !/^[a-z0-9-]{1,64}$/.test(screen)) return reject("400 Bad Request");
    if (screen !== "public" && !runtime.store.assistants().some((assistant) => desktopProfile(assistant.id) === screen)) return reject("404 Not Found");
    let connection: { url: string; token: string };
    try { connection = runtime.desktop.connection(); } catch { return reject("503 Service Unavailable"); }
    const target = new URL(`/vnc/${screen}`, connection.url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const upstream = new WebSocket(target, { headers: { Authorization: `Bearer ${connection.token}` }, perMessageDeflate: false });
    const failed = () => reject("502 Bad Gateway");
    upstream.once("error", failed);
    socket.once("close", () => { if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate(); });
    upstream.once("open", () => {
      upstream.off("error", failed);
      wss.handleUpgrade(req, socket, head, (ws) => {
        runtime.desktopControl.connected(client, screen);
        const filter = new RfbClientFilter(() => runtime.desktopControl.state(client, screen).mine);
        upstream.on("message", (data, binary) => { if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary }); });
        ws.on("message", (data, binary) => {
          try {
            if (!binary) throw new Error("RFB 需要二进制数据");
            for (const message of filter.push(Buffer.from(data as Buffer))) if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
          } catch (error) { console.error("云桌面协议错误：", error instanceof Error ? error.message : String(error)); ws.close(1002, "RFB 协议错误"); }
        });
        ws.on("error", () => upstream.close());
        upstream.on("error", () => ws.close());
        ws.on("close", () => { runtime.desktopControl.disconnected(client, screen); upstream.close(); });
        upstream.on("close", () => ws.close());
      });
    });
  };
  server.on("upgrade", upgrade);
  return () => { server.off("upgrade", upgrade); for (const client of wss.clients) client.terminate(); wss.close(); };
}
