// Google 登录预检：不使用真实账号，不修改浏览器的自动化标志。
import fs from "node:fs";
import { chromium } from "/tmp/hobdesk-pw/node_modules/playwright-core/index.mjs";
const base = process.env.HOBDESK_URL || "http://127.0.0.1:30196";
const headers = { Authorization: `Bearer ${process.env.HOBDESK_TOKEN}` };
const out = process.env.HOBDESK_OUT || ".scratch/v2/ref";
async function post(p, body) { const r = await fetch(base + p, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: body && JSON.stringify(body) }); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); }
async function screenshot(name) { const r = await fetch(base + "/api/screens/public/screenshot", { headers }); if (!r.ok) throw new Error(`screenshot ${r.status}`); fs.writeFileSync(`${out}/${name}`, Buffer.from(await r.arrayBuffer())); }
await post("/api/screens/public/browser/start");
const browser = await chromium.connectOverCDP(base.replace(/^http/, "ws") + "/cdp/public", { headers });
try {
  const page = await browser.contexts()[0].newPage();
  await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  console.log("URL:", page.url(), "webdriver:", await page.evaluate(() => navigator.webdriver));
  await screenshot("65-google-login.png");
  await post("/api/screens/public/input", { actions: [{ type: "click", x: 780, y: 320 }, { type: "type", text: `hob-desktop-check-${Date.now()}@gmail.com` }, { type: "key", keys: "Return" }] });
  await page.waitForTimeout(7000);
  console.log("Google response:", (await page.locator("body").innerText()).slice(0, 2000));
  await screenshot("65-google-response.png");
} finally {
  await browser.close();
  await post("/api/screens/public/stop");
}
