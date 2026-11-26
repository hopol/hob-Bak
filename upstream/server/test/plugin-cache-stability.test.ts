import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Assistant, ModelSettings } from "../../shared/types.ts";
import { applyEngineEnv } from "../src/boot.ts";
import { sha512Integrity } from "../src/bun-runtime.ts";
import { groupTodosPath, loadConfig } from "../src/config.ts";
import { PiHost } from "../src/pi.ts";
import { PROJECT_RECALL_LINE } from "../src/prompt.ts";
import { createRuntime, type HobRuntime } from "../src/runtime.ts";
import { defaultSettings } from "../src/settings.ts";
import { writeTodos } from "../src/todos.ts";
import { waitFor } from "./helpers.ts";

interface CapturedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: {
    model?: string;
    system?: string | Array<{ type?: string; text?: string; [key: string]: unknown }>;
    messages?: Array<{ role: string; content: unknown }>;
  };
}

/** 还原 Anthropic 请求里的完整系统提示词原文（不做时间裁剪，确保任何变动都能被测出来）。 */
function extractSystemText(system: CapturedRequest["body"]["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((block) => (block && typeof block === "object" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

/** 去掉 Anthropic 每轮移动的 cache_control 标记，保留消息与块内容本身，照 agy 插件规则比对首条消息和历史前缀。 */
function normalizeContentBlock(block: unknown): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
    if (key === "cache_control") continue;
    out[key] = Array.isArray(value) ? value.map(normalizeContentBlock) : value;
  }
  return out;
}

function normalizeMessage(message: { role: string; content: unknown }): { role: string; content: unknown[] } {
  const blocks = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : Array.isArray(message.content)
      ? message.content.map(normalizeContentBlock)
      : [message.content];
  return { role: message.role, content: blocks };
}

function headerValue(headers: CapturedRequest["headers"], name: string): string {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw.join(",");
  return typeof raw === "string" ? raw : "";
}

/** 照 agy 插件 conversationKey() 规则：整段 system + 第一条消息 + 会话范围请求头。 */
function conversationKey(req: CapturedRequest): string {
  const system = extractSystemText(req.body.system);
  const first = req.body.messages?.[0] ? normalizeMessage(req.body.messages[0]) : null;
  const scope = `${headerValue(req.headers, "x-magpie-session")}|${headerValue(req.headers, "x-magpie-subagent")}`;
  return createHash("sha256")
    .update(JSON.stringify({ system, first, scope }))
    .digest("hex");
}

function compareContinuation(prev: CapturedRequest, next: CapturedRequest) {
  const prevSystem = extractSystemText(prev.body.system);
  const nextSystem = extractSystemText(next.body.system);
  const prevHistory = (prev.body.messages ?? []).map(normalizeMessage);
  const nextHistory = (next.body.messages ?? []).map(normalizeMessage);
  const sameFirstMessage = prevHistory.length > 0 && nextHistory.length > 0
    && JSON.stringify(prevHistory[0]) === JSON.stringify(nextHistory[0]);
  const isHistoryPrefix = nextHistory.length > prevHistory.length
    && prevHistory.every((msg, idx) => JSON.stringify(nextHistory[idx]) === JSON.stringify(msg));
  return {
    sameSystem: prevSystem === nextSystem,
    sameFirstMessage,
    sameConversationKey: conversationKey(prev) === conversationKey(next),
    isHistoryPrefix,
    prevHistoryLength: prevHistory.length,
    nextHistoryLength: nextHistory.length,
  };
}

