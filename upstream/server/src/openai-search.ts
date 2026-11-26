import {
  DEFAULT_OPENAI_SEARCH_BASE_URL,
  DEFAULT_OPENAI_SEARCH_MODEL,
  type SearchProviderSetting,
} from "../../shared/search.ts";
import type { ProviderSettings } from "../../shared/types.ts";

export type SearchDepth = "fast" | "deep";

export interface OpenAISearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface OpenAISearchResponse {
  query: string;
  results: OpenAISearchResultItem[];
}

export interface ResolvedOpenAISearchConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  headers?: Record<string, string>;
  providerLabel?: string;
}

export function isReusableOpenAISearchProvider(provider: ProviderSettings): boolean {
  return (provider.kind === "builtin" && provider.id === "openai")
    || (provider.kind === "custom" && provider.api === "openai-responses");
}

export function inspectOpenAISearchStatus(
  setting: SearchProviderSetting,
  modelProviders: ProviderSettings[],
  secrets: Record<string, string>,
): { keyConfigured: boolean; resolvedProviderMissing?: boolean; standaloneKeyConfigured: boolean } {
  const standaloneKeyConfigured = Boolean(secrets["search:openai"]?.trim());
  const providerId = setting.providerId?.trim();
  if (!providerId) {
    return { keyConfigured: standaloneKeyConfigured, standaloneKeyConfigured };
  }
  const matched = modelProviders.find((p) => p.id === providerId && isReusableOpenAISearchProvider(p));
  if (!matched) {
    return { keyConfigured: false, resolvedProviderMissing: true, standaloneKeyConfigured };
  }
  const keyConfigured = Boolean(secrets[`provider:${matched.id}`]?.trim());
  return { keyConfigured, resolvedProviderMissing: false, standaloneKeyConfigured };
}

function extractExtraHeaders(extra: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const raw = extra?.headers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const key = k.trim();
    const val = v.trim();
    if (!key || !val) continue;
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "content-type") continue;
    headers[key] = val;
  }
  return Object.keys(headers).length ? headers : undefined;
}

export function resolveOpenAISearchConfig(
  setting: SearchProviderSetting,
  modelProviders: ProviderSettings[],
  keys: Record<string, string>,
): ResolvedOpenAISearchConfig {
  const model = setting.model?.trim() || DEFAULT_OPENAI_SEARCH_MODEL;
  const providerId = setting.providerId?.trim();
  if (providerId) {
    const matched = modelProviders.find((p) => p.id === providerId && isReusableOpenAISearchProvider(p));
    if (!matched) {
      throw new Error("所选 OpenAI 服务商已移除或不支持 Responses API，请重新选择或改用自定义配置。");
    }
    const providerLabel = matched.kind === "builtin" ? "OpenAI" : matched.name;
    const apiKey = keys[`provider:${matched.id}`]?.trim() ?? "";
    if (!apiKey) {
      throw new Error(`所选 OpenAI 服务商（${providerLabel}）未配置 API Key，请先在「设置 → 服务商」中填写或改用自定义配置。`);
    }
    const baseUrl = matched.kind === "builtin"
      ? DEFAULT_OPENAI_SEARCH_BASE_URL
      : (matched.baseUrl?.trim() || DEFAULT_OPENAI_SEARCH_BASE_URL);
    const headers = matched.kind === "custom" ? extractExtraHeaders(matched.extra) : undefined;
    return { apiKey, baseUrl, model, headers, providerLabel };
  }

  const apiKey = keys["search:openai"]?.trim() ?? "";
  if (!apiKey) {
    throw new Error("未配置 OpenAI 联网搜索 API Key。");
  }
  const baseUrl = setting.baseUrl?.trim() || DEFAULT_OPENAI_SEARCH_BASE_URL;
  return { apiKey, baseUrl, model };
}

function normalizeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function urlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatSourceTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (!path || path === "/") return parsed.hostname;
    const shortPath = path.length > 48 ? `${path.slice(0, 45)}…` : path;
    return `${parsed.hostname}${shortPath}`;
  } catch {
    return url;
  }
}

