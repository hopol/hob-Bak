#!/usr/bin/env node
// desktopd：按需管理独立屏幕，屏幕内监督 Xtigervnc、openbox、dock 和浏览器。
// 对外只开一个令牌保护的 HTTP/WS 端口；VNC 和 CDP 只监听容器回环。
// 接口约定见仓库 .scratch/v2/design-desktop-screens.md。
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { pointerEventLength } from "./pointer-event.mjs";
import { ensureLocale } from "./locale.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;

// ---------- 配置 ----------
const DATA_DIR = process.env.DESKTOP_DATA || "/data";
const PORT = Number(process.env.DESKTOP_PORT || 6080);
const MAX_SCREENS = Number(process.env.DESKTOP_MAX_SCREENS || 6);
const IDLE_MS = Number(process.env.DESKTOP_IDLE_MINUTES || 30) * 60000;
const BROWSER = process.env.DESKTOP_BROWSER || (fs.existsSync("/app/browser-kind") ? fs.readFileSync("/app/browser-kind", "utf8").trim() : "chromium");
const context = new AsyncLocalStorage();
const screens = new Map();
const eventClients = new Set();
const TZ = process.env.TZ || "UTC";
// 壁纸、dock 配置和启动器 .desktop 随镜像走（镜像里在 /app/desktop）
const ASSETS = process.env.DESKTOP_ASSETS || path.join(__dirname, "..", "desktop");