async function startCaptureVendor(captured: CapturedRequest[]): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  let replyIndex = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (url.pathname === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          "fake-neon": {
            id: "fake-neon",
            name: "Fake Neon",
            api: { id: "fake-neon", npm: "@ai-sdk/anthropic" },
            limit: { context: 200_000, output: 8192 },
            capabilities: { reasoning: false, attachment: false },
          },
        }));
        return;
      }
      if (url.pathname === "/v1/messages") {
        const body = raw ? JSON.parse(raw) : {};
        captured.push({ headers: { ...req.headers }, body });
        replyIndex++;
        const replyText = `第 ${replyIndex} 轮已收到。`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "message_start", message: { id: `msg_${replyIndex}`, type: "message", role: "assistant", content: [], model: "fake-neon", stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: replyText } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
          { type: "message_stop" },
        ];
        for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404).end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function writeFakeAnthropicPlugin(opts: { home: string; pluginId: string; pkgName: string; vendorUrl: string }) {
  const pluginDir = join(opts.home, "plugins", opts.pluginId);
  const pkgDir = join(pluginDir, "providers-runtime", "node_modules", ...opts.pkgName.split("/"));
  mkdirSync(pkgDir, { recursive: true });
  const integrity = sha512Integrity(Buffer.from(opts.pkgName));

  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({
      name: opts.pluginId,
      displayName: "Fake Cache Plugin",
      version: "1.0.0",
      description: "Fake Anthropic provider plugin for cache stability tests",
      extensions: {
        "com.hob.plugins": {
          categories: ["providers"],
          unofficial: true,
          permissions: ["network"],
          providers: [{ package: opts.pkgName, version: "1.0.0", integrity }],
        },
      },
    }, null, 2),
  );

  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: opts.pkgName, version: "1.0.0", type: "module", main: "./index.mjs" }, null, 2),
  );

  writeFileSync(
    join(pkgDir, "index.mjs"),
    `
const VENDOR = ${JSON.stringify(opts.vendorUrl)};
const PROVIDER_ID = ${JSON.stringify(opts.pluginId)};

export async function FakeCachePlugin() {
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER_ID] = {
        name: "Fake Cache Vendor",
        npm: "@ai-sdk/anthropic",
        api: VENDOR,
        models: {},
      };
    },
    provider: {
      id: PROVIDER_ID,
      async models() {
        const res = await fetch(VENDOR + "/models");
        if (!res.ok) throw new Error("models failed: " + res.status);
        return await res.json();
      },
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          keyless: true,
          label: "Fake Local Access",
          async authorize() {
            return { type: "success", key: "fake-cache-token" };
          },
        },
      ],
      async loader(getAuth) {
        return {
          baseURL: VENDOR + "/v1",
          async fetch(input, init) {
            const auth = await getAuth();
            const headers = new Headers(init?.headers || {});
            headers.set("authorization", "Bearer " + (auth?.key ?? ""));
            return fetch(input, { ...init, headers });
          },
        };
      },
    },
  };
}
`,
  );

  const sysDir = join(opts.home, "system");
  mkdirSync(sysDir, { recursive: true });
  const pluginsPath = join(sysDir, "plugins.json");
  const existing = existsSync(pluginsPath) ? (JSON.parse(readFileSync(pluginsPath, "utf8")) as { plugins: unknown[] }) : { plugins: [] };
  existing.plugins.push({
    id: opts.pluginId,
    version: "1.0.0",
    source: "official",
    sourceName: "Hob 官方",
    enabled: true,
    tools: {},
    config: {},
    approvedCapabilities: { providers: [opts.pkgName], permissions: ["network"], mcpServers: [] },
  });
  writeFileSync(pluginsPath, JSON.stringify(existing, null, 2));
}

