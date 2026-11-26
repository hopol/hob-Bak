// 带模型的插件管理：Bun 与包安装、共享 Bun 宿主、多账号与 secrets 凭据、五种登录流程、
// 按账号缓存模型列表、思考档映射、内部代理端点和 pi 服务商注册。
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { t } from "../../shared/i18n.ts";
import type {
  ModelThinkingView,
  PluginModelOverride,
  PluginAuthMethodView,
  PluginAuthPromptView,
  PluginCliStatusView,
  PluginInstallProgress,
  PluginProviderAccountStatus,
  PluginProviderAccountView,
  PluginProviderModelView,
  PluginProviderSummary,
  PluginProviderUsageView,
  PluginProviderView,
  PluginSignInKind,
  PluginSignInSessionView,
  ProviderApi,
  ProviderHostStatusView,
  ThinkingLevel,
  ThinkingLevelMapSetting,
} from "../../shared/types.ts";
import { THINKING_LEVELS, thinkingPlan } from "../../shared/thinking.ts";
import { BunRuntime, resolveProviderPackageDir, type BunRuntimeOptions } from "./bun-runtime.ts";
import type { Bus } from "./bus.ts";
import { systemDir } from "./config.ts";
import type { ProxyEnvironmentSettings } from "./network-proxy.ts";
import { providerDeclarations } from "./plugin-config.ts";
import type { PluginStore } from "./plugin-store.ts";
import {
  HostRpcError,
  ProviderPluginHost,
  type HostLoadedPlugin,
  type HostLoadedProvider,
  type HostModelEntry,
  type HostPluginLoadSpec,
} from "./provider-plugin-host.ts";
import { computeUpstreamUrl, ProviderPluginProxy, type ProxyRequestDispatch } from "./provider-plugin-proxy.ts";
import { readSecrets, writeSecret } from "./secrets.ts";

const SIGNIN_TTL_MS = 10 * 60 * 1000;
const PASTE_TIMEOUT_MS = 25_000;
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

const LOCAL_CLI_NOTE = "这是跑 Hob 的那台机器上的登录，不是你现在用的设备。";

export interface StoredProviderAccount {
  id: string;
  providerId: string;
  displayName: string;
  authType: "oauth" | "api";
  status: PluginProviderAccountStatus;
  plan?: string;
  hint?: string;
  lastError?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  models?: PluginProviderModelView[];
  rawModels?: HostModelEntry[];
  modelsCachedAt?: string;
  modelsError?: string;
  modelsFellBack?: boolean;
}

interface StoredProviderState {
  name?: string;
  npm?: string;
  api?: string;
  icon?: string;
  single?: boolean;
  methods?: PluginAuthMethodView[];
  usageSupported?: boolean;
  refreshSupported?: boolean;
  refreshLead?: number;
  cli?: { name: string; manual?: string } | null;
  activeAccountId?: string;
  error?: string;
  accounts: Record<string, StoredProviderAccount>;
  /** 用户在插件页改的模型参数，键是模型 id；换账号、刷新模型列表、更新插件都保留 */
  modelOverrides?: Record<string, PluginModelOverride>;
}

interface StoredPluginState {
  error?: string;
  providers: Record<string, StoredProviderState>;
}

interface ProviderPluginsDocument {
  plugins: Record<string, StoredPluginState>;
}

interface ActiveSignInSession {
  view: PluginSignInSessionView;
  hostSessionId?: string;
  loopbackPorts: string[];
  controller: AbortController;
  releaseHost: () => void;
  timer: NodeJS.Timeout;
  targetAccountId?: string;
}

export interface ProviderPluginManagerOptions {
  home: string;
  store: PluginStore;
  bus: Bus;
  proxy?: () => ProxyEnvironmentSettings;
  getThinkingSettings?: () => Record<string, ThinkingLevelMapSetting> | undefined;
  onProvidersChanged?: () => Promise<void>;
  /** 公开模型目录（models.dev）里这个模型 id 的上下文窗口和单次最多输出；插件没给这两项时用它补 */
  catalogLimits?: (modelId: string) => { context: number; output: number } | undefined;
  bunOptions?: Omit<BunRuntimeOptions, "home" | "proxy">;
  hostIdleMs?: number;
  hostScriptPath?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 生成插件供应商在 Hob/引擎中的唯一服务商 id（避免与内置 openai / github-copilot 冲突）。 */
export function hobProviderIdFor(pluginId: string, providerId: string, providerCount: number): string {
  const cleanPlugin = pluginId.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const cleanProvider = providerId.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  if (providerCount <= 1) return `plugin-${cleanPlugin}`;
  // ':' is not allowed in plugin ids, so it keeps plugin-id/provider-id pairs injective.
  return `plugin-${cleanPlugin}:${cleanProvider}`;
}

/** secrets.json 中按插件、按供应商、按账号隔离的键名。 */
export function providerAccountSecretKey(pluginId: string, providerId: string, accountId: string): string {
  return `plugin:${pluginId}:provider:${providerId}:account:${accountId}`;
}

/** OpenCode 模型 npm 包名 → Hob 三种流式协议。 */
export function protocolForModel(providerId: string, npm: string, apiId: string): ProviderApi {
  if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic") {
    return "anthropic-messages";
  }
  if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure") {
    return "openai-responses";
  }
  if (npm === "@ai-sdk/github-copilot" || providerId.startsWith("github-copilot")) {
    const m = /^gpt-(\d+)/i.exec(apiId);
    if (m && Number(m[1]) >= 5 && !apiId.toLowerCase().startsWith("gpt-5-mini")) {
      return "openai-responses";
    }
    return "openai-completions";
  }
  return "openai-completions";
}

/**
 * 把插件声明的 reasoning / variants 映射到 Hob 的思考档与引擎 thinkingLevelMap：
 * - 插件未声明 reasoning 且没有 variants → 不显示思考档（仅 off）；
 * - 插件显式声明 variants → 只开放对应档位，其余档写 null（绝不盲发 xhigh/max）；
 * - 插件声明 reasoning: true 但无 variants → 开放标准 low/medium/high（不猜 xhigh/max）。
 */
export function pluginModelThinking(
  model: { id: string; reasoning: boolean; variants: string[]; api: ProviderApi },
  custom?: ThinkingLevelMapSetting,
): { levels: ThinkingLevel[]; map: Partial<Record<ThinkingLevel, string | null>> } {
  if (!model.reasoning && !model.variants.length) {
    return { levels: ["off"], map: {} };
  }
  if (custom !== undefined) {
    const plan = thinkingPlan(model.id, true, custom, model.api);
    return { levels: plan.levels, map: plan.map };
  }

  const levels: ThinkingLevel[] = ["off"];
  const map: Partial<Record<ThinkingLevel, string | null>> = {};

  if (model.variants.length > 0) {
    const normalized = new Map<string, string>();
    const unmatched: string[] = [];
    const nonOff: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
    for (const v of model.variants) {
      const lower = v.trim().toLowerCase();
      if (!lower) continue;
      if (lower === "off" || lower === "none" || lower === "disabled") continue;
      if ((nonOff as string[]).includes(lower)) {
        normalized.set(lower, v.trim());
      } else {
        unmatched.push(v.trim());
      }
    }
    if (normalized.size > 0) {
      for (const lvl of nonOff) {
        const hit = normalized.get(lvl);
        if (hit) {
          levels.push(lvl);
          map[lvl] = hit;
        } else {
          map[lvl] = null;
        }
      }
    } else {
      // 非标准命名（如 fast / deep）：顺序映射到 low/medium/high/xhigh/max
      const slots: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
      const mapped = new Map<ThinkingLevel, string>();
      unmatched.slice(0, slots.length).forEach((name, idx) => mapped.set(slots[idx], name));
      for (const lvl of nonOff) {
        const hit = mapped.get(lvl);
        if (hit) {
          levels.push(lvl);
          map[lvl] = hit;
        } else {
          map[lvl] = null;
        }
      }
    }
    return { levels, map };
  }

  // reasoning: true 但未声明 variants：只开放通用 low/medium/high
  for (const lvl of ["minimal", "xhigh", "max"] as ThinkingLevel[]) {
    map[lvl] = null;
  }
  levels.push("low", "medium", "high");
  return { levels, map };
}

