import { afterEach, describe, expect, it, vi } from "vitest";
import { skillUsage } from "../src/skill-usage.ts";
import { realApi } from "../src/api.ts";

describe("助手技能", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("显示用量、上次使用时间和版本", () => {
    const now = new Date(2026, 10, 5, 10);
    expect(skillUsage({ uses: 3, lastUsedAt: new Date(2026, 10, 5, 9).toISOString(), version: 2 }, now)).toBe("用过 3 次 · 上次今天 09:00 · 第 2 版");
    expect(skillUsage({ uses: 0, version: 1 }, now)).toBe("还没用过 · 第 1 版");
    expect(skillUsage({ uses: 1, version: 3 }, now)).toBe("用过 1 次 · 第 3 版");
  });

  it("收到技能事件时重新加载对应助手的列表", async () => {
    vi.stubGlobal("location", { search: "", hash: "" });
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1440 });
    const skill = { name: "test", title: "测试", description: "说明", path: "/test/SKILL.md", version: 2, createdAt: "", updatedAt: "", uses: 0, enabled: true };
    const list = vi.spyOn(realApi, "assistantSkills").mockResolvedValue([skill]);
    const { applyEvent, getState } = await import("../src/store.ts");
    applyEvent({ type: "skills", assistantId: "bird" });
    await vi.waitFor(() => expect(getState().assistantSkills.bird?.skills).toEqual([skill]));
    expect(list).toHaveBeenCalledWith("bird");
    expect(getState().assistantSkills.hob).toBeUndefined();
  });
});
