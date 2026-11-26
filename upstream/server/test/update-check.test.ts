import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import type { AboutInfo, Bootstrap, HobEvent, UpdateCheck } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { isNewerVersion, parseVersion, UPDATE_SOURCE, UpdateChecker } from "../src/update-check.ts";
import { makeHob } from "./helpers.ts";

afterEach(() => {
  setLocale("zh-CN");
  vi.useRealTimers();
});

function jsonFetch(body: unknown, status = 200, seen?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen?.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("版本比较", () => {
  it("只认三段数字 x.y.z，并按数字大小比较", () => {
    expect(parseVersion("1.14.0")).toEqual([1, 14, 0]);
    expect(parseVersion(" 2.0.10 ")).toEqual([2, 0, 10]);

    // 新版本
    expect(isNewerVersion("2.0.0", "1.14.0")).toBe(true);
    expect(isNewerVersion("1.15.0", "1.14.0")).toBe(true);
    expect(isNewerVersion("1.14.1", "1.14.0")).toBe(true);
    expect(isNewerVersion("1.2.10", "1.2.9")).toBe(true);

    // 相同和更旧
    expect(isNewerVersion("1.14.0", "1.14.0")).toBe(false);
    expect(isNewerVersion("1.13.9", "1.14.0")).toBe(false);
    expect(isNewerVersion("0.99.99", "1.0.0")).toBe(false);

    // 格式不对
    for (const bad of ["", "v1.15.0", "1.15", "1.15.0.1", "1.15.0-beta.1", "latest", "1.a.0"]) {
      expect(parseVersion(bad)).toBeNull();
      expect(isNewerVersion(bad, "1.14.0")).toBe(false);
    }
  });
});

describe("UpdateChecker", () => {
  it("查 npm registry 最新版本，比本机新记 available，相同或更旧记 up-to-date", async () => {
    const urls: string[] = [];
    const seen: UpdateCheck[] = [];
    const checker = new UpdateChecker({
      currentVersion: "1.14.0",
      fetchImpl: jsonFetch({ version: "1.15.0" }, 200, urls),
      onChange: (u) => seen.push(u),
    });
    expect(checker.status()).toBeUndefined();

    const first = await checker.check();
    expect(urls).toEqual([UPDATE_SOURCE]);
    expect(first).toEqual({ status: "available", latest: "1.15.0" });
    expect(checker.status()).toEqual({ status: "available", latest: "1.15.0" });
    expect(seen).toEqual([{ status: "available", latest: "1.15.0" }]);

    // 相同结果再查一次不重复触发 onChange
    await checker.check();
    expect(seen).toHaveLength(1);

    // 相同版本
    const same = new UpdateChecker({ currentVersion: "1.14.0", fetchImpl: jsonFetch({ version: "1.14.0" }) });
    expect(await same.check()).toEqual({ status: "up-to-date", latest: "1.14.0" });

    // 更旧版本
    const older = new UpdateChecker({ currentVersion: "1.14.0", fetchImpl: jsonFetch({ version: "1.13.2" }) });
    expect(await older.check()).toEqual({ status: "up-to-date", latest: "1.13.2" });
  });

  it("对方版本号格式不对时当没查到，记为失败而不冒充最新", async () => {
    for (const payload of [{ version: "1.15.0-rc.1" }, { version: "v1.15.0" }, { version: "" }, {}, "oops"]) {
      const checker = new UpdateChecker({ currentVersion: "1.14.0", fetchImpl: jsonFetch(payload) });
      const result = await checker.check();
      expect(result).toEqual({ status: "error", error: "返回的版本号无效" });
    }
  });

  it("请求失败、HTTP 错误、超时、非法 JSON 都如实记原因", async () => {
    const httpErr = new UpdateChecker({ currentVersion: "1.14.0", fetchImpl: jsonFetch({ error: "bad" }, 503) });
    expect(await httpErr.check()).toEqual({ status: "error", error: "HTTP 503" });

    const netErr = new UpdateChecker({
      currentVersion: "1.14.0",
      fetchImpl: (async () => {
        throw new Error("fetch failed", { cause: new Error("ENOTFOUND registry.npmjs.org") });
      }) as unknown as typeof fetch,
    });
    expect(await netErr.check()).toEqual({ status: "error", error: "ENOTFOUND registry.npmjs.org" });

    const timeoutErr = new UpdateChecker({
      currentVersion: "1.14.0",
      fetchImpl: (async () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      }) as unknown as typeof fetch,
    });
    expect(await timeoutErr.check()).toEqual({ status: "error", error: "请求超时" });

    const badJson = new UpdateChecker({
      currentVersion: "1.14.0",
      fetchImpl: (async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch,
    });
    expect(await badJson.check()).toEqual({ status: "error", error: "返回的不是有效 JSON" });
  });

  it("start 启动时查一次并按间隔重复，stop 后不再查", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const checker = new UpdateChecker({
      currentVersion: "1.14.0",
      intervalMs: 60_000,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ version: "1.15.0" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    checker.start();
    await Promise.resolve();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);

    checker.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(calls).toBe(2);
  });

  it("createRuntime 里不发网络请求；检查后 /api/about、/api/bootstrap 和 SSE 都能拿到结果", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 });
    }) as unknown as typeof fetch;

    const hob = makeHob({}, { fetchImpl });
    try {
      expect(calls).toBe(0);
      expect(hob.runtime.update.status()).toBeUndefined();

      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

      const aboutBefore = (await (await app.request("/api/about", { headers: { cookie } })).json()) as AboutInfo;
      expect(aboutBefore.update).toBeUndefined();
      expect(calls).toBe(0);

      const events: HobEvent[] = [];
      const off = hob.runtime.bus.subscribe((ev) => events.push(ev));
      await hob.runtime.update.check();
      off();

      expect(calls).toBe(1);
      expect(events).toContainEqual({ type: "update", update: { status: "available", latest: "99.0.0" } });

      const aboutAfter = (await (await app.request("/api/about", { headers: { cookie } })).json()) as AboutInfo;
      expect(aboutAfter.update).toEqual({ status: "available", latest: "99.0.0" });

      const boot = (await (await app.request("/api/bootstrap", { headers: { cookie } })).json()) as Bootstrap;
      expect(boot.update).toEqual({ status: "available", latest: "99.0.0" });
    } finally {
      hob.close();
    }
  });
});
