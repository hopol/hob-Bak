// 记忆：提供者解析、Lore 连接配置（HOB_HOME/lore/config.json）、连接测试、提示词一节。
//
// 和 pi 生态里的做法一致：本地记忆用捆绑的 pi-memory，Lore 用捆绑的 @local/lore-pi-extension，
// 两者互斥。Lore 的连接信息只读写 Hob 自己的 `HOB_HOME/lore/config.json`（格式
// `{ base_url, api_token }`，和 Lore 客户端一致），不读环境变量、不碰别的工具的配置。
// Token 只写不读：这里的任何返回值都不带明文 Token。
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoreConnectionInfo, LoreTestResult, MemoryProvider } from "../../shared/types.ts";
import { loreDir } from "./config.ts";

const LORE_CONFIG_MAX_BYTES = 64 * 1024;
const LORE_TEST_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** 明文 http 只许这些网段（本机 / 局域网 / Tailscale / IPv6 ULA 与 link-local）。 */
const PRIVATE_IPV4_RANGES: readonly (readonly [number, number])[] = [
  [ipv4ToInt([127, 0, 0, 0]), 8],
  [ipv4ToInt([10, 0, 0, 0]), 8],
  [ipv4ToInt([172, 16, 0, 0]), 12],
  [ipv4ToInt([192, 168, 0, 0]), 16],
  [ipv4ToInt([169, 254, 0, 0]), 16],
  [ipv4ToInt([100, 64, 0, 0]), 10], // Tailscale
];

function ipv4ToInt(octets: readonly number[]): number {
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const value = ipv4ToInt(octets);
  return PRIVATE_IPV4_RANGES.some(([base, bits]) => value >>> (32 - bits) === base >>> (32 - bits));
}

/** IPv6 ULA（fc00::/7，含 Tailscale 的 fd7a:115c:a1e0::/48）和 link-local（fe80::/10）。 */
function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const address = hostname.slice(1, -1).toLowerCase();
  return /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address);
}

/** 明文 http 只留给不会离开用户自己网络的地址；公网必须 https。 */
export function isPlainHttpAllowedHost(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(local|ts\.net)$/.test(hostname);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loreConfigPath(home: string): string {
  return join(loreDir(home), "config.json");
}

interface LoreConfig {
  baseUrl?: string;
  apiToken?: string;
  raw: Record<string, unknown>;
}

function readLoreConfig(home: string): LoreConfig {
  let text: string;
  try {
    text = readFileSync(loreConfigPath(home), "utf8");
  } catch {
    return { raw: {} };
  }
  if (Buffer.byteLength(text, "utf8") > LORE_CONFIG_MAX_BYTES) return { raw: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { raw: {} };
  }
  if (!isRecord(parsed)) return { raw: {} };
  const baseUrl = nonEmpty(parsed.base_url);
  const apiToken = nonEmpty(parsed.api_token);
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiToken === undefined ? {} : { apiToken }),
    raw: parsed,
  };
}

/**
 * 生效的 Lore 连接信息（不带 Token）：只来自 `HOB_HOME/lore/config.json`。
 */
export function loreConnection(home: string): LoreConnectionInfo {
  const config = readLoreConfig(home);
  const baseUrl = config.baseUrl ?? null;
  const tokenConfigured = config.apiToken !== undefined;
  return {
    configured: baseUrl !== null && tokenConfigured,
    baseUrl,
    source: config.baseUrl !== undefined ? "config" : "none",
    tokenConfigured,
  };
}

/** 没写过就是缺省值：已经配好 Lore 就用 Lore，否则本地记忆。 */
export function resolveMemoryProvider(explicit: MemoryProvider | undefined, loreConfigured: boolean): MemoryProvider {
  if (explicit) return explicit;
  return loreConfigured ? "lore" : "local";
}

export function isMemoryProvider(value: unknown): value is MemoryProvider {
  return value === "local" || value === "lore" || value === "off";
}

function validateBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Lore 服务地址不是合法的 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Lore 服务地址必须是 http(s)");
  if (url.protocol === "http:" && !isPlainHttpAllowedHost(url.hostname)) {
    throw new Error("公网地址必须用 https；明文 http 只允许本机或局域网地址");
  }
  return url;
}

/**
 * 写 `HOB_HOME/lore/config.json`（0600、原子写、保留不认识的兄弟键）。
 * Token 规则和官方 CLI 一致：给了就替换；没给且地址没变就保留；换了地址就清掉旧 Token。
 */
export function saveLoreConnection(
  home: string,
  input: { baseUrl?: unknown; token?: unknown },
): LoreConnectionInfo {
  const raw = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!raw) throw new Error("Lore 服务地址不能为空");
  const baseUrl = normalizeBase(raw);
  validateBaseUrl(baseUrl);
  const config = readLoreConfig(home);
  const previousBase = config.baseUrl ? normalizeBase(config.baseUrl) : undefined;
  let apiToken: string | undefined;
  if (typeof input.token === "string" && input.token.length > 0) apiToken = input.token;
  else if (previousBase === baseUrl) apiToken = config.apiToken;

  const document: Record<string, unknown> = { ...config.raw, base_url: baseUrl };
  if (apiToken === undefined) delete document.api_token;
  else document.api_token = apiToken;

  const dir = loreDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Lore 目录是个符号链接，不往里面写");
  const path = join(dir, "config.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return loreConnection(home);
}

