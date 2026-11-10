import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { realApi } from "../src/api.ts";
import type { Rule } from "../../shared/types.ts";

const initial: Rule[] = [
  { id: "a", text: "发布前确认", mode: "ask", changedAt: new Date().toISOString() },
  { id: "b", text: "使用中文", mode: "allow", changedAt: "2020-01-01T00:00:00.000Z" },
];

beforeAll(() => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1440 });
});
afterEach(() => vi.restoreAllMocks());

describe("全局规则设置", () => {
  it("渲染两组并保存编辑、新增、删除，失败显示原因，事件重拉", async () => {
    let rules = initial.map((rule) => ({ ...rule }));
    const load = vi.spyOn(realApi, "rules").mockImplementation(async () => ({ rules: structuredClone(rules) }));
    const save = vi.spyOn(realApi, "saveRules").mockImplementation(async (next) => {
      rules = next.map((rule, i) => ({ ...rule, id: rule.id ?? `new-${i}`, changedAt: new Date().toISOString() }));
      return { rules: structuredClone(rules) };
    });
    const store = await import("../src/store.ts");
    const { SettingsPage } = await import("../src/components/Settings.tsx");
    store.openSettings();
    store.setSection("rules");
    await store.loadRules();
    let html = renderToStaticMarkup(createElement(SettingsPage, { narrow: false, leaving: false }));
    expect(html).toContain("执行前确认");
    expect(html).toContain("一律照做");
    expect(html).toContain("发布前确认");
    expect(html).toContain("使用中文");
    expect(html).toContain("最近修改");
    await store.saveRules(rules.map((rule) => rule.id === "a" ? { ...rule, text: "发布需要确认" } : rule));
    await store.saveRules([...store.getState().globalRules.rules!, { text: "新增规则", mode: "allow" }]);
    await store.saveRules(store.getState().globalRules.rules!.filter((rule) => rule.id !== "b"));
    expect(save).toHaveBeenCalledTimes(3);
    expect(store.getState().globalRules.rules?.map((rule) => rule.text)).toEqual(["发布需要确认", "新增规则"]);
    save.mockRejectedValueOnce(new Error("磁盘不可写"));
    expect(await store.saveRules([])).toBe(false);
    html = renderToStaticMarkup(createElement(SettingsPage, { narrow: false, leaving: false }));
    expect(html).toContain("保存失败：磁盘不可写");
    expect(html).toContain("新增规则");
    rules = [{ ...initial[0], text: "外部修改" }];
    store.applyEvent({ type: "rules" });
    await vi.waitFor(() => expect(store.getState().globalRules.rules?.[0].text).toBe("外部修改"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("API 使用整表接口且监听 rules 事件", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ rules: initial })) );
    vi.stubGlobal("fetch", fetch);
    await realApi.rules();
    await realApi.saveRules(initial);
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/rules", expect.anything());
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/rules", expect.objectContaining({ method: "PUT", body: JSON.stringify({ rules: initial }) }));
    const addEventListener = vi.fn();
    vi.stubGlobal("EventSource", class { addEventListener = addEventListener; close() {} });
    realApi.events({ onEvent() {}, onReconnect() {}, onDown() {} });
    expect(addEventListener).toHaveBeenCalledWith("rules", expect.any(Function));
  });
});
