import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Approval, Assistant, JobStep } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import type { HobRuntime } from "../src/runtime.ts";
import { makeHob } from "./helpers.ts";

/** 登录拿 cookie：/api/* 都要它。 */
async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function appWithCookie(runtime: HobRuntime, home: string) {
  const app = createApp(runtime, { home });
  return { app, cookie: await signIn(app) };
}

describe("全局规则", () => {
  it("文件缺失时读取为空且不重建，提示词仍可构建", async () => {
    const hob = makeHob();
    try {
      const path = join(hob.home, "rules.json");
      rmSync(path);
      expect(hob.runtime.store.globalRules()).toEqual([]);
      expect(existsSync(path)).toBe(false);
      const { buildSystemPrompt, buildWorkerPrompt } = await import("../src/prompt.ts");
      const settings = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      expect(buildSystemPrompt(hob.runtime.store, "hob", settings)).toContain("你是「Hob」");
      hob.runtime.store.saveJob({ id: "missing-rules", assistantId: "hob", title: "测试", instruction: "测试", status: "queued", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      expect(buildWorkerPrompt(hob.runtime.store, "missing-rules", settings)).toContain("后台任务");
      expect(existsSync(path)).toBe(false);
    } finally { hob.close(); }
  });

  it("保留未变规则的 changedAt，只更新新增或修改的规则", async () => {
    const hob = makeHob();
    try {
      const old = "2020-01-01T00:00:00.000Z";
      hob.runtime.store.saveGlobalRules([
        { id: "a", text: "保留", mode: "ask", changedAt: old },
        { id: "b", text: "改文字", mode: "ask", changedAt: old },
        { id: "c", text: "改模式", mode: "ask", changedAt: old },
      ]);
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const response = await app.request("/api/rules", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ rules: [
        { id: "a", text: " 保留 ", mode: "ask" }, { id: "b", text: "新文字", mode: "ask" },
        { id: "c", text: "改模式", mode: "allow" }, { text: "新增", mode: "allow" },
      ] }) });
      expect(response.status).toBe(200);
      const { rules } = await response.json() as { rules: { changedAt: string }[] };
      expect(rules[0].changedAt).toBe(old);
      for (const rule of rules.slice(1)) expect(Date.parse(rule.changedAt)).toBeGreaterThan(Date.parse(old));
    } finally { hob.close(); }
  });

  it("首次和升级补默认值，空数组保留；接口鉴权、校验、保存并发事件", async () => {
    const hob = makeHob();
    try {
      const { store, bus } = hob.runtime;
      expect(store.globalRules()).toHaveLength(7);
      expect(store.globalRules().map((rule) => rule.mode)).toEqual(["ask", "ask", "ask", "ask", "allow", "allow", "allow"]);
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      expect((await app.request("/api/rules")).status).toBe(401);
      const events: string[] = [];
      bus.subscribe((event) => events.push(event.type));
      const put = (rules: unknown) => app.request("/api/rules", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ rules }) });
      expect((await put([{ text: "   ", mode: "ask" }])).status).toBe(400);
      expect((await put([{ text: "测试", mode: "bad" }])).status).toBe(400);
      const response = await put([{ text: "  检查  ", mode: "allow" }]);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ rules: [{ text: "检查", mode: "allow", id: expect.any(String), changedAt: expect.any(String) }] });
      expect(events).toContain("rules");
      expect(await (await app.request("/api/rules", { headers: { cookie } })).json()).toEqual({ rules: store.globalRules() });
      await put([]);
      store.init();
      expect(store.globalRules()).toEqual([]);
    } finally { hob.close(); }
  });
});

