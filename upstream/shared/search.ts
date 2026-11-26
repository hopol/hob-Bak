export const SEARCH_PROVIDERS = ["searxng", "exa", "tavily", "brave", "serper", "jina", "firecrawl", "perplexity", "youcom", "ollama", "openai"] as const;
export type SearchProviderName = typeof SEARCH_PROVIDERS[number];
export const DEFAULT_OPENAI_SEARCH_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_SEARCH_MODEL = "gpt-4.1-mini";
export interface SearchProviderSetting {
  name: SearchProviderName;
  enabled: boolean;
  baseUrl?: string;
  /** 仅 openai：复用「设置 → 服务商」中的 provider id；为空表示使用本页独立配置 */
  providerId?: string;
  /** 仅 openai：调用 Responses API 的模型名；为空时使用默认轻量模型 */
  model?: string;
}
export type SearchSettings = SearchProviderSetting[];
export interface SearchProviderView extends SearchProviderSetting {
  keyConfigured: boolean;
  resolvedProviderMissing?: boolean;
  standaloneKeyConfigured?: boolean;
}
export interface SearchView { providers: SearchProviderView[] }

export function defaultSearch(): SearchSettings {
  return SEARCH_PROVIDERS.map((name) => ({ name, enabled: false }));
}

export function normalizeSearch(raw: unknown): SearchSettings {
  const entries = Array.isArray(raw) ? raw : [];
  const result: SearchSettings = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !SEARCH_PROVIDERS.includes(entry.name) || result.some((p) => p.name === entry.name)) continue;
    const base: SearchProviderSetting = {
      name: entry.name,
      enabled: entry.enabled === true,
      ...(typeof entry.baseUrl === "string" && entry.baseUrl.trim() ? { baseUrl: entry.baseUrl.trim() } : {}),
    };
    if (entry.name === "openai") {
      if (typeof entry.providerId === "string" && entry.providerId.trim()) base.providerId = entry.providerId.trim();
      if (typeof entry.model === "string" && entry.model.trim()) base.model = entry.model.trim();
    }
    result.push(base);
  }
  return [...result, ...defaultSearch().filter((p) => !result.some((entry) => entry.name === p.name))];
}
