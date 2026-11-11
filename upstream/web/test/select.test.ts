import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(4000);
});
afterAll(async () => { await browser?.close(); await server?.close(); });

async function fixture() {
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
  await page.goto(`http://127.0.0.1:${address.port}/test/select-fixture.html`);
}

describe("Select", () => {
  it("键盘跳过禁用项，选择后传入值并返回焦点", async () => {
    await fixture();
    const trigger = page.getByRole("button", { name: "测试选择" });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    expect(await trigger.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await page.locator("output").textContent()).toBe("c");
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
  });
  it("建群弹层里的选项可见且只列已有群", async () => {
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
    await page.goto(`http://127.0.0.1:${address.port}/?mock=1&scene=topics`);
    await page.getByTitle("返回首页").click();
    await page.waitForTimeout(600);
    await page.getByTitle("新建助手或建群").click();
    await page.getByRole("menuitem", { name: "建群" }).click();
    await page.locator('.gcreate .select-trigger').click();
    const menu = page.getByRole("listbox");
    expect(await menu.getByRole("option", { name: /Hob 开发/ }).isVisible()).toBe(true);
    expect(await menu.getByRole("option", { name: /登录页加/ }).count()).toBe(0);
    await menu.getByRole("option", { name: /Hob 开发/ }).click();
    expect(await page.locator('.gcreate .select-trigger').textContent()).toContain('照着「Hob 开发」建');
  });
  it("点击外部或按 Escape 关闭", async () => {
    await fixture();
    const trigger = page.getByRole("button", { name: "测试选择" });
    await trigger.click();
    await page.getByRole("button", { name: "外部" }).click();
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    await trigger.press("Enter");
    await trigger.press("Escape");
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator("output").textContent()).toBe("a");
  });
});
