import { afterEach, describe, expect, it, vi } from "vitest";
import { realApi } from "../src/api.ts";
import type { AssistantSummary } from "../../shared/types.ts";

describe("未读", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("正看着的助手来了新回复直接算已读，别的助手照常亮未读", async () => {
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1440 });
    vi.stubGlobal("document", { visibilityState: "visible" });
    const markRead = vi.spyOn(realApi, "markRead").mockResolvedValue(undefined);
    const { applyEvent, getState } = await import("../src/store.ts");
    const summary = (id: string) => ({ id, name: id, duty: "", sprite: "hob", primary: false, pinned: true, hidden: false, notify: true, createdAt: "", unread: 2 }) as unknown as AssistantSummary;
    getState().sel = "hob"; // 正看着 Hob 的对话
    applyEvent({ type: "assistant", assistant: summary("hob") });
    applyEvent({ type: "assistant", assistant: summary("bird") });
    expect(getState().assistants.find((a) => a.id === "hob")?.unread).toBe(0);
    expect(getState().assistants.find((a) => a.id === "bird")?.unread).toBe(2);
    expect(markRead.mock.calls).toEqual([["hob"]]);
  });

  it("已读请求还没落到服务端时，旧摘要不能在返回首页后恢复未读", async () => {
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 390 });
    vi.stubGlobal("document", { visibilityState: "visible" });
    const markRead = vi.spyOn(realApi, "markRead").mockResolvedValue(undefined);
    vi.spyOn(realApi, "items").mockResolvedValue({ items: [], hasMore: false, jobs: [], approvals: [] });
    vi.spyOn(realApi, "profile").mockResolvedValue({ assistant: {} as AssistantSummary, rules: [], routines: [], worklog: [] });
    const { applyEvent, getState, select } = await import("../src/store.ts");
    const summary = (lastAt: string, unread: number) => ({
      id: "hob", name: "Hob", duty: "", sprite: "hob", primary: true, pinned: true, hidden: false,
      notify: true, createdAt: "2026-01-01T00:00:00.000Z", last: { text: "旧消息", at: lastAt }, unread,
      busy: false,
    }) as AssistantSummary;
    Object.assign(getState(), {
      assistants: [summary("2026-01-01T00:00:00.000Z", 2)],
      sel: null, gsel: null, page: "main", mobile: "list",
    });

    await select("hob");
    const readAt = getState().assistants[0]?.readAt;
    expect(readAt).toBeTruthy();
    expect(getState().assistants[0]?.unread).toBe(0);
    expect(markRead).toHaveBeenCalledWith("hob");

    // 返回首页后，已读请求尚未完成时到达的旧摘要仍然是同一批消息。
    getState().mobile = "list";
    applyEvent({ type: "assistant", assistant: summary("2026-01-01T00:00:00.000Z", 2) });
    expect(getState().assistants[0]?.unread).toBe(0);

    // 已读时间点之后的新消息仍然要亮未读。
    applyEvent({ type: "assistant", assistant: summary(new Date(Date.now() + 1000).toISOString(), 1) });
    expect(getState().assistants[0]?.unread).toBe(1);
  });
});