describe("供应商插件缓存键稳定性（票 262）", () => {
  const savedEnv = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_MEMORY_DIR: process.env.PI_MEMORY_DIR,
    LORE_HOME: process.env.LORE_HOME,
    PI_MEMORY_EXIT_SUMMARY: process.env.PI_MEMORY_EXIT_SUMMARY,
  };

  let home = "";
  let vendor!: Awaited<ReturnType<typeof startCaptureVendor>>;
  let runtime!: HobRuntime;
  const captured: CapturedRequest[] = [];
  const memoryEntry = "<!-- 2026-11-24 06:02:18 [01a20d38] -->\nUser prefers concise summary tables.";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "hob-plugin-cache-"));
    applyEngineEnv(process.env, home);

    // 写入长期记忆，确保本地记忆插件 pi-memory 在每轮真实注入 ## Memory 快照
    const memDir = join(home, "system", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "MEMORY.md"), `${memoryEntry}\n`);

    vendor = await startCaptureVendor(captured);
    writeFakeAnthropicPlugin({
      home,
      pluginId: "fake-cache",
      pkgName: "fake-cache-pkg",
      vendorUrl: vendor.url,
    });

    const config = loadConfig(home, { HOB_PASSWORD: "test-password" });
    const base = defaultSettings("Asia/Shanghai");
    const modelRef = "plugin-fake-cache/fake-neon";
    const models: ModelSettings = {
      roster: [{ ref: modelRef, note: "" }],
      conversation: { ref: modelRef, thinking: "off" },
      work: { ref: modelRef, thinking: "off" },
      suggest: null,
    };
    writeFileSync(
      join(home, "system", "settings.json"),
      JSON.stringify({
        revision: 1,
        settings: {
          ...base,
          general: { ...base.general, locale: "zh-CN" },
          models,
        },
        memory: { provider: "local" },
      }),
    );

    const pi = new PiHost({ engineDir: join(home, "system", "engine") });
    runtime = createRuntime({
      home,
      config,
      pi,
      providerPlugins: {
        bunOptions: { bunPath: process.execPath },
        hostIdleMs: 10_000,
      },
    });

    await runtime.providerPlugins.signInApiKey({
      pluginId: "fake-cache",
      providerId: "fake-cache",
      methodIndex: 0,
    });
  }, 30_000);

  afterAll(async () => {
    runtime?.desktopEvents.stop();
    runtime?.desktopControl.dispose();
    runtime?.jobs.disposeAll();
    runtime?.router.disposeAll();
    await runtime?.providerPlugins.close();
    await runtime?.plugins.close();
    await vendor?.close();
    if (home) rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("单聊连续三轮与 releaseSessions() 重开后，body.system、首条消息与历史前缀均稳定", async () => {
    const start = captured.length;
    await runtime.router.send("hob", { text: "第一轮：看下本周计划" });
    await runtime.router.waitIdle("hob", 20_000);

    await runtime.router.send("hob", { text: "第二轮：把周五那项提前" });
    await runtime.router.waitIdle("hob", 20_000);

    await runtime.router.send("hob", { text: "第三轮：顺便记一下截止时间" });
    await runtime.router.waitIdle("hob", 20_000);

    // 跨过秒级边界再释放重开，验证 pi-memory 重建快照不会改变 body.system
    await new Promise((resolve) => setTimeout(resolve, 1100));
    runtime.router.releaseSessions();

    await runtime.router.send("hob", { text: "第四轮：重开会话后继续刚才的话题" });
    await runtime.router.waitIdle("hob", 20_000);

    const turns = captured.slice(start);
    expect(turns).toHaveLength(4);

    // 确认 pi-memory 确实注入了记忆且去掉了会变的快照原因/时间戳，保留了正文条目时间标记
    const sys1 = extractSystemText(turns[0].body.system);
    expect(sys1).toContain("## Memory");
    expect(sys1).toContain("(Use memory_read / memory_search for the authoritative latest state; recent writes may also be visible in tool-call history.)");
    expect(sys1).toContain(memoryEntry);
    expect(sys1).not.toMatch(/Snapshot [^\n.]* at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

    // 连续 1->2、2->3 以及 releaseSessions() 重开后的 3->4 均满足同一对话延续
    for (let i = 0; i < turns.length - 1; i++) {
      const cmp = compareContinuation(turns[i], turns[i + 1]);
      expect(cmp, `turn ${i + 1} -> ${i + 2}`).toMatchObject({
        sameSystem: true,
        sameFirstMessage: true,
        sameConversationKey: true,
        isHistoryPrefix: true,
      });
    }
  }, 30_000);

  it("群主综合会话在别的话题有新发言与待办变化后保持稳定；开新话题后 system 变化（对照）", async () => {
    const baseAssistant = runtime.store.assistant("hob")!;
    const ops: Assistant = { ...baseAssistant, id: "ops", name: "运维", duty: "服务器维护", primary: false, pinned: false, sprite: "page" };
    runtime.store.saveAssistant(ops);

    const group = runtime.groups.create({
      name: "运维小组",
      purpose: "处理服务器和部署事项",
      ownerId: "hob",
      members: ["hob", "ops"],
    });
    const topic = runtime.groups.createTopic(group.id, "排查磁盘告警", "user");

    // 综合会话第 1 轮
    const idx1 = captured.length;
    await runtime.groups.send(group.id, { text: "综合里先同步一下今天要盯的事" });
    await waitFor(() => captured.length > idx1 && runtime.groups.summary(group.id).busy.length === 0, 20_000);
    const overview1 = captured[idx1];
    expect(overview1).toBeDefined();

    // 在别的话题里产生新发言（再附一条未来 2 分钟的记录确保分钟级时间变化）并更新待办
    const topicIdx = captured.length;
    await runtime.groups.send(topic.id, { text: "@运维 看下磁盘使用率" });
    await waitFor(() => captured.length > topicIdx && runtime.groups.summary(topic.id).busy.length === 0, 20_000);
    runtime.store.appendGroupItem(topic.id, {
      kind: "note",
      icon: "info",
      speaker: "ops",
      id: "n-later",
      at: new Date(Date.now() + 120_000).toISOString(),
      text: "补充记录一条新进展",
    });
    writeTodos(groupTodosPath(home, topic.id), [
      { text: "查看挂载点", status: "done" },
      { text: "清理旧日志", status: "doing" },
    ]);

    // 综合会话第 2 轮：别的话题发言和待办都变了，群主综合会话的 system 与对话键必须不变
    const idx2 = captured.length;
    await runtime.groups.send(group.id, { text: "综合里继续确认下午的安排" });
    await waitFor(() => captured.length > idx2 && runtime.groups.summary(group.id).busy.length === 0, 20_000);
    const overview2 = captured[idx2];
    expect(overview2).toBeDefined();

    const overviewSys = extractSystemText(overview2.body.system);
    expect(overviewSys).toContain("## 这个群的话题");
    expect(overviewSys).toContain(`- 「排查磁盘告警」（${topic.id}）· 进行中\n`);
    expect(overviewSys).toContain(PROJECT_RECALL_LINE);
    expect(overviewSys).not.toContain("待办 1/2");

    expect(compareContinuation(overview1, overview2)).toMatchObject({
      sameSystem: true,
      sameFirstMessage: true,
      sameConversationKey: true,
      isHistoryPrefix: true,
    });

    // 对照：开一个新话题后，综合会话的 system 和对话键应当变化（说明测试不是恒真）
    const topic2 = runtime.groups.createTopic(group.id, "升级数据库版本", "user");
    const idx3 = captured.length;
    await runtime.groups.send(group.id, { text: "再看一眼当前的话题安排" });
    await waitFor(() => captured.length > idx3 && runtime.groups.summary(group.id).busy.length === 0, 20_000);
    const overview3 = captured[idx3];
    expect(overview3).toBeDefined();

    expect(extractSystemText(overview3.body.system)).toContain(`- 「升级数据库版本」（${topic2.id}）· 进行中\n`);
    expect(compareContinuation(overview2, overview3)).toMatchObject({
      sameSystem: false,
      sameConversationKey: false,
      sameFirstMessage: true,
      isHistoryPrefix: true,
    });
  }, 30_000);
});