/** 用户改的参数盖在插件给的模型上；关掉「会推理」时插件声明的思考档名一起不用。 */
function withOverride(entry: HostModelEntry, o?: PluginModelOverride): HostModelEntry {
  if (!o) return entry;
  return {
    ...entry,
    ...(o.input ? { image: o.input.includes("image") } : {}),
    ...(o.reasoning !== undefined ? { reasoning: o.reasoning, ...(o.reasoning ? {} : { variants: [] }) } : {}),
    ...(o.contextWindow ? { context: o.contextWindow } : {}),
    ...(o.maxTokens ? { output: o.maxTokens } : {}),
  };
}

/** 接口传进来的参数只留认得的项；数字要正整数，不然照实说哪一项不对。 */
function cleanOverride(o: PluginModelOverride): PluginModelOverride {
  const out: PluginModelOverride = {};
  if (Array.isArray(o.input)) out.input = o.input.includes("image") ? ["text", "image"] : ["text"];
  if (typeof o.reasoning === "boolean") out.reasoning = o.reasoning;
  if (o.contextWindow !== undefined) {
    if (!Number.isInteger(o.contextWindow) || o.contextWindow <= 0) throw new Error(t("上下文窗口要填正整数。"));
    out.contextWindow = o.contextWindow;
  }
  if (o.maxTokens !== undefined) {
    if (!Number.isInteger(o.maxTokens) || o.maxTokens <= 0) throw new Error(t("单次最多输出要填正整数。"));
    out.maxTokens = o.maxTokens;
  }
  return out;
}

function thinkingViewOf(hobProviderId: string, m: PluginProviderModelView, custom?: ThinkingLevelMapSetting): ModelThinkingView {
  const thinking = pluginModelThinking({ id: m.id, reasoning: m.reasoning, variants: m.variants, api: m.api }, custom);
  return {
    ref: `${hobProviderId}/${m.id}`,
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input,
    contextWindow: m.contextWindow,
    levels: thinking.levels.map((level) => ({
      level,
      text: typeof thinking.map[level] === "string" ? thinking.map[level]! : "",
    })),
    custom: custom !== undefined,
  };
}

function toModelView(
  providerId: string,
  entry: HostModelEntry,
  hobProviderId: string,
  customThinking?: Record<string, ThinkingLevelMapSetting>,
): PluginProviderModelView {
  const api = protocolForModel(providerId, entry.npm, entry.apiId);
  const thinking = pluginModelThinking(
    { id: entry.id, reasoning: entry.reasoning, variants: entry.variants, api },
    customThinking?.[`${hobProviderId}/${entry.id}`],
  );
  return {
    id: entry.id,
    apiId: entry.apiId || entry.id,
    name: entry.name || entry.id,
    api,
    reasoning: entry.reasoning || entry.variants.length > 0,
    variants: [...entry.variants],
    thinkingLevels: thinking.levels,
    input: entry.image ? ["text", "image"] : ["text"],
    contextWindow: entry.context > 0 ? entry.context : DEFAULT_CONTEXT,
    maxTokens: entry.output > 0 ? entry.output : DEFAULT_MAX_TOKENS,
    ...(entry.cost ? { cost: entry.cost } : {}),
    ...(entry.free ? { free: true } : {}),
  };
}

// ---- Loopback 回调地址严格校验与单次本机回放 --------------------------------

export function isLoopbackHostname(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return clean === "localhost" || clean === "127.0.0.1" || clean === "::1";
}

function isValidPortString(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

/** 从 OAuth 授权链接的 query 参数中提取本次登录发出的 loopback 回调端口。 */
export function extractLoopbackPorts(rawUrl: string, depth = 2): string[] {
  const ports: string[] = [];
  const add = (p: string) => {
    if (isValidPortString(p) && !ports.includes(p)) ports.push(p);
  };
  const isCallbackParameter = (key: string): boolean => {
    const normalized = key.toLowerCase().replace(/[\s-]/g, "_");
    return normalized === "redirect_uri" || normalized === "redirect_url" || normalized === "redirect"
      || normalized === "callback" || normalized === "callback_url" || normalized === "return_uri"
      || (normalized.includes("redirect") && (normalized.includes("uri") || normalized.includes("url")));
  };
  const scan = (page: string, remaining: number) => {
    let parsed: URL;
    try {
      parsed = new URL(page);
    } catch {
      return;
    }
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!isCallbackParameter(key)) continue;
      try {
        const inner = new URL(value);
        if (inner.protocol === "http:" && isLoopbackHostname(inner.hostname)) {
          add(inner.port || "80");
          continue;
        }
        if (remaining > 1 && (inner.protocol === "https:" || inner.protocol === "http:")) {
          scan(value, remaining - 1);
        }
      } catch { /* 非回调 URL 参数 */ }
    }
  };
  scan(rawUrl, depth);
  return ports;
}

/**
 * 严格校验用户粘贴的浏览器最终地址，并仅向本机 127.0.0.1:<port> 回放一次 GET：
 * - 必须是 http://
 * - 主机名必须是 localhost / 127.0.0.1 / [::1]
 * - 端口必须属于本次登录授权 URL 发出的 allowedPorts
 * - 直连 127.0.0.1，不走代理，不跟随任何跨主机重定向。
 */
export async function replayLoopbackCallback(
  allowedPorts: string[],
  rawUrl: string,
  signal?: AbortSignal,
): Promise<{ status: number; nextUrl?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("请粘贴浏览器最后停住的完整地址（以 http:// 开头）。");
  }
  if (parsed.protocol !== "http:" || !parsed.host) {
    throw new Error("请粘贴浏览器最后停住的完整地址（仅接受 http:// 本机回调地址）。");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error("拒绝回放：只接受本机 loopback 地址（localhost / 127.0.0.1 / ::1）。");
  }
  const port = parsed.port || "80";
  if (!allowedPorts.includes(port)) {
    throw new Error("这个地址的端口不属于本次登录：请粘贴本次登录打开的页面最后停住的地址。");
  }

  const pathWithQuery = `${parsed.pathname || "/"}${parsed.search || ""}`;
  return new Promise<{ status: number; nextUrl?: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path: pathWithQuery,
        method: "GET",
        timeout: PASTE_TIMEOUT_MS,
        headers: {
          host: parsed.host,
          connection: "close",
        },
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        let nextUrl: string | undefined;
        const loc = typeof res.headers.location === "string" ? res.headers.location : "";
        if (status >= 300 && status < 400 && loc.startsWith("https://")) {
          const nextPorts = extractLoopbackPorts(loc);
          if (nextPorts.some((p) => allowedPorts.includes(p))) {
            nextUrl = loc;
          }
        }
        resolve({ status, ...(nextUrl ? { nextUrl } : {}) });
      },
    );
    const onAbort = () => {
      req.destroy(new Error("回调回放已取消"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    req.on("timeout", () => {
      req.destroy(new Error("本机回调端口无响应：本次登录可能已超时，请重新开始。"));
    });
    req.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED") {
        reject(new Error("本次登录的本机回调端口已关闭，请重新发起登录。"));
        return;
      }
      reject(err);
    });
    req.on("close", () => {
      signal?.removeEventListener("abort", onAbort);
    });
    req.end();
  });
}

function extractUserCode(instructions: string): string | undefined {
  if (!instructions) return undefined;
  const m = /(?:code|码)[\s:：]+([A-Z0-9]{3,}(?:-[A-Z0-9]{2,})*)/i.exec(instructions);
  if (m) return m[1];
  const bare = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(instructions);
  return bare?.[1];
}

function classifySignInKind(params: {
  method: "auto" | "code";
  url: string;
  instructions: string;
  loopbackPorts: string[];
  hasCli: boolean;
}): PluginSignInKind {
  if (params.hasCli && !params.url) return "local_cli";
  if (params.method === "code") return "code";
  if (params.loopbackPorts.length > 0) return "loopback_paste";
  if (extractUserCode(params.instructions)) return "device_code";
  return "server_poll";
}

