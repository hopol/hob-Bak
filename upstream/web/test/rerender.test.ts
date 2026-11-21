import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";

// 首页重画几次（票 188）：手机上从群里回到列表，首页那一大片不该跟着重画
interface Probe {
  __renders: { home: number; picked: number };
  __go: (what: "back" | "search", value?: string) => void;
  __where: () => { mobile: string; gsel: string | null };
}

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const BROWSER_TEST_TIMEOUT = 90_000;

beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  // 全仓库并行时浏览器和约 155 个 Vitest worker 竞争 CPU，模块渲染可能超过 15 秒。
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(60_000);
});
afterAll(async () => { await browser?.close(); await server?.close(); });

async function fixture() {
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
  await page.goto(`http://127.0.0.1:${address.port}/test/rerender-fixture.html?mock=1&scene=g-mobile`);
  await page.waitForFunction(() => (window as unknown as Probe).__renders.home >= 1);
}

const renders = () => page.evaluate(() => (window as unknown as Probe).__renders);
const where = () => page.evaluate(() => (window as unknown as Probe).__where());
const go = (what: "back" | "search", value = "") =>
  page.evaluate(([w, v]) => (window as unknown as Probe).__go(w as "back" | "search", v), [what, value]);

describe("首页只订阅自己用的那几项", () => {
  it("挑出来的值没变就不重画，变了才重画", async () => {
    await fixture();
    expect((await renders()).picked).toBe(1);
    await go("search", "写");
    await page.waitForFunction(() => (window as unknown as Probe).__renders.picked === 2);
    // 同一个值再 set 一次：state 换了新对象，挑出来的还是「写」，不该再画一遍
    await go("search", "写");
    await page.waitForTimeout(100);
    expect((await renders()).picked).toBe(2);
  }, BROWSER_TEST_TIMEOUT);

  it("手机上从群返回列表：首页不重画", async () => {
    await fixture();
    expect(await where()).toEqual({ mobile: "chat", gsel: "g-home" });
    expect((await renders()).home).toBe(1); // 只是挂载那一次
    await go("back"); // 关群对话回话题列表，再回首页
    expect(await where()).toEqual({ mobile: "list", gsel: null });
    await page.waitForTimeout(100);
    expect((await renders()).home).toBe(1);
    // 对照：搜索词变了，首页这一片真的重画，说明上面的计数不是死的
    await go("search", "写");
    await page.waitForFunction(() => (window as unknown as Probe).__renders.home === 2);
  }, BROWSER_TEST_TIMEOUT);
});
