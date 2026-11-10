import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexPrices, UsagePrices } from "../src/usage-prices.ts";

/** models.dev 的 api.json 形状：服务商 id → { models: { 模型 id: { cost } } }，单价是美元 / 百万 token。 */
const CATALOG = {
  "302ai": { id: "302ai", models: { "glm-4.6": { id: "glm-4.6", canonical_model_id: "zhipuai/glm-4.6", cost: { input: 0.286, output: 1.142 } } } },
  zhipuai: { id: "zhipuai", models: { "glm-4.6": { id: "glm-4.6", canonical_model_id: "zhipuai/glm-4.6", cost: { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0 } } } },
  opencode: { id: "opencode", models: { "kimi-k2": { id: "kimi-k2", canonical_model_id: "moonshotai/kimi-k2", cost: { input: 0.6, output: 2.5, cache_read: 0.15 } } } },
  llmgateway: { id: "llmgateway", models: { "kimi-k2": { id: "kimi-k2", canonical_model_id: "moonshotai/kimi-k2", cost: { input: 0.55, output: 2.2 } } } },
  anthropic: { id: "anthropic", models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5", canonical_model_id: "anthropic/claude-sonnet-4-5", cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
};

function okFetch(body: unknown, calls: { n: number }, status = 200): typeof fetch {
  return (async () => {
    calls.n += 1;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function failingFetch(calls: { n: number }, message = "连不上"): typeof fetch {
  return (async () => {
    calls.n += 1;
    throw new Error(message);
  }) as unknown as typeof fetch;
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "hob-prices-"));
}

describe("价格表", () => {
  it("按模型 id 匹配；多个服务商都有时优先模型厂商自己那家，没有就取第一个", () => {
    const prices = indexPrices(CATALOG);
    // 302ai 排在前面，但 glm-4.6 是 zhipuai 自己的模型
    expect(prices["glm-4.6"]).toEqual({ input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 });
    // kimi-k2 两家都不是厂商自己（都指回 moonshotai）：取先出现的
    expect(prices["kimi-k2"]).toEqual({ input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 });
    // 没有 cost 的模型和不是列表的输入都不收
    expect(() => indexPrices({ x: { models: {} } })).toThrow("没有模型价格");
    expect(() => indexPrices([])).toThrow("不是服务商列表");
  });

  it("一天最多更新一次，拉到的存进 HOB_HOME，重启后直接用", async () => {
    const home = tempHome();
    try {
      const calls = { n: 0 };
      let now = Date.parse("2026-11-01T00:00:00.000Z");
      const table = new UsagePrices({ home, fetchImpl: okFetch(CATALOG, calls), now: () => now });
      await table.ensure();
      expect(calls.n).toBe(1);
      expect(table.table().error).toBeNull();
      expect(table.table().fetchedAt).toBe("2026-11-01T00:00:00.000Z");
      expect(table.table().prices["claude-sonnet-4-5"]).toMatchObject({ input: 3, output: 15 });
      // 一天内再问：不重拉
      now += 6 * 3600_000;
      await table.ensure();
      expect(calls.n).toBe(1);
      // 新实例（重启）读磁盘上那份，不联网
      const again = new UsagePrices({ home, fetchImpl: failingFetch(calls), now: () => now });
      await again.ensure();
      expect(calls.n).toBe(1);
      expect(again.table().prices["glm-4.6"]?.input).toBe(0.6);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("拉不到就用上次的，写清原因；十分钟内不重试，过了再试成功就清掉原因", async () => {
    const home = tempHome();
    try {
      const calls = { n: 0 };
      let now = Date.parse("2026-11-01T00:00:00.000Z");
      const table = new UsagePrices({ home, fetchImpl: okFetch(CATALOG, calls), now: () => now });
      await table.ensure();
      // 一天后拉失败了：仍用旧的价格，并记下原因
      now += 25 * 3600_000;
      const failing = new UsagePrices({ home, fetchImpl: failingFetch(calls, "请求超时"), now: () => now });
      await failing.ensure();
      expect(calls.n).toBe(2);
      expect(failing.table().error).toBe("请求超时");
      expect(failing.table().fetchedAt).toBe("2026-11-01T00:00:00.000Z");
      expect(failing.table().prices["claude-sonnet-4-5"]).toMatchObject({ input: 3 });
      // 十分钟内不再试（不然每次打开页面都等一次超时）
      now += 5 * 60_000;
      await failing.ensure();
      expect(calls.n).toBe(2);
      // 过了十分钟，这次成功：原因清掉，时间更新
      now += 10 * 60_000;
      const retried = new UsagePrices({ home, fetchImpl: okFetch(CATALOG, calls), now: () => now });
      await retried.ensure();
      expect(calls.n).toBe(3);
      expect(retried.table().error).toBeNull();
      expect(retried.table().fetchedAt).toBe(new Date(now).toISOString());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("一次都没拉到过时如实写原因，不假装有价格", async () => {
    const home = tempHome();
    try {
      const calls = { n: 0 };
      const table = new UsagePrices({ home, fetchImpl: okFetch({ error: "坏了" }, calls, 500), now: () => Date.parse("2026-11-01T00:00:00.000Z") });
      await table.ensure();
      expect(table.table()).toMatchObject({ fetchedAt: null, error: "HTTP 500" });
      expect(table.table().prices).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