function fail(msg) {
  console.error(`desktopd: ${msg}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (s) => String(s || "").trim().split("\n")[0].slice(0, 300);
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const resM = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.DESKTOP_RESOLUTION || "1280x800");
if (!resM) fail(`无效的 DESKTOP_RESOLUTION "${process.env.DESKTOP_RESOLUTION}"（要 1280x800 这种）`);
const width = Number(resM[1]);
const height = Number(resM[2]);
if (width < 320 || width > 7680 || height < 240 || height > 4320) fail(`分辨率超出范围：${width}x${height}`);
// 桌面语言（BCP 47）：决定的程序和浏览器看到的语言，见 locale.mjs。
let LANG_SETTING;
try {
  LANG_SETTING = ensureLocale(process.env.DESKTOP_LANG || "zh-CN");
} catch (e) {
  fail(e.message);
}
// 时区：TZ 原样传给所有子进程；写了地区却不在 zoneinfo 里时早点报错，别让桌面悄悄跑在 UTC。
if (TZ.includes("/") && !fs.existsSync(path.join("/usr/share/zoneinfo", TZ))) fail(`无效的 TZ "${TZ}"（要 IANA 时区名，如 Asia/Shanghai、America/New_York）`);

fs.mkdirSync(path.join(DATA_DIR, "profiles"), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "home"), { recursive: true });

// ---------- 令牌 ----------
function atomicWrite(file, content, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

const TOKEN_FILE = path.join(DATA_DIR, "token");
let token = null;
if (process.env.DESKTOP_TOKEN) {
  token = process.env.DESKTOP_TOKEN;
} else {
  try {
    const v = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (v) {
      fs.chmodSync(TOKEN_FILE, 0o600);
      token = v;
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
if (!token) {
  token = crypto.randomBytes(32).toString("base64url");
  atomicWrite(TOKEN_FILE, token + "\n", 0o600);
}
if (process.env.DESKTOP_TOKEN_EXPORT) {
  atomicWrite(process.env.DESKTOP_TOKEN_EXPORT, token + "\n", 0o600);
}
console.log(`desktopd: 令牌${process.env.DESKTOP_TOKEN ? "来自 DESKTOP_TOKEN 环境变量" : `文件 ${TOKEN_FILE}`}`);
const tokenBuf = Buffer.from(String(token), "utf8");

function safeEqual(a, b) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // 长度不一致也走一遍比较，保持常量时间
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
function authorized(req) {
  const m = /^Bearer (.+)$/s.exec(req.headers.authorization || "");
  return !!m && safeEqual(m[1], tokenBuf);
}
/**
 * 屏幕里的程序（dock 启动器）拿到的只是这块屏幕的小令牌：只能开 / 切到这块屏幕自己的浏览器。
 * 总令牌绝不进屏幕里的进程环境，否则屏幕上开个终端就能拿去操作别的屏幕。
 */
function dockToken(id) {
  return crypto.createHmac("sha256", tokenBuf).update(`dock:${id}`).digest("hex");
}
function dockAuthorized(req, pathname) {
  const m = /^Bearer (.+)$/s.exec(req.headers.authorization || "");
  const route = /^\/api\/screens\/([a-z0-9-]{1,64})\/browser\/(?:start|focus)$/.exec(pathname);
  return req.method === "POST" && !!m && !!route && safeEqual(m[1], Buffer.from(dockToken(route[1]), "utf8"));
}

// ---------- X / 窗口管理器 ----------
let shuttingDown = false;

function watchCritical(name, child) {
  const screen = context.getStore();
  screen.children.add(child);
  console.log(`desktopd: ${screen.id} ${name} pid=${child.pid}`);
  child.on("exit", (code, sig) => {
    screen.children.delete(child);
    if (!screen.stopping && !shuttingDown) {
      console.error(`desktopd: ${screen.id} 的 ${name} 退出（${code}, ${sig}），重启屏幕`);
      const restartBrowser = !!browsers.get(screen.id);
      stopScreen(screen.id).then(() => ensureScreen(screen.id)).then((s) => restartBrowser ? context.run(s, () => ensureBrowser(s.id)) : undefined).catch(console.error);
    }
  });
}

// 监督一个常驻的辅助进程：退出后在 2 秒后重新拉起，直到进程停。
function watchService(name, cmd, args) {
  let child = null;
  let timer = null;
  let stopping = false;
  const restart = () => {
    if (stopping) return;
    clearTimeout(timer);
    timer = setTimeout(start, 2000);
  };
  const start = () => {
    if (stopping) return;
    child = spawn(cmd, args, { env: childEnv(), stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (e) => {
      child = null;
      console.error(`desktopd: ${name} 启动失败：${e.message}`);
      restart();
    });
    child.on("exit", (code, sig) => {
      child = null;
      if (stopping) return;
      console.error(`desktopd: ${name} 退出（code=${code} signal=${sig}），2 秒后重启`);
      restart();
    });
  };
  start();
  context.getStore().services.add(() => {
    stopping = true;
    clearTimeout(timer);
    try { child?.kill("SIGTERM"); } catch {}
  });
}

function childEnv() {
  const screen = context.getStore();
  const { DESKTOP_TOKEN: _token, DESKTOP_TOKEN_EXPORT: _export, ...env } = process.env;
  // 桌面里所有程序（dock、文件管理器、终端、浏览器）的语言都由 DESKTOP_LANG 定。
  return { ...env, DISPLAY: screen?.display, DESKTOP_SCREEN: screen?.id, DESKTOP_DOCK_TOKEN: screen ? dockToken(screen.id) : "", DESKTOP_PORT: String(PORT), TZ, LANG: LANG_SETTING.LANG, LANGUAGE: LANG_SETTING.LANGUAGE };
}

function run(cmd, args, { timeoutMs = 15000, input, maxOutput = 65536 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(cmd, args, { env: childEnv() });
    let out = Buffer.alloc(0);
    let err = "";
    child.stdout.on("data", (d) => {
      out = Buffer.concat([out, d]).subarray(-maxOutput);
    });
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-65536);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: out.toString("utf8"), err });
    };
    child.on("error", (e) => {
      err = (err + "\n" + String(e.message || e)).slice(-65536);
      finish(-1);
    });
    child.on(cmd === "xclip" && args.includes("-out") ? "close" : "exit", (code) => finish(code ?? -1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function startDisplay() {
  const vnc = spawn(
    "Xtigervnc",
    [
      context.getStore().display,
      "-geometry",
      `${width}x${height}`,
      "-depth",
      "24",
      "-dpi",
      "96",
      "-rfbport",
      String(context.getStore().vncPort),
      "-SecurityTypes",
      "None",
      "-localhost",
      "yes",
      "-ac", // X 只在容器内的 unix socket 上可达（-nolisten tcp），关掉 X 自身的访问控制
      "-nolisten",
      "tcp",
    ],
    { env: childEnv(), stdio: ["ignore", "inherit", "inherit"] }
  );
  watchCritical("Xtigervnc", vnc);
  for (let i = 0; i < 30; i++) {
    const r = await run("xdotool", ["getdisplaygeometry"], { timeoutMs: 5000 });
    if (r.code === 0) {
      const got = r.out.trim();
      if (got !== `${width} ${height}`) console.error(`desktopd: 实际几何 ${got} 与请求的 ${width}x${height} 不一致`);
      break;
    }
    if (i === 29) throw new Error("Xtigervnc 15 秒内没有就绪");
    await sleep(500);
  }
  const wm = spawn("openbox", [], { env: childEnv(), stdio: ["ignore", "inherit", "inherit"] });
  watchCritical("openbox", wm);
  await sleep(500);
  await setWallpaper();
  watchService("tint2", "tint2", ["-c", path.join(ASSETS, "dock", "tint2rc")]);
  startBrowserTitles();
}

// 壁纸用 hsetroot 一次性设（-fill 裁切铺满，分辨率改了也满屏）。
// 不用 pcmanfm --desktop：那会多一个常驻的桌面进程还会铺桌面图标，这里只要一张干净的壁纸。
async function setWallpaper() {
  const file = path.join(ASSETS, "wallpaper.png");
  for (let i = 1; i <= 3; i++) {
    const r = await run("hsetroot", ["-fill", file]);
    if (r.code === 0) return;
    console.error(`desktopd: 壁纸设置失败（第 ${i} 次）：${firstLine(r.err || r.out)}`);
    await sleep(1000);
  }
}

// 助手的浏览器窗口标题是网页标题，在 dock 上看不出是哪个助手：
// 定期把 hob-<profile> 窗口的标题补成「助手浏览器 · <profile> — 网页标题」。
// 网页导航后 Chromium 会重写标题，所以不是设一次就完事。
// 用 xprop 而不是 `xdotool set_window --name`：后者把 _NET_WM_NAME 写成 STRING 类型、
// 中文标题在 tint2 里会变成乱码（实测）。
function startBrowserTitles() {
  const tick = async () => {
    if (shuttingDown || context.getStore().stopping) return;
    for (const [profile, entry] of browsers) {
      if (profile !== context.getStore().id) continue;
      if (!entry.settledOk) continue;
      const prefix = profile === "public" ? "公共浏览器" : `${profile} 的浏览器`;
      const found = await run("xdotool", ["search", "--onlyvisible", "--class", `^hob-${profile}$`]);
      for (const id of found.out.trim().split("\n").filter(Boolean)) {
        const cur = (await run("xdotool", ["getwindowname", id])).out.trim();
        if (!cur || cur.startsWith(prefix)) continue;
        await run("xprop", ["-id", id, "-f", "_NET_WM_NAME", "8u", "-set", "_NET_WM_NAME", `${prefix} — ${cur}`]);
      }
    }
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

// ---------- Chromium ----------
const browsers = new Map(); // profile -> { child, port, wsPath, noSandbox, settledOk, ready }
const PROFILE_RE = /^[a-z0-9-]{1,64}$/;

function screenList() {
  return listProfiles().map((id) => {
    const s = screens.get(id);
    return { id, running: !!s && !s.stopping, browserRunning: !!browsers.get(id)?.settledOk, viewers: s?.viewers || 0, lastActiveAt: s?.lastActiveAt || null };
  });
}
function publish() {
  const msg = JSON.stringify({ type: "screens", screens: screenList() });
  for (const ws of eventClients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
function touch(s) { s.lastActiveAt = new Date().toISOString(); }
function ensureScreen(id) {
  if (shuttingDown) return Promise.reject(new HttpError(503, "shutting_down", "桌面正在关闭"));
  const existing = screens.get(id);
  if (existing) {
    touch(existing);
    return existing.stopping ? existing.stopping.then(() => ensureScreen(id)) : existing.ready;
  }
  if (screens.size >= MAX_SCREENS) return Promise.reject(new HttpError(429, "too_many_screens", "屏幕数量已达上限"));
  const used = new Set([...screens.values()].map((s) => s.number));
  let number = 1;
  while (used.has(number)) number++;
  const s = { id, number, display: `:${number}`, vncPort: 5900 + number, children: new Set(), services: new Set(), viewers: 0, cdpClients: 0, activeRequests: 1, sockets: new Set(), inputQueue: Promise.resolve() };
  touch(s);
  screens.set(id, s);
  s.ready = context.run(s, () => startDisplay()).then(() => { publish(); return s; }).catch(async (e) => { if (!s.stopping) await stopScreen(id, true); throw e; }).finally(() => { s.activeRequests--; touch(s); });
  return s.ready;
}
function stopScreen(id, failed = false) {
  const s = screens.get(id);
  if (!s) return Promise.resolve();
  if (s.stopping) return s.stopping;
  s.stopping = (async () => {
    if (!failed) await s.ready.catch(() => {});
    await stopBrowser(id);
    for (const ws of s.sockets) ws.terminate();
    for (const stop of s.services) stop();
    await Promise.all([...s.children].map((child) => killAndWait(child, "SIGTERM", 3000)));
    if (screens.get(id) === s) screens.delete(id);
    publish();
  })();
  return s.stopping;
}
function runningScreen(id) {
  const s = screens.get(id);
  if (!s || s.stopping) throw new HttpError(404, "not_running", `屏幕 ${id} 没在跑`);
  touch(s);
  return s;
}
setInterval(() => {
  for (const s of screens.values()) {
    if (!s.stopping && !s.viewers && !s.cdpClients && !s.activeRequests && Date.now() - Date.parse(s.lastActiveAt) >= IDLE_MS) stopScreen(s.id).catch(console.error);
  }
}, Math.max(250, Math.min(10000, IDLE_MS / 2))).unref();

function chromiumArgs(profile, userDir, noSandbox) {
  const args = [
    `--user-data-dir=${userDir}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-crash-reporter",
    // --lang 是界面语言；--accept-lang 是发给网站的 Accept-Language 和 navigator.languages
    // （两者都传，已有的 profile 也按部署配置，用户在浏览器设置里改的会被盖掉）。
    `--lang=${LANG_SETTING.tag}`,
    `--accept-lang=${LANG_SETTING.acceptLanguage}`,
    `--class=hob-${profile}`,
    `--name=hob-${profile}`,
    "--start-maximized",
    // 部署方可能没给 --shm-size；/dev/shm 太小会让 Chromium 崩，直接用 /tmp
    "--disable-dev-shm-usage",
  ];
  if (noSandbox) args.push("--no-sandbox");
  return args;
}

