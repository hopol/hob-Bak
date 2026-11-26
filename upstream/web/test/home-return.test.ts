import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";

type Frame = { id: string; y: number }[];
type Scenario = "unread" | "replied" | "replying" | "visibility";
interface Probe {
  run: (scenario: Scenario) => Promise<{ beforeReturn: Frame; frames: Frame[] }>;
}

let server: ViteDevServer;
let cacheDir: string;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "hob-home-return-vite-"));
  server = await createServer({ cacheDir, server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  await server.transformRequest("/test/home-return-fixture.tsx");
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  page.setDefaultTimeout(90_000);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

async function fixture(): Promise<void> {
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
  await page.goto(`http://127.0.0.1:${address.port}/test/home-return-fixture.html?mock=1&scene=s1`);
  await page.waitForFunction(() => Boolean((window as unknown as { __homeReturn?: Probe }).__homeReturn));
}

function signature(frame: Frame): string {
  return frame.map((row) => `${row.id}:${row.y}`).join("|");
}

describe("手机从对话返回首页时列表位置", () => {
  // 并发全量测试时首次加载页面可能较慢，断言仍只观察返回后的两秒。
  it.each<Scenario>(["unread", "replied", "replying", "visibility"])("%s：返回前已收到的状态在返回后两秒内保持稳定", async (scenario) => {
    await fixture();
    const result = await page.evaluate((name) => (window as unknown as { __homeReturn: Probe }).__homeReturn.run(name), scenario);
    const positions = [result.beforeReturn, ...result.frames].map(signature);
    expect(new Set(positions).size).toBe(1);
    expect(result.beforeReturn.map((row) => row.id)).toEqual(["recent", "done", "quiet"]);
  }, 90_000);
});
