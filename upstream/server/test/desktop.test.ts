import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { chromium } from "playwright-core";
import { pointerEventLength } from "../../desktop/desktopd/pointer-event.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopControl, RfbClientFilter, attachDesktopWebSocket } from "../src/desktop-control.ts";
import { availableDesktopTools, DesktopToolSession, desktopProfile } from "../src/desktop-tools.ts";
import { DesktopPublicLock } from "../src/desktop-public.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";
import { DesktopService, checkDesktopUrl } from "../src/desktop.ts";
import { SettingsStore } from "../src/settings.ts";
import { writeSecret } from "../src/secrets.ts";
import { lookupFile } from "../src/files.ts";

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
  it("公共屏幕授权经设置接口校验并持久化", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const save = (revision: number, assistants: string[]) => app.request("/api/desktop/public", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ revision, assistants }) });
      expect((await save(1, ["unknown"])).status).toBe(400);
      expect((await save(1, ["hob"])).status).toBe(200);
      expect(new SettingsStore(hob.home).settings.desktop?.publicAssistants).toEqual(["hob"]);
      expect((await save(1, [])).status).toBe(409);
      hob.runtime.settings.setDesktop(2, { url: "http://localhost:6080", enabled: true });
      expect(new SettingsStore(hob.home).settings.desktop?.publicAssistants).toEqual(["hob"]);
      const screens = await (await app.request("/api/desktop/screens", { headers: { cookie } })).json() as { profiles: Record<string, string> };
      expect(screens.profiles.hob).toBe("hob");
    } finally { hob.close(); }
  });
  it("两种截图按身份落盘并返回精确文字，不能看图时仍保存", async () => {
    const hob = makeHob();
    const request = vi.spyOn(hob.runtime.desktop, "request").mockImplementation(async () => new Response("image"));
    try {
      for (const router of [true, false]) for (const canSee of [true, false]) for (const name of ["browser_screenshot", "desktop_screenshot"]) {
        const dir = router ? join(hob.home, "assistants", "hob", "files", "screenshots") : join(hob.runtime.store.workDir("t-1234"), "screenshots");
        const session = new DesktopToolSession(hob.runtime, "hob", canSee, router ? undefined : "任务", router, dir);
        vi.spyOn(session as any, "getPage").mockResolvedValue({ screenshot: async () => Buffer.from("image") });
        try {
          const result = await session.tools().find((tool) => tool.name === name)!.execute("test", {});
          expect(result.isError).not.toBe(true);
          const file = readdirSync(dir).sort().at(-1)!;
          const path = join(dir, file);
          expect(file).toMatch(/^\d{8}T\d{9}\.png$/);
          expect(readFileSync(path).toString()).toBe("image");
          expect(lookupFile(hob.home, path).ok).toBe(true);
          const send = router ? "用 send_file 发它" : "report 时放进 files";
          expect(result.content).toEqual(canSee
            ? [{ type: "image", data: Buffer.from("image").toString("base64"), mimeType: "image/png" }, { type: "text", text: `截图已存到 ${path}。要给用户看，${send}。` }]
            : [{ type: "text", text: `当前模型不能看图。截图已存到 ${path}：要给用户看，${send}；要自己读页面内容，用 browser_snapshot。` }]);
        } finally { await session.dispose(); }
      }
    } finally { request.mockRestore(); hob.close(); }
  });
  it("截图在同一毫秒也不覆盖，超过 20 张删除最旧文件", async () => {
    const hob = makeHob();
    const request = vi.spyOn(hob.runtime.desktop, "request").mockImplementation(async () => new Response("image"));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1793979012123);
    const session = new DesktopToolSession(hob.runtime, "hob", true, undefined, true);
    const dir = join(hob.home, "assistants", "hob", "files", "screenshots");
    try {
      expect(existsSync(dir)).toBe(false);
      const screenshot = session.tools().find((tool) => tool.name === "desktop_screenshot")!;
      for (let i = 0; i < 22; i++) {
        const result = await screenshot.execute(String(i), {});
        expect(result.isError).not.toBe(true);
        const text = (result.content[1] as { text: string }).text;
        const path = text.slice("截图已存到 ".length, text.indexOf("。"));
        expect(existsSync(path)).toBe(true);
      }
      const files = readdirSync(dir).sort();
      expect(files).toHaveLength(20);
      expect(files[0]).toBe("20261106T153012125.png");
      expect(files[19]).toBe("20261106T153012144.png");
    } finally { clock.mockRestore(); request.mockRestore(); await session.dispose(); hob.close(); }
  });
  it("公共屏幕权限决定工具参数且硬传也拒绝", async () => {
    const hob = makeHob();
    const session = new DesktopToolSession(hob.runtime, "hob", true);
    try {
      const tools = session.tools();
      expect(tools.every((tool) => !("screen" in tool.parameters.properties))).toBe(true);
      const rejected = await tools[0].execute("test", { url: "https://example.com", screen: "public" });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0]).toMatchObject({ text: expect.stringContaining("没有使用公共屏幕的权限") });
      hob.runtime.settings.setDesktop(1, { url: "", enabled: false, publicAssistants: ["hob"] });
      expect(session.tools().every((tool) => "screen" in tool.parameters.properties)).toBe(true);
      expect(desktopProfile("public")).not.toBe("public");
    } finally { await session.dispose(); hob.close(); }
  });
  it("任务持有公共屏幕至结束，其他任务等待但自己的屏幕不受阻", async () => {
    const hob = makeHob();
    hob.runtime.settings.setDesktop(1, { url: "", enabled: false, publicAssistants: ["hob", "other"] });
    const request = vi.spyOn(hob.runtime.desktop, "request").mockImplementation(async () => new Response("image"));
    const a = new DesktopToolSession(hob.runtime, "hob", true);
    const b = new DesktopToolSession(hob.runtime, "other", true);
    const tool = (session: DesktopToolSession) => session.tools().find((entry) => entry.name === "desktop_screenshot")!;
    try {
      expect((await tool(a).execute("a", { screen: "public" })).isError).not.toBe(true);
      const waiting = tool(b).execute("b", { screen: "public" });
      await Promise.resolve();
      expect((await tool(b).execute("own", {})).isError).not.toBe(true);
      expect(request.mock.calls.filter(([path]) => String(path).includes("/public/"))).toHaveLength(2);
      await a.dispose();
      expect((await waiting).isError).not.toBe(true);
      expect(request.mock.calls.filter(([path]) => String(path).includes("/public/"))).toHaveLength(4);
    } finally { await a.dispose(); await b.dispose(); request.mockRestore(); hob.close(); }
  });
  it("公共屏幕排队、取消及超时均释放占用", async () => {
    vi.useFakeTimers();
    const lock = new DesktopPublicLock(100);
    const a = {}, b = {}, c = {};
    try {
      await lock.acquire(a, "甲");
      const waiting = lock.acquire(b, "乙");
      const timeout = lock.acquire(c, "丙");
      const assertion = expect(timeout).rejects.toThrow("公共屏幕正被『甲』的任务使用");
      const waitingAssertion = expect(waiting).rejects.toThrow("公共屏幕正被『甲』的任务使用");
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      await waitingAssertion;
      const next = lock.acquire(b, "乙");
      lock.release(a);
      await next;
      const cancelled = lock.acquire(c, "丙");
      const cancelledAssertion = expect(cancelled).rejects.toThrow("任务已结束");
      lock.cancelWait(c);
      await cancelledAssertion;
      lock.release(b);
      await lock.acquire(c, "丙");
      lock.release(c);
    } finally { vi.useRealTimers(); }
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
  it("屏幕接口只允许已存在的助手与公共屏幕", async () => {
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
      expect((await start("public")).status).toBe(200);
      expect((await start("unknown")).status).toBe(404);
      expect((await start("Bad")).status).toBe(400);
      expect(requests).toEqual(["/api/screens/hob/start", "/api/screens/public/start"]);
    } finally { hob.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("接管按屏幕隔离", () => {
    const hob = makeHob();
    const control = new DesktopControl(hob.runtime);
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    try {
      control.connected(a, "hob"); control.connected(b, "public");
      control.take(a, "hob");
      expect(control.state(b, "public").taken).toBe(false);
      control.take(b, "public");
      control.release(a, "hob");
      expect(control.state(b, "public").mine).toBe(true);
    } finally { control.dispose(); hob.close(); }
  });
  it("未配置或服务不健康时没有工具，接管中所有工具返回错误", async () => {
    const hob = makeHob();
    const server = createServer((_req, res) => { res.writeHead(503); res.end(); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      expect(await availableDesktopTools(hob.runtime, "hob", true)).toBeUndefined();
      hob.runtime.settings.setDesktop(1, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, enabled: true });
      writeSecret(hob.home, "desktop:token", "token");
      expect(await availableDesktopTools(hob.runtime, "hob", true)).toBeUndefined();
      server.removeAllListeners("request");
      server.on("request", (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
      const session = await availableDesktopTools(hob.runtime, "hob", true);
      expect(session?.tools()).toHaveLength(9);
      const client = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      hob.runtime.desktopControl.connected(client); hob.runtime.desktopControl.take(client);
      for (const tool of session!.tools()) {
        const result = await tool.execute("test", {});
        expect(result.isError).toBe(true);
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining("用户正在操作云桌面") });
      }
      await session!.dispose();
    } finally {
      hob.runtime.desktopControl.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      hob.close();
    }
  });
  it("同一任务复用浏览器连接，结束时只断开连接", async () => {
    const hob = makeHob();
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/api/health" ? "{}" : '{"cdp":"/cdp/hob"}');
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const page = { isClosed: () => false, setDefaultTimeout: vi.fn(), ariaSnapshot: vi.fn().mockResolvedValue("页面") };
    const newPage = vi.fn().mockResolvedValue(page);
    const browser = { isConnected: () => true, contexts: () => [{ newPage }], close: vi.fn().mockResolvedValue(undefined) };
    const connect = vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(browser as never);
    try {
      hob.runtime.settings.setDesktop(1, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, enabled: true });
      writeSecret(hob.home, "desktop:token", "token");
      const session = await availableDesktopTools(hob.runtime, "hob", true);
      const snapshot = session!.tools().find((tool) => tool.name === "browser_snapshot")!;
      expect((await snapshot.execute("first", {})).isError).not.toBe(true);
      expect((await snapshot.execute("second", {})).isError).not.toBe(true);
      await session!.dispose();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(newPage).toHaveBeenCalledTimes(1);
      expect(requests.filter((path) => path === "/api/screens/hob/browser/start")).toHaveLength(1);
      expect(requests.some((path) => path.endsWith("/stop"))).toBe(false);
    } finally {
      connect.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      hob.close();
    }
  });
  it("助手工具随配置变化，并在任务占用时拒绝操作，释放时断开连接", async () => {
    const hob = makeHob();
    const page = { isClosed: () => false, setDefaultTimeout: vi.fn(), ariaSnapshot: vi.fn().mockResolvedValue("Example Domain") };
    const browser = { isConnected: () => true, contexts: () => [{ newPage: vi.fn().mockResolvedValue(page) }], close: vi.fn().mockResolvedValue(undefined) };
    const connect = vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(browser as never);
    const request = vi.spyOn(hob.runtime.desktop, "request").mockImplementation(async () => new Response('{"cdp":"/cdp/hob"}'));
    const worker = new DesktopToolSession(hob.runtime, "hob", true, "查资料");
    try {
      let state = await hob.runtime.router.ensure("hob");
      expect(state.session!.getActiveToolNames().filter((name) => name.startsWith("browser_"))).toHaveLength(0);
      hob.runtime.settings.setDesktop(1, { url: "http://localhost:6080", enabled: true });
      writeSecret(hob.home, "desktop:token", "token");
      hob.runtime.router.releaseSessions();
      state = await hob.runtime.router.ensure("hob");
      expect(state.session!.getActiveToolNames().filter((name) => name.startsWith("browser_"))).toHaveLength(7);
      expect(state.desktop!.tools().find((tool) => tool.name === "browser_open")!.parameters.properties).not.toHaveProperty("screen");
      await worker.tools().find((tool) => tool.name === "browser_snapshot")!.execute("worker", {});
      const snapshot = state.desktop!.tools().find((tool) => tool.name === "browser_snapshot")!;
      expect((await snapshot.execute("router", {})).content[0]).toMatchObject({ text: "任务「查资料」正在用浏览器，等它做完，或者用 reply_job 让它停下来。" });
      await worker.dispose();
      expect((await snapshot.execute("router", {})).isError).not.toBe(true);
      hob.runtime.router.releaseSessions();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(browser.close).toHaveBeenCalledTimes(2);
      hob.runtime.settings.setDesktop(hob.runtime.settings.get().revision, { url: "http://localhost:6080", enabled: true, publicAssistants: ["hob"] });
      state = await hob.runtime.router.ensure("hob");
      expect(state.desktop!.tools().find((tool) => tool.name === "browser_open")!.parameters.properties).toHaveProperty("screen");
      const client = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      hob.runtime.desktopControl.connected(client); hob.runtime.desktopControl.take(client);
      expect((await state.desktop!.tools().find((tool) => tool.name === "browser_snapshot")!.execute("taken", {})).content[0]).toMatchObject({ text: expect.stringContaining("用户正在操作云桌面") });
      expect(request).toHaveBeenCalled();
    } finally { await worker.dispose(); connect.mockRestore(); hob.close(); }
  });
  it("助手不持有公共屏幕锁，不妨碍任务使用", async () => {
    const hob = makeHob();
    hob.runtime.settings.setDesktop(1, { url: "http://localhost:6080", enabled: true, publicAssistants: ["hob"] });
    writeSecret(hob.home, "desktop:token", "token");
    vi.spyOn(hob.runtime.desktop, "request").mockImplementation(async () => new Response('{"cdp":"/cdp/public"}'));
    const page = { isClosed: () => false, setDefaultTimeout: vi.fn(), ariaSnapshot: vi.fn().mockResolvedValue("页面") };
    const browser = { isConnected: () => true, contexts: () => [{ newPage: vi.fn().mockResolvedValue(page) }], close: vi.fn().mockResolvedValue(undefined) };
    const connect = vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(browser as never);
    const router = new DesktopToolSession(hob.runtime, "hob", true, undefined, true);
    const worker = new DesktopToolSession(hob.runtime, "hob", true, "公共任务");
    try {
      const tool = (session: DesktopToolSession) => session.tools().find((entry) => entry.name === "browser_snapshot")!;
      expect((await tool(router).execute("router", { screen: "public" })).isError).not.toBe(true);
      expect((await tool(worker).execute("worker", { screen: "public" })).isError).not.toBe(true);
      expect((await tool(router).execute("busy", { screen: "public" })).content[0]).toMatchObject({ text: expect.stringContaining("任务「公共任务」正在用浏览器") });
    } finally { await worker.dispose(); await router.dispose(); connect.mockRestore(); hob.close(); }
  });
  it("过长助手 id 映射成稳定且符合 desktopd 约束的 profile", async () => {
    const hob = makeHob();
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/api/health" ? "{}" : '{"cdp":"invalid"}');
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      hob.runtime.settings.setDesktop(1, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, enabled: true });
      writeSecret(hob.home, "desktop:token", "token");
      for (const id of ["a".repeat(65), "a".repeat(65), "a".repeat(64) + "b", "hob"]) {
        const session = await availableDesktopTools(hob.runtime, id, true);
        await session!.tools().find((tool) => tool.name === "browser_open")!.execute("test", { url: "http://example.com" });
        await session!.dispose();
      }
      const profiles = paths.filter((path) => path.includes("/start")).map((path) => path.split("/")[3]);
      expect(profiles).toHaveLength(4);
      expect(profiles[0]).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(profiles[0]).toBe(profiles[1]);
      expect(profiles[0]).not.toBe(profiles[2]);
      expect(profiles[3]).toBe("hob");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      hob.close();
    }
  });
  it("拒绝在地址中嵌入令牌", () => {
    expect(() => checkDesktopUrl("http://user:password@localhost")).toThrow();
    expect(() => checkDesktopUrl("file:///tmp/token")).toThrow();
  });
});