function waitPortFile(child, file, ms, errRef) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let done = false;
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        try {
          const lines = fs.readFileSync(file, "utf8").split("\n");
          if (lines[0].trim() && lines[1] && lines[1].includes("/")) {
            finish();
            resolve();
            return;
          }
        } catch {}
      }
      if (Date.now() - t0 > ms) finish(new Error(`chromium ${ms / 1000}s 内没就绪；stderr：${firstLine(errRef())}`));
    }, 150);
    const onExit = (code, sig) => finish(new Error(`chromium 启动即退出（code=${code} signal=${sig}）：${firstLine(errRef())}`));
    function finish(err) {
      if (done) return;
      done = true;
      clearInterval(timer);
      child.removeListener("exit", onExit);
      if (err) reject(err);
    }
    child.on("exit", onExit);
  });
}

async function launchBrowser(profile, entry) {
  const profilesRoot = path.join(DATA_DIR, "profiles");
  const userDir = path.join(profilesRoot, profile);
  if (path.resolve(userDir).slice(0, profilesRoot.length + 1) !== profilesRoot + path.sep) {
    throw new HttpError(400, "bad_profile", "profile 路径越界");
  }
  fs.mkdirSync(userDir, { recursive: true });
  const realRoot = fs.realpathSync(profilesRoot);
  const realDir = fs.realpathSync(userDir);
  if (path.dirname(realDir) !== realRoot || fs.lstatSync(userDir).isSymbolicLink()) {
    throw new HttpError(400, "bad_profile", "profile 路径越界或是符号链接");
  }
  // 容器被 SIGKILL（如 docker rm -f）时 Chromium 没清锁；换容器后主机名不同，
  // Chromium 会认为 profile 被别的机器锁着而不敢用。启动前清掉 Singleton 残留（会自动重建）。
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    fs.rmSync(path.join(userDir, f), { force: true });
  }
  const portFile = path.join(userDir, "DevToolsActivePort");
  fs.rmSync(portFile, { force: true });
  let errTail = "";
  const errRef = () => errTail;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const child = spawn(BROWSER === "chrome" ? "google-chrome-stable" : "chromium", chromiumArgs(profile, userDir, entry.noSandbox), {
      // 界面语言两头都设：这个 Debian 构建只认 LANG/LANGUAGE（实测），--lang 给认它的构建
      env: childEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    entry.child = child;
    errTail = "";
    child.stderr.on("data", (d) => {
      errTail = (errTail + d).slice(-4096);
    });
    child.on("exit", (code, sig) => {
      if (browsers.get(profile) === entry && entry.settledOk && !entry.stopping) {
        browsers.delete(profile);
        publish();
        console.log(`desktopd: chromium[${profile}] 退出（code=${code} signal=${sig}）`);
      }
    });
    try {
      await waitPortFile(child, portFile, 30000, errRef);
    } catch (e) {
      await killAndWait(child, "SIGTERM", 3000);
      const msg = String(e.message || e);
      if (attempt === 1 && /sandbox|namespace|SUID/i.test(msg)) {
        entry.noSandbox = true;
        console.error(`desktopd: chromium[${profile}] 沙箱不可用（${firstLine(msg)}）；改用 --no-sandbox 重试。代价：浏览器失去内核级沙箱，隔离只剩容器边界`);
        continue;
      }
      throw new HttpError(500, "start_failed", msg);
    }
    const lines = fs.readFileSync(portFile, "utf8").split("\n");
    entry.port = Number(lines[0].trim());
    entry.wsPath = lines[1].trim();
    entry.settledOk = true;
    publish();
    console.log(`desktopd: chromium[${profile}] 就绪 cdp=127.0.0.1:${entry.port}${entry.noSandbox ? "（--no-sandbox）" : ""}`);
    return entry;
  }
}