function extractExpirationIso(auth: Record<string, unknown>): string | undefined {
  const exp = Number(auth.expires);
  if (!Number.isFinite(exp) || exp <= 0) return undefined;
  const ms = exp < 1e12 ? exp * 1000 : exp;
  return new Date(ms).toISOString();
}

/** 管理所有带模型的插件。 */
export class ProviderPluginManager {
  readonly bun: BunRuntime;
  readonly host: ProviderPluginHost;
  readonly proxy: ProviderPluginProxy;

  private activeSignIns = new Map<string, ActiveSignInSession>();
  private refreshLocks = new Map<string, Promise<Record<string, unknown>>>();
  private usageCache = new Map<string, PluginProviderUsageView>();
  private cliInstalling = new Set<string>();
  private appliedProviderIds = new Set<string>();
  private lastRuntime?: ModelRuntime;

  constructor(private readonly options: ProviderPluginManagerOptions) {
    this.bun = new BunRuntime({
      home: options.home,
      proxy: options.proxy,
      ...(options.bunOptions ?? {}),
    });
    this.host = new ProviderPluginHost({
      home: options.home,
      bun: this.bun,
      proxy: options.proxy,
      getPlugins: () => this.buildHostPluginSpecs(),
      onAuthUpdate: (event) => {
        void this.handleHostAuthUpdate(event);
      },
      onStatusChange: (status) => {
        this.options.bus.emit({ type: "plugin-providers", host: status });
      },
      onLoaded: (loaded) => {
        this.mergeLoadedMetadata(loaded);
      },
      redact: (text) => this.redact(text),
      idleMs: options.hostIdleMs,
      hostScriptPath: options.hostScriptPath,
    });
    this.proxy = new ProviderPluginProxy((dispatch) => this.handleProxyRequest(dispatch));
  }

  private get statePath(): string {
    return join(systemDir(this.options.home), "provider-plugins.json");
  }

  private readDoc(): ProviderPluginsDocument {
    if (!existsSync(this.statePath)) return { plugins: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as unknown;
      if (!isObject(parsed) || !isObject(parsed.plugins)) return { plugins: {} };
      return parsed as unknown as ProviderPluginsDocument;
    } catch {
      return { plugins: {} };
    }
  }

