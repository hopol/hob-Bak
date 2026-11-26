import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import { createMock } from "../src/mock.ts";

describe("README 演示场景", () => {
  it("电脑对话中的任务、页面和确认卡引用有效数据", async () => {
    const api = createMock("readme-chat");
    const conversation = await api.items("hob");
    expect(conversation.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "readme-job", status: "done" }),
      expect.objectContaining({ id: "readme-active", status: "running" }),
    ]));
    expect(conversation.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file", path: "/mock/readme-page.html" }),
      expect.objectContaining({ kind: "question", approvalId: "readme-chat-approval" }),
    ]));
    expect(conversation.approvals).toContainEqual(expect.objectContaining({ id: "readme-chat-approval", source: "router" }));
    expect(api.fileUrl("/mock/readme-page.html")).toBe("/mock/readme-page.html");
    expect(readFileSync(new URL("../public/mock/readme-page.html", import.meta.url), "utf8")).toContain("团队资料整理方案");
  });

  it("浮层卡片使用真实的演示条目和引用", async () => {
    const api = createMock("readme-cards");
    const conversation = await api.items("hob");
    expect(conversation.items.map((item) => item.kind)).toEqual(["image", "delegation", "draft", "note"]);
    expect(conversation.items).toContainEqual(expect.objectContaining({ kind: "image", status: "done", path: "/mock/readme-cover.svg" }));
    expect(conversation.delegations).toContainEqual(expect.objectContaining({ id: "readme-delegation", to: "page" }));
    expect(conversation.drafts).toContainEqual(expect.objectContaining({ id: "d-bird", status: "pending" }));
  });

  it("详细场景保留知识库资料、页面预览和桌面截图", async () => {
    const api = createMock("readme-knowledge");
    const { entries, collections } = await api.knowledge({ collection: "kc-1" });
    expect(entries).toHaveLength(5);
    expect(new Set(entries.map((entry) => entry.description)).size).toBe(entries.length);
    expect(entries.every((entry) => entry.index?.state === "ready")).toBe(true);
    expect(collections[0]).toMatchObject({ count: 5, indexed: 5 });
    const page = entries.find((entry) => entry.kind === "html")!;
    expect(api.fileUrl(page.path)).toBe("/mock/readme-page.html");
    const desktop = await createMock("readme-desktop").items("hob");
    expect(desktop.items).toContainEqual(expect.objectContaining({ kind: "file", path: "/mock/desktop.jpg" }));
  });

  it("写作的周报任务与对话、确认卡一致", async () => {
    const api = createMock("readme-profile");
    const jobs = await api.jobs({ assistantId: "page" });
    expect(jobs.jobs).toContainEqual(expect.objectContaining({ id: "readme-weekly", title: "整理本周周报", status: "done" }));
    const conversation = await api.items("page");
    expect(conversation.items).toContainEqual(expect.objectContaining({ kind: "job", jobId: "readme-weekly" }));
    expect(conversation.approvals).toContainEqual(expect.objectContaining({ id: "readme-approval", source: "router", status: "pending" }));
  });

  it("交互卡片与升级版提问卡场景在中英文下引用完整且支持双语", async () => {
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      const api = createMock("readme-interactive-cards");
      const conversation = await api.items("hob");
      expect(conversation.items.map((item) => item.kind)).toEqual(["user", "card", "question"]);
      expect(conversation.cards).toContainEqual(expect.objectContaining({ id: "readme-card-dns", status: "open" }));
      const approval = conversation.approvals.find((item) => item.id === "readme-ask-release");
      expect(approval?.questions).toHaveLength(3);
      expect(approval?.questions?.map((q) => q.input ?? "choice")).toEqual(["choice", "text", "date"]);
      if (locale === "en") {
        expect(approval?.title).toMatch(/^[A-Za-z0-9 ,.&'-]+$/);
      }
    }
    setLocale("zh");
  });

  it("插件市场场景包含工具插件与供应商插件并支持双语", async () => {
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      const api = createMock("readme-plugins");
      const [installed, catalog] = await Promise.all([api.plugins(), api.pluginCatalog()]);
      expect(catalog.plugins).toHaveLength(9);
      expect(catalog.plugins.map((p) => p.id)).toEqual(expect.arrayContaining(["github", "cloudflare", "gmail", "bitwarden", "copilot", "chatgpt", "zcode", "agy-cli"]));
      expect(installed.plugins.map((p) => p.plugin.id)).toEqual(["github", "cloudflare", "gmail", "bitwarden", "copilot"]);
      if (locale === "en") {
        expect(catalog.plugins.find((p) => p.id === "chatgpt")?.manifest.displayName).toBe("ChatGPT");
      }
    }
    setLocale("zh");
  });
});