describe("助手规则编辑", () => {
  it("通过助手设置新增规则，校验内容、模式及重复项", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      hob.runtime.store.saveRules("hob", [{ id: "r1", text: "发布文章", mode: "ask", changedAt: "2020-01-01T00:00:00.000Z" }]);
      const patch = (rule: unknown) => app.request("/api/assistants/hob", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ rule }) });
      expect((await patch({ text: " ", mode: "ask" })).status).toBe(400);
      expect((await patch({ text: "长".repeat(1001), mode: "ask" })).status).toBe(400);
      expect((await patch({ text: "发布文章", mode: "ask" })).status).toBe(400);
      expect((await patch({ text: "发送邮件", mode: "invalid" })).status).toBe(400);
      expect((await patch({ text: "发送邮件" })).status).toBe(400);
      const response = await patch({ text: "  发送邮件  ", mode: "allow" });
      expect(response.status).toBe(200);
      const { rule } = await response.json() as { rule: { id: string; text: string; mode: string } };
      expect(rule).toMatchObject({ text: "发送邮件", mode: "allow" });
      expect(rule.id).toMatch(/^r-/);
      expect(hob.runtime.store.rules("hob")).toHaveLength(2);
      expect(hob.runtime.store.rules("hob")[1]).toMatchObject(rule);
    } finally { hob.close(); }
  });

  it("通过助手设置修改规则，拒绝空内容、重复规则和无效模式", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      hob.runtime.store.saveRules("hob", [
        { id: "r1", text: "发布文章", mode: "ask", changedAt: "2020-01-01T00:00:00.000Z" },
        { id: "r2", text: "发送邮件", mode: "allow", changedAt: "2020-01-01T00:00:00.000Z" },
      ]);
      const patch = (rule: unknown) => app.request("/api/assistants/hob", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ rule }) });
      expect((await patch({ id: "r1", text: "  修改文章  ", mode: "allow" })).status).toBe(200);
      expect(hob.runtime.store.rules("hob")[0]).toMatchObject({ text: "修改文章", mode: "allow" });
      expect((await patch({ id: "r1", text: " " })).status).toBe(400);
      expect((await patch({ id: "r1", text: "长".repeat(1001) })).status).toBe(400);
      expect((await patch({ id: "r1", text: "发送邮件" })).status).toBe(400);
      expect((await patch({ id: "r1", mode: "unknown" })).status).toBe(400);
      expect((await patch({ id: "missing", text: "其他" })).status).toBe(404);
      expect(hob.runtime.store.rules("hob")[0].text).toBe("修改文章");
    } finally { hob.close(); }
  });
});

describe("GET /api/files", () => {
  it("能读任务工作目录里的产出，读不到 HOB_HOME 以外的文件", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const work = join(hob.home, "assistants", "hob", "jobs", "t-aaaa", "work");
      mkdirSync(work, { recursive: true });
      const produced = join(work, "简报.md");
      writeFileSync(produced, "# 简报\n");

      const inside = await app.request(`/api/files?path=${encodeURIComponent(produced)}`, { headers: { cookie } });
      expect(inside.status).toBe(200);
      expect(await inside.text()).toContain("简报");

      const outside = await app.request("/api/files?path=%2Fetc%2Fhostname", { headers: { cookie } });
      expect(outside.status).toBe(403);
    } finally {
      hob.close();
    }
  });
});

