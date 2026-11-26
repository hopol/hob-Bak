import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let baseUrl: string;

beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  page.setDefaultTimeout(30_000);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("工作目录前端交互与只读展示", () => {
  it("新建群：沿用已有群不复制工作目录，报错保留输入，绑定后右栏与编辑页只读展示", async () => {
    await page.goto(`${baseUrl}/?mock=1&scene=workspace-cwd&lang=zh-CN`);
    // 初始落在已绑定工作目录的群话题下，右栏只读显示「工作目录 · 跟随群」
    const panel = page.locator("aside.panel");
    await expect.poll(() => panel.getByText("工作目录 · 跟随群").isVisible()).toBe(true);
    await expect.poll(() => panel.getByText("/workspace/hob-app").isVisible()).toBe(true);

    // 打开编辑群页：确认工作目录只读展示，没有工作目录输入框
    await panel.getByRole("button", { name: "编辑群" }).click();
    await expect.poll(() => panel.locator(".field.ro", { hasText: "/workspace/hob-app" }).isVisible()).toBe(true);
    await expect.poll(() => panel.getByText("创建时已绑定，群内及所有话题共用此目录，不可修改。").isVisible()).toBe(true);

    // 回到首页打开新建群弹窗（mock 里运行中的示例任务会定期追加日志并滚动，若撞上菜单自动关闭则重开）
    await page.getByRole("button", { name: "返回首页" }).click();
    await expect.poll(() => page.locator('.home-row[data-row="g-home"]').isVisible()).toBe(true);
    const dialog = page.getByRole("dialog", { name: "新建群" });
    await expect.poll(async () => {
      if (await dialog.isVisible()) return true;
      const createItem = page.getByRole("menuitem", { name: "建群" });
      if (!(await createItem.isVisible())) {
        await page.getByRole("button", { name: "新建助手或建群" }).click();
      }
      if (await createItem.isVisible()) {
        await createItem.click({ timeout: 500 }).catch(() => undefined);
      }
      return dialog.isVisible();
    }, { timeout: 15_000 }).toBe(true);

    // 沿用已绑定工作目录的「敏捷团队」创建：成员自动勾好，但工作目录输入框保持空白
    await dialog.locator(".pick").click();
    await page.getByRole("option", { name: /沿用「敏捷团队」创建/ }).click();
    const cwdInput = dialog.getByLabel("工作目录（可选）");
    expect(await cwdInput.inputValue()).toBe("");

    // 填入非法相对路径提交：展示错误并保留用户输入
    const nameInput = dialog.getByLabel("群名");
    await nameInput.fill("前端工作区");
    await cwdInput.fill("relative/app");
    await dialog.getByRole("button", { name: "建群" }).click();
    await expect.poll(() => dialog.locator(".gcreate-error").textContent()).toContain("绝对路径");
    expect(await nameInput.inputValue()).toBe("前端工作区");
    expect(await cwdInput.inputValue()).toBe("relative/app");

    // 修正为合法绝对路径提交：创建成功，右栏显示绑定目录
    await cwdInput.fill("/workspace/demo-app");
    await dialog.getByRole("button", { name: "建群" }).click();
    await expect.poll(() => dialog.count()).toBe(0);
    await expect.poll(() => panel.getByText("/workspace/demo-app").isVisible()).toBe(true);
  }, 90_000);

  it("新建话题：已绑定群只读提示跟随群；未绑定群可填工作目录并报错保留输入", async () => {
    await page.goto(`${baseUrl}/?mock=1&scene=workspace-cwd&lang=zh-CN`);
    // 1. 当前在已绑定目录的「敏捷团队」下，打开新建话题对话框
    await page.getByRole("button", { name: "创建新话题" }).click();
    const inheritedDialog = page.getByRole("dialog", { name: "新话题" });
    await expect.poll(() => inheritedDialog.isVisible()).toBe(true);
    await expect.poll(() => inheritedDialog.locator(".field.ro").textContent()).toContain("跟随群（/workspace/hob-app）");
    expect(await inheritedDialog.getByLabel("工作目录（可选）").count()).toBe(0);
    await inheritedDialog.getByRole("button", { name: "取消" }).click();

    // 2. 切到未绑定目录的「家里机器」，打开新建话题对话框
    await page.getByRole("button", { name: "返回首页" }).click();
    await page.locator('.home-row[data-row="g-home"]').click();
    await page.getByRole("button", { name: "创建新话题" }).click();
    const unboundDialog = page.getByRole("dialog", { name: "新话题" });
    await expect.poll(() => unboundDialog.isVisible()).toBe(true);

    const titleInput = unboundDialog.getByLabel("话题名");
    const cwdInput = unboundDialog.getByLabel("工作目录（可选）");
    await titleInput.fill("同步脚本排障");
    await cwdInput.fill("bad/path");
    await unboundDialog.getByRole("button", { name: "创建话题" }).click();
    await expect.poll(() => unboundDialog.locator(".gcreate-error").textContent()).toContain("绝对路径");
    expect(await titleInput.inputValue()).toBe("同步脚本排障");
    expect(await cwdInput.inputValue()).toBe("bad/path");

    await cwdInput.fill("/srv/nas/sync");
    await unboundDialog.getByRole("button", { name: "创建话题" }).click();
    await expect.poll(() => unboundDialog.count()).toBe(0);

    const panel = page.locator("aside.panel");
    await expect.poll(() => panel.getByText("工作目录 · 本话题").isVisible()).toBe(true);
    await expect.poll(() => panel.getByText("/srv/nas/sync").isVisible()).toBe(true);
  }, 90_000);
});
