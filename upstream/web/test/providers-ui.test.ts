import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({ server: { port: 31861, strictPort: true, host: "127.0.0.1" } });
  await server.listen();
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  page.setDefaultTimeout(30_000);
});
afterAll(async () => { await browser?.close(); await server?.close(); });

describe("服务商详情", () => {
  it("管理模型、思考档和连接修改，并保护默认模型", async () => {
    await page.goto("http://127.0.0.1:31861/?mock=1&lang=zh-CN#/settings/providers");
    await page.getByRole("button", { name: /我的代理/ }).click();
    expect(await page.getByRole("button", { name: "保存", exact: true }).count()).toBe(0);
    const gpt = page.locator(".provider-model").filter({ hasText: "GPT X" });
    expect(await gpt.count()).toBe(1);
    const roster = gpt.getByRole("button", { name: "加入可用模型" });
    expect(await roster.getAttribute("aria-pressed")).toBe("false");
    await roster.click();
    await expect.poll(() => roster.getAttribute("aria-pressed")).toBe("true");
    await roster.click();
    await expect.poll(() => roster.getAttribute("aria-pressed")).toBe("false");
    await roster.click();
    await expect.poll(() => roster.getAttribute("aria-pressed")).toBe("true");

    await gpt.locator(".provider-model-label").click();
    const image = gpt.getByRole("button", { name: "能看图", exact: true });
    expect(await image.getAttribute("aria-pressed")).toBe("true");
    await image.click();
    await expect.poll(() => image.getAttribute("aria-pressed")).toBe("false");
    await gpt.locator(".think-levels > .disclosure-row").click();
    const level = gpt.locator('input[title="留空则按服务商协议的默认值发送"]').first();
    await level.fill("off-value");
    await level.blur();
    await expect.poll(() => gpt.getByText("已保存思考档").isVisible()).toBe(true);

    await page.evaluate(async () => {
      const load = new Function("return import('/src/store.ts')") as () => Promise<{ saveSettings: (patch: unknown) => Promise<boolean> }>;
      const store = await load();
      await store.saveSettings({ models: { conversation: { ref: "my-proxy/gpt-x", thinking: "off" } } });
    });
    await expect.poll(() => gpt.getByText("默认模型", { exact: true }).count()).toBe(1);
    expect(await gpt.getByRole("button", { name: "加入可用模型" }).count()).toBe(0);

    const gemini = page.locator(".provider-model").filter({ hasText: "Gemini Sample" });
    await gemini.locator(".provider-model-label").click();
    await gemini.getByRole("button", { name: "从这个服务商移除这个模型" }).click();
    await gemini.getByRole("button", { name: "确认移除" }).click();
    await expect.poll(() => gemini.count()).toBe(0);

    await page.locator(".formcard input").first().fill("示例代理");
    expect(await page.getByRole("button", { name: "保存", exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "取消", exact: true }).isVisible()).toBe(true);
  }, 90_000);
});
