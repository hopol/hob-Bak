import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPENAI_SEARCH_BASE_URL,
  DEFAULT_OPENAI_SEARCH_MODEL,
  normalizeSearch,
  type SearchSettings,
} from "../../shared/search.ts";
import type { ProviderSettings } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { inspectOpenAISearchStatus, parseOpenAISearchResults } from "../src/openai-search.ts";
import { WebSearch } from "../src/search.ts";
import { writeSecret } from "../src/secrets.ts";
import { makeHob } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeResponsesPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_test_1",
    output: [
      {
        type: "web_search_call",
        action: {
          type: "search",
          sources: [
            { type: "url", url: "https://example.com/cited" },
            { type: "url", url: "https://docs.example.org/guide/intro" },
            { type: "internal", url: "oai-weather" },
            { type: "url", url: "javascript:alert(1)" },
          ],
        },
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Hob is a self-hosted personal assistant ([example.com](https://example.com/cited)). It supports web search via Responses API.",
            annotations: [
              {
                type: "url_citation",
                url: "https://example.com/cited",
                title: "Hob Documentation",
                start_index: 0,
                end_index: 78,
              },
              {
                type: "url_citation",
                url: "https://example.com/cited",
                title: "Duplicate Entry",
                start_index: 0,
                end_index: 10,
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("OpenAI 原生 Web Search", () => {
  it("normalizeSearch 清洗 openai 专属字段并过滤非 openai 字段", () => {
    const normalized = normalizeSearch([
      { name: "openai", enabled: true, providerId: "  openai  ", model: "  gpt-4o-mini ", baseUrl: " https://proxy.example/v1 " },
      { name: "exa", enabled: false, providerId: "should-strip", model: "should-strip" },
    ]);
    const openai = normalized.find((p) => p.name === "openai")!;
    const exa = normalized.find((p) => p.name === "exa")!;
    expect(openai).toEqual({
      name: "openai",
      enabled: true,
      baseUrl: "https://proxy.example/v1",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    expect(exa).toEqual({ name: "exa", enabled: false });
    expect(normalized.some((p) => p.name === "openai")).toBe(true);
  });

  it("正确构造 Responses API 请求，映射 depth 到 search_context_size 并合并自定义请求头", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-openai-search-"));
    try {
      writeSecret(home, "provider:my-relay", "relay-secret-token");
      const modelProviders: ProviderSettings[] = [
        {
          kind: "custom",
          id: "my-relay",
          name: "我的中转站",
          api: "openai-responses",
          baseUrl: "https://relay.example.test/v1/",
          models: [{ id: "gpt-4.1-mini" }],
          extra: {
            headers: {
              "X-Custom-Tenant": "team-a",
              Authorization: "Bearer should-not-override",
            },
          },
        },
      ];
      const searchSettings: SearchSettings = [
        { name: "openai", enabled: true, providerId: "my-relay", model: "gpt-4o-mini" },
      ];

      const calls: { url: string; init: RequestInit }[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify(makeResponsesPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const service = new WebSearch(home, () => searchSettings, undefined, {}, () => modelProviders);
      const fastRes = await service.search("hob assistant", "fast", 5);
      expect(fastRes.providers).toEqual(["openai"]);
      expect(fastRes.results).toHaveLength(2);
      expect(fastRes.results[0]).toMatchObject({
        title: "Hob Documentation",
        url: "https://example.com/cited",
        sources: ["openai"],
      });
      expect(fastRes.results[0].snippet).toContain("Hob is a self-hosted personal assistant");
      expect(fastRes.results[0].snippet).not.toContain("https://example.com/cited");
      expect(fastRes.results[1]).toMatchObject({
        url: "https://docs.example.org/guide/intro",
        title: "docs.example.org/guide/intro",
        sources: ["openai"],
      });

      await service.search("hob assistant", "deep", 3);

      expect(calls).toHaveLength(2);
      expect(calls[0].url).toBe("https://relay.example.test/v1/responses");
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer relay-secret-token");
      expect(headers["X-Custom-Tenant"]).toBe("team-a");
      expect(headers["Content-Type"]).toBe("application/json");

      const fastBody = JSON.parse(String(calls[0].init.body));
      expect(fastBody).toMatchObject({
        model: "gpt-4o-mini",
        input: "hob assistant",
        tools: [{ type: "web_search", search_context_size: "low" }],
        tool_choice: "auto",
        include: ["web_search_call.action.sources"],
        store: false,
      });

      const deepBody = JSON.parse(String(calls[1].init.body));
      expect(deepBody.tools).toEqual([{ type: "web_search", search_context_size: "high" }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("三层结果解析：url_citation、sources 补充、Markdown 链接降级、截断与无来源报错", () => {
    // 1. url_citation + sources + maxResults 截断
    const capped = parseOpenAISearchResults(makeResponsesPayload(), 1);
    expect(capped).toHaveLength(1);
    expect(capped[0].url).toBe("https://example.com/cited");

    // 2. Markdown 链接降级（无 annotations 和 sources）
    const mdPayload = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "See [OpenAI Docs](https://platform.openai.com/docs) and [Hob Repo](https://github.com/FFatTiger/hob) for details.",
            },
          ],
        },
      ],
    };
    const mdResults = parseOpenAISearchResults(mdPayload, 5);
    expect(mdResults.map((r) => r.url)).toEqual([
      "https://platform.openai.com/docs",
      "https://github.com/FFatTiger/hob",
    ]);
    expect(mdResults[0].title).toBe("OpenAI Docs");

    // 3. 无有效来源报错
    expect(() =>
      parseOpenAISearchResults({
        output: [
          { type: "web_search_call", action: { sources: [{ url: "oai-weather" }] } },
          { type: "message", content: [{ type: "output_text", text: "No links here." }] },
        ],
      }, 5),
    ).toThrow("OpenAI 未返回网页来源引用");
  });

  it("支持复用内置 openai、独立配置模式、以及失效服务商报错与脱敏", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-openai-modes-"));
    try {
      // 复用内置 openai
      writeSecret(home, "provider:openai", "sk-builtin-secret-123");
      const builtinProviders: ProviderSettings[] = [{ kind: "builtin", id: "openai" }];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(makeResponsesPayload()), { status: 200 }),
      );
      const reuseService = new WebSearch(
        home,
        () => [{ name: "openai", enabled: true, providerId: "openai" }],
        undefined,
        {},
        () => builtinProviders,
      );
      await reuseService.search("test");
      expect(fetchSpy.mock.calls[0][0]).toBe(`${DEFAULT_OPENAI_SEARCH_BASE_URL}/responses`);
      expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).model).toBe(DEFAULT_OPENAI_SEARCH_MODEL);

      // 独立配置模式
      writeSecret(home, "search:openai", "sk-standalone-secret-456");
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(makeResponsesPayload()), { status: 200 }),
      );
      const standaloneService = new WebSearch(
        home,
        () => [{ name: "openai", enabled: true, baseUrl: "https://custom.openai.test/v1" }],
      );
      await standaloneService.search("test standalone");
      expect(fetchSpy.mock.calls[1][0]).toBe("https://custom.openai.test/v1/responses");
      expect((fetchSpy.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe("Bearer sk-standalone-secret-456");

      // 引用已删除的服务商
      const missingService = new WebSearch(
        home,
        () => [{ name: "openai", enabled: true, providerId: "deleted-provider" }],
        undefined,
        {},
        () => builtinProviders,
      );
      await expect(missingService.search("test")).rejects.toThrow("已移除或不支持 Responses API");

      // 引用 openai-completions 服务商会被拒绝
      const completionsProviders: ProviderSettings[] = [
        { kind: "custom", id: "legacy", name: "Legacy", api: "openai-completions", baseUrl: "https://legacy.test/v1", models: [] },
      ];
      expect(inspectOpenAISearchStatus({ name: "openai", enabled: true, providerId: "legacy" }, completionsProviders, {})).toMatchObject({
        keyConfigured: false,
        resolvedProviderMissing: true,
      });

      // 报错脱敏（不泄露 provider:openai Key）
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Invalid key sk-builtin-secret-123" } }), { status: 401 }),
      );
      await expect(reuseService.search("secret leak test")).rejects.toThrow("API Key 无效或无权限");
      await expect(reuseService.search("secret leak test 2").catch((e) => e.message)).resolves.not.toContain("sk-builtin-secret-123");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("404/400 等中转网关错误返回清晰中文排障提示", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-openai-err-"));
    try {
      writeSecret(home, "search:openai", "sk-test-key");
      const service = new WebSearch(home, () => [{ name: "openai", enabled: true }]);

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
      await expect(service.search("q")).rejects.toThrow("不支持 OpenAI Responses API（/responses）");

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Tool web_search is not supported for this model" } }), { status: 400 }),
      );
      await expect(service.search("q")).rejects.toThrow("不支持原生 web_search 工具");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("HTTP /api/search 与 /api/search/test 支持复用与未保存表单组合测试", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];

      // 预置内置 openai 模型服务商与 Key
      writeSecret(hob.home, "provider:openai", "sk-provider-openai-secret");
      hob.runtime.settings.setProvider({ kind: "builtin", id: "openai" });

      // 保存 OpenAI 搜索为复用模式
      const rev1 = hob.runtime.settings.get().revision;
      const putRes = await app.request("/api/search", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          revision: rev1,
          providers: [{ name: "openai", enabled: true, providerId: "openai", model: "gpt-4.1-mini" }],
        }),
      });
      expect(putRes.status).toBe(200);

      // GET /api/search 反映复用状态且不泄露 Key
      const getRes = await app.request("/api/search", { headers: { cookie } });
      const rawGetText = await getRes.text();
      expect(rawGetText).not.toContain("sk-provider-openai-secret");
      const searchView = JSON.parse(rawGetText);
      const openaiView = searchView.providers.find((p: { name: string }) => p.name === "openai");
      expect(openaiView).toMatchObject({
        name: "openai",
        enabled: true,
        providerId: "openai",
        model: "gpt-4.1-mini",
        keyConfigured: true,
        resolvedProviderMissing: false,
        standaloneKeyConfigured: false,
      });

      // POST /api/search/test 测试未保存的表单组合（切回自定义配置 + 新模型 + 临时 Key）
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(makeResponsesPayload()), { status: 200 }),
      );
      const testRes = await app.request("/api/search/test", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "openai",
          providerId: "",
          baseUrl: "https://temp.gateway.test/v1",
          model: "gpt-5-mini",
          apiKey: "sk-temp-form-key",
        }),
      });
      expect(testRes.status).toBe(200);
      expect(await testRes.json()).toEqual({ ok: true, count: 2 });
      expect(fetchSpy.mock.calls[0][0]).toBe("https://temp.gateway.test/v1/responses");
      expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer sk-temp-form-key");
      expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).model).toBe("gpt-5-mini");
    } finally {
      hob.close();
    }
  });
});
