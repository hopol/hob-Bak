// login 工具（填写登录）和 fill_new_password 的端到端：真 Chrome（假云桌面转它的调试口）、假网站、假的密码管理插件、假模型。
// 每条路径都看网页上真的填对了（提交后页面显示的结果），再在整个 HOB_HOME、推给前端的事件和日志里搜不到密码。
// 没有 Chrome（找不到 google-chrome，也没设 HOB_TEST_CHROME）就整组跳过。
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Approval, HobEvent } from "../../shared/types.ts";
import { answerApproval } from "../src/actions.ts";
import { DesktopToolSession } from "../src/desktop-tools.ts";
import { readLoginAuto } from "../src/login-auto.ts";
import { ensurePlaywrightCli } from "../src/playwright-cli.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";
import { startFakeDesktopd } from "./fixtures/fake-desktopd.mjs";
import { startFakeSites } from "./fixtures/fake-sites.mjs";

const chromePath = process.env.HOB_TEST_CHROME ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));
const HOSTS = ["forum.example.net", "login.example.net", "shop.example.com", "books.example.com", "forum-example.net.verify-login.io", "wiki.example.org", "mail.example.org", "club.example.org", "notes.example.org", "cloud.example.org", "chat.example.org", "bank.example.org"];
const PASSWORDS = { forum: "forum-secret-7QhV", community: "reader-secret-7QhV", book: "book-secret-7QhV", alt: "alt-secret-7QhV", entry: "EntryCard#257", club: "ClubCard#257", mail: "MailCard#257", shop: "ShopEntry#257" };
const NO_FIELDS = (url: string) => `当前页面（${url}）上没有账号密码框。先打开登录表单再调 login；这个网站只能用扫码、第三方账号这类方式登录的话，再调一次 login，Hob 会请用户自己登录。`;
const SELF = (site: string) => `已请用户在云桌面里自己登录 ${site}，这一轮先到这里；用户登录完会告诉你。`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
  });
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => { const path = join(root, name); return statSync(path).isDirectory() ? walk(path) : statSync(path).size < 5 * 1024 * 1024 ? [path] : []; });
}

const describeE2E = chromePath ? describe : describe.skip;