function ensureBrowser(profile) {
  if (shuttingDown) return Promise.reject(new HttpError(503, "shutting_down", "桌面正在关闭"));
  const cur = browsers.get(profile);
  if (cur) return cur.stopping ? cur.stopping.then(() => ensureBrowser(profile)) : cur.ready;
  const entry = { child: null, port: 0, wsPath: "", noSandbox: false, settledOk: false, ready: null };
  entry.ready = launchBrowser(profile, entry).catch((e) => {
    if (browsers.get(profile) === entry && !entry.stopping) browsers.delete(profile);
    throw e;
  });
  browsers.set(profile, entry);
  return entry.ready;
}

function stopBrowser(profile) {
  const entry = browsers.get(profile);
  if (!entry) return Promise.resolve();
  if (entry.stopping) return entry.stopping;
  // 启动中的浏览器也要等它就绪后关闭；关闭完成前不能启动同一 profile。
  entry.stopping = entry.ready.catch(() => {}).then(async () => {
    await cdpClose(entry);
    if (!(await waitForExit(entry.child, 5000))) await killAndWait(entry.child, "SIGTERM", 8000);
    if (browsers.get(profile) === entry) browsers.delete(profile);
    publish();
    console.log(`desktopd: chromium[${profile}] 已停止`);
  });
  return entry.stopping;
}