function cleanSnippetText(raw: string): string {
  return raw
    // 清理形如 ([example.com](https://...)) 的括号引用尾缀
    .replace(/\s*\(\[[^\]]*\]\(https?:\/\/[^)]+\)\)/g, "")
    // 清理内联 Markdown 链接 [文本](https://...) -> 文本
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function extractContextSnippet(text: string, startIndex?: unknown, endIndex?: unknown): string {
  if (!text) return "";
  const len = text.length;
  const rawStart = typeof startIndex === "number" && Number.isFinite(startIndex)
    ? Math.max(0, Math.min(len, Math.floor(startIndex)))
    : 0;
  const rawEnd = typeof endIndex === "number" && Number.isFinite(endIndex)
    ? Math.max(rawStart, Math.min(len, Math.floor(endIndex)))
    : rawStart;

  const isBoundary = (ch: string) => ch === "\n" || ch === "。" || ch === "！" || ch === "？";
  const isAsciiSentenceEnd = (i: number) => {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") return false;
    const next = text[i + 1];
    return !next || next === " " || next === "\n" || next === "\t";
  };

  let left = Math.max(0, rawStart - 160);
  for (let i = rawStart - 1; i >= left; i--) {
    if (isBoundary(text[i]) || isAsciiSentenceEnd(i)) {
      left = i + 1;
      break;
    }
  }

  let right = Math.min(len, rawEnd + 160);
  for (let i = rawEnd; i < right; i++) {
    if (isBoundary(text[i]) || isAsciiSentenceEnd(i)) {
      right = i + 1;
      break;
    }
  }

  const cleaned = cleanSnippetText(text.slice(left, right));
  if (cleaned.length <= 260) return cleaned;
  return `${cleaned.slice(0, 259).trimEnd()}…`;
}

export function parseOpenAISearchResults(data: unknown, maxResults: number): OpenAISearchResultItem[] {
  const limit = Math.max(1, maxResults);
  const items = new Map<string, OpenAISearchResultItem>();
  const output = (data && typeof data === "object" && Array.isArray((data as { output?: unknown[] }).output))
    ? (data as { output: Record<string, unknown>[] }).output
    : [];
  const textBlocks: string[] = [];

  // 第一层：url_citation annotations（最高相关性、带标题与定位）
  for (const entry of output) {
    if (!entry || typeof entry !== "object" || entry.type !== "message" || !Array.isArray(entry.content)) continue;
    for (const block of entry.content as Record<string, unknown>[]) {
      if (!block || typeof block !== "object" || block.type !== "output_text") continue;
      const text = typeof block.text === "string" ? block.text : "";
      if (text) textBlocks.push(text);
      const annotations = Array.isArray(block.annotations) ? block.annotations as Record<string, unknown>[] : [];
      for (const ann of annotations) {
        if (!ann || typeof ann !== "object" || ann.type !== "url_citation") continue;
        const url = normalizeHttpUrl(ann.url);
        if (!url || items.has(url)) continue;
        const title = typeof ann.title === "string" && ann.title.trim() ? ann.title.trim() : urlHostname(url);
        const snippet = extractContextSnippet(text, ann.start_index, ann.end_index);
        items.set(url, { title, url, snippet });
      }
    }
  }

  // 第二层：web_search_call.action.sources 补充来源
  for (const entry of output) {
    if (!entry || typeof entry !== "object" || entry.type !== "web_search_call") continue;
    const action = entry.action as Record<string, unknown> | undefined;
    const sources = Array.isArray(action?.sources) ? action.sources : [];
    for (const source of sources) {
      const rawUrl = typeof source === "string"
        ? source
        : (source && typeof source === "object" ? (source as Record<string, unknown>).url : undefined);
      const url = normalizeHttpUrl(rawUrl);
      if (!url || items.has(url)) continue;
      const rawTitle = source && typeof source === "object" ? (source as Record<string, unknown>).title : undefined;
      const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : formatSourceTitle(url);
      items.set(url, { title, url, snippet: "OpenAI 搜索检索来源" });
    }
  }

  // 第三层：中转站未透传 annotations / sources 时的 Markdown 链接降级提取
  if (items.size === 0) {
    if (!textBlocks.length && data && typeof data === "object" && typeof (data as { output_text?: unknown }).output_text === "string") {
      textBlocks.push((data as { output_text: string }).output_text);
    }
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    for (const text of textBlocks) {
      let match: RegExpExecArray | null;
      while ((match = linkRe.exec(text)) !== null) {
        const url = normalizeHttpUrl(match[2]);
        if (!url || items.has(url)) continue;
        const title = match[1].trim() || urlHostname(url);
        const snippet = extractContextSnippet(text, match.index, match.index + match[0].length);
        items.set(url, { title, url, snippet });
      }
    }
  }

  const results = [...items.values()].slice(0, limit);
  if (!results.length) {
    throw new Error("OpenAI 未返回网页来源引用，请确认模型与网关支持原生 web_search。");
  }
  return results;
}

