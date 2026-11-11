import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base: string;

beforeAll(async () => {
  server = await createServer({
    server: { port: 0, host: "127.0.0.1", proxy: {} },
    plugins: [{ name: "cleanup-test-exports", enforce: "pre", transform(code, id) {
      if (id.endsWith("/components/Items.tsx")) return `${code}\nexport { SingleQuestionCard, JobCard };`;
      if (id.endsWith("/components/Projects.tsx")) return `${code}\nexport { NoteBox };`;
      if (id.endsWith("/components/Settings.tsx")) return `${code}\nexport { McpDetail };`;
    } }],
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  page = await browser.newPage();
});
afterAll(async () => { await page?.close(); await browser?.close(); await server?.close(); });

async function fixture(name: string) { await page.goto(`${base}/test/cleanup-fixture.html?fixture=${name}`); }
async function calls(key: string) { return page.evaluate((k) => (window as unknown as { cleanupCalls: Record<string, number> }).cleanupCalls[k], key); }

describe("前端失败路径", () => {
  it("F19 混排保存后浏览器刷新仍按原顺序展示", async () => {
    await fixture("pins");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole("button", { name: "保存顺序" }).click();
    await expect.poll(() => page.locator("output").textContent()).toBe("g,a,b");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("fixture.assistants"))).toContain('"b":2');
    await page.reload();
    await expect.poll(() => page.locator("output").textContent()).toBe("g,a,b");
  });
  it("F21 提交失败后单问题卡可重新选择", async () => {
    await fixture("question");
    await page.getByRole("button", { name: /继续/ }).click();
    await expect.poll(() => calls("answer")).toBe(1);
    await expect.poll(() => page.getByRole("button", { name: /暂停/ }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: /暂停/ }).click();
    await expect.poll(() => calls("answer")).toBe(2);
  });
  it("F22 任务补话失败保留草稿，组字 Enter 不发送", async () => {
    await fixture("job");
    await page.getByRole("button", { name: "补充要求", exact: true }).click();
    const input = page.getByPlaceholder("补充说明或更正方向");
    await input.fill("保留这段文字");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    expect(await calls("reply")).toBe(0);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => calls("reply")).toBe(1);
    await expect.poll(() => input.inputValue()).toBe("保留这段文字");
  });
  it("F22 事项补话组字 Enter 不发送", async () => {
    await fixture("project");
    const input = page.getByPlaceholder("补充说明…");
    await input.fill("补充");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    expect(await calls("project")).toBe(0);
    await input.press("Enter");
    await expect.poll(() => calls("project")).toBe(1);
  });
  it("F29 翻页提示在深浅主题都使用 text3", async () => {
    await fixture("older");
    const color = async () => page.locator(".older-messages").evaluate(el => [getComputedStyle(el).color, getComputedStyle(document.documentElement).getPropertyValue("--text3").trim()]);
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle("dark", value), dark);
      const [actual, variable] = await color();
      const expected = await page.evaluate(value => { const el = document.createElement("span"); el.style.color = value; document.body.append(el); const result = getComputedStyle(el).color; el.remove(); return result; }, variable);
      expect(actual).toBe(expected);
    }
  });
  it("F30 工具开关失败回原状态并以服务端返回为准", async () => {
    await fixture("mcp");
    const toggle = page.getByRole("button", { name: "tool启用" });
    await toggle.click();
    await expect.poll(() => calls("mcp")).toBe(1);
    await expect.poll(() => toggle.getAttribute("aria-pressed")).toBe("true");
    await toggle.click();
    await expect.poll(() => calls("mcp")).toBe(2);
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    await toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-pressed")).toBe("false");
  });
});
