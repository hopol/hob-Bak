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
    const summary = (id: string) => ({ id, name: id, duty: "", sprite: "hob", primary: false, pinned: true, hidden: false, notify: true, instructions: "", createdAt: "", unread: 2 }) as unknown as AssistantSummary;
    expect(getState().sel).toBe("hob");
    applyEvent({ type: "assistant", assistant: summary("hob") });
    applyEvent({ type: "assistant", assistant: summary("bird") });
    expect(getState().assistants.find((a) => a.id === "hob")?.unread).toBe(0);
    expect(getState().assistants.find((a) => a.id === "bird")?.unread).toBe(2);
    expect(markRead.mock.calls).toEqual([["hob"]]);
  });
});
