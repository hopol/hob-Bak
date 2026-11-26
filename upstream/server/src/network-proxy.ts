import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

export interface ProxyEnvironmentSettings {
  proxy: string;
  noProxy: string;
}

/** Add the configured proxy variables to a child process without changing inherited values when disabled. */
export function proxyEnvironment(env: NodeJS.ProcessEnv, settings: ProxyEnvironmentSettings): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>;
  if (!settings.proxy) return inherited;
  return {
    ...inherited,
    HTTP_PROXY: settings.proxy,
    HTTPS_PROXY: settings.proxy,
    ALL_PROXY: settings.proxy,
    NO_PROXY: settings.noProxy,
    http_proxy: settings.proxy,
    https_proxy: settings.proxy,
    all_proxy: settings.proxy,
    no_proxy: settings.noProxy,
  };
}

/** Validate and normalize the proxy URL stored in GeneralSettings. */
export function checkProxy(value: unknown): string {
  if (typeof value !== "string") throw new Error("代理地址要以 http:// 或 https:// 开头");
  const proxy = value.trim();
  if (!proxy) return "";
  try {
    const parsed = new URL(proxy);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || !parsed.hostname) throw new Error();
  } catch {
    throw new Error("代理地址要以 http:// 或 https:// 开头");
  }
  return proxy;
}

export function normalizeProxy(value: unknown, fallback: string): string {
  try { return checkProxy(value); } catch { return fallback; }
}

export function normalizeNoProxy(value: unknown, fallback = DEFAULT_NO_PROXY): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** Mask only proxy credentials so the address remains useful in the settings page. */
export function maskProxy(value: string): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) return value;
    parsed.username = parsed.username ? "***" : "";
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString();
  } catch {
    return value;
  }
}

let previousDispatcher: ReturnType<typeof getGlobalDispatcher> | undefined;
let proxyAgent: EnvHttpProxyAgent | undefined;

function closeAgent(agent: EnvHttpProxyAgent): void {
  const closing = (agent as unknown as { close?: () => Promise<void> }).close?.();
  void closing?.catch(() => {});
}

/** Apply Hob's proxy to Node's undici-backed global fetch immediately. */
export function applyNetworkProxy(proxy: string, noProxy: string): void {
  if (!proxy) {
    if (!proxyAgent) return;
    setGlobalDispatcher(previousDispatcher ?? getGlobalDispatcher());
    closeAgent(proxyAgent);
    proxyAgent = undefined;
    previousDispatcher = undefined;
    return;
  }
  if (!proxyAgent) previousDispatcher = getGlobalDispatcher();
  const old = proxyAgent;
  proxyAgent = new EnvHttpProxyAgent({ httpProxy: proxy, httpsProxy: proxy, noProxy });
  setGlobalDispatcher(proxyAgent);
  if (old) closeAgent(old);
}
