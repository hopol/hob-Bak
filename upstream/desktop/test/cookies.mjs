#!/usr/bin/env node
// 票 55 登录保持测试：用容器里 profile 的 Chromium 存一个 cookie，删容器（保留卷）重建后验证还在。
//
// 前置：宿主上先跑 desktop/test/cookieweb.mjs；容器加 --add-host=host.docker.internal:host-gateway；
//       playwright-core 装在 /tmp/hobdesk-pw（见 smoke.mjs）。
// 用法：
//   node desktop/test/cookies.mjs set             # 存 cookie，stdout 最后一行输出 cookie 值
//   node desktop/test/cookies.mjs check <值>       # 重建容器后验证
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.env.HOBDESK_URL || "http://127.0.0.1:30196";
const TOKEN = process.env.HOBDESK_TOKEN;
const PROFILE = process.env.HOBDESK_PROFILE || "t1";
const WEB = process.env.HOBDESK_WEB || "http://host.docker.internal:30298";
const PW_DIR = process.env.HOBDESK_PLAYWRIGHT || "/tmp/hobdesk-pw/node_modules/playwright-core";
const [cmd, expected] = process.argv.slice(2);
if (!TOKEN || (cmd !== "set" && cmd !== "check")) {
  console.error("用法：HOBDESK_TOKEN=... node desktop/test/cookies.mjs set | check <值>");
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

const { chromium } = await import(pathToFileURL(path.join(PW_DIR, "index.mjs")).href);
const started = await api("POST", `/api/browser/${PROFILE}/start`);
if (started.status !== 200) {
  console.error(`start 失败：${started.status} ${started.text}`);
  process.exit(1);
}
const browser = await chromium.connectOverCDP(BASE.replace(/^http/, "ws") + `/cdp/${PROFILE}`, { headers: auth });
const page = await browser.contexts()[0].newPage();

try {
  if (cmd === "set") {
    await page.goto(`${WEB}/set`, { timeout: 30000 });
    const value = (await page.textContent("body")).trim();
    await page.goto(`${WEB}/read`, { timeout: 30000 });
    const seen = JSON.parse(await page.textContent("body")).cookie;
    console.log(`set：写入 hob=${value}，随后读到 Cookie 头 "${seen}"`);
    console.log(value);
  } else {
    await page.goto(`${WEB}/read`, { timeout: 30000 });
    const seen = JSON.parse(await page.textContent("body")).cookie;
    const ok = seen.includes(`hob=${expected}`);
    console.log(`check：Cookie 头 "${seen}"，期望包含 hob=${expected} → ${ok ? "还在" : "丢了"}`);
    process.exitCode = ok ? 0 : 1;
  }
} finally {
  await browser.close().catch(() => {});
  await api("POST", `/api/browser/${PROFILE}/stop`);
}
