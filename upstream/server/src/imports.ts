// 从本机已有的配置导入服务商和 Lore 连接：只读来源文件，绝不写回、不改权限和时间戳。
// Key / Token 只在内存里传给调用方，任何接口返回值和日志里都不出现明文。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { THINKING_LEVELS, THINKING_TEXT_MAX } from "../../shared/thinking.ts";
import type {
  LoreImportView,
  ProviderApi,
  ProviderImportItem,
  ProviderImportKey,
  ProviderModelSetting,
  ProviderSettings,
  ThinkingLevelMapSetting,
} from "../../shared/types.ts";

const MAX_BYTES = 256 * 1024;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
/** 整个值就是一个环境变量引用的写法（和引擎的解析规则一致：`$NAME` / `${NAME}`）。 */
const SINGLE_ENV_REF = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
/** 服务商里由 Hob 自己管的字段，其余（compat、headers、authHeader…）原样透传给引擎。 */
const PROVIDER_OWNED_KEYS = new Set(["name", "baseUrl", "api", "apiKey", "models"]);
/** 模型里由 Hob 自己映射的字段，其余进模型的 extra；thinkingLevelMap 进 Hob 的自定义思考档。 */
const MODEL_OWNED_KEYS = new Set(["id", "name", "input", "reasoning", "contextWindow", "maxTokens", "thinkingLevelMap"]);

const COMMAND_KEY_NOTE = "Key 需通过命令获取，请导入后手动填写。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positive(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 本机原有的引擎目录（启动时记下的原值，没启动过就用默认位置）。 */
export function localPiDir(env: NodeJS.ProcessEnv = process.env): string {
  return text(env.HOB_LOCAL_PI_DIR) || join(homedir(), ".pi", "agent");
}

/** 本机原有的 Lore 目录。 */
export function localLoreHome(env: NodeJS.ProcessEnv = process.env): string {
  return text(env.HOB_LOCAL_LORE_HOME) || join(homedir(), ".lore");
}

export interface ImportKey {
  kind: ProviderImportKey;
  /** 字面值或环境变量的值；命令不执行，所以没有 */
  value?: string;
  note?: string;
}

/** 把本机配置里的 Key 解析成能直接用的样子：字面值直接用，环境变量取值，命令不执行。 */
export function resolveImportKey(raw: unknown, env: NodeJS.ProcessEnv = process.env): ImportKey {
  const value = text(raw);
  if (!value) return { kind: "none" };
  if (value.startsWith("!")) return { kind: "command", note: COMMAND_KEY_NOTE };
  const reference = SINGLE_ENV_REF.exec(value);
  if (reference) {
    const name = reference[1]!;
    const resolved = text(env[name]);
    if (resolved) return { kind: "env", value: resolved };
    return { kind: "none", note: `Key 引用的环境变量 ${name} 未设置，请导入后手动填写。` };
  }
  return { kind: "literal", value };
}

/**
 * 本机那份 thinkingLevelMap 在导入那一刻原样复制进 Hob 的自定义档位：
 * 写明的字符串和 null 都带上（null = 这一档不要），没写的键不补。
 * 没写的档之后按 Hob 的默认规则算（默认范围里引擎默认不开的 xhigh / max 会自动开），
 * 不再拿档名去补齐——写了字符串的档引擎会原样发出去，那不是每个协议都收的值。
 * 返回 undefined 表示本机没写思考档（用默认规则）。
 */
function importThinking(raw: unknown): ThinkingLevelMapSetting | undefined {
  if (!isRecord(raw)) return undefined;
  const map: ThinkingLevelMapSetting = {};
  for (const level of THINKING_LEVELS) {
    if (!(level in raw)) continue;
    const value = raw[level];
    if (value === null) {
      // 关闭这一档不能删（Hob 的规矩），本机写 null 就当没改
      if (level !== "off") map[level] = null;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    // 读不懂的值当没写，不因此把这一档删掉
    if (!text || text.length > THINKING_TEXT_MAX) continue;
    map[level] = text;
  }
  return Object.keys(map).length ? map : undefined;
}

function mapModel(raw: unknown): { model: ProviderModelSetting; thinking?: ThinkingLevelMapSetting } | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  if (!id) return undefined;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!MODEL_OWNED_KEYS.has(key)) extra[key] = value;
  }
  const name = text(raw.name);
  const input = Array.isArray(raw.input)
    ? raw.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image")
    : [];
  const contextWindow = positive(raw.contextWindow);
  const maxTokens = positive(raw.maxTokens);
  const reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : false;
  // 本机那份的思考档只复制这一次：之后只看 Hob 设置里存的，和本机再无关系
  const thinking = reasoning ? importThinking(raw.thinkingLevelMap) : undefined;
  return {
    model: {
      id,
      ...(name ? { name } : {}),
      ...(input.length ? { input } : {}),
      ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    },
    ...(thinking ? { thinking } : {}),
  };
}

/** 一个候选：界面看到的那一项 + 真正要写进设置的内容。 */
export interface ProviderImportCandidate {
  item: ProviderImportItem;
  /** 可导入时有值：要写进 settings.json 的服务商（Key 不在里面） */
  provider?: ProviderSettings;
  /** 要写进 secrets.json 的 Key（命令和缺失的环境变量没有） */
  key?: string;
  /** 导入那一刻从本机复制的思考档，键是模型 ref（之后只看 Hob 设置） */
  thinking?: Record<string, ThinkingLevelMapSetting>;
}

