import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 导入 store 需要的浏览器对象在这里补一份（合并函数本身不碰它们）
beforeEach(() => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: () => undefined }), innerWidth: 390 });
  vi.stubGlobal("document", { documentElement: { classList: { toggle: () => undefined }, style: {} } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("把这一页带来的任务、确认并进总表", () => {
  it("这一页没带条目时原样返回旧表，首页不会因为换了一张空表重画", async () => {
    const { mergePage } = await import("../src/store.ts");
    const base = { a: { id: "a", title: "旧的" } };
    expect(mergePage(base, undefined)).toBe(base);
    expect(mergePage(base, [])).toBe(base);
  });

  it("有新的就并进去，同一个 id 用这一页的", async () => {
    const { mergePage } = await import("../src/store.ts");
    const base = { a: { id: "a", title: "旧的" } };
    expect(mergePage(base, [{ id: "a", title: "新的" }, { id: "b", title: "乙" }])).toEqual({
      a: { id: "a", title: "新的" },
      b: { id: "b", title: "乙" },
    });
  });
});