describe("答复审批", () => {
  /** 一个待答的审批（来源是任务，但任务已经不在跑，答完不会有副作用）。 */
  function seedApproval(runtime: HobRuntime): Approval {
    const approval: Approval = {
      id: "q-text",
      assistantId: "hob",
      title: "要发吗？",
      options: [
        { key: "A", label: "发" },
        { key: "B", label: "不发" },
      ],
      status: "pending",
      source: "job",
      jobId: "t-gone",
      createdAt: new Date().toISOString(),
    };
    runtime.store.saveApproval(approval);
    return approval;
  }

  it("除了选项，还能收一段自己写的话；空白和超长都是 400", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const approval = seedApproval(hob.runtime);
      const post = (body: unknown) =>
        app.request(`/api/approvals/${approval.id}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      expect((await post({ text: "   " })).status).toBe(400);
      expect((await post({ text: "长".repeat(1001) })).status).toBe(400);

      const saved = await post({ text: "  先别发，等我写完摘要  " });
      expect(saved.status).toBe(200);
      expect(hob.runtime.store.approval(approval.id)).toMatchObject({
        status: "answered",
        answerText: "先别发，等我写完摘要",
      });

      // 已经答过的不再收
      expect((await post({ key: "A" })).status).toBe(409);
    } finally {
      hob.close();
    }
  });
});

describe("设置接口", () => {
  it("GET 返回 revision + 设置，PUT 按节合并、revision 不对回 409", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const got = (await (await app.request("/api/settings", { headers: { cookie } })).json()) as {
        revision: number;
        settings: { general: { theme: string }; work: { maxJobs: number } };
      };
      expect(got.settings.general.theme).toBe("system");
      expect(got.settings.work.maxJobs).toBe(2);

      const put = (body: unknown) =>
        app.request("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });
      const ok = await put({ revision: got.revision, patch: { work: { maxJobs: 3 } } });
      expect(ok.status).toBe(200);
      const next = (await ok.json()) as { revision: number; settings: { general: { theme: string }; work: { maxJobs: number } } };
      expect(next.revision).toBe(got.revision + 1);
      expect(next.settings.work.maxJobs).toBe(3);
      // 没给的节保持原样
      expect(next.settings.general.theme).toBe("system");

      const stale = await put({ revision: got.revision, patch: { work: { maxJobs: 1 } } });
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { error: string }).error).toContain("已刷新");
    } finally {
      hob.close();
    }
  });

  it("改密码：旧的不对回 403，改完旧密码登不上、新密码能登", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const change = (old: string, next: string) =>
        app.request("/api/password", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ old, new: next }),
        });
      expect((await change("wrong", "newpass")).status).toBe(403);
      expect((await change("test", "newpass")).status).toBe(200);
      const login = (password: string) =>
        app.request("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
      expect((await login("test")).status).toBe(401);
      expect((await login("newpass")).status).toBe(200);
    } finally {
      hob.close();
    }
  });

  it("GET /api/about 只给版本和数据目录", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const about = (await (await app.request("/api/about", { headers: { cookie } })).json()) as Record<string, string>;
      expect(about.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(about.home).toBe(hob.home);
      expect(Object.keys(about).sort()).toEqual(["home", "version"]);
    } finally {
      hob.close();
    }
  });
});

describe("GET /api/jobs", () => {
  it("新的在前，按助手和状态筛选，分页给 hasMore", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const job = (id: string, assistantId: string, status: "done" | "stuck", createdAt: string) => ({
        id,
        assistantId,
        title: id,
        instruction: "干活",
        kind: "local" as const,
        status,
        createdAt,
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      });
      hob.runtime.store.saveJob(job("t-1", "hob", "done", "2026-11-01T01:00:00.000Z"));
      hob.runtime.store.saveJob(job("t-2", "hob", "stuck", "2026-11-01T02:00:00.000Z"));
      hob.runtime.store.saveJob(job("t-3", "other", "done", "2026-11-01T03:00:00.000Z"));
      hob.runtime.store.saveJob(job("t-4", "hob", "done", "2026-11-01T04:00:00.000Z"));

      const all = await app.request("/api/jobs?limit=2", { headers: { cookie } });
      const first = (await all.json()) as { jobs: { id: string }[]; hasMore: boolean };
      expect(first.jobs.map((item) => item.id)).toEqual(["t-4", "t-3"]);
      expect(first.hasMore).toBe(true);

      const next = await app.request("/api/jobs?limit=2&before=t-3", { headers: { cookie } });
      const second = (await next.json()) as { jobs: { id: string }[]; hasMore: boolean };
      expect(second.jobs.map((item) => item.id)).toEqual(["t-2", "t-1"]);
      expect(second.hasMore).toBe(false);

      const filtered = await app.request("/api/jobs?assistantId=hob&status=done", { headers: { cookie } });
      const onlyDone = (await filtered.json()) as { jobs: { id: string }[] };
      expect(onlyDone.jobs.map((item) => item.id)).toEqual(["t-4", "t-1"]);

      const bad = await app.request("/api/jobs?status=跑了", { headers: { cookie } });
      expect(bad.status).toBe(400);
    } finally {
      hob.close();
    }
  });
});

describe("GET /api/jobs/:id/transcript", () => {
  it("返回任务和从它会话推导出的步骤；没有的任务 404", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      hob.runtime.store.saveJob({
        id: "t-aa01",
        assistantId: "hob",
        title: "写脚本",
        instruction: "写个脚本",
        kind: "local",
        status: "done",
        createdAt: "2026-11-01T01:00:00.000Z",
        startedAt: "2026-11-01T01:00:00.000Z",
        endedAt: "2026-11-01T01:01:00.000Z",
        stats: { reads: 0, commands: 1, edits: 0 },
        activity: [],
        cwd: join(hob.home, "assistants", "hob", "jobs", "t-aa01", "work"),
      });
      mkdirSync(join(hob.home, "assistants", "hob", "jobs", "t-aa01"), { recursive: true });
      writeFileSync(
        hob.runtime.store.workerFile("t-aa01"),
        [
          { type: "message", message: { role: "user", content: "写个脚本", timestamp: 1000 } },
          {
            type: "message",
            message: {
              role: "assistant",
              timestamp: 1100,
              content: [
                { type: "text", text: "好，写一个。" },
                { type: "toolCall", id: "call-1", name: "write", arguments: { path: "run.sh", content: "echo hi" } },
              ],
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "write",
              content: [{ type: "text", text: "Wrote 7 bytes" }],
              isError: false,
              durationMs: 3,
              timestamp: 1200,
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );

      const response = await app.request("/api/jobs/t-aa01/transcript", { headers: { cookie } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { job: { id: string }; steps: JobStep[] };
      expect(body.job.id).toBe("t-aa01");
      expect(body.steps.map((step) => step.title ?? step.text)).toEqual(["好，写一个。", "写入 run.sh"]);
      expect(body.steps[1]).toMatchObject({ output: "Wrote 7 bytes", durationMs: 3 });

      const missing = await app.request("/api/jobs/t-zzzz/transcript", { headers: { cookie } });
      expect(missing.status).toBe(404);
    } finally {
      hob.close();
    }
  });
});
describe("PATCH /api/assistants/:id", () => {
  it("duty 太长在服务端截断，左栏小字不会溢出", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const response = await app.request("/api/assistants/hob", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ duty: "盯着模型发布和 agent 产品的最新动态" }),
      });
      expect(response.status).toBe(200);
      expect(hob.runtime.store.assistant("hob")?.duty).toBe("盯着模型发布和");
      expect(hob.runtime.store.assistant("hob")?.duty.length).toBeLessThanOrEqual(8);
    } finally {
      hob.close();
    }
  });

  it("置顶位置存进档案，重新打开还是这个位置", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const patch = (body: unknown) =>
        app.request("/api/assistants/hob", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      const response = await patch({ pinOrder: 2 });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { assistant: Assistant }).assistant.pinOrder).toBe(2);
      expect(hob.runtime.store.assistant("hob")?.pinOrder).toBe(2);
      // 落的是 profile.json：另开一个 store 读同一份家目录
      const { Store } = await import("../src/store.ts");
      expect(new Store(hob.home).assistant("hob")?.pinOrder).toBe(2);
    } finally {
      hob.close();
    }
  });

  it("置顶位置不是数字就不收，小数取整、负数归零", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const patch = (body: unknown) => app.request("/api/assistants/hob", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      await patch({ pinOrder: "3" });
      expect(hob.runtime.store.assistant("hob")?.pinOrder).toBeUndefined();
      await patch({ pinOrder: 1.6 });
      expect(hob.runtime.store.assistant("hob")?.pinOrder).toBe(2);
      await patch({ pinOrder: -5 });
      expect(hob.runtime.store.assistant("hob")?.pinOrder).toBe(0);
    } finally {
      hob.close();
    }
  });
});