export interface ListProviderImportsOptions {
  /** 本机引擎目录（HOB_LOCAL_PI_DIR） */
  source: string;
  /** 已经配置过的服务商 id（界面上标「将覆盖」） */
  existing: Set<string>;
  /** 引擎自带的服务商 id（auth.json 里的条目只有引擎认识才列出来） */
  builtinIds: ReadonlySet<string>;
  /** 引擎自带的模型数（内置服务商那一项显示用） */
  builtinModelCount?: (id: string) => number;
  /** 支持哪些协议（和注册进引擎时一致） */
  apis: readonly ProviderApi[];
  env?: NodeJS.ProcessEnv;
}

function customCandidate(
  id: string,
  raw: unknown,
  options: ListProviderImportsOptions,
): ProviderImportCandidate | undefined {
  if (!isRecord(raw)) return undefined;
  const knownApi = options.apis.includes(text(raw.api) as ProviderApi);
  const api = text(raw.api) as ProviderApi;
  const baseUrl = text(raw.baseUrl).replace(/\/+$/, "");
  const mapped = Array.isArray(raw.models) ? raw.models.map(mapModel).filter((entry) => entry !== undefined) : [];
  const models = mapped.map((entry) => entry.model);
  const thinking: Record<string, ThinkingLevelMapSetting> = {};
  for (const entry of mapped) {
    if (entry.thinking) thinking[`${id}/${entry.model.id}`] = entry.thinking;
  }
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PROVIDER_OWNED_KEYS.has(key)) extra[key] = value;
  }
  const key = resolveImportKey(raw.apiKey, options.env ?? process.env);
  const usable = SLUG.test(id) && knownApi && baseUrl !== "" && models.length > 0;
  const note = usable
    ? key.note
    : !SLUG.test(id)
      ? "服务商标识不符合要求，无法导入。"
      : !knownApi
        ? "缺少协议或协议不支持，无法导入。"
        : baseUrl === ""
          ? "缺少服务地址，无法导入。"
          : "没有模型列表，无法导入。";
  const item: ProviderImportItem = {
    id,
    kind: "custom",
    ...(knownApi ? { api } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    models: models.length,
    key: key.kind,
    exists: options.existing.has(id),
    selectable: usable,
    ...(note ? { note } : {}),
  };
  if (!usable) return { item };
  const provider: ProviderSettings = {
    kind: "custom",
    id,
    // 显示名就用 id：本机那份的 name 只是那边起的名字，换成 id 两边好对应
    name: id,
    api,
    baseUrl,
    models,
    ...(Object.keys(extra).length ? { extra } : {}),
  };
  return { item, provider, ...(key.value ? { key: key.value } : {}), ...(Object.keys(thinking).length ? { thinking } : {}) };
}

function builtinCandidate(
  id: string,
  raw: unknown,
  options: ListProviderImportsOptions,
): ProviderImportCandidate | undefined {
  if (!options.builtinIds.has(id) || !isRecord(raw)) return undefined;
  const models = options.builtinModelCount?.(id) ?? 0;
  const credentialType = text(raw.type);
  if (credentialType !== "api_key") {
    return {
      item: {
        id,
        kind: "builtin",
        models,
        key: "none",
        exists: options.existing.has(id),
        selectable: false,
        note: "登录授权类凭据无法导入。",
      },
    };
  }
  const key = resolveImportKey(raw.key, options.env ?? process.env);
  return {
    item: {
      id,
      kind: "builtin",
      models,
      key: key.kind,
      exists: options.existing.has(id),
      selectable: true,
      ...(key.note ? { note: key.note } : {}),
    },
    provider: { kind: "builtin", id },
    ...(key.value ? { key: key.value } : {}),
  };
}

/**
 * 读本机的 models.json（兼容接口）和 auth.json（内置服务商），列出能导入的项。
 * 同一 id 只列一次，models.json 的先列。
 */
export function listProviderImports(options: ListProviderImportsOptions): ProviderImportCandidate[] {
  const modelsFile = readJson(join(options.source, "models.json"));
  const authFile = readJson(join(options.source, "auth.json"));
  const out: ProviderImportCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: ProviderImportCandidate | undefined) => {
    if (!candidate || seen.has(candidate.item.id)) return;
    seen.add(candidate.item.id);
    out.push(candidate);
  };
  const providers = modelsFile?.providers;
  if (isRecord(providers)) {
    for (const [id, raw] of Object.entries(providers)) push(customCandidate(id, raw, options));
  }
  if (authFile) {
    for (const [id, raw] of Object.entries(authFile)) push(builtinCandidate(id, raw, options));
  }
  return out;
}

/** 读本机的 Lore 连接（只读）。token 只在导入时用，不返回给页面。 */
export function readLocalLoreConnection(loreHome: string): { view: LoreImportView; token?: string } {
  const document = readJson(join(loreHome, "config.json")) ?? {};
  const baseUrl = text(document.base_url).replace(/\/+$/, "");
  const token = text(document.api_token);
  return {
    view: {
      source: loreHome,
      found: baseUrl !== "",
      ...(baseUrl ? { baseUrl } : {}),
      tokenPresent: token !== "",
    },
    ...(token ? { token } : {}),
  };
}

/** 本机 Lore 连接的页面视图（不带 Token）。 */
export function readLocalLore(loreHome: string): LoreImportView {
  return readLocalLoreConnection(loreHome).view;
}
