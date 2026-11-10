// 服务商：设置里只放不敏感的部分，Key 存 HOB_HOME/secrets.json（键名 provider:<id>），任何接口都不回显。
// 内置服务商（引擎自带模型目录）只填 Key；兼容接口带上地址、协议和模型列表，注册进引擎。
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type {
  CustomProviderSettings,
  DiscoveredModels,
  ModelThinkingView,
  ProviderApi,
  ProviderImportView,
  ProviderModelSetting,
  ProviderSettings,
  ProviderView,
  ProvidersView,
  ThinkingLevelMapSetting,
} from "../../shared/types.ts";
import { listProviderImports, localPiDir, type ProviderImportCandidate } from "./imports.ts";
import { thinkingPlan } from "../../shared/thinking.ts";
import type { ModelCatalog } from "./models.ts";
import type { PiHost } from "./pi.ts";
import { readSecrets, writeSecret } from "./secrets.ts";
import type { SettingsStore } from "./settings.ts";

export const PROVIDER_APIS: ProviderApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

/** 兼容接口能列模型的协议：OpenAI 系打 /models，Anthropic 系打 /v1/models。 */
const LISTABLE: ProviderApi[] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

const DISCOVER_TIMEOUT_MS = 15_000;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
/** 兼容接口没填的元数据用这些值：引擎要求每个字段都有。 */
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** secrets.json 里一个服务商的 Key 叫什么。 */
export function providerKeyName(id: string): string {
  return `provider:${id}`;
}

export function providerKey(home: string, id: string): string {
  return readSecrets(home)[providerKeyName(id)]?.trim() ?? "";
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkBaseUrl(raw: string): string {
  const baseUrl = raw.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("请填写服务地址，如 http://127.0.0.1:8080/v1。");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("服务地址无效：需以 http:// 或 https:// 开头。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("服务地址协议无效：仅支持 http:// 或 https://。");
  }
  return baseUrl;
}

function checkModelList(raw: unknown): ProviderModelSetting[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error("兼容接口至少需要一个模型。");
  const models: ProviderModelSetting[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const id = trim(item.id);
    if (!id) throw new Error("存在未填写 ID 的模型。");
    if (seen.has(id)) throw new Error(`模型重复：${id}。`);
    seen.add(id);
    const name = trim(item.name);
    const input = Array.isArray(item.input)
      ? item.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image")
      : [];
    const contextWindow = Number(item.contextWindow);
    const maxTokens = Number(item.maxTokens);
    models.push({
      id,
      ...(name ? { name } : {}),
      ...(input.length ? { input } : {}),
      ...(typeof item.reasoning === "boolean" ? { reasoning: item.reasoning } : {}),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.round(contextWindow) } : {}),
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens: Math.round(maxTokens) } : {}),
      ...(item.extra && typeof item.extra === "object" ? { extra: item.extra as Record<string, unknown> } : {}),
    });
  }
  return models;
}