type FetchLike = typeof fetch;

/**
 * 连一下 Lore（`GET <base>/api/health` + Bearer，和捆绑扩展启动时那次健康检查一样）。
 * 失败是正常的返回值，不抛错；返回值里没有 Token。
 */
export async function testLoreConnection(
  home: string,
  input: { baseUrl?: unknown; token?: unknown },
  options: { fetchImpl?: FetchLike } = {},
): Promise<LoreTestResult> {
  const config = readLoreConfig(home);
  const inputBase = typeof input.baseUrl === "string" && input.baseUrl.trim() !== "" ? input.baseUrl : undefined;
  const rawBase = normalizeBase(inputBase ?? config.baseUrl ?? "");
  if (rawBase === "") return { ok: false, reason: "invalid_url" };
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "invalid_url" };
  if (url.protocol === "http:" && !isPlainHttpAllowedHost(url.hostname)) return { ok: false, reason: "insecure_http" };

  const explicitToken = typeof input.token === "string" && input.token.length > 0 ? input.token : undefined;
  // 保存的 Token 只发给当前生效的地址：测试别的地址必须自带 Token，否则会把旧密钥送给别的服务。
  const effectiveBase = normalizeBase(config.baseUrl ?? "");
  const apiToken =
    inputBase !== undefined && rawBase !== effectiveBase ? explicitToken : (explicitToken ?? config.apiToken);
  if (apiToken === undefined) return { ok: false, reason: "missing_token" };

  const health = new URL(`${rawBase}/api/health`);
  health.searchParams.set("client_type", "pi");
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(health.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(LORE_TEST_TIMEOUT_MS),
      // 跟随重定向会把 Bearer 送到另一个源；直接当失败处理。
      redirect: "manual",
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status >= 300 && response.status < 400) return { ok: false, reason: "unreachable" };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized" };
  if (!response.ok) return { ok: false, reason: "unreachable" };
  const healthData = await response.json().catch(() => undefined) as unknown;
  const current = readLoreConfig(home);
  if (isRecord(healthData) && isRecord(healthData.capabilities) && current.baseUrl === rawBase && current.apiToken === apiToken) {
    const document = { ...current.raw, server_profile: { base_url: rawBase, capabilities: healthData.capabilities } };
    const path = loreConfigPath(home);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }
  return { ok: true, baseUrl: rawBase };
}

/** Hob 自带的 Lore 插件版本：vendor 里放的是 Lore 正式版，换版本用 `npm run update-lore -- <版本号>`。 */
export const LORE_PLUGIN_VERSION: string = JSON.parse(
  readFileSync(new URL("../../vendor/lore-pi-extension/package.json", import.meta.url), "utf8"),
).version;

/** 提示词里「记忆」一节的文案：按当前提供者给，关闭时整节不出。 */
export function memoryPromptLines(provider: MemoryProvider): string[] {
  if (provider === "local") {
    return [
      "## 记忆",
      "你和用户是长期合作。用户过去的偏好、决定和约定，先用 memory_read 查，免得让用户再说一遍；新出现的、以后还用得上的事实，用 memory_write 记下来。记忆写短一些，过时的及时改掉或删掉。",
    ];
  }
  if (provider === "lore") {
    return [
      "## 记忆",
      "长期记忆在 Lore。用户过去的偏好、决定和约定，先去 Lore 查，免得让用户再说一遍；新出现的、以后还用得上的事实，记进 Lore。读到的记忆和你刚核实的情况对不上，当场改对；已经不成立的，删掉，免得以后被它误导。",
    ];
  }
  return [];
}

/** 各提供者要放行的记忆工具（插件注册的工具名；没加载插件时一个都不存在）。 */
export const MEMORY_TOOL_PATTERNS: Record<MemoryProvider, string[]> = {
  local: ["memory_*", "scratchpad"],
  lore: ["lore_*"],
  off: [],
};

/**
 * 会写记忆的工具：Router 调成功后在对话里出一行「记忆已更新 · …」。
 * 名字取自捆绑插件的实际注册（pi-memory 0.4.2 的 memory_write，Lore 插件的建/改节点）。
 */
export const MEMORY_WRITE_TOOLS = new Set(["memory_write", "lore_create_node", "lore_update_node"]);

/** note 里的摘要：写入内容的第一行，最多 80 个字符。 */
export function memoryNoteText(params: unknown): string | undefined {
  const record = isRecord(params) ? params : {};
  for (const key of ["content", "text", "title", "new_text", "old_text"]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const first = value.split("\n").map((line) => line.trim()).find((line) => line !== "");
    if (!first) continue;
    const chars = Array.from(first.replace(/[:：,，;；、]+\s*$/u, ""));
    if (!chars.length) continue;
    return chars.length > 80 ? `${chars.slice(0, 80).join("").replace(/[:：,，;；、]+\s*$/u, "")}…` : chars.join("");
  }
  return undefined;
}