describeE2E("login / 新密码端到端（真 Chrome）", () => {
  let hob: TestHob;
  let chrome: ChildProcess | undefined;
  let desktopd: Awaited<ReturnType<typeof startFakeDesktopd>>;
  let sites: Awaited<ReturnType<typeof startFakeSites>>;
  let harness: Browser;
  let page: Page;
  let tmp: string;
  let vaultPath: string;
  let logPath: string;
  let failPath: string;
  const events: HobEvent[] = [];
  const logs: string[] = [];
  let secrets: string[] = [];

  const vault = () => JSON.parse(readFileSync(vaultPath, "utf8")) as { folders: { id: string; name: string }[]; items: { id: string; name: string; login: { username: string; password: string; uris: { uri: string }[] } }[] };
  const fixtureCalls = () => existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [];
  const toolResults = (toolName: string) => hob.runtime.router.sessionEntries("hob").flatMap((entry) => (entry as { message?: { role?: string; toolName?: string; content?: unknown; isError?: boolean } }).message?.role === "toolResult" && (entry as { message: { toolName?: string } }).message.toolName === toolName ? [entry as { message: { content: { type: string; text?: string }[]; isError?: boolean } }] : []);
  const lastResult = (toolName: string) => { const found = toolResults(toolName).at(-1); if (!found) throw new Error(`没有 ${toolName} 的工具结果`); return { text: found.message.content.map((part) => part.text ?? "").join("\n"), isError: Boolean(found.message.isError) }; };
  const approvals = () => hob.runtime.store.approvals().filter((approval) => approval.login);
  const pending = () => approvals().filter((approval) => approval.status === "pending");
  const goto = async (url: string) => { await page.goto(url); await page.waitForLoadState("domcontentloaded"); };
  const inputs = () => page.locator("input:not([type=hidden])").evaluateAll((elements) => elements.map((element) => { const input = element as HTMLInputElement; return { type: input.type, name: input.name, autocomplete: input.autocomplete, value: input.value }; }));
  const submit = async () => { await page.locator('button[type="submit"], button:not([type])').first().click(); await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(200); return { url: page.url(), text: await page.locator("body").innerText() }; };
  const eventText = (messages: unknown[]): string => {
    const last = (messages as Array<{ role?: string; content?: unknown }>).filter((message) => message.role === "user").at(-1);
    const content = last?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string })?.text ?? "").join("") : "";
    return text.slice(text.lastIndexOf("[hob-event]")).replace(/^\[hob-event\]\s*/, "");
  };
  const turn = async (toolName: string, args: Record<string, unknown>, userText = "帮我登录") => {
    hob.faux.setResponses([call(toolName, args), text("好的。")]);
    await hob.runtime.router.send("hob", { text: userText });
    await hob.runtime.router.waitIdle("hob");
    return lastResult(toolName);
  };
  const login = (args: Record<string, unknown>, userText?: string) => turn("login", { reason: "看里面的内容要先登录", ...args }, userText);
  /** 用户在卡片上作答（服务端 API）：等模型真的看到 [hob-event] 那一轮 */
  const approve = async (body: { key: "A" | "B" | "C"; candidateId?: string; folder?: string; username?: string; password?: string; provider?: string }) => {
    const approval = pending().at(-1);
    if (!approval) throw new Error("没有待答复的卡");
    const before = logs.length;
    hob.faux.setResponses([(context: { messages: unknown[] }) => { logs.push(JSON.stringify(context.messages)); return text("收到，我来点登录。"); }]);
    const response = await answerApproval(hob.runtime, approval.id, body);
    expect(response.status).toBe(200);
    await waitFor(() => logs.length > before, 15_000);
    await hob.runtime.router.waitIdle("hob");
    const seen = JSON.parse(logs.at(-1)!) as unknown[];
    return { response, approval: hob.runtime.store.approval(approval.id)!, event: eventText(seen) };
  };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "hob-fill-e2e-"));
    const profile = join(tmp, "chrome-profile");
    vaultPath = join(tmp, "vault.json");
    logPath = join(tmp, "fixture-calls.log");
    failPath = join(tmp, "fail-at.txt");
    const [sitesPort, cdpPort, desktopPort] = await Promise.all([freePort(), freePort(), freePort()]);
    sites = await startFakeSites({ port: sitesPort, expected: { forum: { username: "lin@example.com", password: PASSWORDS.forum }, community: { username: "reader@example.net", password: PASSWORDS.community }, books: { username: "lin@example.com", password: PASSWORDS.book } } });
    writeFileSync(vaultPath, `${JSON.stringify({
      folders: [{ id: "folder-forum", name: "论坛账号" }],
      items: [
        { id: "login-forum", type: 1, name: "Example 论坛", folderId: "folder-forum", login: { username: "lin@example.com", password: PASSWORDS.forum, uris: [{ uri: "https://forum.example.net/" }] } },
        { id: "login-forum-alt", type: 1, name: "Example 论坛（小号）", folderId: "folder-forum", login: { username: "lin.alt@example.com", password: PASSWORDS.alt, uris: [{ uri: "https://forum.example.net/" }] } },
        { id: "login-community", type: 1, name: "Example 社区", folderId: "folder-forum", login: { username: "reader@example.net", password: PASSWORDS.community, uris: [{ uri: "https://example.net/" }] } },
        { id: "login-book", type: 1, name: "二手书市", login: { username: "lin@example.com", password: PASSWORDS.book, uris: [{ uri: "https://books.example.com/" }] } },
      ],
    }, null, 2)}\n`);
    chrome = spawn(chromePath!, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, `--host-resolver-rules=${HOSTS.map((host) => `MAP ${host} 127.0.0.1:${sitesPort}`).join(", ")}`, "about:blank"], { stdio: "ignore", detached: true });
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok; } catch { return false; } }, 15_000);
    const token = "fake-desktop-token";
    desktopd = await startFakeDesktopd({ port: desktopPort, cdp: `http://127.0.0.1:${cdpPort}`, token });
    process.env.HOB_DESKTOP_URL = desktopd.url;
    process.env.HOB_DESKTOP_TOKEN = token;
    hob = makeHob({}, { memory: "off" });
    const host = hob.runtime.plugins;
    host.store.addCustom("vault", { command: process.execPath, args: [join(import.meta.dirname, "fixtures", "credentials-fixture.mjs")], env: { HOB_FAKE_VAULT: vaultPath, HOB_FAKE_LOG: logPath, HOB_FAKE_FAIL_FILE: failPath } });
    const manifestPath = join(hob.home, "plugins", "vault", "plugin.json");
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), displayName: "测试密码库" }, null, 2));
    await host.start();
    expect(host.credentialProviders("hob").map((provider) => provider.role).sort()).toEqual(["generate", "list", "save", "secret"]);
    for (const level of ["log", "error", "warn", "info"] as const) vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => { logs.push(parts.map((part) => (part instanceof Error ? part.stack ?? part.message : typeof part === "string" ? part : JSON.stringify(part))).join(" ")); });
    hob.runtime.bus.subscribe((event) => events.push(event));
    harness = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    page = harness.contexts()[0]!.pages()[0]!;
  }, 60_000);

  afterAll(async () => {
    delete process.env.HOB_DESKTOP_URL;
    delete process.env.HOB_DESKTOP_TOKEN;
    vi.restoreAllMocks();
    await harness?.close().catch(() => {});
    await hob?.runtime.plugins.close();
    hob?.close();
    await desktopd?.close();
    await sites?.close();
    // 自己起的 Chrome 整个进程组一起停（渲染进程还会往 profile 里写一会儿），临时目录删不干净也不算测试失败
    if (chrome && chrome.pid) {
      const exited = new Promise((resolve) => chrome!.once("exit", resolve));
      try { process.kill(-chrome.pid, "SIGTERM"); } catch { chrome.kill("SIGTERM"); }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn(`临时目录没删干净：${tmp}`); }
  }, 60_000);

  const expectNoSecrets = () => {
    const haystack = [...walk(hob.home).map((path) => readFileSync(path, "utf8")), JSON.stringify(events), ...logs].join("\n");
    for (const secret of secrets.filter(Boolean)) expect(haystack, `密码出现在 HOB_HOME、事件或日志里：${secret.slice(0, 4)}…`).not.toContain(secret);
  };
  const itemByName = (name: string) => vault().items.filter((item) => item.name === name);

  it("一步登录：批准后填好账号和密码，网站收到正确的值，密码不落盘", async () => {
    await goto("http://forum.example.net/login");
    const result = await login({ site: "forum.example.net" }, "去 Example 论坛帮我看看有没有新私信");
    expect(result.text).toBe("已请用户批准在 forum.example.net 填写登录，这一轮先到这里；用户批准后 Hob 会填好并告诉你。");
    const [approval] = pending();
    expect(approval).toMatchObject({ title: "在 forum.example.net 登录", detail: "Hob 从 测试密码库 取出密码，直接填进登录页，助手看不到。", options: [{ key: "A", label: "不允许" }, { key: "B", label: "这次允许" }, { key: "C", label: "这个网站以后都允许", always: true }], login: { site: "forum.example.net", reason: "看里面的内容要先登录", fillLogin: { state: "pending", candidates: [{ provider: "vault", id: "login-forum", username: "lin@example.com", folder: "论坛账号" }, { provider: "vault", id: "login-forum-alt", username: "lin.alt@example.com", folder: "论坛账号" }, { provider: "vault", id: "login-community", username: "reader@example.net" }] } } });
    expect(JSON.stringify(approval)).not.toContain(PASSWORDS.forum);
    expect((await inputs()).every((input) => input.value === "")).toBe(true);

    const { approval: answered, event } = await approve({ key: "B", candidateId: "vault:login-forum" });
    expect(answered).toMatchObject({ status: "answered", chosen: "B", login: { fillLogin: { state: "filled", result: "已登录 · 这次允许", chosenId: "vault:login-forum" } } });
    expect(event).toContain("用户允许了在 forum.example.net 登录，Hob 已填好 lin@example.com 的账号和密码，接下来点登录按钮。");
    expect(await inputs()).toMatchObject([{ name: "email", value: "lin@example.com" }, { name: "password", value: PASSWORDS.forum }]);
    const submitted = await submit();
    expect(submitted.url).toBe("http://forum.example.net/inbox");
    expect(submitted.text).toContain("新私信：2 条");
    expect(sites.received.at(-1)).toMatchObject({ kind: "login", usernameOk: true, passwordOk: true });
    expect(readFileSync(join(hob.home, "assistants", "hob", "router.jsonl"), "utf8")).not.toContain(PASSWORDS.forum);
    expectNoSecrets();
  });

  it("两步登录：先填用户名，十分钟内第二次不再问，填好密码", async () => {
    await goto("http://login.example.net/");
    const first = await login({ site: "Example 社区" }, "看看 Example 社区有没有新私信");
    expect(first.text).toBe("已请用户批准在 login.example.net 填写登录，这一轮先到这里；用户批准后 Hob 会填好并告诉你。");
    const { approval, event } = await approve({ key: "B" });
    expect(approval.login?.fillLogin).toMatchObject({ state: "filled", result: "已填好用户名 reader@example.net" });
    expect(event).toContain("用户允许了在 login.example.net 登录，Hob 已填好用户名 reader@example.net，点下一步后再调一次 login 填密码。");
    expect(await inputs()).toMatchObject([{ name: "user", value: "reader@example.net" }]);
    await submit();
    expect(await page.locator('input[name="password"]').count()).toBe(1);

    const before = approvals().length;
    const second = await login({ site: "login.example.net" });
    expect(second.isError).toBe(false);
    expect(second.text).toBe("已在 login.example.net 填好 reader@example.net 的账号和密码，接下来点登录按钮。");
    expect(approvals().length).toBe(before);
    expect(await inputs()).toMatchObject([{ name: "password", value: PASSWORDS.community }]);
    const submitted = await submit();
    expect(submitted.text).toContain("新私信：1 条");
    expect(sites.received.at(-1)).toMatchObject({ kind: "login", usernameOk: true, passwordOk: true });
    expectNoSecrets();
  });

  it("以后都允许：记下自动填写，下次直接填，不再出卡", async () => {
    await goto("http://forum.example.net/login");
    await login({ site: "forum.example.net" });
    const before = approvals().length;
    await approve({ key: "C", candidateId: "vault:login-forum" });
    expect(readLoginAuto(hob.home)).toEqual([expect.objectContaining({ provider: "vault", itemId: "login-forum", host: "forum.example.net", username: "lin@example.com" })]);
    expect(approvals().length).toBe(before);

    await goto("http://forum.example.net/login");
    expect((await inputs()).every((input) => input.value === "")).toBe(true);
    const direct = await login({ site: "forum.example.net" });
    expect(direct.text).toBe("已在 forum.example.net 填好 lin@example.com 的账号和密码，接下来点登录按钮。");
    expect(approvals().length).toBe(before);
    expect(await inputs()).toMatchObject([{ value: "lin@example.com" }, { value: PASSWORDS.forum }]);
    expectNoSecrets();
    // 后面的场景还要在论坛上出批准卡：把自动填写清掉
    rmSync(join(hob.home, "system", "login-auto.json"));
  });

  // 有几个标签页时取「正在看的那个」（document.hasFocus / visibilityState）在 headless Chrome 里测不了：所有标签页都报 visible、hasFocus 也不可靠，
  // 这里始终保持只有一个标签页；真浏览器里的行为靠 currentPage 的规则（前台标签页 → 可见的 → 最后一个）
  it("助手用 playwright-cli 看页面时，输出和快照文件里看不到 Hob 填的密码", async () => {
    // 助手自己的浏览器命令行：快照会把密码框的值带出来，Hob 把它填过的密码从输出和 .playwright-cli 的快照文件里抹掉
    ensurePlaywrightCli(join(hob.home, "system", "engine"));
    const launcher = join(hob.home, "system", "engine", "bin", "playwright-cli");
    const work = join(tmp, "cli-work");
    mkdirSync(work, { recursive: true });
    const session = new DesktopToolSession(hob.runtime, "hob");
    try {
      const env = await session.preparePlaywrightCli();
      // 要用异步的 execFile：同步的 execFileSync 会卡住这个进程的事件循环，转发入口（就在这个进程里）就没法应答启动器的检查
      const execFileAsync = promisify(execFile);
      const run = async (args: string[]) => {
        try {
          return (await execFileAsync(process.execPath, [launcher, ...args], { cwd: work, env: { ...process.env, ...env }, encoding: "utf8", timeout: 90_000 })).stdout;
        } catch (error) {
          throw new Error(`playwright-cli ${args.join(" ")} 失败：${error instanceof Error ? `${error.message}\n${String((error as { stderr?: string }).stderr ?? '').slice(0, 2000)}` : String(error)}`);
        }
      };
      // 照助手的真实顺序：先用命令行连上浏览器、打开登录页，再让 Hob 填，然后命令行看页面
      await run(["open"]);
      await run(["goto", "http://forum.example.net/login"]);
      await login({ site: "forum.example.net" });
      await approve({ key: "B", candidateId: "vault:login-forum" });
      const snapshot = await run(["snapshot"]);
      expect(snapshot).toContain("••••");
      expect(snapshot).not.toContain(PASSWORDS.forum);
      // 存心去翻的也翻不到：读输入框的值同样经过输出
      expect(await run(["eval", "document.querySelector('input[type=password]').value"])).not.toContain(PASSWORDS.forum);
      for (const name of readdirSync(join(work, ".playwright-cli"))) {
        if (!/\.ya?ml$/.test(name)) continue;
        expect(readFileSync(join(work, ".playwright-cli", name), "utf8")).not.toContain(PASSWORDS.forum);
      }
      // 别的值、没填过的东西照原样输出
      expect(await run(["eval", "document.querySelector('input[type=email]').value"])).toContain("lin@example.com");
    } finally {
      await session.dispose();
    }
    expectNoSecrets();
  });

  it("仿冒页：对不上就不填，不出批准卡，也不去密码库取密码", async () => {
    const secretCalls = fixtureCalls().filter((name) => name === "credentials_secret").length;
    await goto("http://forum-example.net.verify-login.io/login");
    const result = await login({ site: "forum.example.net" }, "邮件里说账号要重新验证，帮我去这个页面验证一下");
    expect(result.text).toBe("没有填写：当前页面是 forum-example.net.verify-login.io，和密码管理器里保存的网址（forum.example.net、example.net）对不上，可能是仿冒的页面。把情况告诉用户。");
    expect(pending()).toHaveLength(0);
    const [card] = approvals().filter((approval) => approval.login?.fillLogin?.state === "mismatch");
    expect(card).toMatchObject({ title: "没有填写密码", status: "answered", login: { site: "forum.example.net", reason: "看里面的内容要先登录", fillLogin: { host: "forum-example.net.verify-login.io", currentHost: "forum-example.net.verify-login.io" } } });
    expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "question" && item.approvalId === card.id)).toBe(true);
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
    expect(fixtureCalls().filter((name) => name === "credentials_secret").length).toBe(secretCalls);
    expectNoSecrets();
  });

  it("批准期间页面跳走：不填，告诉助手没填上", async () => {
    await goto("http://forum.example.net/login");
    await login({ site: "forum.example.net" });
    const secretCalls = fixtureCalls().filter((name) => name === "credentials_secret").length;
    await goto("http://forum-example.net.verify-login.io/login");
    const { approval, event } = await approve({ key: "B", candidateId: "vault:login-forum" });
    expect(approval.login?.fillLogin).toMatchObject({ state: "failed", result: "没有填写：当前页面是 forum-example.net.verify-login.io，和保存的网址对不上，可能是仿冒的页面。" });
    expect(event).toContain("用户允许了在 forum.example.net 登录，但没有填上：当前页面是 forum-example.net.verify-login.io，和保存的网址对不上，可能是仿冒的页面。");
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
    expect(fixtureCalls().filter((name) => name === "credentials_secret").length).toBe(secretCalls);
    expectNoSecrets();
  });

  it("密码库里没有账号、页面有登录框：出录入卡，用户填一次后 Hob 存进密码库再填进页面，密码不落盘", async () => {
    await goto("http://wiki.example.org/login");
    const result = await login({ site: "wiki.example.org" }, "帮我登录 Example 百科");
    expect(result.text).toBe("密码管理器里没有 wiki.example.org 的账号，已请用户在卡片上填写，这一轮先到这里；用户填好后 Hob 会存进密码管理器、填进页面并告诉你。");
    const [approval] = pending();
    expect(approval).toMatchObject({ title: "在 wiki.example.org 登录", detail: "密码管理器里还没有这个网站的账号。在这里填一次，Hob 存进测试密码库再填进登录页，助手看不到。", options: [{ key: "A", label: "不登录" }, { key: "B", label: "保存并登录" }], login: { site: "wiki.example.org", reason: "看里面的内容要先登录", entry: { host: "wiki.example.org", providers: [{ provider: "vault", providerName: "测试密码库" }], state: "pending" } } });
    expect(approval.login?.entry?.account).toBeUndefined();
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);

    secrets.push(PASSWORDS.entry);
    const { approval: answered, event } = await approve({ key: "B", username: "wikier@example.org", password: PASSWORDS.entry });
    expect(answered).toMatchObject({ status: "answered", chosen: "B", login: { entry: { state: "filled", result: "已填好", provider: "vault", username: "wikier@example.org" } } });
    expect(event).toBe("用户在卡片上填了 wiki.example.org 的账号，Hob 已存进测试密码库，并填好 wikier@example.org 的账号和密码，接下来点登录按钮。");
    const [item] = itemByName("wiki.example.org");
    expect(item.login).toMatchObject({ username: "wikier@example.org", password: PASSWORDS.entry, uris: [{ uri: "https://wiki.example.org" }] });
    expect(await inputs()).toMatchObject([{ name: "name", value: "wikier@example.org" }, { name: "password", value: PASSWORDS.entry }]);
    // 存进去的那一条以后就是正常候选：再调一次走批准卡
    await goto("http://wiki.example.org/login");
    expect((await login({ site: "wiki.example.org" })).text).toBe("已请用户批准在 wiki.example.org 填写登录，这一轮先到这里；用户批准后 Hob 会填好并告诉你。");
    expect(pending().at(-1)).toMatchObject({ login: { fillLogin: { candidates: [{ provider: "vault", username: "wikier@example.org", uris: ["https://wiki.example.org"] }] } } });
    await approve({ key: "A" });
    expect(JSON.stringify(approvals())).not.toContain(PASSWORDS.entry);
    expectNoSecrets();
  });

  it("录入卡的两步登录：account 预填用户名，填好用户名并记 10 分钟，第二次直接填密码", async () => {
    await goto("http://club.example.org/");
    const result = await login({ site: "club.example.org", account: "reader-club" }, "看看读书会这周读什么");
    expect(result.text).toBe("密码管理器里没有 club.example.org 的账号，已请用户在卡片上填写，这一轮先到这里；用户填好后 Hob 会存进密码管理器、填进页面并告诉你。");
    expect(pending().at(-1)).toMatchObject({ login: { entry: { host: "club.example.org", account: "reader-club" } } });
    secrets.push(PASSWORDS.club);
    const { approval, event } = await approve({ key: "B", username: "reader-club", password: PASSWORDS.club });
    expect(approval.login?.entry).toMatchObject({ state: "filled", result: "已填好用户名", username: "reader-club" });
    expect(event).toBe("用户在卡片上填了 club.example.org 的账号，Hob 已存进测试密码库，并填好用户名 reader-club，点下一步后再调一次 login 填密码。");
    expect(await inputs()).toMatchObject([{ name: "nick", value: "reader-club" }]);
    await submit();
    expect(await page.locator('input[name="password"]').count()).toBe(1);
    const before = approvals().length;
    expect((await login({ site: "club.example.org" })).text).toBe("已在 club.example.org 填好 reader-club 的账号和密码，接下来点登录按钮。");
    expect(approvals().length).toBe(before);
    expect(await inputs()).toMatchObject([{ name: "password", value: PASSWORDS.club }]);
    expect((await submit()).text).toContain("本周共读");
    expectNoSecrets();
  });

  it("录入卡点「不登录」：什么都不存、什么都不填", async () => {
    await goto("http://mail.example.org/login");
    await login({ site: "mail.example.org" }, "帮我收一下邮件");
    const before = vault().items.length;
    const { approval, event } = await approve({ key: "A" });
    expect(approval.login?.entry).toMatchObject({ state: "rejected", result: "没有登录" });
    expect(event).toBe("用户没有登录 mail.example.org。");
    expect(vault().items.length).toBe(before);
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
  });

  it("录入卡保存失败：卡上写原因、保持可填、不回模型；再来一次能存能填", async () => {
    await goto("http://mail.example.org/login");
    await login({ site: "mail.example.org" });
    const approval = pending().at(-1)!;
    const before = logs.length;
    writeFileSync(failPath, "save");
    const failed = await answerApproval(hob.runtime, approval.id, { key: "B", username: "mailer@example.org", password: PASSWORDS.mail });
    expect(failed.status).toBe(400);
    expect(failed.body).toEqual({ error: "测试密码库 没有保存：密码库拒绝保存" });
    expect(hob.runtime.store.approval(approval.id)).toMatchObject({ status: "pending", login: { entry: { state: "pending", error: "测试密码库 没有保存：密码库拒绝保存" } } });
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logs.length).toBe(before);
    expect(vault().items.some((item) => item.login.username === "mailer@example.org")).toBe(false);
    expectNoSecrets();
    rmSync(failPath);

    secrets.push(PASSWORDS.mail);
    const { approval: answered, event } = await approve({ key: "B", username: "mailer@example.org", password: PASSWORDS.mail });
    expect(answered.login?.entry).toMatchObject({ state: "filled", result: "已填好", username: "mailer@example.org" });
    expect(event).toBe("用户在卡片上填了 mail.example.org 的账号，Hob 已存进测试密码库，并填好 mailer@example.org 的账号和密码，接下来点登录按钮。");
    const submitted = await submit();
    expect(submitted.url).toBe("http://mail.example.org/inbox");
    expectNoSecrets();
  });

  it("录入卡存好但没填上（用户填卡期间页面跳走）：明说已存进哪、为什么没填", async () => {
    await goto("http://cloud.example.org/login");
    await login({ site: "cloud.example.org" }, "帮我看看网盘里有什么");
    await goto("http://forum.example.net/about");
    secrets.push(PASSWORDS.shop);
    const { approval, event } = await approve({ key: "B", username: "shopper@example.org", password: PASSWORDS.shop });
    expect(approval.login?.entry).toMatchObject({ state: "failed", username: "shopper@example.org", provider: "vault" });
    expect(approval.login?.entry?.result).toContain("当前页面是 forum.example.net，和保存的网址对不上，可能是仿冒的页面。");
    expect(event).toContain("用户在卡片上填了 cloud.example.org 的账号，Hob 已存进测试密码库，但没有填上：当前页面是 forum.example.net，和保存的网址对不上，可能是仿冒的页面。");
    expect(itemByName("cloud.example.org")[0]?.login).toMatchObject({ username: "shopper@example.org", password: PASSWORDS.shop });
    expect(await inputs()).toEqual([]);
    expectNoSecrets();
  });

  it("批准卡上点「我自己登录」：同一张卡换成自己登录卡的样子，不回模型；用户登完才回一句", async () => {
    await goto("http://forum.example.net/login");
    await login({ site: "forum.example.net" });
    const approval = pending().at(-1)!;
    const before = logs.length;
    const switched = await answerApproval(hob.runtime, approval.id, { self: true });
    expect(switched.status).toBe(200);
    expect(hob.runtime.store.approval(approval.id)).toMatchObject({ status: "pending", title: "在 forum.example.net 登录", login: { fillLogin: { state: "self" } } });
    expect(pending()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logs.length).toBe(before);
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
    // 换成自己登录卡以后只认「已登录」
    expect((await answerApproval(hob.runtime, approval.id, { key: "B", candidateId: "vault:login-forum" })).status).toBe(400);
    const { approval: answered, event } = await approve({ key: "A" });
    expect(answered).toMatchObject({ status: "answered", chosen: "A", login: { fillLogin: { state: "self" } } });
    expect(event).toBe("用户已在「forum.example.net」完成登录。");
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
  });

  it("录入卡上点「我自己登录」：同样换成自己登录卡，不存不填", async () => {
    await goto("http://notes.example.org/login");
    await login({ site: "notes.example.org" }, "打开我的笔记");
    const approval = pending().at(-1)!;
    const before = vault().items.length;
    expect((await answerApproval(hob.runtime, approval.id, { self: true })).status).toBe(200);
    expect(hob.runtime.store.approval(approval.id)).toMatchObject({ status: "pending", login: { entry: { state: "self" } } });
    const { approval: answered, event } = await approve({ key: "A" });
    expect(answered).toMatchObject({ status: "answered", login: { entry: { state: "self" } } });
    expect(event).toBe("用户已在「notes.example.org」完成登录。");
    expect(vault().items.length).toBe(before);
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
  });

  it("登录后出验证码页：直接出自己登录卡，reason 显示在卡上；不取密码、不填", async () => {
    await goto("http://bank.example.org/login");
    await page.locator('input[name="user"]').fill("lin@example.com");
    await page.locator('input[name="password"]').fill("anything");
    await submit();
    expect(page.url()).toBe("http://bank.example.org/verify");
    const secretCalls = fixtureCalls().filter((name) => name === "credentials_secret").length;
    const result = await login({ site: "bank.example.org" }, "帮我看看银行卡余额");
    expect(result.text).toBe(SELF("bank.example.org"));
    expect(pending()).toHaveLength(1);
    expect(pending().at(-1)).toMatchObject({ title: "需要登录：bank.example.org", detail: "看里面的内容要先登录", options: [{ key: "A", label: "已登录" }], login: { site: "bank.example.org", reason: "看里面的内容要先登录" } });
    expect(pending().at(-1)?.login?.fillLogin).toBeUndefined();
    const { event } = await approve({ key: "A" });
    expect(event).toBe("用户已在「bank.example.org」完成登录。");
    expect(fixtureCalls().filter((name) => name === "credentials_secret").length).toBe(secretCalls);
    expect(await inputs()).toMatchObject([{ name: "otp", value: "" }]);
  });

  it("用户说要自己登录（self）：存了账号也直接出自己登录卡，不取密码、不填", async () => {
    await goto("http://forum.example.net/login");
    const secretCalls = fixtureCalls().filter((name) => name === "credentials_secret").length;
    const result = await login({ site: "forum.example.net", self: true }, "用户要自己登录论坛");
    expect(result.text).toBe(SELF("forum.example.net"));
    expect(pending().at(-1)).toMatchObject({ title: "需要登录：forum.example.net", options: [{ key: "A", label: "已登录" }], login: { site: "forum.example.net" } });
    expect(pending().at(-1)?.login?.fillLogin).toBeUndefined();
    const { event } = await approve({ key: "A" });
    expect(event).toBe("用户已在「forum.example.net」完成登录。");
    expect(fixtureCalls().filter((name) => name === "credentials_secret").length).toBe(secretCalls);
    expect((await inputs()).every((input) => input.value === "")).toBe(true);
  });

  it("只有第三方登录按钮的页面：第一次回「没有登录框」，第二次出自己登录卡；不去点第三方按钮", async () => {
    await goto("http://chat.example.org/login");
    const first = await login({ site: "chat.example.org" }, "帮我看看聊天里有没有新消息");
    expect(first.text).toBe(NO_FIELDS("http://chat.example.org/login"));
    expect(pending()).toHaveLength(0);
    const second = await login({ site: "chat.example.org" });
    expect(second.text).toBe(SELF("chat.example.org"));
    expect(pending()).toHaveLength(1);
    expect(pending().at(-1)).toMatchObject({ title: "需要登录：chat.example.org", options: [{ key: "A", label: "已登录" }] });
    await approve({ key: "A" });
    expect(sites.received.filter((entry) => entry.kind === "oauth")).toHaveLength(0);
    expect(page.url()).toBe("http://chat.example.org/login");
  });

  it("存了账号但页面上没有登录框（只有搜索框）：先回「没有登录框」，10 分钟内再来就出自己登录卡", async () => {
    await goto("http://forum.example.net/about?search=1");
    const first = await login({ site: "forum.example.net" });
    expect(first.text).toBe(NO_FIELDS("http://forum.example.net/about?search=1"));
    expect(pending()).toHaveLength(0);
    const second = await login({ site: "forum.example.net" });
    expect(second.text).toBe(SELF("forum.example.net"));
    expect(pending().at(-1)).toMatchObject({ title: "需要登录：forum.example.net", options: [{ key: "A", label: "已登录" }] });
    await approve({ key: "A" });
  });

  it("任务里调 login：批准卡交给助手，用户在卡上批准后填好，答复回到任务", async () => {
    await goto("http://forum.example.net/login");
    const relay = vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
    try {
      hob.faux.setResponses([call("login", { site: "forum.example.net", reason: "看私信要先登录" }), call("report", { outcome: "done", result: "已收到答复" })]);
      const job = await hob.runtime.jobs.start("hob", { title: "看论坛私信", instruction: "登录后看有多少私信" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "waiting", 5000);
      const approval = hob.runtime.store.approvals().find((item) => item.jobId === job.id)!;
      expect(approval).toMatchObject({ source: "job", status: "pending", title: "在 forum.example.net 登录", options: [{ key: "A", label: "不允许" }, { key: "B", label: "这次允许" }, { key: "C", label: "这个网站以后都允许" }], login: { site: "forum.example.net", reason: "看私信要先登录", fillLogin: { state: "pending" } } });
      expect((await answerApproval(hob.runtime, approval.id, { key: "B", candidateId: "vault:login-forum" })).status).toBe(200);
      await hob.runtime.jobs.waitIdle(5000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
      expect(hob.runtime.store.approval(approval.id)).toMatchObject({ status: "answered", login: { fillLogin: { state: "filled" } } });
      const history = hob.runtime.store.workerFile(job.id);
      const entries = readFileSync(history, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { message?: { role?: string; toolName?: string; content?: { text?: string }[] } });
      expect(entries.find((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "login")?.message?.content[0]?.text).toBe("用户允许了在 forum.example.net 登录，Hob 已填好 lin@example.com 的账号和密码，接下来点登录按钮。");
    } finally { relay.mockRestore(); }
  });

  it("注册：按页面的规则生成，先存进密码库再填，网站收到的密码和库里存的一致", async () => {
    await goto("http://shop.example.com/register");
    const result = await turn("fill_new_password", { username: "lin@example.com", length: 12, characters: ["lowercase", "uppercase", "numbers"], name: "Example 商城" }, "帮我在 Example 商城注册个账号，用 lin@example.com");
    expect(result.text).toBe("已请用户批准在 shop.example.com 注册新账号，这一轮先到这里；用户批准后 Hob 会生成、保存并填好。");
    const [approval] = pending();
    expect(approval).toMatchObject({ title: "在 shop.example.com 注册", options: [{ key: "A", label: "不允许" }, { key: "B", label: "生成并填写" }], login: { fillNewPassword: { mode: "register", username: "lin@example.com", length: 12, characters: ["lowercase", "uppercase", "numbers"], name: "Example 商城", origin: "http://shop.example.com", folders: ["论坛账号"] } } });
    expect(approval.login?.fillNewPassword?.candidate).toBeUndefined();
    expect(JSON.stringify(approval)).not.toMatch(/"password"/);

    const { approval: answered, event } = await approve({ key: "B", folder: "论坛账号" });
    expect(answered.login?.fillNewPassword).toMatchObject({ state: "filled", folder: "论坛账号", result: "已填写，已存进 测试密码库「论坛账号」" });
    const [item] = itemByName("Example 商城");
    secrets.push(item.login.password);
    expect(item.login.password).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(item.login.password).toMatch(/[a-z]/);
    expect(item.login.password).toMatch(/[A-Z]/);
    expect(item.login.password).toMatch(/[0-9]/);
    expect(item.login.uris).toEqual([{ uri: "http://shop.example.com" }]);
    expect(event).toContain(`用户允许了在 shop.example.com 注册新账号，Hob 已生成 12 位新密码（字母和数字），存进 测试密码库「论坛账号」的「Example 商城」，并填好了密码框。`);
    expect(await inputs()).toMatchObject([{ name: "email", value: "lin@example.com" }, { name: "password", value: item.login.password }, { name: "confirm", value: item.login.password }]);
    const submitted = await submit();
    expect(submitted.text).toContain("注册成功");
    expect(sites.received.at(-1)).toMatchObject({ kind: "register", accepted: true, password: item.login.password });
    expectNoSecrets();
  });

  it("网站拒收后再调：更新同一条，不多存，批准卡照样出", async () => {
    await goto("http://shop.example.com/register");
    await turn("fill_new_password", { username: "lin.shopper@example.com", length: 20 }, "再帮我注册一个 Example 商城账号，用 lin.shopper@example.com");
    await approve({ key: "B" });
    const [first] = itemByName("shop.example.com");
    secrets.push(first.login.password);
    expect(first.login.password).toMatch(/[^A-Za-z0-9]/);
    const rejected = await submit();
    expect(rejected.text).toContain("密码不能包含符号");
    expect(sites.received.at(-1)).toMatchObject({ accepted: false, problems: expect.arrayContaining(["密码不能包含符号"]) });

    const again = await turn("fill_new_password", { username: "lin.shopper@example.com", length: 10, characters: ["lowercase", "numbers"], name: "Example 商城（第二个）" });
    expect(again.text).toBe("已请用户批准在 shop.example.com 注册新账号，这一轮先到这里；用户批准后 Hob 会生成、保存并填好。");
    const [approval] = pending();
    expect(approval.login?.fillNewPassword).toMatchObject({ mode: "register", candidate: { id: first.id } });
    expect(approval.login?.fillNewPassword?.folder).toBeUndefined();
    const { event } = await approve({ key: "B" });
    const items = vault().items.filter((item) => item.login.username === "lin.shopper@example.com");
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(first.id);
    secrets.push(items[0]!.login.password);
    expect(items[0]!.login.password).toMatch(/^[a-z0-9]{10}$/);
    expect(event).toContain("用户允许了在 shop.example.com 注册新账号，Hob 已生成 10 位新密码（小写字母、数字）");
    const submitted = await submit();
    expect(submitted.text).toContain("注册成功");
    expectNoSecrets();
  });

  it("改密码：旧密码填第一个框，新密码存回原来那一条并填其余框", async () => {
    await goto("http://books.example.com/account/password");
    const result = await turn("fill_new_password", { username: "lin@example.com", length: 16 }, "把二手书市的密码改一下");
    expect(result.text).toBe("已请用户批准在 books.example.com 修改密码，这一轮先到这里；用户批准后 Hob 会生成、保存并填好。");
    const [approval] = pending();
    expect(approval).toMatchObject({ title: "在 books.example.com 修改密码", login: { fillNewPassword: { mode: "change", candidate: { id: "login-book", username: "lin@example.com" }, folders: ["论坛账号"] } } });
    const { approval: answered, event } = await approve({ key: "B" });
    expect(answered.login?.fillNewPassword).toMatchObject({ state: "filled", result: "已填写，已存进 测试密码库「未分类」" });
    const [item] = itemByName("二手书市");
    expect(item.id).toBe("login-book");
    secrets.push(item.login.password);
    expect(item.login.password).toHaveLength(16);
    expect(event).toContain("用户允许了在 books.example.com 修改密码，Hob 已生成 16 位新密码（含符号），存进 测试密码库「未分类」的「二手书市」，并填好了密码框。");
    expect(await inputs()).toMatchObject([{ name: "old", value: PASSWORDS.book }, { name: "new", value: item.login.password }, { name: "confirm", value: item.login.password }]);
    const submitted = await submit();
    expect(submitted.text).toContain("密码已修改");
    expect(sites.received.at(-1)).toMatchObject({ kind: "change", oldOk: true, same: true, fresh: true });
    expectNoSecrets();
  });

  it("保存成功但填写失败（用户批准期间页面跳走）：明说已存进哪一条，密码不落盘", async () => {
    await goto("http://shop.example.com/register");
    await turn("fill_new_password", { username: "lin.lost@example.com", length: 14, name: "Example 商城（丢三落四）" });
    await goto("http://forum.example.net/about");
    const { approval, event } = await approve({ key: "B" });
    expect(approval.login?.fillNewPassword).toMatchObject({ state: "failed" });
    expect(approval.login?.fillNewPassword?.result).toContain("没有完成：新密码已经存进 测试密码库「Example 商城（丢三落四）」；当前页面是 forum.example.net，和刚才核对的页面对不上，已保存新密码但没有填写。");
    expect(event).toContain("用户允许了在 shop.example.com 注册新账号，但没有完成：新密码已经存进 测试密码库「Example 商城（丢三落四）」；");
    const [item] = itemByName("Example 商城（丢三落四）");
    secrets.push(item.login.password);
    expect(await inputs()).toEqual([]);
    expectNoSecrets();
  });

  it("不允许：什么都不填，密码库不动", async () => {
    await goto("http://forum.example.net/login");
    await login({ site: "forum.example.net" });
    const { approval, event } = await approve({ key: "A", candidateId: "vault:login-forum" });
    expect(approval.login?.fillLogin).toMatchObject({ state: "rejected", result: "已拒绝" });
    expect(event).toContain("用户没有允许在 forum.example.net 填写登录。");
    expect(await inputs()).toMatchObject([{ value: "" }, { value: "" }]);
    await goto("http://shop.example.com/register");
    await turn("fill_new_password", { username: "lin.no@example.com", length: 12 });
    const before = vault().items.length;
    const rejected = await approve({ key: "A" });
    expect(rejected.event).toContain("用户没有允许在 shop.example.com 注册新账号。");
    expect(vault().items.length).toBe(before);
    expectNoSecrets();
  });

  it("整个过程里密码没有进 HOB_HOME、事件、日志，假密码库之外的文件里也没有", () => {
    secrets.push(...vault().items.map((item) => item.login.password));
    expectNoSecrets();
    expect(walk(hob.home).length).toBeGreaterThan(10);
    expect(readFileSync(join(hob.home, "system", "new-password.json"), "utf8")).not.toContain("password");
  });
});

describe("fake desktopd", () => {
  it("要令牌，没有就是 401", async () => {
    const { startFakeDesktopd: start } = await import("./fixtures/fake-desktopd.mjs");
    const fake = await start({ port: 0, cdp: "http://127.0.0.1:1", token: "t" });
    try {
      expect((await fetch(`${fake.url}/api/health`)).status).toBe(401);
      expect((await fetch(`${fake.url}/api/health`, { headers: { Authorization: "Bearer t" } })).status).toBe(200);
      await expect((await fetch(`${fake.url}/api/screens/hob/browser/start`, { method: "POST", headers: { Authorization: "Bearer t" } })).json()).resolves.toEqual({ cdp: "/cdp/hob" });
    } finally { await fake.close(); }
  });
});