/** 一个服务商的设置：不合法就抛错，界面把原因原样显示。 */
export function checkProvider(id: string, raw: unknown): ProviderSettings {
  const slug = trim(id).toLowerCase();
  if (!SLUG.test(slug)) throw new Error("服务商标识无效：只能包含小写字母、数字、点和短横线，如 my-proxy。");
  const input = (raw ?? {}) as Record<string, unknown>;
  if (input.kind === "builtin") return { kind: "builtin", id: slug };
  if (input.kind !== "custom") throw new Error("服务商类型无效：可选值为内置服务商或兼容接口。");
  const name = trim(input.name);
  if (!name) throw new Error("请填写兼容接口名称，如「我的代理」。");
  const api = input.api as ProviderApi;
  if (!PROVIDER_APIS.includes(api)) {
    throw new Error("协议无效：可选值为 OpenAI 兼容、Anthropic 兼容或 Google 兼容。");
  }
  const extra = isRecord(input.extra) ? { ...input.extra } : {};
  const custom: CustomProviderSettings = {
    kind: "custom",
    id: slug,
    name,
    api,
    baseUrl: checkBaseUrl(trim(input.baseUrl)),
    models: checkModelList(input.models),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
  return custom;
}

/** 兼容接口的模型 → 引擎要的模型配置：extra 原样透传，Hob 管的几项排在后面（包括思考档）。 */
export function engineModels(
  provider: CustomProviderSettings,
  thinking: Record<string, ThinkingLevelMapSetting> | undefined,
): ProviderModelConfig[] {
  return provider.models.map((model) => {
    const reasoning = model.reasoning === true;
    const plan = thinkingPlan(model.id, reasoning, thinking?.[`${provider.id}/${model.id}`], provider.api);
    return {
      ...(model.extra ?? {}),
      id: model.id,
      name: model.name?.trim() || model.id,
      input: model.input?.length ? model.input : ["text"],
      reasoning,
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      cost: { input: 0, output: 0 },
      // 会推理的模型写 Hob 算好的稀疏档位表：改过的字符、要开的 xhigh/max、删掉的档写 null
      ...(reasoning ? { thinkingLevelMap: plan.map } : {}),
    } as ProviderModelConfig;
  });
}

function detailOf(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = parsed.error;
    if (typeof error === "string") return `：${error}`;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return `：${message}`;
    }
    if (typeof parsed.message === "string") return `：${parsed.message}`;
  } catch {
    // 不是 JSON：给一小段原话
  }
  const clean = text.replace(/\s+/g, " ");
  return `：${clean.length > 200 ? `${clean.slice(0, 199)}…` : clean}`;
}

