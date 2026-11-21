import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { pointerEventLength } from "../../desktop/desktopd/pointer-event.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopControl, RfbClientFilter, attachDesktopWebSocket } from "../src/desktop-control.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";
import { DesktopService, checkDesktopUrl } from "../src/desktop.ts";
import { SettingsStore } from "../src/settings.ts";
import { writeSecret } from "../src/secrets.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function setup(env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "hob-desktop-"));
  homes.push(home);
  const settings = new SettingsStore(home);
  return { home, settings, desktop: new DesktopService(home, settings, env) };
}

describe("云桌面配置", () => {
  it("保存配置和密钥但不回传令牌", () => {
    const { home, settings, desktop } = setup();
    settings.setDesktop(settings.get().revision, { url: "http://localhost:6080", enabled: true });
    writeSecret(home, "desktop:token", "secret");
    expect(desktop.view()).toMatchObject({ enabled: true, tokenConfigured: true, deployed: false });
    expect(JSON.stringify(desktop.view())).not.toContain("secret");
    expect(desktop.connection()).toEqual({ url: "http://localhost:6080", token: "secret" });
    expect(new SettingsStore(home).settings.desktop?.url).toBe("http://localhost:6080");
  });
  it("请求云桌面时带上 Hob 设置的时区", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => { seen.push(req.headers["x-hob-timezone"] as string); res.writeHead(200); res.end("{}"); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const { home, settings, desktop } = setup();
    try {
      settings.patch(settings.get().revision, { general: { timezone: "Asia/Shanghai" } });
      settings.setDesktop(settings.get().revision, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, enabled: true });
      writeSecret(home, "desktop:token", "token");
      await desktop.request("/api/health");
      expect(seen).toEqual(["Asia/Shanghai"]);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("配置接口保存令牌但不向客户端返回", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const saved = await app.request("/api/desktop", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ revision: 1, url: "http://localhost:6080", enabled: true, token: "sensitive-token" }) });
      expect(saved.status).toBe(200);
      expect(await saved.text()).not.toContain("sensitive-token");
      const settings = await app.request("/api/settings", { headers: { cookie } });
      expect(await settings.text()).not.toContain("sensitive-token");
      expect(hob.runtime.desktop.token()).toBe("sensitive-token");
    } finally { hob.close(); }
  });
  it("只有当前屏幕的接管者能提交文字，失败不会伪报成功", async () => {
    const hob = makeHob();
    const owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    try {
      const request = vi.spyOn(hob.runtime.desktop, "request").mockResolvedValue(new Response("{}"));
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const paste = (client: string, text = "中文\n第二行") => app.request("/api/desktop/paste", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ client, screen: "hob", text }) });
      hob.runtime.desktopControl.connected(owner);
      hob.runtime.desktopControl.take(owner);
      expect((await paste(other)).status).toBe(403);
      expect((await paste(owner, "bad\0text")).status).toBe(400);
      expect((await paste(owner)).status).toBe(200);
      expect(request).toHaveBeenCalledWith("/api/screens/hob/paste", expect.objectContaining({ body: JSON.stringify({ text: "中文\n第二行" }) }));
      request.mockRejectedValueOnce(new Error("剪贴板未就绪"));
      const failed = await paste(owner);
      expect(failed.status).toBe(502);
      expect(await failed.text()).toContain("剪贴板未就绪");
    } finally { hob.close(); }
  });
  it("环境优先且每次读取令牌文件", () => {
    const env: NodeJS.ProcessEnv = { HOB_DESKTOP_URL: "http://desktop:6080" };
    const { home, settings, desktop } = setup(env);
    settings.setDesktop(settings.get().revision, { url: "http://localhost:6080", enabled: true });
    writeSecret(home, "desktop:token", "saved");
    env.HOB_DESKTOP_TOKEN_FILE = join(home, "token");
    expect(desktop.view()).toMatchObject({ deployed: false, enabled: true, url: "http://localhost:6080" });
    expect(desktop.connection().token).toBe("saved");
    writeFileSync(env.HOB_DESKTOP_TOKEN_FILE, " \n");
    expect(desktop.view().deployed).toBe(false);
    writeFileSync(env.HOB_DESKTOP_TOKEN_FILE, "first\n");
    expect(desktop.view()).toMatchObject({ deployed: true, url: "http://desktop:6080" });
    expect(desktop.connection().token).toBe("first");
    expect(desktop.view().enabled).toBe(true);
    writeFileSync(env.HOB_DESKTOP_TOKEN_FILE, "second\n");
    expect(desktop.connection().token).toBe("second");
    env.HOB_DESKTOP_TOKEN = "direct";
    expect(desktop.connection().token).toBe("direct");
    delete env.HOB_DESKTOP_TOKEN;
    rmSync(env.HOB_DESKTOP_TOKEN_FILE);
    expect(desktop.connection().token).toBe("saved");
  });
  it("打开助手的浏览器：先启动再提到最前，带令牌；不存在的助手 404", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cdp: "/cdp/hob" }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const hob = makeHob();
    try {
      hob.runtime.settings.setDesktop(hob.runtime.settings.get().revision, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, enabled: true });
      writeSecret(hob.home, "desktop:token", "open-token");
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const open = (assistantId: string) => app.request("/api/desktop/browser", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assistantId }) });
      expect((await open("hob")).status).toBe(200);
      expect(seen).toEqual(["POST /api/screens/hob/browser/start Bearer open-token", "POST /api/screens/hob/browser/focus Bearer open-token"]);
      expect((await open("nobody")).status).toBe(404);
      expect(seen).toHaveLength(2);
    } finally { hob.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("普通接管和登录接管都使用同一个浏览器，并在交还时同步登录态", async () => {
    const hob = makeHob();
    const requests: string[] = [];
    const request = vi.spyOn(hob.runtime.desktop, "request").mockImplementation(async (path) => { requests.push(path); return new Response("{}"); });
    const client = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    hob.runtime.desktopControl.connected(client, "hob");
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const control = (action: string) => app.request("/api/desktop/control", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ client, screen: "hob", action }) });
      expect((await control("take")).status).toBe(200);
      expect((await control("release")).status).toBe(200);
      expect(requests).toEqual(["/api/screens/hob/browser/sync"]);
      expect((await control("take")).status).toBe(200);
      expect((await control("release")).status).toBe(200);
      expect(requests).toEqual(["/api/screens/hob/browser/sync", "/api/screens/hob/browser/sync"]);
    } finally { request.mockRestore(); hob.close(); }
  });

  it("云桌面错误中的令牌会打码", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "令牌 private-token 被拒：private-token" } }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const { home, settings, desktop } = setup();
    try {
      settings.setDesktop(1, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, enabled: true });
      writeSecret(home, "desktop:token", "private-token");
      await expect(desktop.request("/api/health")).rejects.toThrow("令牌 [已隐藏] 被拒：[已隐藏]");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("读取连接时地址与令牌来自同一次部署配置快照", () => {
    let reads = 0;
    const env: NodeJS.ProcessEnv = { HOB_DESKTOP_URL: "http://desktop:6080" };
    Object.defineProperty(env, "HOB_DESKTOP_TOKEN", { get: () => (++reads === 1 ? "deployed-token" : "") });
    const { home, settings, desktop } = setup(env);
    settings.setDesktop(settings.get().revision, { url: "http://localhost:6080", enabled: true });
    writeSecret(home, "desktop:token", "saved-token");
    expect(desktop.connection()).toEqual({ url: "http://desktop:6080", token: "deployed-token" });
    expect(reads).toBe(1);
  });
  it("VNC 需要登录，转发带令牌且旁观者无法发送键鼠", async () => {
    const hob = makeHob();
    const upstream = createServer();
    const wss = new WebSocketServer({ server: upstream });
    const received: Buffer[] = [];
    let auth = "";
    wss.on("connection", (socket, request) => {
      auth = request.headers.authorization ?? "";
      socket.on("message", (data) => received.push(Buffer.from(data as Buffer)));
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const port = (upstream.address() as AddressInfo).port;
    hob.runtime.settings.setDesktop(1, { url: `http://127.0.0.1:${port}`, enabled: true });
    writeSecret(hob.home, "desktop:token", "test-token");
    const proxy = createServer();
    const detach = attachDesktopWebSocket(proxy, hob.runtime);
    proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
    const base = `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}/api/desktop/vnc?screen=hob&client=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
    let client: WebSocket | undefined;
    try {
      const denied = new WebSocket(base);
      const [, response] = await once(denied, "unexpected-response");
      expect(response.statusCode).toBe(401);
      response.resume();
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const badOrigin = new WebSocket(base, { headers: { cookie, origin: "https://evil.example", "x-forwarded-host": "public.example, evil.example" } });
      const [, forbidden] = await once(badOrigin, "unexpected-response");
      expect(forbidden.statusCode).toBe(403);
      forbidden.resume();
      const proxied = new WebSocket(base, { headers: { cookie, origin: "https://public.example", "x-forwarded-host": "public.example, proxy.internal" } });
      await once(proxied, "open");
      proxied.terminate();
      client = new WebSocket(base, { headers: { cookie } });
      await once(client, "open");
      client.send(Buffer.from("RFB 003.008\n")); client.send(Buffer.from([1])); client.send(Buffer.from([1]));
      client.send(Buffer.from([5, 1, 0, 1, 0, 1]));
      client.send(Buffer.from([5, 128, 0, 1, 0, 1, 1]));
      await vi.waitFor(() => expect(received.length).toBe(3));
      expect(auth).toBe("Bearer test-token");
      hob.runtime.desktopControl.take("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      client.send(Buffer.from([5, 1, 0, 1, 0, 1]));
      await vi.waitFor(() => expect(received.length).toBe(4));
    } finally {
      client?.terminate(); detach(); hob.runtime.desktopControl.dispose();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      hob.close();
    }
  });
  it("RFB 流按消息边界过滤旁观者输入并允许接管者操作", () => {
    let allowed = false;
    const filter = new RfbClientFilter(() => allowed);
    const handshake = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]);
    expect(Buffer.concat(filter.push(handshake.subarray(0, 7)))).toEqual(Buffer.alloc(0));
    expect(Buffer.concat(filter.push(handshake.subarray(7)))).toEqual(handshake);
    const encodings = Buffer.from([2, 0, 0, 1, 0, 0, 0, 1]);
    const update = Buffer.alloc(10); update[0] = 3;
    const key = Buffer.alloc(8); key[0] = 4;
    const pointer = Buffer.from([5, 1, 0, 1, 0, 1]);
    const extendedPointer = Buffer.from([5, 128, 0, 1, 0, 1, 1]);
    expect(pointerEventLength(pointer.subarray(0, 1), 0)).toBeUndefined();
    expect(pointerEventLength(pointer, 0)).toBe(6);
    expect(pointerEventLength(extendedPointer, 0)).toBe(7);
    expect(pointerEventLength(Buffer.concat([key, extendedPointer]), key.length)).toBe(7);
    const clipboard = Buffer.from([6, 0, 0, 0, 0, 0, 0, 4, 116, 101, 115, 116]);
    const resize = Buffer.alloc(24); resize[0] = 251; resize[6] = 1;
    const stream = Buffer.concat([encodings, key, pointer, extendedPointer, clipboard, resize, update]);
    const parts = [stream.subarray(0, 11), stream.subarray(11, 25), stream.subarray(25)];
    expect(Buffer.concat(parts.flatMap((part) => filter.push(part)))).toEqual(Buffer.concat([encodings, update]));
    allowed = true;
    expect(Buffer.concat(filter.push(Buffer.concat([key, pointer, extendedPointer, clipboard, resize])))).toEqual(Buffer.concat([key, pointer, extendedPointer, clipboard, resize]));
    allowed = false;
    expect(filter.push(key)).toEqual([]);
    expect(() => filter.push(Buffer.from([99]))).toThrow("不支持的 RFB 消息");
  });
  it("接管互斥，断线一分钟后交还，重连保留", () => {
    vi.useFakeTimers();
    const hob = makeHob();
    const control = new DesktopControl(hob.runtime);
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const events: boolean[] = [];
    const unsubscribe = hob.runtime.bus.subscribe((event) => { if (event.type === "desktop-control") events.push(event.taken); });
    try {
      control.connected(a); control.connected(b); control.take(a);
      expect(() => control.take(b)).toThrow("另一位用户");
      control.disconnected(a); vi.advanceTimersByTime(30_000); control.connected(a); vi.advanceTimersByTime(60_000);
      expect(control.state(a).mine).toBe(true);
      control.disconnected(a); vi.advanceTimersByTime(60_000);
      expect(control.state(b).taken).toBe(false);
      control.take(b); expect(control.state(b).mine).toBe(true);
      expect(events).toEqual([true, false, true]);
    } finally { unsubscribe(); control.dispose(); hob.close(); vi.useRealTimers(); }
  });
  it("转发屏幕快照并在断线后重连", async () => {
    const hob = makeHob();
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
      realSetTimeout(callback, delay === 1000 ? 1 : delay, ...args)) as typeof setTimeout);
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const snapshot = [{ id: "hob", running: true, browserRunning: false, viewers: 0, lastActiveAt: null }];
    let connections = 0;
    sockets.on("connection", (socket) => { connections++; socket.send(JSON.stringify({ type: "screens", screens: snapshot })); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      hob.runtime.settings.setDesktop(1, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, enabled: true });
      writeSecret(hob.home, "desktop:token", "token");
      const events: unknown[] = [];
      const unsubscribe = hob.runtime.bus.subscribe((event) => { if (event.type === "desktop-screens") events.push(event.screens); });
      hob.runtime.desktopEvents.restart();
      await vi.waitFor(() => expect(hob.runtime.desktopEvents.screens).toEqual(snapshot));
      const changed = [{ ...snapshot[0], browserRunning: true }];
      for (const socket of sockets.clients) socket.send(JSON.stringify({ type: "screens", screens: changed }));
      await vi.waitFor(() => expect(hob.runtime.desktopEvents.screens).toEqual(changed));
      const beforeDisconnect = events.length;
      for (const socket of sockets.clients) socket.terminate();
      await vi.waitFor(() => expect(events.slice(beforeDisconnect)).toContainEqual([]));
      await vi.waitFor(() => expect(connections).toBe(2), { timeout: 4000 });
      await vi.waitFor(() => expect(hob.runtime.desktopEvents.screens).toEqual(snapshot));
      expect(events).toContainEqual(changed);
      expect(timers.mock.calls.some(([, delay]) => delay === 1000)).toBe(true);
      unsubscribe();
    } finally {
      vi.restoreAllMocks();
      hob.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("启动时未配置的桌面在配置出现后会自动连接", async () => {
    const hob = makeHob();
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
      realSetTimeout(callback, delay === 1000 ? 1 : delay, ...args)) as typeof setTimeout);
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => socket.send(JSON.stringify({ type: "screens", screens: [{ id: "hob", running: true, browserRunning: false, viewers: 0, lastActiveAt: null }] })));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      hob.runtime.desktopEvents.restart();
      hob.runtime.settings.setDesktop(1, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, enabled: true });
      writeSecret(hob.home, "desktop:token", "token");
      await vi.waitFor(() => expect(hob.runtime.desktopEvents.screens[0]?.id).toBe("hob"), { timeout: 4000 });
      expect(timers.mock.calls.some(([, delay]) => delay === 1000)).toBe(true);
    } finally {
      vi.restoreAllMocks();
      hob.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("屏幕接口只允许已存在的助手屏幕", async () => {
    const hob = makeHob();
    const requests: string[] = [];
    const server = createServer((req, res) => { requests.push(req.url ?? ""); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      hob.runtime.settings.setDesktop(1, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, enabled: true });
      writeSecret(hob.home, "desktop:token", "token");
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const start = (id: string) => app.request(`/api/desktop/screens/${id}/start`, { method: "POST", headers: { cookie } });
      expect((await start("hob")).status).toBe(200);
      expect((await start("unknown")).status).toBe(404);
      expect((await start("Bad")).status).toBe(400);
      expect(requests).toEqual(["/api/screens/hob/start"]);
    } finally { hob.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("接管按屏幕隔离", () => {
    const hob = makeHob();
    const control = new DesktopControl(hob.runtime);
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    try {
      control.connected(a, "hob"); control.connected(b, "other");
      control.take(a, "hob");
      expect(control.state(b, "other").taken).toBe(false);
      control.take(b, "other");
      control.release(a, "hob");
      expect(control.state(b, "other").mine).toBe(true);
    } finally { control.dispose(); hob.close(); }
  });
  it("拒绝在地址中嵌入令牌", () => {
    expect(() => checkDesktopUrl("http://user:password@localhost")).toThrow();
    expect(() => checkDesktopUrl("file:///tmp/token")).toThrow();
  });
});
