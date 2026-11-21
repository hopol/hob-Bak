import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedLoginStore, changedCookies, mergeCookies, pageMatchesCookieSite, pushCookiesToBrowsers, refreshAllowed, removedCookies, sharedLoginPaths } from "../../desktop/desktopd/shared-login.mjs";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const cookie = (name: string, value: string, domain = "127.0.0.1") => ({ name, value, domain, path: "/", secure: false, httpOnly: false, session: true });

describe("共享浏览器登录态", () => {
  it("把公共快照放在 desktop 数据目录，并在首次使用时合并各旧 profile 的 cookie", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-shared-login-")); homes.push(home);
    const store = new SharedLoginStore(home);
    expect(store.paths).toEqual(sharedLoginPaths(home));
    expect(store.paths.cookies).toBe(join(home, "shared-login", "cookies.json"));

    const fromA = await store.migrateProfile("a", [cookie("a", "1")]);
    const fromB = await store.migrateProfile("b", [cookie("b", "2")]);
    expect(fromA).toEqual([expect.objectContaining({ name: "a" })]);
    expect(fromB).toEqual(expect.arrayContaining([expect.objectContaining({ name: "a" }), expect.objectContaining({ name: "b" })]));
    expect(store.snapshot()).toEqual(fromB);
    expect(JSON.parse(readFileSync(store.paths.state, "utf8")).profiles).toEqual({ a: true, b: true });
  });

  it("已知 profile 重启时合并本地新增 cookie", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-shared-login-")); homes.push(home);
    const store = new SharedLoginStore(home);
    await store.migrateProfile("a", [cookie("session", "old")]);
    const merged = await store.migrateProfile("a", [cookie("session", "new")]);
    expect(merged).toEqual([expect.objectContaining({ name: "session", value: "new" })]);
  });

  it("关闭或同步时只导出相对基线新增和变更的 cookie", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-shared-login-")); homes.push(home);
    const store = new SharedLoginStore(home);
    const baseline = [cookie("session", "S2", "x.example"), cookie("keep", "same", "x.example")];
    await store.syncProfile("a", baseline);
    const browserBaseline = [cookie("session", "S1", "x.example"), cookie("keep", "same", "x.example")];
    const oldBrowser = [cookie("session", "S1", "x.example"), cookie("keep", "same", "x.example")];
    expect(changedCookies(browserBaseline, oldBrowser)).toEqual([]);
    await store.syncProfile("b", changedCookies(browserBaseline, oldBrowser));
    expect(store.snapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "session", value: "S2" })]));
    const changed = [cookie("session", "S3", "x.example"), cookie("keep", "same", "x.example"), cookie("new", "1", "x.example")];
    expect(changedCookies(baseline, changed)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "session", value: "S3" }), expect.objectContaining({ name: "new" })]));
    await store.syncProfile("a", changedCookies(baseline, changed));
    expect(store.snapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "session", value: "S3" }), expect.objectContaining({ name: "new", value: "1" })]));
  });

  it("登录同步后把公共 cookie 推给正在运行的 CDP profile", async () => {
    const entries = new Map([
      ["a", { settledOk: true, cookieBaseline: [] }],
      ["b", { settledOk: true, cookieBaseline: [] }],
    ]);
    const pushed: string[] = [];
    const cookies = [cookie("session", "S2", "x.example")];
    const removed = [{ name: "logout", domain: "x.example", path: "/" }];
    await pushCookiesToBrowsers("a", entries, cookies, async (entry, next, deleted) => { pushed.push(entry === entries.get("b") ? `${next.length}/${deleted.length}` : "other"); }, removed);
    expect(pushed).toEqual(["1/1"]);
    expect(entries.get("b")?.cookieBaseline).toEqual([]);
    // 推送不改变目标浏览器的基线；只有下一轮实际读到的 cookie 才能成为它的基线
    const own = cookie("pref", "dark", "y.example");
    entries.get("b")!.cookieBaseline = [own];
    await pushCookiesToBrowsers("a", entries, cookies, async () => {});
    expect(entries.get("b")?.cookieBaseline).toEqual([own]);
    expect(changedCookies(entries.get("b")!.cookieBaseline, [own, ...cookies])).toEqual([expect.objectContaining({ name: "session" })]);
  });

  it("目标浏览器没收到公共 cookie 时，后续同步不会把它误判为退出登录", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-shared-login-")); homes.push(home);
    const store = new SharedLoginStore(home);
    const common = cookie("session", "S1", "x.example");
    await store.syncProfile("a", [common]);
    const entries = new Map([
      ["a", { settledOk: true, cookieBaseline: [common] }],
      ["b", { settledOk: true, cookieBaseline: [] }],
    ]);
    await pushCookiesToBrowsers("a", entries, [common], async () => {
      // 模拟分区限制或无效域名导致 Chrome 拒收，b 的实际读取结果仍为空。
    });
    for (let i = 0; i < 3; i++) {
      const previous = entries.get("b")!.cookieBaseline;
      const actual = [];
      const changed = changedCookies(previous, actual);
      const removed = removedCookies(previous, actual);
      if (changed.length || removed.length) await store.syncProfile("b", changed, removed);
      entries.get("b")!.cookieBaseline = actual;
    }
    expect(store.snapshot()).toEqual([expect.objectContaining({ name: "session", value: "S1" })]);
  });

  it("退出登录从公共快照和其他浏览器删除 cookie", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-shared-login-")); homes.push(home);
    const store = new SharedLoginStore(home);
    const active = cookie("session", "S1", "x.example");
    await store.syncProfile("a", [active, cookie("keep", "same", "x.example")]);
    const removed = removedCookies([active, cookie("keep", "same", "x.example")], [cookie("keep", "same", "x.example")]);
    expect(removed).toEqual([{ name: "session", domain: "x.example", path: "/" }]);
    await store.syncProfile("a", [], removed);
    expect(store.snapshot()).toEqual([expect.objectContaining({ name: "keep" })]);
  });

  it("网站匹配和刷新限频按域名计算", () => {
    expect(pageMatchesCookieSite("https://app.x.example/path", "x.example")).toBe(true);
    expect(pageMatchesCookieSite("https://other.example/path", "x.example")).toBe(false);
    expect(refreshAllowed([1_000, 10_000, 59_999], 60_000)).toBe(false);
    expect(refreshAllowed([0, 10_000], 60_000)).toBe(true);
  });

  it("同名 cookie 用最新同步值，两个 profile 并发同步不会丢掉另一方的域", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-shared-login-")); homes.push(home);
    const store = new SharedLoginStore(home);
    await Promise.all([
      store.syncProfile("a", [cookie("session", "a", "a.example")]),
      store.syncProfile("b", [cookie("session", "b", "b.example")]),
    ]);
    expect(store.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "session", value: "a", domain: "a.example" }),
      expect.objectContaining({ name: "session", value: "b", domain: "b.example" }),
    ]));
    expect(mergeCookies([cookie("session", "old")], [cookie("session", "new")])).toEqual([expect.objectContaining({ value: "new" })]);
  });
});
