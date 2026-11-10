#!/usr/bin/env node
// 对运行在 30196 的测试容器执行；HOBDESK_TOKEN 必填，截图写入 HOBDESK_OUT。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const base = process.env.HOBDESK_URL || "http://127.0.0.1:30196";
const token = process.env.HOBDESK_TOKEN;
const out = process.env.HOBDESK_OUT || ".scratch/v2/ref";
if (!token) throw new Error("缺 HOBDESK_TOKEN");
fs.mkdirSync(out, { recursive: true });
const headers = { Authorization: `Bearer ${token}` };
const wsBase = base.replace(/^http/, "ws");
const { chromium } = await import(pathToFileURL(path.join(process.env.HOBDESK_PLAYWRIGHT || "/tmp/hobdesk-pw/node_modules/playwright-core", "index.mjs")).href);
async function api(method, route, body) {
  const r = await fetch(base + route, { method, headers: { ...headers, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const bytes = Buffer.from(await r.arrayBuffer());
  return { status: r.status, bytes, json: () => JSON.parse(bytes) };
}
async function post(route, body) { const r = await api("POST", route, body); assert.equal(r.status, 200, r.bytes.toString()); return r; }
async function shot(id, name) { const r = await api("GET", `/api/screens/${id}/screenshot`); assert.equal(r.status, 200); fs.writeFileSync(path.join(out, name), r.bytes); return r.bytes; }
const events = [];
const eventSocket = new WebSocket(`${wsBase}/api/events`, { headers });
await new Promise((resolve, reject) => { eventSocket.once("message", (msg) => { events.push(JSON.parse(msg)); resolve(); }); eventSocket.once("error", reject); });
eventSocket.on("message", (msg) => events.push(JSON.parse(msg)));
const browsers = [];
try {
  assert.equal((await fetch(base + "/api/health")).status, 401);
  assert.equal(events[0].type, "screens");
  for (const id of ["a1", "a2"]) await post(`/api/screens/${id}/stop`);
  await Promise.all(["a1", "a2"].map((id) => post(`/api/screens/${id}/browser/start`)));
  if ((await api("GET", "/api/health")).json().maxScreens === 2) assert.equal((await api("POST", "/api/screens/a3/start")).status, 429);
  const missing = new WebSocket(`${wsBase}/vnc/missing`, { headers });
  await new Promise((resolve, reject) => { missing.once("unexpected-response", (_, response) => { try { assert.equal(response.statusCode, 404); resolve(); } catch (e) { reject(e); } }); missing.once("error", reject); });
  const viewer = new WebSocket(`${wsBase}/vnc/a1`, { headers });
  await new Promise((resolve, reject) => { viewer.once("open", resolve); viewer.once("error", reject); });
  await new Promise((r) => setTimeout(r, 200));
  viewer.close();
  await new Promise((resolve) => viewer.once("close", resolve));
  for (const id of ["a1", "a2"]) browsers.push(await chromium.connectOverCDP(`${wsBase}/cdp/${id}`, { headers }));
  const pages = await Promise.all(browsers.map((b) => b.contexts()[0].newPage()));
  await Promise.all(pages.map((p, i) => p.goto(`data:text/html,<title>screen-${i + 1}</title><h1>Screen ${i + 1}</h1>`)));
  await Promise.all(["a1", "a2"].map((id, i) => post(`/api/screens/${id}/input`, { actions: [
    { type: "key", keys: "ctrl+l" }, { type: "wait", ms: 400 }, { type: "type", text: `https://example.com/?screen=${i + 1}` }, { type: "key", keys: "Return" },
  ] })));
  await Promise.all(pages.map((p, i) => p.waitForURL(`https://example.com/?screen=${i + 1}`)));
  const [a, b] = await Promise.all([shot("a1", "65-a1.png"), shot("a2", "65-a2.png")]);
  assert(!a.equals(b));
  const first = post("/api/screens/a1/input", { actions: [{ type: "key", keys: "ctrl+l" }, { type: "wait", ms: 500 }, { type: "type", text: "https://example.com/?first" }] });
  await new Promise((r) => setTimeout(r, 100));
  const second = post("/api/screens/a1/input", { actions: [{ type: "type", text: "second" }, { type: "key", keys: "Return" }] });
  await Promise.all([first, second]);
  await pages[0].waitForURL(/firstsecond/, { timeout: 15000 });
  await post("/api/screens/a1/browser/stop");
  await post("/api/screens/a1/stop");
  assert(events.some((e) => e.screens?.some((s) => s.id === "a1" && s.browserRunning)));
  assert(events.some((e) => e.screens?.some((s) => s.id === "a1" && s.viewers === 1)));
  assert(events.some((e) => e.screens?.some((s) => s.id === "a1" && !s.running)));
  console.log("多屏隔离、并发输入队列、事件及鉴权通过");
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  for (const id of ["a1", "a2"]) await post(`/api/screens/${id}/stop`).catch(() => {});
  eventSocket.close();
}