  private writeDoc(doc: ProviderPluginsDocument): void {
    mkdirSync(systemDir(this.options.home), { recursive: true });
    const tmp = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.statePath);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  private readAccountAuth(pluginId: string, providerId: string, accountId: string): Record<string, unknown> | null {
    const raw = readSecrets(this.options.home)[providerAccountSecretKey(pluginId, providerId, accountId)];
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeAccountAuth(pluginId: string, providerId: string, accountId: string, auth: Record<string, unknown> | null): void {
    writeSecret(
      this.options.home,
      providerAccountSecretKey(pluginId, providerId, accountId),
      auth ? JSON.stringify(auth) : "",
    );
  }

  /** 遮蔽文本中出现的所有供应商插件凭据值。 */
  redact(text: string): string {
    if (!text) return text;
    let out = text;
    try {
      const secrets = readSecrets(this.options.home);
      for (const [key, raw] of Object.entries(secrets)) {
        if (!key.includes(":provider:") && !key.startsWith("provider:")) continue;
        if (key.startsWith("provider:")) {
          if (raw.length >= 6) out = out.split(raw).join("[已隐藏]");
          continue;
        }
        try {
          const parsed = JSON.parse(raw) as unknown;
          const values: string[] = [];
          const visit = (value: unknown, seen: Set<object>) => {
            if (typeof value === "string") {
              if (value.length >= 6) values.push(value);
              return;
            }
            if (!value || typeof value !== "object" || seen.has(value)) return;
            seen.add(value);
            if (Array.isArray(value)) value.forEach((item) => visit(item, seen));
            else Object.values(value).forEach((item) => visit(item, seen));
          };
          visit(parsed, new Set());
          for (const value of values) out = out.split(value).join("[已隐藏]");
        } catch {
          if (raw.length >= 6) out = out.split(raw).join("[已隐藏]");
        }
      }
    } catch { /* ignore */ }
    return out;
  }

  private buildHostPluginSpecs(): HostPluginLoadSpec[] {
    const specs: HostPluginLoadSpec[] = [];
    for (const installed of this.options.store.list()) {
      if (!installed.enabled || installed.needsApproval) continue;
      let manifest: Record<string, unknown>;
      try {
        manifest = this.options.store.files(installed.id).manifest;
      } catch {
        continue;
      }
      const providers = providerDeclarations(manifest);
      if (!providers.length) continue;
      const pluginDir = this.options.store.pluginDir(installed.id);
      const packages = providers
        .map((spec) => ({
          package: spec.package,
          dir: resolveProviderPackageDir(pluginDir, spec.package),
          version: spec.version,
        }))
        .filter((entry) => existsSync(entry.dir));
      if (!packages.length) continue;

      const extensions = isObject(manifest.extensions) ? manifest.extensions : undefined;
      const hob = isObject(extensions?.["com.hob.plugins"]) ? extensions["com.hob.plugins"] : undefined;
      const providerConfig = isObject(hob?.providerConfig) ? hob.providerConfig : undefined;

      specs.push({
        pluginId: installed.id,
        dataDir: join(this.options.home, "plugin-data", installed.id),
        packages,
        ...(providerConfig ? { userConfig: { provider: providerConfig } } : {}),
      });
    }
    return specs;
  }

  private mergeLoadedMetadata(loaded: HostLoadedPlugin[]): void {
    const doc = this.readDoc();
    let changed = false;
    for (const item of loaded) {
      const pState = (doc.plugins[item.pluginId] ??= { providers: {} });
      pState.error = item.error ? this.redact(item.error) : undefined;
      for (const prov of item.providers) {
        const cur = (pState.providers[prov.providerId] ??= { accounts: {} });
        cur.name = prov.name;
        cur.npm = prov.npm;
        cur.api = prov.api;
        cur.icon = prov.icon || undefined;
        cur.single = prov.single;
        cur.methods = prov.methods;
        cur.usageSupported = prov.usageSupported;
        cur.refreshSupported = prov.refreshSupported;
        cur.refreshLead = prov.refreshLead;
        cur.cli = prov.cli;
        // 如果有静态声明的模型且该账号还没有缓存，先不覆盖账号缓存
        changed = true;
      }
    }
    if (changed) this.writeDoc(doc);
  }

  private async handleHostAuthUpdate(event: { pluginId: string; provider: string; accountId: string; auth: Record<string, unknown> }): Promise<void> {
    if (!event.pluginId || !event.provider || !event.accountId) return;
    const lockKey = `${event.pluginId}\0${event.provider}\0${event.accountId}`;
    const prev = this.refreshLocks.get(lockKey);
    const task = (prev ? prev.catch(() => {}) : Promise.resolve()).then(() => {
      const doc = this.readDoc();
      const account = doc.plugins[event.pluginId]?.providers[event.provider]?.accounts[event.accountId];
      if (!account) return event.auth;
      this.writeAccountAuth(event.pluginId, event.provider, event.accountId, event.auth);
      account.updatedAt = new Date().toISOString();
      account.expiresAt = extractExpirationIso(event.auth);
      account.status = "logged_in";
      account.lastError = undefined;
      this.writeDoc(doc);
      return event.auth;
    });
    this.refreshLocks.set(lockKey, task);
    try {
      await task;
    } finally {
      if (this.refreshLocks.get(lockKey) === task) this.refreshLocks.delete(lockKey);
    }
  }

  /** 安装或更新插件时：下载 Bun（按需）并用 Bun 安装校验过 integrity 的包，推送进度事件。 */
  async installPluginProviders(pluginId: string, targetDir?: string): Promise<void> {
    const pluginDir = targetDir ?? this.options.store.pluginDir(pluginId);
    const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8")) as Record<string, unknown>;
    const specs = providerDeclarations(manifest);
    if (!specs.length) return;
    const emitProgress = (ev: Omit<PluginInstallProgress, "pluginId">) => {
      this.options.bus.emit({ type: "plugin-install", pluginId, ...ev });
    };
    try {
      await this.bun.installPackages(pluginDir, specs, emitProgress);
      if (targetDir) return;
      // 确保 state 里有记录；启动宿主加载一次元数据（methods / cli / icon / 静态模型）
      await this.host.syncIfRunning();
      const installed = this.options.store.get(pluginId);
      if (installed.enabled && !installed.needsApproval) {
        const loaded = await this.host.ensureStarted();
        this.mergeLoadedMetadata(loaded);
      }
      this.options.bus.emit({ type: "plugin-providers", pluginId, host: this.host.statusView() });
    } catch (error) {
      const msg = this.redact(error instanceof Error ? error.message : String(error));
      emitProgress({ stage: "error", error: msg, message: msg });
      throw error;
    }
  }

  /** 插件启停/确认/卸载后的同步。 */
  async onPluginStateChanged(pluginId: string): Promise<void> {
    await this.host.syncIfRunning();
    await this.options.onProvidersChanged?.();
    this.options.bus.emit({ type: "plugin-providers", pluginId, host: this.host.statusView() });
  }

  /** 卸载插件时清理该插件全部账号状态、活跃登录会话与凭据。 */
  async onPluginRemoved(pluginId: string): Promise<void> {
    for (const [sid, session] of this.activeSignIns) {
      if (session.view.pluginId === pluginId) {
        this.cancelSignInInternal(sid, "cancelled");
      }
    }
    const doc = this.readDoc();
    delete doc.plugins[pluginId];
    this.writeDoc(doc);
    for (const key of Object.keys(readSecrets(this.options.home))) {
      if (key.startsWith(`plugin:${pluginId}:provider:`)) {
        writeSecret(this.options.home, key, "");
      }
    }
    await this.host.syncIfRunning();
    await this.options.onProvidersChanged?.();
    this.options.bus.emit({ type: "plugin-providers", pluginId, host: this.host.statusView() });
  }

  /** 确保某个插件的元数据已在宿主里探测过（若已缓存则不启动宿主）。 */
  async ensurePluginMetadata(pluginId: string, forceHost = false): Promise<PluginProviderView[]> {
    const installed = this.options.store.get(pluginId);
    const specs = providerDeclarations(this.options.store.files(pluginId).manifest);
    if (!specs.length) return [];
    if (forceHost && installed.enabled && !installed.needsApproval) {
      const loaded = await this.host.ensureStarted();
      this.mergeLoadedMetadata(loaded);
    }
    return this.pluginProvidersView(pluginId);
  }

  /** 读取某个插件的模型供应商视图（纯读缓存和内存状态，绝不触发拉起 Bun 宿主）。 */
  pluginProvidersView(pluginId: string): PluginProviderView[] {
    let manifest: Record<string, unknown>;
    try {
      manifest = this.options.store.files(pluginId).manifest;
    } catch {
      return [];
    }
    const specs = providerDeclarations(manifest);
    if (!specs.length) return [];

    const doc = this.readDoc();
    const pState = doc.plugins[pluginId];
    if (!pState) return [];
    const providerIds = Object.keys(pState.providers);
    const customThinking = this.options.getThinkingSettings?.();

    return providerIds.map((providerId) => {
      const prov = pState.providers[providerId];
      const hobProviderId = hobProviderIdFor(pluginId, providerId, providerIds.length);
      const accountList = Object.values(prov.accounts).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const activeId = prov.activeAccountId && prov.accounts[prov.activeAccountId]
        ? prov.activeAccountId
        : accountList[0]?.id;
      const activeAccount = activeId ? prov.accounts[activeId] : undefined;

      const accounts: PluginProviderAccountView[] = accountList.map((acc) => ({
        id: acc.id,
        providerId: acc.providerId,
        displayName: acc.displayName,
        authType: acc.authType,
        active: acc.id === activeId,
        status: acc.status,
        ...(acc.plan ? { plan: acc.plan } : {}),
        ...(acc.hint ? { hint: acc.hint } : {}),
        ...(acc.lastError ? { lastError: acc.lastError } : {}),
        ...(acc.expiresAt ? { expiresAt: acc.expiresAt } : {}),
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt,
      }));

      const overrides = prov.modelOverrides ?? {};
      // 参数从低到高：插件给的 < 插件没给时按公开模型目录补的 < 用户在插件页改的
      const models = (activeAccount?.rawModels ?? []).map((entry) => ({
        ...toModelView(providerId, withOverride(this.withCatalog(entry), overrides[entry.id]), hobProviderId, customThinking),
        ...(overrides[entry.id] ? { overridden: true } : {}),
      }));
      const cachedModels = (models.length ? models : (activeAccount?.models ?? [])).map((m) => ({
        ...m,
        thinking: thinkingViewOf(hobProviderId, m, customThinking?.[`${hobProviderId}/${m.id}`]),
      }));

      const activeSignIn = [...this.activeSignIns.values()]
        .find((s) => s.view.pluginId === pluginId && s.view.providerId === providerId)?.view;

      const usageKey = activeId ? `${pluginId}\0${providerId}\0${activeId}` : "";
      const usage = usageKey ? this.usageCache.get(usageKey) : undefined;
      const cliKey = `${pluginId}\0${providerId}`;

      return {
        hobProviderId,
        providerId,
        name: prov.name || providerId,
        ...(prov.icon ? { icon: prov.icon } : {}),
        single: prov.single === true,
        methods: prov.methods ?? [],
        accounts,
        ...(activeId ? { activeAccountId: activeId } : {}),
        models: cachedModels,
        ...(activeAccount?.modelsCachedAt ? { modelsCachedAt: activeAccount.modelsCachedAt } : {}),
        ...(activeAccount?.modelsError ? { modelsError: activeAccount.modelsError } : {}),
        ...(activeAccount?.modelsFellBack ? { modelsFellBack: true } : {}),
        usageSupported: prov.usageSupported === true,
        ...(usage ? { usage } : {}),
        ...(prov.cli
          ? {
              cli: {
                declared: true,
                name: prov.cli.name,
                ...(prov.cli.manual ? { manual: prov.cli.manual } : {}),
                installing: this.cliInstalling.has(cliKey),
              },
            }
          : {}),
        ...(activeSignIn ? { signIn: { ...activeSignIn } } : {}),
        ...(pState.error || prov.error ? { error: pState.error || prov.error } : {}),
      };
    });
  }

  /** 设置 → 服务商页用的插件服务商摘要列表 + 对应思考档视图。 */
  providerSummaries(): { summaries: PluginProviderSummary[]; models: Record<string, ModelThinkingView[]> } {
    const summaries: PluginProviderSummary[] = [];
    const models: Record<string, ModelThinkingView[]> = {};
    const customThinking = this.options.getThinkingSettings?.();

    for (const installed of this.options.store.list()) {
      let manifest: Record<string, unknown>;
      try {
        manifest = this.options.store.files(installed.id).manifest;
      } catch {
        continue;
      }
      if (!providerDeclarations(manifest).length) continue;
      const pluginName = typeof manifest.displayName === "string"
        ? manifest.displayName
        : typeof manifest.name === "string"
          ? manifest.name
          : installed.id;

      for (const view of this.pluginProvidersView(installed.id)) {
        const active = view.accounts.find((a) => a.active);
        summaries.push({
          id: view.hobProviderId,
          pluginId: installed.id,
          pluginName,
          providerId: view.providerId,
          name: view.name || pluginName,
          enabled: installed.enabled && !installed.needsApproval,
          loggedIn: Boolean(active),
          ...(active ? { activeAccount: active.displayName } : {}),
          modelCount: view.models.length,
          ...(view.error || view.modelsError ? { error: view.error || view.modelsError } : {}),
        });
        models[view.hobProviderId] = view.models.map((m) =>
          m.thinking ?? thinkingViewOf(view.hobProviderId, m, customThinking?.[`${view.hobProviderId}/${m.id}`]),
        );
      }
    }
    return { summaries, models };
  }

  /** 插件没给上下文窗口 / 单次最多输出时，用公开模型目录里同 id 模型的补上；目录里也没有就留给默认值。 */
  private withCatalog(entry: HostModelEntry): HostModelEntry {
    if (entry.context > 0 && entry.output > 0) return entry;
    const known = this.options.catalogLimits?.(entry.id);
    if (!known) return entry;
    return {
      ...entry,
      context: entry.context > 0 ? entry.context : known.context,
      output: entry.output > 0 ? entry.output : known.output,
    };
  }

  /**
   * 插件页：改一个模型的参数。override 只带改的那几项，和之前改过的合在一起；null 恢复插件给的。
   * 存完重新注册进引擎，下一轮对话就按新参数。
   */
  async setModelOverride(pluginId: string, providerId: string, modelId: string, override: PluginModelOverride | null): Promise<void> {
    const doc = this.readDoc();
    const prov = doc.plugins[pluginId]?.providers[providerId];
    if (!prov) throw new Error(t("这个插件没有供应商 {provider}。", { provider: providerId }));
    const known = Object.values(prov.accounts).some((acc) =>
      (acc.rawModels ?? acc.models ?? []).some((m) => m.id === modelId),
    );
    if (!known) throw new Error(t("模型 {model} 不在这个供应商的模型列表里。", { model: modelId }));
    const overrides = { ...prov.modelOverrides };
    const next = override ? { ...overrides[modelId], ...cleanOverride(override) } : {};
    if (Object.keys(next).length) overrides[modelId] = next;
    else delete overrides[modelId];
    prov.modelOverrides = Object.keys(overrides).length ? overrides : undefined;
    this.writeDoc(doc);
    await this.options.onProvidersChanged?.();
    this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
  }

  /** 返回当前所有已注册的插件服务商 id（供 builtin 列表过滤）。 */
  registeredHobProviderIds(): Set<string> {
    return new Set(this.appliedProviderIds);
  }

  // ---- 模型列表拉取与缓存 --------------------------------------------------

  private seedModelsFromRuntime(providerId: string): Record<string, unknown> {
    const builtin = this.lastRuntime?.getProvider(providerId)?.getModels() ?? [];
    if (!builtin.length) return {};
    const out: Record<string, unknown> = {};
    for (const m of builtin) {
      const npm =
        m.api === "anthropic-messages"
          ? "@ai-sdk/anthropic"
          : m.api === "openai-responses"
            ? "@ai-sdk/openai"
            : "@ai-sdk/openai-compatible";
      out[m.id] = {
        id: m.id,
        name: m.name || m.id,
        api: { id: m.id, npm, url: m.baseUrl || "" },
        limit: { context: m.contextWindow, output: m.maxTokens },
        capabilities: {
          reasoning: Boolean(m.reasoning),
          input: { text: true, image: m.input.includes("image") },
        },
        cost: m.cost,
      };
    }
    return out;
  }

  /**
   * 刷新指定账号的模型列表：
   * - 成功时更新按账号缓存的 models + modelsCachedAt，清空 modelsError，重新注册进 pi；
   * - 失败时保留上次成功的列表，写明 modelsError 和 modelsFellBack: true（绝不用空列表冒充）。
   */
  async refreshModels(pluginId: string, providerId: string, accountId?: string, signal?: AbortSignal): Promise<PluginProviderModelView[]> {
    const doc = this.readDoc();
    const pState = doc.plugins[pluginId];
    const prov = pState?.providers[providerId];
    const targetId = accountId ?? prov?.activeAccountId ?? Object.keys(prov?.accounts ?? {})[0];
    if (!prov || !targetId || !prov.accounts[targetId]) {
      throw new Error("请先登录账号后再刷新模型列表。");
    }

    const auth = await this.ensureFreshAuth(pluginId, providerId, targetId, signal);
    const seedModels = this.seedModelsFromRuntime(providerId);
    const providerCount = Object.keys(pState.providers).length;
    const hobProviderId = hobProviderIdFor(pluginId, providerId, providerCount);
    const customThinking = this.options.getThinkingSettings?.();

    try {
      const result = await this.host.models(
        { pluginId, provider: providerId, accountId: targetId, auth, seedModels },
        signal,
      );
      const rawModels = result.models;
      const views = rawModels.map((entry) => toModelView(providerId, entry, hobProviderId, customThinking));

      const freshDoc = this.readDoc();
      const acc = freshDoc.plugins[pluginId]?.providers[providerId]?.accounts[targetId];
      if (acc) {
        acc.rawModels = rawModels;
        acc.models = views;
        acc.modelsCachedAt = new Date().toISOString();
        acc.modelsError = undefined;
        acc.modelsFellBack = false;
        acc.updatedAt = new Date().toISOString();
        this.writeDoc(freshDoc);
      }
      await this.options.onProvidersChanged?.();
      this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
      return views;
    } catch (error) {
      const reason = this.redact(error instanceof Error ? error.message : String(error));
      const freshDoc = this.readDoc();
      const acc = freshDoc.plugins[pluginId]?.providers[providerId]?.accounts[targetId];
      if (acc) {
        acc.modelsError = reason;
        acc.modelsFellBack = true;
        if (error instanceof HostRpcError && error.signIn === "expired") {
          acc.status = "expired";
          acc.lastError = reason;
        }
        this.writeDoc(freshDoc);
      }
      this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
      throw new Error(`拉取模型列表失败：${reason}`, { cause: error });
    }
  }

  // ---- 凭据单飞刷新 --------------------------------------------------------

  private async ensureFreshAuth(
    pluginId: string,
    providerId: string,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const auth = this.readAccountAuth(pluginId, providerId, accountId);
    if (!auth) throw new Error("该账号缺少凭据，请重新登录。");
    if (auth.type !== "oauth") return auth;

    const doc = this.readDoc();
    const prov = doc.plugins[pluginId]?.providers[providerId];
    if (!prov?.refreshSupported) return auth;
    const exp = Number(auth.expires);
    const lead = prov.refreshLead ?? 5 * 60 * 1000;
    const expMs = Number.isFinite(exp) && exp > 0 ? (exp < 1e12 ? exp * 1000 : exp) : 0;
    if (!expMs || Date.now() + lead < expMs) return auth;

    const lockKey = `${pluginId}\0${providerId}\0${accountId}`;
    const existing = this.refreshLocks.get(lockKey);
    if (existing) return existing;

    const task = (async () => {
      const latest = this.readAccountAuth(pluginId, providerId, accountId);
      if (!latest) throw new Error("该账号缺少凭据，请重新登录。");
      const res = await this.host.refresh({ pluginId, provider: providerId, accountId, auth: latest }, signal);
      if (res.refreshed && res.auth) {
        // 覆盖前再读一次，避免覆盖同时发生的新登录
        const current = this.readAccountAuth(pluginId, providerId, accountId);
        if (!current || current.refresh === latest.refresh) {
          this.writeAccountAuth(pluginId, providerId, accountId, res.auth);
          const d = this.readDoc();
          const acc = d.plugins[pluginId]?.providers[providerId]?.accounts[accountId];
          if (acc) {
            acc.status = "logged_in";
            acc.lastError = undefined;
            acc.expiresAt = extractExpirationIso(res.auth);
            acc.updatedAt = new Date().toISOString();
            this.writeDoc(d);
          }
          return res.auth;
        }
        return current;
      }
      if (res.signIn === "expired") {
        const d = this.readDoc();
        const acc = d.plugins[pluginId]?.providers[providerId]?.accounts[accountId];
        if (acc) {
          acc.status = "expired";
          acc.lastError = this.redact(res.error || "登录已过期，请重新登录。");
          this.writeDoc(d);
        }
        this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
        throw new HostRpcError(this.redact(res.error || "登录已过期，请重新登录。"), "expired");
      }
      return latest;
    })().finally(() => {
      if (this.refreshLocks.get(lockKey) === task) this.refreshLocks.delete(lockKey);
    });

    this.refreshLocks.set(lockKey, task);
    return task;
  }

  // ---- 多账号管理 ----------------------------------------------------------

  private saveSignedInAccount(params: {
    pluginId: string;
    providerId: string;
    auth: Record<string, unknown>;
    targetAccountId?: string;
    displayName?: string;
    hint?: string;
  }): StoredProviderAccount {
    const doc = this.readDoc();
    const pState = (doc.plugins[params.pluginId] ??= { providers: {} });
    const prov = (pState.providers[params.providerId] ??= { accounts: {} });
    const existingIds = Object.keys(prov.accounts);
    let accountId: string;
    if (prov.single && existingIds.length > 0) {
      accountId = existingIds[0];
    } else if (params.targetAccountId && prov.accounts[params.targetAccountId]) {
      accountId = params.targetAccountId;
    } else {
      accountId = randomUUID().slice(0, 8);
    }

    const now = new Date().toISOString();
    const prev = prov.accounts[accountId];
    const authType: "oauth" | "api" = params.auth.type === "oauth" ? "oauth" : "api";
    const fallbackName = prov.single
      ? (prov.name || params.providerId)
      : `账号 ${existingIds.includes(accountId) ? existingIds.indexOf(accountId) + 1 : existingIds.length + 1}`;
    const displayName = (params.displayName?.trim() || prev?.displayName || fallbackName).slice(0, 120);

    const record: StoredProviderAccount = {
      ...(prev ?? {}),
      id: accountId,
      providerId: params.providerId,
      displayName,
      authType,
      status: "logged_in",
      ...(params.hint ? { hint: params.hint } : {}),
      lastError: undefined,
      expiresAt: extractExpirationIso(params.auth),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    prov.accounts[accountId] = record;
    prov.activeAccountId = accountId;

    this.writeAccountAuth(params.pluginId, params.providerId, accountId, params.auth);
    this.writeDoc(doc);
    void this.host.invalidateAccount({ pluginId: params.pluginId, provider: params.providerId, accountId });
    return record;
  }

  async setActiveAccount(pluginId: string, providerId: string, accountId: string): Promise<void> {
    const doc = this.readDoc();
    const prov = doc.plugins[pluginId]?.providers[providerId];
    if (!prov || !prov.accounts[accountId]) throw new Error("找不到该账号");
    prov.activeAccountId = accountId;
    this.writeDoc(doc);
    await this.options.onProvidersChanged?.();
    this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
  }

  async removeAccount(pluginId: string, providerId: string, accountId: string): Promise<void> {
    const doc = this.readDoc();
    const prov = doc.plugins[pluginId]?.providers[providerId];
    if (!prov || !prov.accounts[accountId]) throw new Error("找不到该账号");
    delete prov.accounts[accountId];
    if (prov.activeAccountId === accountId) {
      prov.activeAccountId = Object.keys(prov.accounts)[0];
    }
    this.writeAccountAuth(pluginId, providerId, accountId, null);
    this.writeDoc(doc);
    this.usageCache.delete(`${pluginId}\0${providerId}\0${accountId}`);
    await this.host.invalidateAccount({ pluginId, provider: providerId, accountId });
    await this.options.onProvidersChanged?.();
    this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
  }

  // ---- 五种登录流程 --------------------------------------------------------

  async nextPrompt(params: {
    pluginId: string;
    providerId: string;
    methodIndex: number;
    inputs: Record<string, string>;
  }): Promise<PluginAuthPromptView | null> {
    await this.ensurePluginMetadata(params.pluginId, true);
    const res = await this.host.prompt({
      pluginId: params.pluginId,
      provider: params.providerId,
      method: params.methodIndex,
      inputs: params.inputs,
    });
    return res.prompt;
  }

  async validatePrompt(params: {
    pluginId: string;
    providerId: string;
    methodIndex: number;
    key: string;
    value: string;
  }): Promise<string | null> {
    await this.ensurePluginMetadata(params.pluginId, true);
    const res = await this.host.validatePrompt({
      pluginId: params.pluginId,
      provider: params.providerId,
      method: params.methodIndex,
      key: params.key,
      value: params.value,
    });
    return res.error;
  }

  /** 登录方式 1：填密钥或 keyless 免登录。 */
  async signInApiKey(params: {
    pluginId: string;
    providerId: string;
    methodIndex: number;
    key?: string;
    displayName?: string;
    inputs?: Record<string, string>;
    accountId?: string;
  }): Promise<{ account: StoredProviderAccount; models: PluginProviderModelView[]; modelsError?: string }> {
    await this.ensurePluginMetadata(params.pluginId, true);
    const result = await this.host.apiKey({
      pluginId: params.pluginId,
      provider: params.providerId,
      method: params.methodIndex,
      inputs: params.inputs ?? {},
      key: params.key,
      accountId: params.accountId,
    });
    if (!result.ok || !result.auth) {
      throw new Error(this.redact(result.error || "登录失败"));
    }
    const targetProvider = result.provider || params.providerId;
    const account = this.saveSignedInAccount({
      pluginId: params.pluginId,
      providerId: targetProvider,
      auth: result.auth,
      targetAccountId: params.accountId,
      displayName: params.displayName?.trim() || result.accountInfo?.displayName,
      hint: result.accountInfo?.hint,
    });
    let models: PluginProviderModelView[] = [];
    let modelsError: string | undefined;
    try {
      models = await this.refreshModels(params.pluginId, targetProvider, account.id);
    } catch (error) {
      modelsError = error instanceof Error ? error.message : String(error);
    }
    this.options.bus.emit({ type: "plugin-providers", pluginId: params.pluginId, providerId: targetProvider });
    return { account, models, ...(modelsError ? { modelsError } : {}) };
  }

  /** 登录方式 2/3/4/5：发起 OAuth / 设备码 / 服务端轮询 / Loopback 粘贴 / 本机 CLI 登录。 */
  async startSignIn(params: {
    pluginId: string;
    providerId: string;
    methodIndex: number;
    inputs?: Record<string, string>;
    accountId?: string;
  }): Promise<PluginSignInSessionView> {
    await this.ensurePluginMetadata(params.pluginId, true);
    const doc = this.readDoc();
    const prov = doc.plugins[params.pluginId]?.providers[params.providerId];
    const hasCli = Boolean(prov?.cli);
    // 插件要靠本机命令行运行、机器上还没有时，登录前先替用户装好，不让用户先去装再回来
    if (hasCli) {
      const cli = await this.checkCli(params.pluginId, params.providerId);
      if (cli.declared && !cli.installed) await this.installCli(params.pluginId, params.providerId);
    }

    // 取消同一插件同一供应商之前的等待会话
    for (const [sid, existing] of this.activeSignIns) {
      if (existing.view.pluginId === params.pluginId && existing.view.providerId === params.providerId && existing.view.status === "waiting") {
        this.cancelSignInInternal(sid, "cancelled");
      }
    }

    const sessionId = randomUUID();
    const ctl = new AbortController();
    const releaseHost = this.host.holdSignIn();

    let authz: Awaited<ReturnType<ProviderPluginHost["authorize"]>>;
    try {
      authz = await this.host.authorize(
        {
          pluginId: params.pluginId,
          provider: params.providerId,
          method: params.methodIndex,
          inputs: params.inputs ?? {},
          accountId: params.accountId,
        },
        ctl.signal,
      );
    } catch (error) {
      releaseHost();
      throw new Error(this.redact(error instanceof Error ? error.message : String(error)), { cause: error });
    }

    if (!authz.ok || !authz.session) {
      releaseHost();
      throw new Error(this.redact(authz.error || "无法发起登录"));
    }

    const url = authz.url ?? "";
    const instructions = authz.instructions ?? "";
    const method = authz.method === "code" ? "code" : "auto";
    const loopbackPorts = url ? extractLoopbackPorts(url) : [];
    const kind = classifySignInKind({ method, url, instructions, loopbackPorts, hasCli });
    const userCode = extractUserCode(instructions);
    const now = Date.now();

    const view: PluginSignInSessionView = {
      sessionId,
      pluginId: params.pluginId,
      providerId: params.providerId,
      methodIndex: params.methodIndex,
      kind,
      status: "waiting",
      ...(url ? { url } : {}),
      ...(userCode ? { userCode } : {}),
      ...(instructions ? { instructions } : {}),
      ...(authz.opened ? { opened: true } : {}),
      ...(loopbackPorts.length > 0 ? { loopbackPasteAllowed: true } : {}),
      ...(hasCli ? { localCliNote: LOCAL_CLI_NOTE } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SIGNIN_TTL_MS).toISOString(),
    };

    const timer = setTimeout(() => {
      this.cancelSignInInternal(sessionId, "expired");
    }, SIGNIN_TTL_MS);
    timer.unref();

    const active: ActiveSignInSession = {
      view,
      hostSessionId: authz.session,
      loopbackPorts,
      controller: ctl,
      releaseHost,
      timer,
      targetAccountId: params.accountId,
    };
    this.activeSignIns.set(sessionId, active);
    this.options.bus.emit({ type: "plugin-providers", pluginId: params.pluginId, providerId: params.providerId, signIn: { ...view } });

    // method === "auto" 时后台等待插件 callback（设备码轮询、服务端轮询、本机 loopback 回调或本机 CLI 复用）
    if (method === "auto") {
      void this.runCallback(active);
    }

    return { ...view };
  }

  private async runCallback(session: ActiveSignInSession, code?: string): Promise<PluginSignInSessionView> {
    if (!session.hostSessionId) return { ...session.view };
    const hostSession = session.hostSessionId;
    session.hostSessionId = undefined;
    try {
      const res = await this.host.callback({
        session: hostSession,
        ...(code !== undefined ? { code } : {}),
        pluginId: session.view.pluginId,
        provider: session.view.providerId,
        accountId: session.targetAccountId ?? "",
      }, session.controller.signal);
      if (session.view.status === "cancelled" || session.view.status === "expired") {
        return { ...session.view };
      }
      if (!res.ok || !res.auth) {
        this.finishSignIn(session, "failed", this.redact(res.error || "登录未完成或失败"));
        return { ...session.view };
      }
      const targetProvider = res.provider || session.view.providerId;
      const account = this.saveSignedInAccount({
        pluginId: session.view.pluginId,
        providerId: targetProvider,
        auth: res.auth,
        targetAccountId: session.targetAccountId,
        displayName: res.accountInfo?.displayName,
        hint: res.accountInfo?.hint,
      });
      session.view.accountId = account.id;
      this.finishSignIn(session, "completed");
      // 异步刷新模型列表，失败也不把刚完成的登录标成失败
      void this.refreshModels(session.view.pluginId, targetProvider, account.id).catch(() => {});
      return { ...session.view };
    } catch (error) {
      if (session.view.status === "cancelled" || session.view.status === "expired") {
        return { ...session.view };
      }
      const reason = this.redact(error instanceof Error ? error.message : String(error));
      this.finishSignIn(session, "failed", reason);
      return { ...session.view };
    }
  }

  private finishSignIn(session: ActiveSignInSession, status: PluginSignInSessionView["status"], error?: string): void {
    clearTimeout(session.timer);
    session.view.status = status;
    if (error) session.view.error = error;
    session.releaseHost();
    this.options.bus.emit({
      type: "plugin-providers",
      pluginId: session.view.pluginId,
      providerId: session.view.providerId,
      signIn: { ...session.view },
    });
    // 保留已完成/失败的会话状态 2 分钟供前端轮询读取，之后清理
    const cleanup = setTimeout(() => {
      if (this.activeSignIns.get(session.view.sessionId) === session) {
        this.activeSignIns.delete(session.view.sessionId);
      }
    }, 120_000);
    cleanup.unref();
  }

  private cancelSignInInternal(sessionId: string, reason: "cancelled" | "expired"): PluginSignInSessionView | null {
    const session = this.activeSignIns.get(sessionId);
    if (!session) return null;
    if (session.view.status !== "waiting" && session.view.status !== "pending") {
      return { ...session.view };
    }
    session.view.status = reason;
    session.view.error = reason === "expired" ? "登录已过期，请重新开始。" : "登录已取消。";
    session.controller.abort();
    this.finishSignIn(session, reason, session.view.error);
    return { ...session.view };
  }

  getSignInSession(sessionId: string, pluginId?: string, providerId?: string): PluginSignInSessionView | null {
    const s = this.activeSignIns.get(sessionId);
    if (!s || (pluginId !== undefined && s.view.pluginId !== pluginId) || (providerId !== undefined && s.view.providerId !== providerId)) return null;
    return { ...s.view };
  }

  assertSignInSession(pluginId: string, providerId: string, sessionId: string): void {
    if (!this.getSignInSession(sessionId, pluginId, providerId)) throw new Error("登录会话不属于当前插件和供应商");
  }

  cancelSignIn(sessionId: string): PluginSignInSessionView {
    const view = this.cancelSignInInternal(sessionId, "cancelled");
    if (!view) throw new Error("找不到对应的登录会话");
    return view;
  }

  /** 提交手动授权码（method === "code"）。 */
  async submitSignInCode(sessionId: string, code: string): Promise<PluginSignInSessionView> {
    const session = this.activeSignIns.get(sessionId);
    if (!session || session.view.status !== "waiting") {
      throw new Error("登录会话不存在或已结束，请重新开始。");
    }
    if (!code.trim()) throw new Error("请输入授权码或回调地址。");
    return this.runCallback(session, code.trim());
  }

  /** 提交远程浏览器停住的本机回调地址：严格校验 loopback 主机与本次登录端口后，在本机回放一次 GET。 */
  async pasteLoopbackCallback(sessionId: string, rawUrl: string): Promise<{ status: number; nextUrl?: string; session: PluginSignInSessionView }> {
    const session = this.activeSignIns.get(sessionId);
    if (!session || session.view.status !== "waiting") {
      throw new Error("登录会话不存在或已结束，请重新开始。");
    }
    if (!session.loopbackPorts.length) {
      throw new Error("本次登录不接受本机回调地址粘贴。");
    }
    const replayed = await replayLoopbackCallback(session.loopbackPorts, rawUrl, session.controller.signal);
    if (replayed.nextUrl) {
      session.view.url = replayed.nextUrl;
      this.options.bus.emit({
        type: "plugin-providers",
        pluginId: session.view.pluginId,
        providerId: session.view.providerId,
        signIn: { ...session.view },
      });
    }
    return { ...replayed, session: { ...session.view } };
  }

  // ---- 本机 CLI 检测与安装 -------------------------------------------------

  async checkCli(pluginId: string, providerId: string): Promise<PluginCliStatusView> {
    await this.ensurePluginMetadata(pluginId, true);
    const res = await this.host.cliStatus({ pluginId, provider: providerId });
    return {
      ...res,
      installing: this.cliInstalling.has(`${pluginId}\0${providerId}`),
    };
  }

  async installCli(pluginId: string, providerId: string, signal?: AbortSignal): Promise<PluginCliStatusView> {
    await this.ensurePluginMetadata(pluginId, true);
    const key = `${pluginId}\0${providerId}`;
    if (this.cliInstalling.has(key)) throw new Error("正在安装 CLI，请稍候。");
    this.cliInstalling.add(key);
    this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
    try {
      await this.host.cliInstall({ pluginId, provider: providerId }, signal);
      return await this.checkCli(pluginId, providerId);
    } finally {
      this.cliInstalling.delete(key);
      this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
    }
  }

  // ---- 额度 / 用量查询 -----------------------------------------------------

  async fetchUsage(pluginId: string, providerId: string, accountId?: string, signal?: AbortSignal): Promise<PluginProviderUsageView> {
    const doc = this.readDoc();
    const prov = doc.plugins[pluginId]?.providers[providerId];
    const targetId = accountId ?? prov?.activeAccountId ?? Object.keys(prov?.accounts ?? {})[0];
    if (!prov || !targetId || !prov.accounts[targetId]) {
      throw new Error("请先登录账号后再查询额度。");
    }
    const auth = await this.ensureFreshAuth(pluginId, providerId, targetId, signal);
    const now = new Date().toISOString();
    try {
      const raw = await this.host.usage({ pluginId, provider: providerId, accountId: targetId, auth }, signal);
      const { signIn, ...rest } = raw;
      const view: PluginProviderUsageView = {
        ...rest,
        error: rest.error ? this.redact(rest.error) : undefined,
        fetchedAt: now,
      };
      this.usageCache.set(`${pluginId}\0${providerId}\0${targetId}`, view);

      const d = this.readDoc();
      const acc = d.plugins[pluginId]?.providers[providerId]?.accounts[targetId];
      if (acc) {
        if (view.plan) acc.plan = view.plan;
        if (view.user && !acc.displayName.includes("@")) acc.displayName = view.user;
        if (signIn === "expired") {
          acc.status = "expired";
          acc.lastError = view.error || "登录已过期，请重新登录。";
        } else if (signIn === "renewed") {
          acc.status = "logged_in";
          acc.lastError = undefined;
        }
        this.writeDoc(d);
      }
      this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
      return view;
    } catch (error) {
      const reason = this.redact(error instanceof Error ? error.message : String(error));
      const failedView: PluginProviderUsageView = {
        error: reason,
        windows: [],
        fetchedAt: now,
      };
      this.usageCache.set(`${pluginId}\0${providerId}\0${targetId}`, failedView);
      return failedView;
    }
  }

  // ---- 内部端点请求转发 ----------------------------------------------------

  private async handleProxyRequest(dispatch: ProxyRequestDispatch) {
    const { pluginId, providerId, restPath, method, headers, body, modelId, signal } = dispatch;
    const installed = this.options.store.list().find((p) => p.id === pluginId);
    if (!installed || !installed.enabled || installed.needsApproval) {
      throw new Error(`插件 ${pluginId} 未启用`);
    }

    const doc = this.readDoc();
    const prov = doc.plugins[pluginId]?.providers[providerId];
    const activeId = prov?.activeAccountId && prov.accounts[prov.activeAccountId]
      ? prov.activeAccountId
      : Object.keys(prov?.accounts ?? {})[0];
    if (!prov || !activeId) {
      throw new Error(`供应商 ${providerId} 尚未登录`);
    }
    const account = prov.accounts[activeId];
    const auth = await this.ensureFreshAuth(pluginId, providerId, activeId, signal);

    const rawModel = account.rawModels?.find((m) => m.id === modelId)
      ?? account.rawModels?.find((m) => m.apiId === modelId);
    const apiId = rawModel?.apiId || modelId;
    const modelNpm = rawModel?.npm || prov.npm || "";
    const protocol = protocolForModel(providerId, modelNpm, apiId);

    // 若模型 id 与上游 apiId 不同，重写 JSON 请求体里的 model 字段
    let outgoingBody = body;
    if (body.length > 0 && apiId && apiId !== modelId) {
      try {
        const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        if (parsed.model === modelId) {
          parsed.model = apiId;
          outgoingBody = Buffer.from(JSON.stringify(parsed), "utf8");
        }
      } catch { /* ignore */ }
    }

    const seedModels = this.seedModelsFromRuntime(providerId);
    const seedProvider = Object.keys(seedModels).length ? { models: seedModels } : undefined;
    const loader = await this.host.load({
      pluginId,
      provider: providerId,
      accountId: activeId,
      auth,
      ...(seedProvider ? { seedProvider } : {}),
    });

    const upstreamUrl = computeUpstreamUrl({
      loaderBaseUrl: loader.baseURL,
      modelUrl: rawModel?.url,
      providerApi: prov.api,
      modelNpm,
      protocol,
      restPath,
    });

    try {
      const response = await this.host.fetch(
        {
          pluginId,
          provider: providerId,
          accountId: activeId,
          auth,
          model: apiId,
          npm: modelNpm,
          url: upstreamUrl,
          method,
          headers,
          ...(outgoingBody.length > 0 ? { bodyBase64: outgoingBody.toString("base64") } : {}),
          ...(seedProvider ? { seedProvider } : {}),
        },
        signal,
      );

      // 根据 X-Magpie-Sign-In 或 401 更新账号状态
      const signInHeader = response.headers["x-magpie-sign-in"]?.toLowerCase();
      if (signInHeader === "expired" || (response.status === 401 && signInHeader !== "kept")) {
        const d = this.readDoc();
        const acc = d.plugins[pluginId]?.providers[providerId]?.accounts[activeId];
        if (acc) {
          acc.status = signInHeader === "expired" ? "expired" : "needs_relogin";
          acc.lastError = "认证被拒绝（HTTP 401），请重新登录。";
          this.writeDoc(d);
          this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
        }
      }
      return response;
    } catch (error) {
      if (error instanceof HostRpcError && error.signIn === "expired") {
        const d = this.readDoc();
        const acc = d.plugins[pluginId]?.providers[providerId]?.accounts[activeId];
        if (acc) {
          acc.status = "expired";
          acc.lastError = this.redact(error.message);
          this.writeDoc(d);
          this.options.bus.emit({ type: "plugin-providers", pluginId, providerId });
        }
      }
      throw error;
    }
  }

  // ---- 注册到 pi ModelRuntime ----------------------------------------------

  /**
   * 把所有已启用、已登录且有缓存模型的插件供应商注册到 pi 引擎：
   * 注意这里只读磁盘缓存，不拉起 Bun 宿主，保持闲置零内存占用。
   */
  async applyTo(runtime: ModelRuntime): Promise<void> {
    this.lastRuntime = runtime;
    const nextIds = new Set<string>();
    const customThinking = this.options.getThinkingSettings?.();

    const toRegister: { hobProviderId: string; config: ProviderConfig }[] = [];

    for (const installed of this.options.store.list()) {
      if (!installed.enabled || installed.needsApproval) continue;
      let manifest: Record<string, unknown>;
      try {
        manifest = this.options.store.files(installed.id).manifest;
      } catch {
        continue;
      }
      if (!providerDeclarations(manifest).length) continue;

      for (const view of this.pluginProvidersView(installed.id)) {
        const active = view.accounts.find((a) => a.active);
        if (!active || !view.models.length) continue;
        // 只有真正要注册模型时才启动内部代理端点（仅监听 127.0.0.1 随机端口）
        if (!this.proxy.port) await this.proxy.start();

        const models: ProviderModelConfig[] = view.models.map((m) => {
          const ref = `${view.hobProviderId}/${m.id}`;
          const thinking = pluginModelThinking(
            { id: m.id, reasoning: m.reasoning, variants: m.variants, api: m.api },
            customThinking?.[ref],
          );
          return {
            id: m.id,
            name: m.name,
            api: m.api,
            baseUrl: this.proxy.baseUrlFor(installed.id, view.providerId, m.api),
            input: m.input.length ? m.input : ["text"],
            reasoning: m.reasoning,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
            ...(m.reasoning ? { thinkingLevelMap: thinking.map } : {}),
          } as ProviderModelConfig;
        });

        const primaryApi = view.models[0].api;
        nextIds.add(view.hobProviderId);
        toRegister.push({
          hobProviderId: view.hobProviderId,
          config: {
            name: view.name,
            api: primaryApi,
            baseUrl: this.proxy.baseUrlFor(installed.id, view.providerId, primaryApi),
            apiKey: this.proxy.token,
            models,
          } as ProviderConfig,
        });
      }
    }

    for (const oldId of this.appliedProviderIds) {
      if (!nextIds.has(oldId)) {
        runtime.unregisterProvider(oldId);
      }
    }
    for (const entry of toRegister) {
      runtime.registerProvider(entry.hobProviderId, entry.config);
    }
    this.appliedProviderIds = nextIds;
  }

  /** 返回当前宿主状态视图。 */
  hostStatus(): ProviderHostStatusView {
    return this.host.statusView();
  }

  /** 关闭宿主和内部端点。 */
  async close(): Promise<void> {
    for (const sid of [...this.activeSignIns.keys()]) {
      this.cancelSignInInternal(sid, "cancelled");
    }
    await this.host.close();
    await this.proxy.close();
  }
}
