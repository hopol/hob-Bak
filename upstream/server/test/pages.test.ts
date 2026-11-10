import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http.ts";
import { renderPage, pageTool } from "../src/pages.ts";
import { livePageHtml, pageHtml } from "../../shared/page-shell.ts";
import type { HobEvent } from "../../shared/types.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text } from "./helpers.ts";

const html = "<h2>建立连接</h2><p>客户端发送 SYN。</p>";

describe("展示页面", () => {
  it("存盘和实时外壳共享样式和隔离策略", () => {
    const stored = pageHtml("标题", "摘要", html);
    const live = livePageHtml();
    expect(live.match(/<style>([\s\S]*?)<\/style>/)?.[1]).toBe(stored.match(/<style>([\s\S]*?)<\/style>/)?.[1]);
    expect(live).toContain("default-src 'none'");
    expect(live).toContain("querySelectorAll('script,iframe,object,embed')");
    expect(live).toContain("a.name.toLowerCase()==='srcdoc'");
  });

  it("Router 假模型调用成功和失败都推送最终状态", async () => {
    const hob = makeHob({}, { tokensPerSecond: 100 });
    try {
      const events: HobEvent[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "page-live") events.push(event); });
      hob.faux.setResponses([call("show_page", { title: "TCP", summary: "握手", html })]);
      await hob.runtime.router.send("hob", { text: "画一页" });
      await hob.runtime.router.waitIdle("hob");
      const pages = events.filter((event) => event.type === "page-live");
      const writing = pages.filter((event) => event.state === "writing");
      expect(writing.length).toBeGreaterThan(1);
      expect(writing.length).toBeLessThan(JSON.stringify({ title: "TCP", summary: "握手", html }).length / 4);
      expect(writing.some((event) => event.html === html)).toBe(true);
      expect(pages.find((event) => event.state === "done")?.path).toMatch(/\.html$/);
      events.length = 0;
      hob.faux.setResponses([call("show_page", { title: "TCP", summary: "握手", html: "<body>错</body>" }), text("出错了")]);
      await hob.runtime.router.send("hob", { text: "再画一页" });
      await hob.runtime.router.waitIdle("hob");
      expect(events.some((event) => event.type === "page-live" && event.state === "failed" && event.error?.includes("正文片段"))).toBe(true);
    } finally { hob.close(); }
  });
  it("中断生成时通知失败并保留草稿", async () => {
    const hob = makeHob({}, { tokensPerSecond: 20 });
    try {
      const events: HobEvent[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "page-live") events.push(event); });
      hob.faux.setResponses([call("show_page", { title: "TCP", summary: "握手", html: html.repeat(8) })]);
      await hob.runtime.router.send("hob", { text: "画一页" });
      await vi.waitFor(() => expect(events.some((event) => event.type === "page-live" && event.state === "writing")).toBe(true));
      await hob.runtime.router.stop("hob");
      await hob.runtime.router.waitIdle("hob");
      expect(events.some((event) => event.type === "page-live" && event.state === "failed")).toBe(true);
      expect(hob.runtime.router.items("hob").pageLive ?? []).toHaveLength(0);
    } finally { hob.close(); }
  });

  it("任务没有页面工具：只交 Markdown 和文件，展示交给助手", async () => {
    const hob = makeHob();
    try {
      const open = vi.spyOn(hob.runtime.pi, "open");
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      hob.faux.appendResponses([text("完成")]);
      await hob.runtime.jobs.start("hob", { title: "画图", instruction: "画一页" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      const worker = open.mock.calls.map(([options]) => options).find((options) => options.customTools.some((tool) => tool.name === "report"));
      expect(worker!.customTools.map((tool) => tool.name)).not.toContain("show_page");
      expect(worker!.customTools.map((tool) => tool.name)).not.toContain("make_page");
    } finally { hob.close(); }
  });

  it("套上 Hob 页面外壳，文件接口隔离内联", async () => {
    const hob = makeHob();
    try {
      const path = await renderPage(hob.home, "hob", "TCP <握手>", "三次交换", html);
      const page = readFileSync(path, "utf8");
      expect(page).toContain("<h1>TCP &lt;握手&gt;</h1>");
      expect(page).toContain(html);
      expect(page).toContain("default-src 'none'");
      expect(page).toContain("hob-page-link");
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const meta = await app.request(`/api/files/meta?path=${encodeURIComponent(path)}`, { headers: { cookie } });
      expect((await meta.json()).page).toBe(true);
      const response = await app.request(`/api/files?path=${encodeURIComponent(path)}&inline=1`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox");
      expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
      const outside = await app.request(`/api/files?path=${encodeURIComponent("/etc/hostname")}`, { headers: { cookie } });
      expect(outside.status).toBe(403);
    } finally { hob.close(); }
  });

  it("助手出卡后结束，send_file 发页面带标题和摘要", async () => {
    const hob = makeHob();
    try {
      const params = { title: "TCP 握手", summary: "三次交换建立连接", html };
      const router = await pageTool(hob.runtime, "hob").execute("r", params);
      expect(router.terminate).toBe(true);
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "file")).toHaveLength(1);
      const send = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "send_file")!;
      const special = await renderPage(hob.home, "hob", 'A & <B>', '摘要 "&"', html);
      await send.execute("send", { path: special });
      expect(hob.runtime.router.items("hob").items.find((item) => item.kind === "file" && item.path === special)).toMatchObject({ name: "A & <B>", meta: '摘要 "&"' });
    } finally { hob.close(); }
  });

  it("整页文档、超长、空内容都报错且不发卡", async () => {
    const hob = makeHob();
    try {
      const tool = pageTool(hob.runtime, "hob");
      const result = await tool.execute("x", { title: "错", summary: "错", html: "<html><body>整页</body></html>" });
      expect(result.isError).toBe(true);
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "file")).toHaveLength(0);
      await expect(renderPage(hob.home, "hob", "t", "s", "x".repeat(80001))).rejects.toThrow("80000");
      await expect(renderPage(hob.home, "hob", "t", "s", "  ")).rejects.toThrow("不能为空");
    } finally { hob.close(); }
  });

  it("关闭时不注册 Router 工具，旧工具也拒绝调用", async () => {
    const hob = makeHob({}, { settings: { general: { showPage: false } } });
    try {
      expect(buildRouterTools(hob.runtime, "hob").some((tool) => tool.name === "show_page")).toBe(false);
      const result = await pageTool(hob.runtime, "hob").execute("x", { title: "标题", summary: "摘要", html });
      expect(result.isError).toBe(true);
      const open = vi.spyOn(hob.runtime.pi, "open");
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      hob.faux.appendResponses([text("完成")]);
      await hob.runtime.jobs.start("hob", { title: "测试", instruction: "完成测试" });
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      const worker = open.mock.calls.map(([options]) => options).find((options) => options.customTools.some((tool) => tool.name === "report"));
      expect(worker).toBeDefined();
      expect(worker!.tools).not.toContain("show_page");
      expect(worker!.systemPrompt()).not.toContain("show_page");
    } finally { hob.close(); }
  });
});
