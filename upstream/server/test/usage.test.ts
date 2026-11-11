import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Assistant, Job, UsageView } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { makeHob, type TestHob } from "./helpers.ts";

const PRICES = {
  anthropic: { id: "anthropic", models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5", cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
};

function fakePrices(calls: { n: number } = { n: 0 }): typeof fetch {
  return (async () => {
    calls.n += 1;
    return new Response(JSON.stringify(PRICES), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** 会话文件的一行：assistant 消息，带用量。 */
function assistantLine(at: string, usage: Record<string, number>, provider = "anthropic", model = "claude-sonnet-4-5"): string {
  return `${JSON.stringify({
    type: "message",
    id: `m-${at}`,
    timestamp: at,
    message: { role: "assistant", provider, model, timestamp: Date.parse(at), content: [], usage: { type: "usage", ...usage } },
  })}\n`;
}

function writeSession(path: string, lines: string[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, [`{"type":"session","version":3,"id":"s","timestamp":"2026-11-01T00:00:00.000Z","cwd":"/tmp"}\n`, ...lines].join(""));
}

function addAssistant(hob: TestHob, id: string, name: string): Assistant {
  const assistant: Assistant = {
    id,
    name,
    duty: "写周报",
    sprite: "page",
    primary: false,
    pinned: false,
    hidden: false,
    notify: true,
    instructions: "",
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

function addJob(hob: TestHob, id: string, assistantId: string, assistantName?: string): Job {
  const job: Job = {
    id,
    assistantId,
    ...(assistantName ? { assistantName } : {}),
    title: "写周报",
    instruction: "写这周的周报",
    status: "done",
    createdAt: "2026-11-05T00:00:00.000Z",
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
  };
  hob.runtime.store.saveJob(job);
  return job;
}

/** 一条 11-06 23:30（上海）和一条 11-07 00:30 的消息：按上海时区跨天，按 UTC 不跨。 */
function twoDays(hob: TestHob): void {
  writeSession(join(hob.home, "assistants", "hob", "router.jsonl"), [
    assistantLine("2026-11-06T15:30:00.000Z", { input: 100, output: 10, cacheRead: 900, cacheWrite: 50 }),
    assistantLine("2026-11-06T16:30:00.000Z", { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 }),
  ]);
}

function byDay(view: UsageView): Record<string, number> {
  return Object.fromEntries(view.rows.map((row) => [`${row.day} ${row.assistantId} ${row.source}`, row.requests]));
}

describe("消耗统计", () => {
  it("从会话文件统计，按设置时区跨天，缓存和花费的字段都对", async () => {
    const hob = makeHob({}, { fetchImpl: fakePrices() });
    try {
      twoDays(hob);
      const view = await hob.runtime.usage.view();
      expect(view.timezone).toBe("Asia/Shanghai");
      expect(view.rows).toHaveLength(2);
      const [first, second] = view.rows;
      expect(first).toMatchObject({ day: "2026-11-06", assistantId: "hob", source: "chat", provider: "anthropic", model: "claude-sonnet-4-5", requests: 1, input: 100, output: 10, cacheRead: 900, cacheWrite: 50 });
      expect(second).toMatchObject({ day: "2026-11-07", requests: 1, input: 200, output: 20 });
      // 换成 UTC：两条落在同一天，合成一行
      const saved = hob.runtime.settings.get();
      hob.runtime.settings.patch(saved.revision, { general: { timezone: "UTC" } });
      const utc = await hob.runtime.usage.view();
      expect(utc.rows).toHaveLength(1);
      expect(utc.rows[0]).toMatchObject({ day: "2026-11-06", requests: 2, input: 300, output: 30, cacheRead: 900 });
    } finally {
      hob.close();
    }
  });

  it("任务的会话按 job.json 归到所属助手，归档助手的对话也算", async () => {
    const hob = makeHob({}, { fetchImpl: fakePrices() });
    try {
      addAssistant(hob, "page", "写稿搭子");
      twoDays(hob);
      writeSession(join(hob.home, "assistants", "page", "router.jsonl"), [assistantLine("2026-11-06T02:00:00.000Z", { input: 1000, output: 100 })]);
      addJob(hob, "t-1", "page");
      writeSession(join(hob.home, "assistants", "hob", "jobs", "t-1", "worker.jsonl"), [assistantLine("2026-11-06T03:00:00.000Z", { input: 5000, output: 500 }, "openai", "gpt-5")]);
      // 归档的助手：目录挪进 archive/assistants/<id>-<时间>，名字从归档里的档案读
      addAssistant(hob, "bird", "行业动态");
      writeSession(join(hob.home, "assistants", "bird", "router.jsonl"), [assistantLine("2026-11-04T02:00:00.000Z", { input: 700, output: 70 })]);
      hob.runtime.store.archiveAssistant("bird", "bird-2026-11-05T00:00:00.000Z");

      const view = await hob.runtime.usage.view();
      expect(byDay(view)).toEqual({
        "2026-11-04 bird chat": 1,
        "2026-11-06 hob chat": 1,
        "2026-11-06 page chat": 1,
        "2026-11-06 page job": 1,
        "2026-11-07 hob chat": 1,
      });
      expect(view.assistants).toEqual(expect.arrayContaining([
        { id: "bird", name: "行业动态", archived: true },
        { id: "hob", name: "Hob", archived: false },
        { id: "page", name: "写稿搭子", archived: false },
      ]));
      const jobRow = view.rows.find((row) => row.source === "job");
      expect(jobRow).toMatchObject({ assistantId: "page", provider: "openai", model: "gpt-5", input: 5000 });
    } finally {
      hob.close();
    }
  });

  it("沉淀会话开头抄的任务会话不重复算，只算沉淀那段", async () => {
    const hob = makeHob({}, { fetchImpl: fakePrices() });
    try {
      addJob(hob, "t-1", "hob");
      const dir = join(hob.home, "assistants", "hob", "jobs", "t-1");
      const first = assistantLine("2026-11-06T03:00:00.000Z", { input: 5000, output: 500 });
      writeSession(join(dir, "worker.jsonl"), [first]);
      writeSession(join(dir, "sediment", `${Date.parse("2026-11-06T04:00:00.000Z")}.jsonl`), [first, assistantLine("2026-11-06T04:01:00.000Z", { input: 800, output: 80 })]);
      const rows = (await hob.runtime.usage.view()).rows.filter((row) => row.source === "job");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ requests: 2, input: 5800, output: 580 });
    } finally {
      hob.close();
    }
  });

  it("文件没变时不重读，追加后只把新的一段算进来，变短时整份重读", async () => {
    const hob = makeHob({}, { fetchImpl: fakePrices() });
    try {
      twoDays(hob);
      const file = join(hob.home, "assistants", "hob", "router.jsonl");
      expect((await hob.runtime.usage.view()).rows).toHaveLength(2);
      expect(hob.runtime.usage.reads).toBe(1);
      // 没动文件：不再读
      expect((await hob.runtime.usage.view()).rows).toHaveLength(2);
      expect(hob.runtime.usage.reads).toBe(1);
      // 追加一条：只读追加的那段
      appendFileSync(file, assistantLine("2026-11-08T02:00:00.000Z", { input: 300, output: 30 }));
      const appended = await hob.runtime.usage.view();
      expect(hob.runtime.usage.reads).toBe(2);
      expect(appended.rows.map((row) => row.day)).toEqual(["2026-11-06", "2026-11-07", "2026-11-08"]);
      expect(appended.rows.at(-1)?.input).toBe(300);
      // 写成更短的一份：整份重读，旧的记录不能留着
      writeSession(file, [assistantLine("2026-11-09T02:00:00.000Z", { input: 42, output: 4 })]);
      const rewritten = await hob.runtime.usage.view();
      expect(hob.runtime.usage.reads).toBe(3);
      expect(rewritten.rows).toHaveLength(1);
      expect(rewritten.rows[0]).toMatchObject({ day: "2026-11-09", input: 42 });
    } finally {
      hob.close();
    }
  });

  it("没有会话文件时是空的，不报错", async () => {
    const hob = makeHob({}, { fetchImpl: fakePrices() });
    try {
      const view = await hob.runtime.usage.view();
      expect(view.rows).toEqual([]);
      expect(view.prices.models["claude-sonnet-4-5"]).toEqual({ price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, custom: false });
    } finally {
      hob.close();
    }
  });

  it("改单价写进设置，恢复默认后回到价格表的值", async () => {
    const hob = makeHob({}, { fetchImpl: fakePrices() });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const put = (body: unknown) => app.request("/api/usage/price", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

      const price = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 };
      const saved = await put({ revision: hob.runtime.settings.get().revision, model: "claude-sonnet-4-5", price });
      expect(saved.status).toBe(200);
      const body = (await saved.json()) as { settings: { settings: { usage?: { prices: Record<string, unknown> } } }; price: { custom: boolean; default?: unknown } };
      expect(body.settings.settings.usage?.prices["claude-sonnet-4-5"]).toEqual(price);
      expect(body.price).toEqual({ price, custom: true, default: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });
      expect((await hob.runtime.usage.view()).prices.models["claude-sonnet-4-5"]).toEqual({ price, custom: true, default: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });

      // 负数和缺项都拒
      const bad = await put({ revision: hob.runtime.settings.get().revision, model: "claude-sonnet-4-5", price: { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 } });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toContain("输入");

      const restored = await put({ revision: hob.runtime.settings.get().revision, model: "claude-sonnet-4-5", price: null });
      expect(restored.status).toBe(200);
      expect(((await restored.json()) as { price: { custom: boolean } }).price.custom).toBe(false);
      expect(hob.runtime.settings.settings.usage).toBeUndefined();

      // 旧 revision 写不进
      const stale = await put({ revision: 1, model: "claude-sonnet-4-5", price });
      expect(stale.status).toBe(409);

      // 改别的设置不会把自定单价冲掉
      const saved2 = await put({ revision: hob.runtime.settings.get().revision, model: "gpt-x", price });
      expect(saved2.status).toBe(200);
      const current = hob.runtime.settings.get();
      const patched = await app.request("/api/settings", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ revision: current.revision, patch: { work: { maxJobs: 3 } } }) });
      expect(patched.status).toBe(200);
      expect(hob.runtime.settings.settings.usage?.prices["gpt-x"]).toEqual(price);
    } finally {
      hob.close();
    }
  });
});