/** 从接口返回里挑出模型列表（OpenAI 和 Anthropic 都是 data[]，也认 models[]）。 */
export function discoveredModels(body: unknown): { id: string; name?: string }[] {
  const record = (body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  const out: { id: string; name?: string }[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry === "string") {
      if (entry.trim() && !seen.has(entry.trim())) {
        seen.add(entry.trim());
        out.push({ id: entry.trim() });
      }
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = trim(item.id) || trim(item.name) || trim(item.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = trim(item.display_name) || trim(item.displayName) || trim(item.name);
    out.push({ id, ...(name && name !== id ? { name } : {}) });
  }
  return out;
}

export interface ProviderServiceOptions {
  home: string;
  settings: SettingsStore;
  pi: PiHost;
  catalog: ModelCatalog;
  /** 测试注入假服务器 */
  fetchImpl?: typeof fetch;
}

/**
 * 服务商的读写与引擎接线：设置里存不敏感的，Key 存 secrets.json；
 * 每次变动都套进引擎，并让模型名单缓存失效。
 */
export class ProviderService {
  /** 已经套进引擎的服务商（删掉的要清掉，不然 Key 和模型会留在引擎里）。 */
  private applied = new Map<string, ProviderSettings["kind"]>();
  /** 上次写给引擎的 modelOverrides（内置服务商的思考档），没变就不重写、不刷新引擎配置。 */
  private appliedOverrides?: string;

  constructor(private readonly options: ProviderServiceOptions) {}

  private get settings(): SettingsStore {
    return this.options.settings;
  }

  private views(): ProviderView[] {
    const secrets = readSecrets(this.options.home);
    return this.settings.settings.providers.map((provider) => ({
      ...provider,
      keyConfigured: Boolean(secrets[providerKeyName(provider.id)]?.trim()),
    }));
  }

  /** 一个服务商的每个模型现在用什么思考档（自定义或 Hob 的默认规则）。 */
  private thinkingViews(
    provider: string,
    models: { id: string; name: string; reasoning: boolean; api?: string; input?: ("text" | "image")[]; contextWindow?: number }[],
    thinking: Record<string, ThinkingLevelMapSetting> | undefined,
  ): ModelThinkingView[] {
    return models.map((model) => {
      const ref = `${provider}/${model.id}`;
      const custom = thinking?.[ref];
      const plan = thinkingPlan(model.id, model.reasoning, custom, model.api);
      return {
        ref,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        ...(model.input ? { input: model.input } : {}),
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        // 空串 = 没改过，按服务商协议的默认
        levels: plan.levels.map((level) => ({ level, text: plan.chars[level] ?? "" })),
        custom: custom !== undefined,
      };
    });
  }

  /** 一个服务商的模型（兼容接口用自己存的，内置服务商用引擎目录）。 */
  private modelsOf(
    provider: ProviderSettings,
    runtime: ModelRuntime,
  ): { id: string; name: string; reasoning: boolean; api?: string; input?: ("text" | "image")[]; contextWindow?: number }[] {
    if (provider.kind === "custom") {
      return provider.models.map((model) => ({
        id: model.id,
        name: model.name?.trim() || model.id,
        reasoning: model.reasoning === true,
        input: model.input ?? ["text"],
        contextWindow: model.contextWindow ?? DEFAULT_CONTEXT,
        api: provider.api,
      }));
    }
    return (runtime.getProvider(provider.id)?.getModels() ?? []).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: Boolean(model.reasoning),
      input: model.input,
      contextWindow: model.contextWindow,
      api: model.api,
    }));
  }

  /** 一个模型现在的思考档（保存后回显给界面）。 */
  async thinkingOf(ref: string): Promise<ModelThinkingView | undefined> {
    const provider = this.settings.settings.providers.find((item) => ref.startsWith(`${item.id}/`));
    if (!provider) return undefined;
    const runtime = await this.options.pi.runtime();
    return this.thinkingViews(
      provider.id,
      this.modelsOf(provider, runtime),
      this.settings.settings.models.thinking,
    ).find((view) => view.ref === ref);
  }

  /** 全部服务商 + 引擎自带的服务商目录 + 每个服务商的模型和思考档 + 整份设置（前端要新 revision）。 */
  async view(): Promise<ProvidersView> {
    const runtime = await this.options.pi.runtime();
    const settings = this.settings.settings;
    const customIds = new Set(
      settings.providers.filter((provider) => provider.kind === "custom").map((provider) => provider.id),
    );
    const builtin = runtime
      .getProviders()
      .filter((provider) => provider.id !== "claude-bridge" && !customIds.has(provider.id))
      .map((provider) => ({ id: provider.id, name: provider.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const models: Record<string, ModelThinkingView[]> = {};
    for (const provider of settings.providers) {
      models[provider.id] = this.thinkingViews(
        provider.id,
        this.modelsOf(provider, runtime),
        settings.models.thinking,
      );
    }
    return { providers: this.views(), builtin, settings: this.settings.get(), models };
  }

  /** 把设置里的服务商套进引擎：内置的设/清 Key，兼容接口注册/注销。 */
  async applyTo(runtime: ModelRuntime): Promise<void> {
    const providers = this.settings.settings.providers;
    const current = new Map(providers.map((provider) => [provider.id, provider.kind]));
    for (const [id, kind] of this.applied) {
      if (current.has(id)) continue;
      if (kind === "custom") runtime.unregisterProvider(id);
      else await runtime.removeRuntimeApiKey(id);
    }
    this.applied = current;
    const thinking = this.settings.settings.models.thinking;
    const secrets = readSecrets(this.options.home);
    for (const provider of providers) {
      const key = secrets[providerKeyName(provider.id)]?.trim() ?? "";
      if (provider.kind === "builtin") {
        if (key) await runtime.setRuntimeApiKey(provider.id, key);
        else await runtime.removeRuntimeApiKey(provider.id);
        continue;
      }
      const config: ProviderConfig = {
        // 服务商级字段（compat、headers、authHeader…）原样透传给引擎，Hob 管的几项排在后面
        ...(provider.extra ?? {}),
        name: provider.name,
        baseUrl: provider.baseUrl,
        api: provider.api,
        ...(key ? { apiKey: key } : {}),
        models: engineModels(provider, thinking),
      } as ProviderConfig;
      runtime.registerProvider(provider.id, config);
    }
    await this.applyBuiltinThinking(runtime);
    await this.options.pi.configureClaude(runtime, this.options.home, this.settings.settings.claude);
  }

  /**
   * 内置服务商的思考档只能走引擎的 models.json（modelOverrides），写完刷新一次引擎配置。
   * 文件在 Hob 自己的引擎目录里（HOB_HOME/engine/models.json），不读也不写别的工具的配置。
   */
  private async applyBuiltinThinking(runtime: ModelRuntime): Promise<void> {
    const providers: Record<string, { modelOverrides: Record<string, { thinkingLevelMap: unknown }> }> = {};
    for (const provider of this.settings.settings.providers) {
      if (provider.kind !== "builtin") continue;
      const modelOverrides: Record<string, { thinkingLevelMap: unknown }> = {};
      for (const model of runtime.getProvider(provider.id)?.getModels() ?? []) {
        if (!model.reasoning) continue;
        const plan = thinkingPlan(
          model.id,
          true,
          this.settings.settings.models.thinking?.[`${provider.id}/${model.id}`],
          model.api,
        );
        modelOverrides[model.id] = { thinkingLevelMap: plan.map };
      }
      if (Object.keys(modelOverrides).length) providers[provider.id] = { modelOverrides };
    }
    const text = `${JSON.stringify({ providers }, null, 2)}\n`;
    if (text === this.appliedOverrides) return;
    const path = this.options.pi.modelsPath;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    this.appliedOverrides = text;
    await runtime.refresh();
  }

  /** 服务商变了：套进引擎、模型名单缓存失效。 */
  async apply(): Promise<void> {
    await this.applyTo(await this.options.pi.runtime());
    this.options.catalog.reset();
  }

  /** 新建或改一个服务商。Key 可选，留空就沿用已存的。 */
  async put(id: string, body: unknown): Promise<ProvidersView> {
    const next = checkProvider(id, body);
    const key = trim((body as { key?: unknown } | undefined)?.key);
    this.settings.setProvider(next);
    if (key) writeSecret(this.options.home, providerKeyName(next.id), key);
    await this.apply();
    return this.view();
  }

  /** 本机已有配置里能导入的服务商（只读来源文件，不带 Key 明文）。 */
  private async importCandidates(): Promise<{ source: string; candidates: ProviderImportCandidate[] }> {
    const runtime = await this.options.pi.runtime();
    const customIds = new Set(
      this.settings.settings.providers.filter((provider) => provider.kind === "custom").map((provider) => provider.id),
    );
    const builtin = new Map(
      runtime
        .getProviders()
        .filter((provider) => provider.id !== "claude-bridge" && !customIds.has(provider.id))
        .map((provider) => [provider.id, provider] as const),
    );
    const source = localPiDir();
    return {
      source,
      candidates: listProviderImports({
        source,
        existing: new Set(this.settings.settings.providers.map((provider) => provider.id)),
        builtinIds: new Set(builtin.keys()),
        builtinModelCount: (id) => builtin.get(id)?.getModels().length ?? 0,
        apis: PROVIDER_APIS,
      }),
    };
  }

  /** 设置 → 服务商「从本机导入」的列表。 */
  async importView(): Promise<ProviderImportView> {
    const { source, candidates } = await this.importCandidates();
    return { source, items: candidates.map((candidate) => candidate.item) };
  }

  /** 导入所选的服务商：同 id 覆盖，Key 进 secrets.json，然后套进引擎。 */
  async importFromLocal(ids: string[]): Promise<ProvidersView> {
    const { candidates } = await this.importCandidates();
    const wanted = new Set(ids);
    const picked = candidates.filter(
      (candidate) => candidate.item.selectable && wanted.has(candidate.item.id) && candidate.provider !== undefined,
    );
    if (!picked.length) throw new Error("没有可导入的服务商：请选择状态为可导入的项目。");
    const thinking = { ...(this.settings.settings.models.thinking ?? {}) };
    for (const candidate of picked) {
      this.settings.setProvider(candidate.provider!);
      if (candidate.key) writeSecret(this.options.home, providerKeyName(candidate.item.id), candidate.key);
      Object.assign(thinking, candidate.thinking ?? {});
    }
    // 导入带过来的思考档只在这一次复制进 Hob 设置，之后和本机再无关系
    if (Object.keys(thinking).length) {
      this.settings.patch(this.settings.get().revision, { models: { thinking } });
    }
    await this.apply();
    return this.view();
  }

  /** 删服务商：Key 一起删，名单里用到它的模型变成不可用（不连带删名单）。 */
  async remove(id: string): Promise<ProvidersView | undefined> {
    if (!this.settings.removeProvider(id)) return undefined;
    writeSecret(this.options.home, providerKeyName(id), "");
    await this.apply();
    return this.view();
  }

  /** 测试内置服务商使用实际模型请求；兼容接口使用认证后的模型列表。 */
  async testConnection(input: { kind?: unknown; id?: unknown; api?: unknown; baseUrl?: unknown; apiKey?: unknown }): Promise<void> {
    const id = trim(input.id);
    if (input.kind === "custom") {
      const key = trim(input.apiKey) || (id ? providerKey(this.options.home, id) : "");
      try {
        await this.discover(input);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(key ? reason.split(key).join("[已隐藏]") : reason);
      }
      return;
    }
    if (input.kind !== "builtin" || !id) throw new Error("请选择内置服务商。");
    const key = trim(input.apiKey) || providerKey(this.options.home, id);
    if (!key) throw new Error("请填写 API Key。");
    const runtime = await this.options.pi.runtime();
    const provider = runtime.getProvider(id);
    const model = provider?.getModels().find((item) => item.id && item.baseUrl && !item.baseUrl.includes("{"));
    if (!model) throw new Error("该服务商没有可用的测试模型或需要额外配置。");
    try {
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] }, { apiKey: key, maxTokens: 8, signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS) });
      if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || "请求未完成。");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`连接测试失败：${reason.split(key).join("[已隐藏]")}`);
    }
  }

  /** 从兼容接口拉模型列表：OpenAI、Google 为 /models，Anthropic 为 /v1/models。 */
  async discover(input: { api?: unknown; baseUrl?: unknown; apiKey?: unknown; id?: unknown }): Promise<DiscoveredModels> {
    const api = input.api as ProviderApi;
    if (!PROVIDER_APIS.includes(api)) {
      throw new Error("请先选择协议：OpenAI 兼容、Anthropic 兼容或 Google 兼容。");
    }
    const baseUrl = checkBaseUrl(trim(input.baseUrl));
    if (!LISTABLE.includes(api)) {
      throw new Error("该协议不支持获取模型列表，请手动填写模型 ID。");
    }
    const key = trim(input.apiKey) || (trim(input.id) ? providerKey(this.options.home, trim(input.id).toLowerCase()) : "");
    if (!key) throw new Error("尚未填写 API Key：填写后重试获取模型列表。");
    const url = api === "anthropic-messages" ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
    const headers: Record<string, string> =
      api === "anthropic-messages"
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : api === "google-generative-ai"
          ? { "x-goog-api-key": key }
          : { authorization: `Bearer ${key}` };
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/timeout|timed out|abort/i.test(reason)) throw new Error(`无法连接 ${baseUrl}：15 秒内未响应。`);
      throw new Error(`无法连接 ${baseUrl}：${reason}`);
    }
    const text = (await response.text().catch(() => "")).split(key).join("[已隐藏]");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${baseUrl} 拒绝该 API Key（${response.status}）${detailOf(text)}`);
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new Error(
        `${baseUrl} 未提供模型列表接口（${response.status}）：请手动填写模型 ID。`,
      );
    }
    if (!response.ok) throw new Error(`${baseUrl} 返回状态码 ${response.status}${detailOf(text)}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${baseUrl} 返回的内容不是模型列表：请检查服务地址是否需要包含 /v1。`);
    }
    const models = discoveredModels(body).map((model) => api === "google-generative-ai" ? { ...model, id: model.id.replace(/^models\//, "") } : model);
    if (!models.length) throw new Error(`${baseUrl} 未返回可用模型：请手动填写模型 ID。`);
    return { models };
  }
}
