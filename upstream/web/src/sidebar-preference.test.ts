import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("收起右栏退出云桌面展开和页面栈，再展开回到首页", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const store = await import("./store.ts");
  store.showNowWide();
  store.openRoutine("routine");
  store.openNewRoutine();
  store.collapsePanel();
  expect(store.getState()).toMatchObject({ collapsed: true, nowWide: false, panelStack: [] });
  store.expandPanel();
  expect(store.getState()).toMatchObject({ collapsed: false, nowWide: false, panelStack: [] });
});

it("左栏偏好保存、恢复并保留其他界面偏好", async () => {
  const storage = new Map([["hob.ui", JSON.stringify({ other: 42 })]]);
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const first = await import("./store.ts");
  expect(first.getState().sideCollapsed).toBe(false);
  first.toggleSideCollapsed();
  expect(JSON.parse(storage.get("hob.ui")!)).toEqual({ other: 42, sideCollapsed: true });
  vi.resetModules();
  const reopened = await import("./store.ts");
  expect(reopened.getState().sideCollapsed).toBe(true);
  reopened.toggleSideCollapsed();
  expect(JSON.parse(storage.get("hob.ui")!).sideCollapsed).toBe(false);
});