// 没在跑的 child 返回 true；在跑的等它退出，超时返回 false
function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const t = setTimeout(() => { child.removeListener("exit", yes); resolve(false); }, ms);
    const yes = () => { clearTimeout(t); resolve(true); };
    child.once("exit", yes);
  });
}

function killAndWait(child, sig, ms) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, ms);
    child.once("exit", () => { clearTimeout(t); resolve(); });
    try { child.kill(sig); } catch {}
  });
}

function cdpClose(entry) {
  return new Promise((resolve) => {
    if (!entry.port || !entry.wsPath || !entry.child || entry.child.exitCode !== null || entry.child.signalCode !== null) return resolve();
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${entry.port}${entry.wsPath}`);
    } catch {
      return resolve();
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { ws.terminate(); } catch {}
      resolve();
    };
    ws.on("open", () => {
      try { ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); } catch {}
    });
    ws.on("error", finish);
    setTimeout(finish, 3000);
  });
}

async function focusBrowser(profile) {
  const entry = browsers.get(profile);
  if (!entry || !entry.settledOk) throw new HttpError(404, "not_running", `浏览器 ${profile} 没在跑`);
  // start 返回时窗口可能还没 map，搜几秒
  let ids = [];
  for (let i = 0; i < 20 && !ids.length; i++) {
    const r = await run("xdotool", ["search", "--onlyvisible", "--class", `hob-${profile}`]);
    ids = r.out.trim().split("\n").filter(Boolean);
    if (!ids.length) await sleep(250);
  }
  if (!ids.length) throw new HttpError(404, "no_window", `没找到 ${profile} 的窗口`);
  const act = await run("xdotool", ["windowactivate", "--sync", ids[0]], { timeoutMs: 5000 });
  if (act.code !== 0) throw new HttpError(500, "focus_failed", `windowactivate 失败：${firstLine(act.err || act.out)}`);
  await run("xdotool", ["windowraise", ids[0]]);
}

// ---------- 截图 / 输入 ----------
async function screenshot() {
  const file = `/tmp/desktopd-shot-${process.pid}-${crypto.randomUUID()}.png`;
  const r = await run("scrot", ["-z", "-o", file], { timeoutMs: 20000 });
  if (r.code !== 0) throw new HttpError(500, "screenshot_failed", `scrot 失败：${firstLine(r.err || r.out)}`);
  try { return fs.readFileSync(file); } finally { fs.rmSync(file, { force: true }); }
}

const BUTTONS = { left: "1", middle: "2", right: "3" };
function xyErr(v, label) {
  if (!v || typeof v !== "object") return `${label}：要 {x,y}`;
  if (!Number.isInteger(v.x) || !Number.isInteger(v.y)) return `${label}：x/y 要整数`;
  if (v.x < 0 || v.x >= width || v.y < 0 || v.y >= height) return `${label}：坐标越界（桌面 ${width}x${height}）`;
  return null;
}

function validateActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return "actions：要非空数组";
  if (actions.length > 100) return "actions：一次最多 100 个";
  let totalWait = 0;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!a || typeof a !== "object" || typeof a.type !== "string") return `actions[${i}]：要带 type 的对象`;
    switch (a.type) {
      case "click": {
        const e = xyErr(a, `actions[${i}]`);
        if (e) return e;
        if (a.button !== undefined && (typeof a.button !== "string" || !Object.hasOwn(BUTTONS, a.button))) return `actions[${i}]：button 只能是 left/right/middle`;
        if (a.count !== undefined && !(Number.isInteger(a.count) && a.count >= 1 && a.count <= 3)) return `actions[${i}]：count 要 1-3`;
        break;
      }
      case "move": {
        const e = xyErr(a, `actions[${i}]`);
        if (e) return e;
        break;
      }
      case "drag": {
        let e = xyErr(a.from, `actions[${i}].from`);
        if (e) return e;
        e = xyErr(a.to, `actions[${i}].to`);
        if (e) return e;
        break;
      }
      case "type": {
        if (typeof a.text !== "string" || a.text.length === 0 || a.text.length > 5000) return `actions[${i}]：text 要 1-5000 字符`;
        break;
      }
      case "key": {
        if (typeof a.keys !== "string" || !/^[a-zA-Z0-9_]+(\+[a-zA-Z0-9_]+){0,7}$/.test(a.keys)) {
          return `actions[${i}]：keys 要 ctrl+l、Return、alt+Home 这种（最多 8 个键名）`;
        }
        break;
      }
      case "scroll": {
        const e = xyErr(a, `actions[${i}]`);
        if (e) return e;
        if (!Number.isInteger(a.dy) || Math.abs(a.dy) > 50) return `actions[${i}]：dy 要 -50..50 的整数`;
        if (a.dx !== undefined && (!Number.isInteger(a.dx) || Math.abs(a.dx) > 50)) return `actions[${i}]：dx 要 -50..50 的整数`;
        break;
      }
      case "wait": {
        if (!Number.isInteger(a.ms) || a.ms < 0 || a.ms > 5000) return `actions[${i}]：ms 要 0-5000`;
        totalWait += a.ms;
        if (totalWait > 30000) return "actions：wait 加起来最多 30 秒";
        break;
      }
      default:
        return `actions[${i}]：不认识的 type "${a.type}"`;
    }
  }
  return null;
}

function actionArgs(a) {
  switch (a.type) {
    case "click":
      return ["mousemove", String(a.x), String(a.y), "click", "--repeat", String(a.count ?? 1), BUTTONS[a.button ?? "left"]];
    case "move":
      return ["mousemove", String(a.x), String(a.y)];
    case "drag":
      return ["mousemove", String(a.from.x), String(a.from.y), "mousedown", "1", "mousemove", "--sync", String(a.to.x), String(a.to.y), "mouseup", "1"];
    case "type":
      return ["type", "--clearmodifiers", "--delay", "15", "--", a.text];
    case "key":
      return ["key", "--clearmodifiers", a.keys];
    case "scroll": {
      const args = ["mousemove", String(a.x), String(a.y)];
      if (a.dy) args.push("click", "--repeat", String(Math.abs(a.dy)), a.dy > 0 ? "5" : "4");
      if (a.dx) args.push("click", "--repeat", String(Math.abs(a.dx)), a.dx > 0 ? "7" : "6");
      return args;
    }
  }
}

function doInput(actions) {
  const screen = context.getStore();
  screen.inputQueue = screen.inputQueue.catch(() => {}).then(async () => {
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.type === "wait") {
        await sleep(a.ms);
        continue;
      }
      const r = await run("xdotool", actionArgs(a), { timeoutMs: 20000 });
      if (r.code !== 0) throw new HttpError(500, "input_failed", `actions[${i}]（${a.type}）执行失败：${firstLine(r.err || r.out)}`);
    }
  });
  return screen.inputQueue;
}

function pasteText(text) {
  const screen = context.getStore();
  screen.inputQueue = screen.inputQueue.catch(() => {}).then(async () => {
    const written = await run("xclip", ["-selection", "clipboard", "-in"], { input: text });
    if (written.code !== 0) throw new HttpError(500, "clipboard_failed", `写入剪贴板失败：${firstLine(written.err)}`);
    const read = await run("xclip", ["-selection", "clipboard", "-out"], { maxOutput: 1024 * 1024 });
    if (read.code !== 0 || read.out !== text) throw new HttpError(500, "clipboard_failed", "无法确认云桌面剪贴板内容。");
    const pasted = await run("xdotool", ["key", "--clearmodifiers", "ctrl+v"]);
    if (pasted.code !== 0) throw new HttpError(500, "input_failed", `粘贴失败：${firstLine(pasted.err)}`);
  });
  return screen.inputQueue;
}

// ---------- HTTP / WS ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "too_large", "请求体超过 1MB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new HttpError(400, "bad_json", "请求体不是合法 JSON"));
      }
    });
  });
}

function listProfiles() {
  const root = path.join(DATA_DIR, "profiles");
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && PROFILE_RE.test(d.name))
      .map((d) => d.name);
  } catch {}
  return [...new Set([...dirs, ...screens.keys()])];
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (!authorized(req) && !dockAuthorized(req, pathname)) return sendError(res, 401, "unauthorized", "缺 Bearer 令牌");
  const route = /^\/api\/screens\/([a-z0-9-]{1,64})\/(start|stop|screenshot|input|paste|browser\/(?:start|stop|focus))$/.exec(pathname);
  try {
    if (req.method === "GET" && pathname === "/api/health") {
      return sendJson(res, 200, {
        version,
        display: { width, height },
        browser: BROWSER,
        timezone: TZ,
        lang: { tag: LANG_SETTING.tag, locale: LANG_SETTING.LANG, acceptLanguage: LANG_SETTING.acceptLanguage },
        maxScreens: MAX_SCREENS,
        screens: screenList(),
      });
    }
    if (route) {
      const [, id, action] = route;
      if (req.method === "POST" && action === "start") {
        await ensureScreen(id);
        return sendJson(res, 200, {});
      }
      if (req.method === "POST" && action === "stop") {
        await stopScreen(id);
        return sendJson(res, 200, {});
      }
      if (req.method === "POST" && action === "browser/start") {
        const s = await ensureScreen(id);
        s.activeRequests++;
        try {
          await context.run(s, () => ensureBrowser(id));
          return sendJson(res, 200, { cdp: `/cdp/${id}` });
        } finally {
          s.activeRequests--;
          touch(s);
        }
      }
      const s = runningScreen(id);
      s.activeRequests++;
      try {
        await s.ready;
        return await context.run(s, async () => {
          if (req.method === "GET" && action === "screenshot") {
            const png = await screenshot();
            res.writeHead(200, { "content-type": "image/png" });
            return res.end(png);
          }
          if (req.method === "POST" && action === "paste") {
            const body = await readJson(req);
            if (typeof body?.text !== "string" || !body.text || body.text.includes("\0") || Buffer.byteLength(body.text) > 512 * 1024) {
              return sendError(res, 400, "bad_request", "文字须为非空文本，且不能超过 512KB 或包含空字符。");
            }
            await pasteText(body.text);
            return sendJson(res, 200, {});
          }
          if (req.method === "POST" && action === "input") {
            const body = await readJson(req);
            const invalid = validateActions(body?.actions);
            if (invalid) return sendError(res, 400, "bad_request", invalid);
            await doInput(body.actions);
            touch(s);
            return sendJson(res, 200, {});
          }
          if (req.method === "POST" && action === "browser/stop") { await stopBrowser(id); return sendJson(res, 200, {}); }
          if (req.method === "POST" && action === "browser/focus") { await focusBrowser(id); return sendJson(res, 200, {}); }
          return sendError(res, 404, "not_found", "没有这个接口");
        });
      } finally {
        s.activeRequests--;
        touch(s);
      }
    }
    return sendError(res, 404, "not_found", `没有这个接口：${req.method} ${pathname}`);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    console.error("desktopd:", e);
    return sendError(res, 500, "internal", String(e.message || e));
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const deny = (status, message) => {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  if (!authorized(req)) return deny(401, "Unauthorized");
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/api/events") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      eventClients.add(ws);
      ws.send(JSON.stringify({ type: "screens", screens: screenList() }));
      ws.on("close", () => eventClients.delete(ws));
      ws.on("error", () => {});
    });
    return;
  }
  const vncM = /^\/vnc\/([a-z0-9-]{1,64})$/.exec(pathname);
  if (vncM) {
    const s = screens.get(vncM[1]);
    if (!s || s.stopping) return deny(404, "Not Found");
    wss.handleUpgrade(req, socket, head, (ws) => {
      s.viewers++; s.sockets.add(ws); touch(s); publish();
      ws.on("close", () => { s.viewers--; s.sockets.delete(ws); touch(s); publish(); });
      pipeVnc(ws, s.vncPort);
    });
    return;
  }
  const cdpM = /^\/cdp\/([a-z0-9-]{1,64})$/.exec(pathname);
  if (!cdpM) return deny(404, "Not Found");
  const entry = browsers.get(cdpM[1]);
  const screen = screens.get(cdpM[1]);
  if (!entry || !entry.settledOk || !screen || screen.stopping) return deny(404, "Not Found");
  const upstream = new WebSocket(`ws://127.0.0.1:${entry.port}${entry.wsPath}`, { perMessageDeflate: false });
  upstream.on("open", () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      screen.cdpClients++; screen.sockets.add(ws); touch(screen);
      ws.on("close", () => { screen.cdpClients--; screen.sockets.delete(ws); touch(screen); });
      relayWs(ws, upstream);
    });
  });
  upstream.on("error", () => deny(502, "Bad Gateway"));
});

