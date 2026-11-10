export const SEARCH_PROVIDERS = ["searxng", "exa", "tavily", "brave", "serper", "jina", "firecrawl", "perplexity", "youcom", "ollama"] as const;
export type SearchProviderName = typeof SEARCH_PROVIDERS[number];
export interface SearchProviderSetting { name: SearchProviderName; enabled: boolean; baseUrl?: string }
export type SearchSettings = SearchProviderSetting[];
export interface SearchView { providers: (SearchProviderSetting & { keyConfigured: boolean })[] }

export function defaultSearch(): SearchSettings {
  return SEARCH_PROVIDERS.map((name) => ({ name, enabled: false }));
}

export function normalizeSearch(raw: unknown): SearchSettings {
  const entries = Array.isArray(raw) ? raw : [];
  const result: SearchSettings = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !SEARCH_PROVIDERS.includes(entry.name) || result.some((p) => p.name === entry.name)) continue;
    result.push({ name: entry.name, enabled: entry.enabled === true, ...(typeof entry.baseUrl === "string" && entry.baseUrl.trim() ? { baseUrl: entry.baseUrl.trim() } : {}) });
  }
  return [...result, ...defaultSearch().filter((p) => !result.some((entry) => entry.name === p.name))];
}
