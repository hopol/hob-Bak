import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSearchProvider } from "@juicesharp/rpiv-web-tools/providers/factory.ts";
import { fetchViaGenericHtml } from "@juicesharp/rpiv-web-tools/providers/fetch-helpers.ts";
import { GitHubInterceptor } from "@juicesharp/rpiv-web-tools/providers/interceptors/github.ts";
import { join } from "node:path";
import type { SearchSettings, SearchProviderSetting } from "../../shared/search.ts";
import { readSecrets } from "./secrets.ts";

export type SearchClient = ReturnType<typeof createSearchProvider>;
type Factory = (name: string, credentials: { apiKey?: string; baseUrl?: string }) => SearchClient;

function safeError(error: unknown, keys: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of keys.filter(Boolean)) message = message.split(key).join("[已隐藏]");
  return message;
}

export class WebSearch {
  constructor(readonly home: string, readonly settings: () => SearchSettings, readonly factory: Factory = createSearchProvider, readonly keyOverrides: Record<string, string> = {}) {}
  private keys() { return { ...readSecrets(this.home), ...this.keyOverrides }; }
  private client(provider: SearchProviderSetting, keys: Record<string, string>): SearchClient {
    return this.factory(provider.name, { apiKey: keys[`search:${provider.name}`], baseUrl: provider.baseUrl });
  }
  async search(query: string, depth: "fast" | "deep" = "fast", max = 8) {
    if (!query.trim()) throw new Error("搜索词不能为空。");
    const providers = this.settings().filter((p) => p.enabled);
    if (!providers.length) throw new Error("未启用联网搜索服务商。");
    const count = Number.isFinite(max) ? Math.max(1, Math.min(20, Math.floor(max))) : 8;
    const keys = this.keys();
    const errors: { provider: string; error: string }[] = [];
    const used: string[] = [];
    const merged = new Map<string, { title: string; url: string; snippet: string; sources: string[] }>();
    const run = async (p: SearchProviderSetting) => {
      try {
        const response = await this.client(p, keys).search(query, count, AbortSignal.timeout(15_000));
        return { p, response };
      } catch (error) { return { p, error: safeError(error, Object.values(keys)) }; }
    };
    const collect = (entry: Awaited<ReturnType<typeof run>>) => {
      if (entry.error !== undefined) { errors.push({ provider: entry.p.name, error: entry.error }); return false; }
      used.push(entry.p.name);
      for (const item of entry.response!.results) {
        if (!item.url) continue;
        const old = merged.get(item.url);
        if (old) {
          old.sources.push(entry.p.name);
          if (item.snippet.length > old.snippet.length) { old.snippet = item.snippet; old.title = item.title; }
        } else merged.set(item.url, { ...item, sources: [entry.p.name] });
      }
      return true;
    };
    if (depth === "deep") (await Promise.all(providers.map(run))).forEach(collect);
    else for (const provider of providers) if (collect(await run(provider))) break;
    if (!used.length) throw new Error(`联网搜索失败：${errors.map((e) => `${e.provider}: ${e.error}`).join("；")}`);
    return { providers: used, errors, results: [...merged.values()].slice(0, count) };
  }
  async fetch(url: string, raw = false) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("网址无效。"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("仅支持 http 和 https 网址。");
    const keys = this.keys();
    const signal = AbortSignal.timeout(15_000);
    try {
      const github = new GitHubInterceptor({ enabled: true, clonePath: join(this.home, "cache", "github") });
      let result = await github.intercept(url, { raw, signal });
      if (!result) {
        const native = this.settings().find((p) => p.enabled && ["exa", "tavily", "jina", "firecrawl"].includes(p.name));
        const client = native ? this.client(native, keys) : undefined;
        result = client && "fetch" in client && typeof client.fetch === "function"
          ? await client.fetch(url, raw, signal)
          : await fetchViaGenericHtml(url, raw, signal);
      }
      if (!result) throw new Error("网页抓取未返回内容。");
      return { ...result, text: result.text.slice(0, 40_000), truncated: result.text.length > 40_000 };
    } catch (error) { throw new Error(safeError(error, Object.values(keys))); }
  }
}

export function searchTools(home: string, settings: () => SearchSettings): ToolDefinition<any, any>[] {
  if (!settings().some((p) => p.enabled)) return [];
  const service = new WebSearch(home, settings);
  const output = async (run: () => Promise<unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await run()) }], details: undefined }; }
    catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true }; }
  };
  return [
    { name: "web_search", label: "联网搜索", description: "搜索互联网，返回结果、来源和服务商错误。", parameters: Type.Object({ query: Type.String(), depth: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("deep")])), max: Type.Optional(Type.Number()) }), execute: async (_id, p: any) => output(() => service.search(p.query, p.depth, p.max)) },
    { name: "web_fetch", label: "读取网页", description: "读取网页正文，最多返回 40000 字符。", parameters: Type.Object({ url: Type.String(), raw: Type.Optional(Type.Boolean()) }), execute: async (_id, p: any) => output(() => service.fetch(p.url, p.raw)) },
  ];
}