function extractApiErrorDetail(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // 非 JSON 响应直接截断原文
  }
  return trimmed.slice(0, 240);
}

function formatOpenAIHttpError(status: number, rawText: string, providerLabel?: string): Error {
  const detail = extractApiErrorDetail(rawText);
  const suffix = detail ? `（${detail}）` : "";
  if (status === 401 || status === 403) {
    const prefix = providerLabel
      ? `所选 OpenAI 服务商（${providerLabel}）的 API Key 无效或无权限`
      : "OpenAI API Key 无效或无权限";
    return new Error(`${prefix}（HTTP ${status}）${suffix}`);
  }
  if (status === 404 || status === 405 || status === 501) {
    return new Error(`当前服务地址不支持 OpenAI Responses API（/responses），请确认使用官方地址或支持 Responses API 的网关（HTTP ${status}）。`);
  }
  if (status === 400 && /web_search|tools|unsupported|not supported|model/i.test(detail || rawText)) {
    return new Error(`当前模型或网关不支持原生 web_search 工具，请更换支持联网搜索的模型（如 gpt-4.1-mini / gpt-4o-mini）${suffix}。`);
  }
  return new Error(`OpenAI 联网搜索请求失败（HTTP ${status}）${suffix}`);
}

export class OpenAISearchProvider {
  readonly name = "openai";
  readonly label = "OpenAI";
  readonly envVar = "";

  constructor(
    private readonly config: ResolvedOpenAISearchConfig,
    private readonly depth: SearchDepth = "fast",
  ) {}

  async search(query: string, maxResults = 8, signal?: AbortSignal): Promise<OpenAISearchResponse> {
    const count = Number.isFinite(maxResults) ? Math.max(1, Math.min(20, Math.floor(maxResults))) : 8;
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, "")}/responses`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...(this.config.headers ?? {}),
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        instructions: `Search the web for the user's query and provide concise, factual findings with inline citations. Prioritize up to ${count} authoritative sources.`,
        input: query,
        tools: [
          {
            type: "web_search",
            search_context_size: this.depth === "deep" ? "high" : "low",
          },
        ],
        tool_choice: "auto",
        include: ["web_search_call.action.sources"],
        store: false,
      }),
      signal,
    });

    const rawText = await response.text().catch(() => "");
    if (!response.ok) {
      throw formatOpenAIHttpError(response.status, rawText, this.config.providerLabel);
    }

    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error("OpenAI Responses API 返回了无效的 JSON 响应。");
    }

    return {
      query,
      results: parseOpenAISearchResults(data, count),
    };
  }
}

export function createOpenAISearchProvider(
  setting: SearchProviderSetting,
  modelProviders: ProviderSettings[],
  keys: Record<string, string>,
  depth: SearchDepth = "fast",
): OpenAISearchProvider {
  const config = resolveOpenAISearchConfig(setting, modelProviders, keys);
  return new OpenAISearchProvider(config, depth);
}