// RFB 字节流透传（语义同 websockify）
// RFB 字节流透传（语义同 websockify）。
// 一个例外：客户端→服务端方向的 SetEncodings 里滤掉 ExtendedDesktopSize(-308)。
// Debian bookworm 的 TigerVNC 1.12.0 收到它后就一个 framebuffer 更新都不发（实测复现），
// 而 noVNC 默认会宣告它；它只用于 resizeSession，去掉不影响观看。
const ENC_EXTENDED_DESKTOP_SIZE = -308;
function createSetEncodingsFilter() {
  let pending = Buffer.alloc(0);
  let seen = 0;
  let version = Buffer.alloc(0);
  let handshakeLength = 14; // RFB 3.7/3.8：版本、安全选择、ClientInit
  const FIXED_LEN = { 0: 20, 3: 10, 4: 8, 5: 6, 150: 10, 255: 12 };
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const out = [];
    if (seen < 12) {
      const n = Math.min(12 - seen, pending.length);
      const part = pending.subarray(0, n);
      version = Buffer.concat([version, part]);
      out.push(part);
      pending = pending.subarray(n);
      seen += n;
      if (seen < 12) return out;
      if (version.toString("ascii") === "RFB 003.003\n") handshakeLength = 13;
    }
    if (seen < handshakeLength) {
      const n = Math.min(handshakeLength - seen, pending.length);
      out.push(pending.subarray(0, n));
      pending = pending.subarray(n);
      seen += n;
      if (seen < handshakeLength) return out;
    }
    let cur = 0;
    while (cur < pending.length) {
      const type = pending[cur];
      let len = FIXED_LEN[type];
      if (type === 5) {
        len = pointerEventLength(pending, cur);
        if (len === undefined) break;
      }
      if (type === 2) {
        if (pending.length < cur + 4) break;
        len = 4 + pending.readUInt16BE(cur + 2) * 4;
      }
      if (type === 6) {
        if (pending.length < cur + 8) break;
        // 扩展剪贴板用负的有符号长度表示压缩载荷。
        len = 8 + Math.abs(pending.readInt32BE(cur + 4));
        if (len > 1024 * 1024) throw new Error("VNC 剪贴板消息过大");
      }
      if (type === 248) {
        if (pending.length < cur + 9) break;
        len = 9 + pending[cur + 8];
      }
      if (type === 251) {
        if (pending.length < cur + 8) break;
        len = 8 + pending[cur + 6] * 16;
      }
      if (len === undefined) throw new Error(`不支持的 VNC 客户端消息类型 ${type}`);
      if (pending.length < cur + len) break;
      const msg = pending.slice(cur, cur + len);
      if (type === 2) {
        const count = msg.readUInt16BE(2);
        const keep = [];
        for (let i = 0; i < count; i++) {
          const enc = msg.readInt32BE(4 + i * 4);
          if (enc !== ENC_EXTENDED_DESKTOP_SIZE) keep.push(enc);
        }
        if (keep.length !== count) {
          const rewritten = Buffer.alloc(4 + keep.length * 4);
          rewritten[0] = 2;
          rewritten.writeUInt16BE(keep.length, 2);
          keep.forEach((e, i) => rewritten.writeInt32BE(e, 4 + i * 4));
          out.push(rewritten);
        } else {
          out.push(msg);
        }
      } else {
        out.push(msg);
      }
      cur += len;
    }
    pending = pending.slice(cur);
    return out;
  };
}

