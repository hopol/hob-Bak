import { describe, expect, it } from "vitest";
import type { PageLive } from "../../shared/types.ts";
import { shouldOpenLive, visibleLiveCards } from "../src/page-live.ts";

const page: PageLive = { assistantId: "hob", callId: "call", html: "<p>内容", state: "writing" };
const options = { seen: false, closed: false, assistantId: "hob", inChat: true };

describe("页面实时预览", () => {
  it("只在当前对话第一次生成时自动打开", () => {
    expect(shouldOpenLive(page, options)).toBe(true);
    expect(shouldOpenLive(page, { ...options, assistantId: "other" })).toBe(false);
    expect(shouldOpenLive(page, { ...options, inChat: false })).toBe(false);
    expect(shouldOpenLive(page, { ...options, seen: true })).toBe(false);
    expect(shouldOpenLive(page, { ...options, closed: true })).toBe(false);
  });

  it("只在生成中显示占位卡，完成和失败都移除", () => {
    const failed: PageLive = { ...page, callId: "failed", state: "failed", error: "保存失败" };
    expect(visibleLiveCards([{ ...page, state: "done", path: "/page.html" }, failed], "hob")).toEqual([]);
    expect(visibleLiveCards([page], "other")).toEqual([]);
  });
});
