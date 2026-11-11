import { describe, expect, it, vi } from "vitest";
import { realApi } from "../src/api.ts";

vi.stubGlobal("location", { search: "", hash: "" });
vi.stubGlobal("localStorage", { getItem: () => null });
vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1440 });

describe("群资料缓存", () => {
  it("群成员或模型变化时刷新，普通消息摘要变化不刷新", async () => {
    const store = await import("../src/store.ts");
    const group = { id: "g-test", name: "群", purpose: "", ownerId: "a", members: ["a"], createdAt: "2026-01-01", unread: 0, busy: [] };
    Object.assign(store.getState(), { groups: [group], groupProfiles: { "g-test": { value: { group, rules: [], memberModels: {} } } } });
    const fetch = vi.spyOn(realApi, "groupProfile").mockResolvedValue({ group, rules: [], memberModels: {} });
    store.applyEvent({ type: "group", group: { ...group, last: { at: "2026-01-01", speaker: "user", text: "消息" } } });
    expect(fetch).not.toHaveBeenCalled();
    store.applyEvent({ type: "group", group: { ...group, members: ["a", "b"] } });
    expect(fetch).toHaveBeenCalledWith("g-test");
    fetch.mockRestore();
  });
});
