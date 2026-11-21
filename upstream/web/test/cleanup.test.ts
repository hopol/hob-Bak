import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base: string;
const BROWSER_TEST_TIMEOUT = 90_000;

beforeAll(async () => {
  server = await createServer({
    server: { port: 0, host: "127.0.0.1", proxy: {} },
    plugins: [{ name: "cleanup-test-exports", enforce: "pre", transform(code, id) {
      if (id.endsWith("/components/Items.tsx")) return `${code}\nexport { SingleQuestionCard, JobCard };`;
      if (id.endsWith("/components/Settings.tsx")) return `${code}\nexport { McpDetail };`;
    } }],
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ locale: "zh-CN" });
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(60_000);
});
afterAll(async () => { await page?.close(); await browser?.close(); await server?.close(); });

async function fixture(name: string) { await page.goto(`${base}/test/cleanup-fixture.html?fixture=${name}&lang=zh-CN`); }
async function calls(key: string) { return page.evaluate((k) => (window as unknown as { cleanupCalls: Record<string, number> }).cleanupCalls[k], key); }

describe("前端失败路径", () => {
  it("云桌面展开默认 720，拖到最宽按视口、左栏和高度封顶，刷新恢复左栏偏好和宽度", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/?mock=1&a=hob&desktop=ready&lang=zh-CN`);
    const prompt = page.getByRole("button", { name: "暂不开启" });
    if (await prompt.isVisible()) await prompt.click();
    await page.getByRole("button", { name: "在侧栏展开", exact: true }).first().click();
    const panel = page.locator(".panelwrap.focus");
    await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(720);
    expect(await panel.locator(".sidebar-card").count()).toBe(0);
    // 拖动左边缘：往左拖很远也只到上限（对话区留 420px）
    const handle = (await page.locator(".panel-resize").boundingBox())!;
    await page.mouse.move(handle.x + 4, 400);
    await page.mouse.down();
    await page.mouse.move(handle.x - 2000, 400, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(724);
    // 左栏收起后上限变大，拖过的宽度不变；再拖才变宽
    await page.getByRole("button", { name: "收起左栏" }).click();
    await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(724);
    const wider = (await page.locator(".panel-resize").boundingBox())!;
    await page.mouse.move(wider.x + 4, 400);
    await page.mouse.down();
    await page.mouse.move(wider.x - 2000, 400, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(1020);
    // 矮一些的屏幕：按画面放满高度封顶
    await page.setViewportSize({ width: 1920, height: 700 });
    await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(976);
    await page.reload();
    await expect.poll(() => page.getByRole("button", { name: "展开左栏" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "展开左栏" }).click();
    await page.getByRole("button", { name: "在侧栏展开", exact: true }).first().click();
    await page.getByRole("button", { name: "缩小右栏", exact: true }).first().click();
    expect(await page.locator(".panelwrap .sidebar-card").count()).toBeGreaterThan(0);
  }, BROWSER_TEST_TIMEOUT);

  it("右栏各页只显示一个收起按钮，收起展开后回到首页", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const go = async (query: string) => {
      await page.goto(`${base}/${query}`);
      const prompt = page.getByRole("button", { name: "暂不开启" });
      if (await prompt.isVisible()) await prompt.click();
    };
    const root = page.locator(".panelwrap > .panel > .phead");
    const top = page.locator(".panel-layer:not(.leaving) .panel-head").last();
    const check = async (head: typeof top) => {
      await expect.poll(() => head.getByRole("button", { name: "收起右栏" }).count()).toBe(1);
      expect(await head.getByRole("button", { name: "收起右栏" }).isVisible()).toBe(true);
      expect(await head.locator('button[title="关闭"]:visible').count()).toBe(0);
    };
    const back = async () => { await top.getByTitle("返回").click(); };
    await go("?mock=1&a=hob&desktop=ready&lang=zh-CN");
    await check(root);
    await page.locator('.now-acts button[title="在侧栏展开"]').click();
    await check(page.locator(".focus-head"));
    await page.locator('.focus-head button[title="收起右栏"]').click();
    await page.getByRole("button", { name: "展开右栏" }).click();
    await check(root);
    expect(await page.locator(".focus-head").count()).toBe(0);
    await root.getByTitle("编辑助手").click();
    await check(top);
    await back();
    for (const title of ["定时任务", "技能", "知识库", "执行前确认"]) {
      await page.locator(".panelwrap > .panel .pbody").getByText(title, { exact: false }).first().click();
      await check(top);
      if (title === "定时任务") {
        await page.locator(".panel-layer:not(.leaving) .pbody button").first().click();
        await check(top);
        await back();
        await top.getByTitle("新建定时任务").click();
        await check(top);
        await back();
      }
      await back();
    }
    await page.locator(".chat").getByText("排查页面卡顿").first().click();
    await check(top);
    await top.getByTitle("切换全宽").click();
    await check(top);
    await back();
    await go("?mock=1&a=server&lang=zh-CN");
    await page.locator(".chat").getByText("清理旧日志").first().click();
    await page.locator(".panel-layer:not(.leaving)").getByText("log-cleanup-1031.md", { exact: false }).first().click();
    await check(top);
    await top.getByTitle("切换全宽").click();
    await check(top);
    await go("?mock=1&scene=topics&lang=zh-CN#/group/g-topics");
    await check(root);
    await root.getByTitle("编辑群").click();
    await check(top);
    await back();
    await page.locator(".panelwrap > .panel .gm-open").first().click();
    await check(top);
    await go("?mock=1&scene=topics&lang=zh-CN#/group/t-remember");
    await check(root);
    await go("?mock=1&lang=zh-CN");
    await page.locator('.sidestack button[title="首页"]').click();
    await page.locator(".sidestack button.more").filter({ hasText: "全部" }).last().click();
    await check(top);

    await page.setViewportSize({ width: 390, height: 844 });
    await go("?mock=1&a=hob&desktop=ready&lang=zh-CN");
    await page.getByText("主助手", { exact: true }).first().click();
    await page.getByRole("button", { name: "助手信息" }).click();
    expect(await page.getByRole("button", { name: "收起右栏" }).count()).toBe(0);
    await page.getByTitle("编辑助手").last().click();
    expect(await page.getByRole("button", { name: "收起右栏" }).count()).toBe(0);
    await page.getByTitle("返回").last().click();
    await page.getByTitle("返回").last().click();
    await page.locator(".chat").getByText("排查页面卡顿").first().click();
    expect(await page.getByRole("button", { name: "收起右栏" }).count()).toBe(0);
  }, BROWSER_TEST_TIMEOUT);

  it("F19 混排保存后浏览器刷新仍按原顺序展示", async () => {
    await fixture("pins");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole("button", { name: "保存顺序" }).click();
    await expect.poll(() => page.locator("output").textContent()).toBe("g,a,b");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("fixture.assistants"))).toContain('"b":2');
    await page.reload();
    await expect.poll(() => page.locator("output").textContent()).toBe("g,a,b");
  }, BROWSER_TEST_TIMEOUT);
  it("F21 提交失败后单问题卡可重新选择", async () => {
    await fixture("question");
    await page.getByRole("button", { name: /继续/ }).click();
    await expect.poll(() => calls("answer")).toBe(1);
    await expect.poll(() => page.getByRole("button", { name: /暂停/ }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: /暂停/ }).click();
    await expect.poll(() => calls("answer")).toBe(2);
  }, BROWSER_TEST_TIMEOUT);
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
  }, BROWSER_TEST_TIMEOUT);
  it("F29 翻页提示在深浅主题都使用 text3", async () => {
    await fixture("older");
    const color = async () => page.locator(".older-messages").evaluate(el => [getComputedStyle(el).color, getComputedStyle(document.documentElement).getPropertyValue("--text3").trim()]);
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle("dark", value), dark);
      const [actual, variable] = await color();
      const expected = await page.evaluate(value => { const el = document.createElement("span"); el.style.color = value; document.body.append(el); const result = getComputedStyle(el).color; el.remove(); return result; }, variable);
      expect(actual).toBe(expected);
    }
  }, BROWSER_TEST_TIMEOUT);
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
  }, BROWSER_TEST_TIMEOUT);
});
