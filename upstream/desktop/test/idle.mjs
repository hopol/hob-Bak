// 配合 DESKTOP_IDLE_MINUTES=0.2 的测试容器运行。
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { chromium } from "/tmp/hobdesk-pw/node_modules/playwright-core/index.mjs";
const base = process.env.HOBDESK_URL || "http://127.0.0.1:30196";
const headers = { Authorization: `Bearer ${process.env.HOBDESK_TOKEN}` };
const wsBase = base.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, p) { const r = await fetch(base + p, { method, headers }); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); }
await api("POST", "/api/screens/idle/browser/start");
let browser = await chromium.connectOverCDP(wsBase + "/cdp/idle", { headers });
await browser.contexts()[0].addCookies([{ name: "hob_idle", value: "persist", url: "https://example.com", expires: Math.floor(Date.now() / 1000) + 3600 }]);
await browser.close();
const viewer = new WebSocket(wsBase + "/vnc/idle", { headers });
await new Promise((resolve, reject) => { viewer.once("open", resolve); viewer.once("error", reject); });
await sleep(16000);
let health = await api("GET", "/api/health");
assert(health.screens.find((s) => s.id === "idle")?.running, "有观看者不能回收");
viewer.close();
await new Promise((resolve) => viewer.once("close", resolve));
await sleep(18000);
health = await api("GET", "/api/health");
assert.equal(health.screens.find((s) => s.id === "idle")?.running, false, "闲置屏幕应回收");
await api("POST", "/api/screens/idle/browser/start");
browser = await chromium.connectOverCDP(wsBase + "/cdp/idle", { headers });
assert((await browser.contexts()[0].cookies("https://example.com")).some((c) => c.name === "hob_idle" && c.value === "persist"));
await browser.close();
await api("POST", "/api/screens/idle/stop");
console.log("观看保护、闲置回收与 cookie 保留通过");