function pipeVnc(ws, vncPort) {
  const rfb = net.connect(vncPort, "127.0.0.1");
  const filter = createSetEncodingsFilter();
  ws.on("error", () => rfb.destroy());
  rfb.on("error", () => ws.close(1011, "VNC 不可用"));
  ws.on("message", (data) => {
    try {
      for (const piece of filter(Buffer.from(data))) {
        if (piece.length && !rfb.write(piece)) ws.pause();
      }
    } catch (e) {
      console.error(`desktopd: VNC 协议错误：${e.message}`);
      ws.close(1002, "不支持的 VNC 消息");
      rfb.destroy();
    }
  });
  rfb.on("drain", () => ws.resume());
  rfb.on("data", (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > 32 * 1024 * 1024) rfb.pause();
  });
  ws._socket?.on("drain", () => rfb.resume());
  ws.on("close", () => rfb.destroy());
  rfb.on("close", () => {
    try {
      ws.close();
    } catch {}
  });
}

function relayWs(a, b) {
  const aOnMessage = (data, isBinary) => {
    b.send(data, { binary: isBinary });
    if (b.bufferedAmount > 64 * 1024 * 1024) a.pause();
  };
  a.on("message", aOnMessage);
  b.on("message", (data, isBinary) => {
    a.send(data, { binary: isBinary });
    if (a.bufferedAmount > 64 * 1024 * 1024) b.pause();
  });
  // ws 的底层 socket 在 _socket 上（open/connection 回调时已可用）
  b._socket?.on("drain", () => a.resume());
  a._socket?.on("drain", () => b.resume());
  const bye = () => {
    try {
      a.close();
    } catch {}
    try {
      b.close();
    } catch {}
  };
  a.on("close", bye);
  b.on("close", bye);
  a.on("error", bye);
  b.on("error", bye);
}

// ---------- 停止 ----------
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("desktopd: 收到停止信号，关闭中");
  server.close();
  Promise.all([...screens.keys()].map((id) => stopScreen(id)))
    .catch(console.error)
    .finally(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ---------- main ----------
console.log(`desktopd ${version}：display ${width}x${height}，TZ=${TZ}，语言 ${LANG_SETTING.tag}（${LANG_SETTING.LANG}${LANG_SETTING.generated ? "，本次生成" : ""}），数据目录 ${DATA_DIR}`);
await new Promise((resolve) => server.listen(PORT, "0.0.0.0", resolve));
console.log(`desktopd: 监听 0.0.0.0:${PORT}（访问控制靠令牌；映射到哪个接口由部署方决定）`);
