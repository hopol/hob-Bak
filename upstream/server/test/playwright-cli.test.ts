import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserShellEnv, DesktopToolSession } from "../src/desktop-tools.ts";
import { ensurePlaywrightCli } from "../src/playwright-cli.ts";
import { browserCommandLabel } from "../src/transcript.ts";
import { activityLabel } from "../src/router-activity.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { bundledPlaywrightSkillDir } from "../src/skills.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";
import { writeSecret } from "../src/secrets.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("playwright-cli", () => {
  it("识别带 cd 和 session 参数的浏览器命令，并让未知命令走普通显示", () => {
    expect(browserCommandLabel("cd /tmp/site && playwright-cli -s=assistant open https://example.test/page")).toBe("浏览器 · 打开 example.test");
    expect(browserCommandLabel("playwright-cli -s assistant snapshot")).toBe("浏览器 · 读取页面");
    for (const [command, expected] of [
      ["playwright-cli goto https://example.test", "浏览器 · 打开 example.test"],
      ["playwright-cli snapshot", "浏览器 · 读取页面"],
      ["playwright-cli click e3", "浏览器 · 点击"],
      ["playwright-cli type hello", "浏览器 · 输入"],
      ["playwright-cli fill e3 hello", "浏览器 · 输入"],
      ["playwright-cli press Enter", "浏览器 · 按键"],
      ["playwright-cli go-back", "浏览器 · 返回"],
      ["playwright-cli screenshot", "浏览器 · 截图"],
      ["playwright-cli eval 'document.title'", "浏览器 · eval"],
    ]) expect(browserCommandLabel(command)).toBe(expected);
    expect(browserCommandLabel("echo playwright-cli open https://example.test")).toBeUndefined();
  });

  it("生成 Hob 自己的启动器，没有会话连接时明确报云桌面未开启", () => {
    const home = mkdtempSync(join(tmpdir(), "hob-cli-wrapper-"));
    homes.push(home);
    const engine = join(home, "engine");
    ensurePlaywrightCli(engine);
    const executable = join(engine, "bin", "playwright-cli");
    expect(existsSync(executable)).toBe(true);
    expect(readFileSync(executable, "utf8")).toContain("playwright-core/lib/tools/cli-client/program.js");
    const result = spawnSync(executable, ["open", "https://example.test"], { encoding: "utf8", env: { ...process.env, PLAYWRIGHT_MCP_CDP_ENDPOINT: "", PLAYWRIGHT_MCP_CDP_HEADERS: "" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("云桌面没有开启");
    const version = spawnSync(executable, ["--version"], { encoding: "utf8", env: { ...process.env, PLAYWRIGHT_MCP_CDP_ENDPOINT: "", PLAYWRIGHT_MCP_CDP_HEADERS: "" } });
    expect(version.status).toBe(0);
    const cliEnv = { ...process.env, PLAYWRIGHT_MCP_CDP_ENDPOINT: "ws://127.0.0.1:1/cdp", PLAYWRIGHT_MCP_CDP_HEADERS: "Authorization: Bearer local" };
    for (const args of [["kill-all"], ["-s=other", "kill-all"], ["--json", "--", "kill-all"]]) {
      const blocked = spawnSync(executable, args, { encoding: "utf8", env: cliEnv });
      expect(blocked.status).toBe(1);
      expect(blocked.stderr).toContain("kill-all 会终止其他浏览器会话");
    }
    expect(spawnSync(executable, ["--help", "type", "kill-all"], { encoding: "utf8", env: cliEnv }).status).toBe(0);
  });

  it("单聊和群会话按能力开关提供工具并使用助手自己的工作目录", async () => {
    const hob = makeHob();
    try {
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, abilities: { exec: false, write: false, image: false } });
      const group = hob.runtime.groups.create({ name: "协作", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const opened: { cwd: string }[] = [];
      const open = hob.runtime.pi.open.bind(hob.runtime.pi);
      vi.spyOn(hob.runtime.pi, "open").mockImplementation(async (options) => { opened.push(options); return open(options); });
      for (const state of [await hob.runtime.router.ensure("hob"), await hob.runtime.router.ensure("hob", group.id)]) {
        const names = state.session!.getActiveToolNames();
        expect(names).toContain("read");
        expect(names).not.toContain("bash");
        expect(names).not.toContain("edit");
        expect(names).not.toContain("write");
        expect(names.some((name) => name.startsWith("browser_"))).toBe(false);
      }
      expect(opened.map((item) => item.cwd)).toEqual([join(hob.home, "assistants", "hob", "work"), join(hob.home, "assistants", "hob", "work")]);
      expect(existsSync(opened[0].cwd)).toBe(true);
      writeFileSync(join(opened[0].cwd, "notes.txt"), "工作目录里的内容");
      const read = buildRouterTools(hob.runtime, "hob", undefined, opened[0].cwd).find((tool) => tool.name === "read")!;
      expect((await read.execute("work", { path: "notes.txt" })).content[0].text).toBe("工作目录里的内容");
      const send = buildRouterTools(hob.runtime, "hob", undefined, opened[0].cwd).find((tool) => tool.name === "send_file")!;
      expect((await send.execute("send", { path: "notes.txt" })).isError).not.toBe(true);
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "file" && item.path === join(opened[0].cwd, "notes.txt"))).toBe(true);
      expect((await read.execute("skill", { path: join(bundledPlaywrightSkillDir(), "SKILL.md") })).content[0].text).toContain("Browser Automation with playwright-cli");
    } finally { hob.close(); }
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])("执行能力 %s、写入能力 %s 时单聊和群工具一致", async (exec, write) => {
    const hob = makeHob();
    try {
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, abilities: { exec, write, image: false } });
      const group = hob.runtime.groups.create({ name: "协作", purpose: "测试", ownerId: "hob", members: ["hob"] });
      for (const state of [await hob.runtime.router.ensure("hob"), await hob.runtime.router.ensure("hob", group.id)]) {
        const names = state.session!.getActiveToolNames();
        expect(names).toContain("read");
        expect(names.includes("bash")).toBe(exec);
        expect(names.includes("edit")).toBe(write);
        expect(names.includes("write")).toBe(write);
      }
    } finally { hob.close(); }
  });

  it("任务和助手有各自的 CLI 连接，任务工具表没有 browser 工具", async () => {
    const hob = makeHob();
    try {
      hob.runtime.settings.setDesktop(hob.runtime.settings.get().revision, { url: "http://127.0.0.1:1", enabled: true });
      writeSecret(hob.home, "desktop:token", "token");
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const opened: { options: any; names: string[] }[] = [];
      const open = hob.runtime.pi.open.bind(hob.runtime.pi);
      vi.spyOn(hob.runtime.pi, "open").mockImplementation(async (options) => {
        const result = await open(options);
        opened.push({ options, names: result.session.getActiveToolNames() });
        return result;
      });
      await hob.runtime.router.ensure("hob");
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      await hob.runtime.jobs.start("hob", { title: "测试任务", instruction: "测试" });
      await hob.runtime.jobs.waitIdle();
      const router = opened.find((item) => item.options.file.endsWith("router.jsonl"))!;
      const worker = opened.find((item) => item.options.file.endsWith("worker.jsonl"))!;
      expect(worker.names).toEqual(expect.arrayContaining(["bash", "read", "edit", "write", "desktop_screenshot", "desktop_action"]));
      expect(worker.names.some((name) => name.startsWith("browser_"))).toBe(false);
      const env = (item: typeof router) => item.options.bashSpawnHook({ command: "playwright-cli snapshot", cwd: ".", env: {} }).env;
      expect(env(router).PLAYWRIGHT_CLI_SESSION).not.toBe(env(worker).PLAYWRIGHT_CLI_SESSION);
      expect(env(router).HOB_PLAYWRIGHT_CACHE_HOME).not.toBe(env(worker).HOB_PLAYWRIGHT_CACHE_HOME);
    } finally { hob.close(); }
  });

  it("交接时相对路径以助手工作目录为准，任务能看到附带文件路径", async () => {
    const hob = makeHob();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const state = await hob.runtime.router.ensure("hob");
      const cwd = join(hob.home, "assistants", "hob", "work");
      const file = join(cwd, "handoff.txt");
      writeFileSync(file, "已查到的内容");
      const start = buildRouterTools(hob.runtime, "hob", undefined, cwd).find((tool) => tool.name === "start_job")!;
      const rejected = await start.execute("bad", { title: "错误目录", note: "继续处理", cwd: "." });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toContain("不能把 Hob 的数据目录指定为任务工作目录");
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const result = await start.execute("start", { title: "继续处理", note: "核对附带文件", files: ["handoff.txt"] });
      expect(result.isError).not.toBe(true);
      await hob.runtime.jobs.waitIdle();
      const job = hob.runtime.store.jobs().find((item) => item.title === "继续处理")!;
      expect(job.inputs).toEqual([file]);
      expect(readFileSync(join(hob.home, "assistants", "hob", "jobs", job.id, "worker.jsonl"), "utf8")).toContain(`附带文件：\\n- ${file}`);
      expect(state.session).toBeDefined();
    } finally { hob.close(); }
  });

  it("助手执行命令只显示在正在做的那一行，不往对话里写过程", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("bash", { command: "printf 'ok'" }), text("完成")]);
      await hob.runtime.router.send("hob", { text: "执行一条命令" });
      await hob.runtime.router.waitIdle("hob", 10_000);
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.text.includes("printf"))).toBe(false);
      expect(activityLabel("bash", { command: "printf 'ok'" })).toContain("printf");
    } finally { hob.close(); }
  });

  it("任务保留整屏桌面工具，但不再暴露 browser 工具", async () => {
    const hob = makeHob();
    hob.runtime.settings.setDesktop(hob.runtime.settings.get().revision, { url: "http://127.0.0.1:1", enabled: true });
    writeSecret(hob.home, "desktop:token", "token");
    vi.spyOn(hob.runtime.desktop, "request").mockResolvedValue(new Response("image"));
    const dir = join(hob.home, "assistants", "hob", "jobs", "t-test", "work", "screenshots");
    const session = new DesktopToolSession(hob.runtime, "hob", true, "截图", false, dir);
    try {
      const tools = session.tools();
      expect(tools.map((tool) => tool.name)).toEqual(["desktop_screenshot", "desktop_action"]);
      const result = await tools[0].execute("shot", {});
      expect(result.isError).not.toBe(true);
      expect(result.content.some((item) => item.type === "image")).toBe(true);
      expect(result.content.some((item) => item.type === "text" && item.text.includes(dir))).toBe(true);
    } finally { await session.dispose(); hob.close(); }
  });

  it("未开启云桌面时不创建本地连接", async () => {
    const hob = makeHob();
    const session = new DesktopToolSession(hob.runtime, "hob");
    try { await expect(session.preparePlaywrightCli()).rejects.toThrow("云桌面没有开启"); }
    finally { await session.dispose(); hob.close(); }
  });

  it("每个会话有独立的本地端点，转发时只把云桌面令牌留在 Hob 内", async () => {
    const hob = makeHob();
    hob.runtime.settings.setDesktop(hob.runtime.settings.get().revision, { url: "http://127.0.0.1:1", enabled: true });
    writeSecret(hob.home, "desktop:token", "cloud-token");
    const first = new DesktopToolSession(hob.runtime, "hob", false, "第一件事");
    const second = new DesktopToolSession(hob.runtime, "hob", false, "第二件事");
    const other = new DesktopToolSession(hob.runtime, "other", false, "另一位助手");
    try {
      const firstEnv = await first.preparePlaywrightCli();
      const secondEnv = await second.preparePlaywrightCli();
      const otherEnv = await other.preparePlaywrightCli();
      expect(firstEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp\//);
      expect(firstEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT).not.toBe(secondEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT);
      expect(firstEnv.PLAYWRIGHT_CLI_SESSION).not.toBe(secondEnv.PLAYWRIGHT_CLI_SESSION);
      expect(firstEnv.PLAYWRIGHT_MCP_CDP_HEADERS).not.toContain("cloud-token");
      expect(firstEnv.HOB_PLAYWRIGHT_CACHE_HOME).toBe(join(hob.home, "cache", "playwright", firstEnv.PLAYWRIGHT_CLI_SESSION));
      expect(firstEnv.HOB_PLAYWRIGHT_CACHE_HOME).not.toBe(secondEnv.HOB_PLAYWRIGHT_CACHE_HOME);
      expect(firstEnv.HOB_PLAYWRIGHT_CACHE_HOME).not.toBe(otherEnv.HOB_PLAYWRIGHT_CACHE_HOME);
      expect(browserShellEnv({ XDG_CACHE_HOME: "/tmp/ordinary-cache" }, firstEnv).XDG_CACHE_HOME).toBe("/tmp/ordinary-cache");
      expect(firstEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT).not.toBe(otherEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT);
    } finally {
      await first.dispose();
      await second.dispose();
      await other.dispose();
      hob.close();
    }
  });

  it("通过本地转发连接云桌面并在用户接管时断开", async () => {
    const remote = createServer((request, response) => {
      if (request.url === "/api/health") {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (request.url === "/api/screens/hob/browser/start") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ cdp: "/cdp/hob" }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const remoteWss = new WebSocketServer({ server: remote, path: "/cdp/hob" });
    let cloudAuthorization = "";
    remoteWss.on("connection", (socket, request) => {
      cloudAuthorization = request.headers.authorization ?? "";
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    remote.listen(0, "127.0.0.1");
    await once(remote, "listening");
    const hob = makeHob();
    const session = new DesktopToolSession(hob.runtime, "hob", false, "查资料");
    const router = new DesktopToolSession(hob.runtime, "hob", false, undefined, true);
    try {
      const port = (remote.address() as AddressInfo).port;
      hob.runtime.settings.setDesktop(hob.runtime.settings.get().revision, { url: `http://127.0.0.1:${port}`, enabled: true });
      writeSecret(hob.home, "desktop:token", "cloud-token");
      const env = await session.preparePlaywrightCli();
      const routerEnv = await router.preparePlaywrightCli();
      const status = () => fetch(routerEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT.replace(/^ws:/, "http:"), { headers: { Authorization: routerEnv.PLAYWRIGHT_MCP_CDP_HEADERS.slice("Authorization: ".length) } });
      const client = new WebSocket(env.PLAYWRIGHT_MCP_CDP_ENDPOINT, { headers: { Authorization: env.PLAYWRIGHT_MCP_CDP_HEADERS.slice("Authorization: ".length) } });
      await once(client, "open");
      client.send("cdp-message");
      const [message] = await once(client, "message");
      expect(String(message)).toBe("cdp-message");
      expect(cloudAuthorization).toBe("Bearer cloud-token");
      expect(env.PLAYWRIGHT_MCP_CDP_HEADERS).not.toContain("cloud-token");
      const busy = await status();
      expect(busy.status).toBe(409);
      expect(await busy.text()).toContain("任务「查资料」正在用浏览器");
      const secondClient = new WebSocket(env.PLAYWRIGHT_MCP_CDP_ENDPOINT, { headers: { Authorization: env.PLAYWRIGHT_MCP_CDP_HEADERS.slice("Authorization: ".length) } });
      await once(secondClient, "open");
      const firstClosed = once(client, "close");
      client.close();
      await firstClosed;
      expect(await (await status()).text()).toContain("任务「查资料」正在用浏览器");
      const lateRouter = new DesktopToolSession(hob.runtime, "hob", false, undefined, true);
      try { await expect(lateRouter.preparePlaywrightCli()).resolves.toBeDefined(); }
      finally { await lateRouter.dispose(); }
      const close = once(secondClient, "close");
      const owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      hob.runtime.desktopControl.connected(owner, "hob");
      hob.runtime.desktopControl.take(owner, "hob");
      await close;
      const taken = await status();
      expect(await taken.text()).toContain("用户正在操作云桌面");
      hob.runtime.desktopControl.release(owner, "hob");
      const again = new WebSocket(env.PLAYWRIGHT_MCP_CDP_ENDPOINT, { headers: { Authorization: env.PLAYWRIGHT_MCP_CDP_HEADERS.slice("Authorization: ".length) } });
      await once(again, "open");
      const ended = once(again, "close");
      await session.dispose();
      await ended;
    } finally {
      await session.dispose();
      await router.dispose();
      remoteWss.close();
      for (const socket of remoteWss.clients) socket.terminate();
      await new Promise<void>((resolve) => remote.close(() => resolve()));
      hob.close();
    }
  });
});
