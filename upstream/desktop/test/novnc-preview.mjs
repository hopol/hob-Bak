#!/usr/bin/env node
// 票 55 验收：noVNC 网页客户端直连 /vnc（令牌由本代理带上，模拟 Hob 服务端的转发角色），截图 + 测刷新延迟。
//
// 前置：
//   npm i --prefix /tmp/hobdesk-novnc @novnc/novnc
//   npm i --prefix /tmp/hobdesk-pw playwright-core
//   容器里已 start 一个 profile 并打开 example.com（本脚本自己起）
// 用法：HOBDESK_TOKEN=... node desktop/test/novnc-preview.mjs <输出目录>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws"; // 仓库根 node_modules

const BASE = process.env.HOBDESK_URL || "http://127.0.0.1:30196";
const TOKEN = process.env.HOBDESK_TOKEN;
const PROFILE = process.env.HOBDESK_PROFILE || "t1";
const PORT = Number(process.env.HOBDESK_PREVIEW_PORT || 30297);
const NOVNC_DIR = "/tmp/hobdesk-novnc/node_modules/@novnc/novnc";
const PW_DIR = process.env.HOBDESK_PLAYWRIGHT || "/tmp/hobdesk-pw/node_modules/playwright-core";
const OUT = process.argv[2] || "/tmp/hobdesk-out";
if (!TOKEN) {
  console.error("缺 HOBDESK_TOKEN");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(path.join(NOVNC_DIR, "core", "rfb.js"))) {
  console.error(`在 ${NOVNC_DIR} 里找不到 noVNC（core/rfb.js）`);
  process.exit(1);
}
const auth = { Authorization: `Bearer ${TOKEN}` };
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

// 1) 本地 127.0.0.1 小页面：静态 noVNC + WS 代理（带令牌连桌面 /vnc）。
// noVNC 1.7 没有“帧已绘制”事件，用 RAF + 画布采样校验和检测画面变化（延迟测量用）
const page = `<!doctype html><meta charset="utf-8"><title>hob desktop</title>
<style>body{margin:0;background:#16181d;overflow:hidden}canvas{display:block;border:1px solid #333}</style>
<div id="wrap"><div id="screen"></div></div>
<script type="module">
  import RFB from '/novnc/core/rfb.js';
  const rfb = new RFB(document.getElementById('screen'), 'ws://' + location.host + '/vnc', {});
  window.rfb = rfb; window.__conn = ''; window.__lastChange = 0; window.__changes = 0;
  rfb.addEventListener('connect', () => { window.__conn = 'connected'; });
  rfb.addEventListener('disconnect', (e) => { window.__conn = 'disconnected'; window.__why = e.detail; });
  const ctxOf = () => { const c = document.querySelector('#wrap canvas'); return c ? [c, c.getContext('2d')] : [null, null]; };
  let last = null;
  function checksum() {
    const [c, ctx] = ctxOf();
    if (!c || !c.width || !c.height) return null;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 256) s = (s * 31 + d[i]) | 0;
    return s;
  }
  (function loop() {
    const c = checksum();
    if (c !== null && c !== last) {
      if (last !== null) { window.__lastChange = Date.now(); window.__changes++; }
      last = c;
    }
    requestAnimationFrame(loop);
  })();
</script>`;
const TYPES = { ".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml" };
const wss = new WebSocketServer({ noServer: true });
const httpServer = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  // /novnc/<包内相对路径>，伺服 npm 包源码（ESM 相对导入），拒绝越界
  const rel = /^\/novnc\/(.+)$/.exec(req.url)?.[1];
  const file = rel ? path.resolve(NOVNC_DIR, decodeURIComponent(rel)) : null;
  if (file && file.startsWith(NOVNC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  } else {
    res.writeHead(404);
    res.end();
  }
});
httpServer.on("upgrade", (req, socket, head) => {
  if (req.url !== "/vnc") {
    socket.destroy();
    return;
  }
  const upstream = new WebSocket(BASE.replace(/^http/, "ws") + "/vnc", { headers: auth, perMessageDeflate: false });
  upstream.on("open", () => wss.handleUpgrade(req, socket, head, (ws) => relay(ws, upstream)));
  upstream.on("error", () => socket.destroy());
});
function relay(a, b) {
  const bye = () => {
    try { a.close(); } catch {}
    try { b.close(); } catch {}
  };
  a.on("message", (data, isBinary) => b.send(data, { binary: isBinary }));
  b.on("message", (data, isBinary) => a.send(data, { binary: isBinary }));
  a.on("close", bye);
  b.on("close", bye);
}
httpServer.listen(PORT, "127.0.0.1");
console.log(`novnc 预览页：http://127.0.0.1:${PORT}/（noVNC 1.7 ESM）`);

// 2) 起浏览器 + 打开一个页面，保证桌面上有东西可看
const { chromium } = await import(pathToFileURL(path.join(PW_DIR, "index.mjs")).href);
await api("POST", `/api/browser/${PROFILE}/start`);
const cdpBrowser = await chromium.connectOverCDP(BASE.replace(/^http/, "ws") + `/cdp/${PROFILE}`, { headers: auth });
const tab = await cdpBrowser.contexts()[0].newPage();
await tab.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
await tab.waitForTimeout(1200);

// 3) 用宿主 Chrome 打开预览页，等连上、画面出现，截图
const host = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const hp = await host.newPage({ viewport: { width: 1440, height: 900 } });
await hp.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
await hp.waitForFunction(() => window.__conn === "connected", null, { timeout: 15000 });
await hp.waitForTimeout(4000);
const painted = await hp.evaluate(() => { const c = document.querySelector("#wrap canvas"); return { changes: window.__changes, w: c ? c.width : 0, h: c ? c.height : 0 }; });
console.log(`画面：${painted.w}x${painted.h}，连接后变化 ${painted.changes} 次${painted.changes === 0 ? "（画布没绘出内容！）" : ""}`);
const shot = path.resolve(OUT, "55-novnc-desktop.png");
await hp.screenshot({ path: shot });
console.log(`已截图：${shot}`);

// 4) VNC 观看时一次整屏刷新的延迟：ctrl+t 开新标签页（整窗重绘，不依赖外网），量 input 请求发出 → 画布内容变化
await hp.evaluate(() => { window.__changes = 0; window.__lastChange = 0; });
const t0 = Date.now();
const r = await api("POST", "/api/input", { actions: [{ type: "key", keys: "ctrl+t" }] });
if (r.status !== 200) throw new Error(`input 失败：${r.status} ${r.text}`);
let latency = -1;
try {
  await hp.waitForFunction((start) => window.__lastChange > start, t0, { timeout: 20000, polling: 50 });
  latency = await hp.evaluate((start) => window.__lastChange - start, t0);
} catch {
  console.error("延迟测量失败：20 秒内画布没变化");
}
console.log(`VNC 整屏刷新延迟（input 请求发出 → noVNC 画布变化）：约 ${latency} ms`);

// 5) 收尾
await cdpBrowser.close().catch(() => {});
await host.close();
await api("POST", `/api/browser/${PROFILE}/stop`);
httpServer.close();
process.exit(latency >= 0 ? 0 : 2);
