import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base: string;

beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
});

afterAll(async () => { await browser?.close(); await server?.close(); });

describe("助手说明界面", () => {
  it("资料面板编辑保存长说明，重新打开后保留换行", async () => {
    await page.goto(`${base}/?mock=1&scene=s1`);
    await page.getByTitle("编辑助手").click();
    const input = page.getByLabel("补充提示词");
    const value = `第一行\n${"详细格式和工作方法。".repeat(400)}\n最后一行`;
    await input.fill(value);
    await input.blur();
    await page.getByText("已保存").first().waitFor();
    await page.getByTitle("返回").last().click();
    await page.getByTitle("编辑助手").click();
    expect(await page.getByLabel("补充提示词").inputValue()).toBe(value);
  }, 30000);

  it("草稿卡预览说明并用统一展开行展开全文", async () => {
    await page.goto(`${base}/?mock=1&scene=readme-cards`);
    const preview = page.locator(".draft-instructions");
    const disclosure = page.locator(".draft-instructions-disclosure > .disclosure-row");
    await preview.waitFor();
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    await disclosure.click();
    expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await preview.innerText()).toContain("遇到不确定的归属时列出问题。");
    await disclosure.click();
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
  }, 30000);
});
