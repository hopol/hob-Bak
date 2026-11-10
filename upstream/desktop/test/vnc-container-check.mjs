// 宿主浏览器访问测试容器内的 noVNC 临时代理，不占用宿主端口。
import { chromium } from "/tmp/hobdesk-pw/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(process.env.HOBDESK_PREVIEW_URL);
  await page.waitForFunction(() => window.state === "connected" || window.state === "disconnected", null, { timeout: 15000 });
  await page.waitForTimeout(5000);
  const result = await page.evaluate(() => ({ state: window.state, reason: window.reason, width: document.querySelector("canvas")?.width, height: document.querySelector("canvas")?.height }));
  console.log(result);
  await page.screenshot({ path: process.env.HOBDESK_SCREENSHOT });
  if (result.state !== "connected" || result.width !== 1280 || result.height !== 800) process.exitCode = 1;
} finally {
  await browser.close();
}
