// HOB_HOME/system/settings.json：界面可改的设置，带 revision（写入走 CAS）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ClaudeCodeSettings,
  MemoryConfig,
  MemoryProvider,
  ModelPick,
  ModelSettings,
  ProviderSettings,
  RosterEntry,
  Settings,
  SettingsFile,
  SettingsPatch,
  Theme,
  ThinkingLevel,
  ThinkingLevelMapSetting,
  TokenPrice,
} from "../../shared/types.ts";
import { defaultSearch, normalizeSearch } from "../../shared/search.ts";
import { checkImageSettings, normalizeImageSettings } from "./image.ts";
import { checkEmbeddingSettings, normalizeEmbeddingSettings } from "./embedding.ts";
import { checkThinkingMap, isThinkingLevel } from "./models.ts";
import { normalizeThinkingMap } from "../../shared/thinking.ts";
import type { ModelScores } from "../../shared/types.ts";
import { isMemoryProvider, LORE_PLUGIN_VERSION, loreConnection, resolveMemoryProvider } from "./memory.ts";
import { checkProvider } from "./providers.ts";
import { checkTimezone } from "./time.ts";
import { systemDir } from "./config.ts";
import { checkPrice } from "./usage-prices.ts";

const FILE = "settings.json";
const THEMES: Theme[] = ["system", "light", "dark"];
const DEFAULT_CONVERSATION_THINKING: ThinkingLevel = "low";
const DEFAULT_WORK_THINKING: ThinkingLevel = "high";

/** config.json 里搬过来的旧模型设置。 */
export interface LegacyModels {
  conversation?: string;
  conversationThinking?: string;
  work?: string;
  workThinking?: string;
}

/** 读 HOB_HOME/system/config.json 里还没搬走的模型字段（启动在建 settings 之前调）。 */
export function readLegacyModels(home: string): LegacyModels | undefined {
  const file = join(systemDir(home), "config.json");
  if (!existsSync(file)) return undefined;
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const text = (key: string) => (typeof stored[key] === "string" ? String(stored[key]).trim() : undefined);
  const legacy: LegacyModels = {
    conversation: text("routerModel"),
    conversationThinking: text("routerThinking"),
    work: text("workerModel"),
    workThinking: text("workerThinking"),
  };
  return Object.values(legacy).some(Boolean) ? legacy : undefined;
}

/**
 * 一个模型都没配时的名单：只从 config.json 搬来的旧设置里取，没有就是空的（没有服务商时名单就是空的）。
 * 两个角色都用它，思考档沿用旧的默认（对话 low、任务执行 high）。
 */
export function seedModels(legacy?: LegacyModels): ModelSettings {
  const conversation = legacy?.conversation || legacy?.work || "";
  const work = legacy?.work || conversation;
  const refs = [...new Set([conversation, work].filter(Boolean))];
  return {
    roster: refs.map((ref) => ({ ref, note: "" })),
    conversation: {
      ref: conversation,
      thinking: isThinkingLevel(legacy?.conversationThinking) ? legacy!.conversationThinking! : DEFAULT_CONVERSATION_THINKING,
    },
    work: {
      ref: work,
      thinking: isThinkingLevel(legacy?.workThinking) ? legacy!.workThinking! : DEFAULT_WORK_THINKING,
    },
  };
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function defaultSettings(timezone = systemTimezone(), models: ModelSettings = seedModels()): Settings {
  return {
    general: { theme: "system", timezone, showPage: true, avatarBackground: true, aboutYou: { name: "", language: "", notes: "" } },
    providers: [],
    models,
    image: { source: "off" },
    search: defaultSearch(),
    desktop: { url: "", enabled: false, publicAssistants: [] },
    claude: { enabled: false, plan: "pro", executable: "" },
    work: { maxJobs: 2, jobStallMinutes: 15, routerStallMinutes: 6 },
    push: { email: "" },
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 自定义思考档：键是模型 ref，值是这个模型的档位表；坏的项丢掉，不影响其他项。 */
function normalizeThinking(raw: unknown): Record<string, ThinkingLevelMapSetting> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, ThinkingLevelMapSetting> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const ref = key.trim();
    const clean = normalizeThinkingMap(value);
    if (ref && clean) out[ref] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

function validScores(value: unknown): value is ModelScores {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scores = value as Record<string, unknown>;
  return ["smart", "cost", "speed"].every((key) => typeof scores[key] === "number" && Number.isInteger(scores[key]) && (scores[key] as number) >= 0 && (scores[key] as number) <= 100);
}

/** 名单：去掉空的和重复的；角色必须在名单里，不在就退到角色的默认值。 */
function normalizeModels(raw: unknown, base: ModelSettings): ModelSettings {
  const input = (raw ?? {}) as Partial<ModelSettings>;
  let roster: RosterEntry[] = base.roster;
  if (Array.isArray(input.roster)) {
    roster = [];
    const seen = new Set<string>();
    for (const entry of input.roster) {
      const ref = typeof entry?.ref === "string" ? entry.ref.trim() : "";
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      roster.push({
        ref,
        note: typeof entry.note === "string" ? entry.note.trim() : "",
        ...(validScores(entry.scores) ? { scores: { smart: entry.scores.smart, cost: entry.scores.cost, speed: entry.scores.speed } } : {}),
        ...(typeof entry.scoresConfirmed === "boolean" ? { scoresConfirmed: entry.scoresConfirmed } : {}),
        ...(isThinkingLevel(entry.thinking) ? { thinking: entry.thinking } : {}),
      });
    }
  }
  const pick = (value: unknown, fallback: ModelPick): ModelPick => {
    const raw = (value ?? {}) as Partial<ModelPick>;
    const ref = typeof raw.ref === "string" ? raw.ref.trim() : "";
    const usable = roster.some((entry) => entry.ref === ref) ? ref : roster.some((entry) => entry.ref === fallback.ref) ? fallback.ref : (roster[0]?.ref ?? "");
    return {
      ref: usable,
      thinking: isThinkingLevel(raw.thinking) ? raw.thinking : fallback.thinking,
    };
  };
  const thinking = input.thinking === undefined ? undefined : normalizeThinking(input.thinking);
  return {
    roster,
    conversation: pick(input.conversation, base.conversation),
    work: pick(input.work, base.work),
    ...(input.thinkingChoice === "auto" || input.thinkingChoice === "fixed" ? { thinkingChoice: input.thinkingChoice } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/** 服务商：不合法的一项丢掉（比如手改坏了文件），不影响其他项；Key 不在这里。 */
function normalizeProviders(raw: unknown): ProviderSettings[] {
  if (!Array.isArray(raw)) return [];
  const providers: ProviderSettings[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const id = typeof (entry as { id?: unknown } | undefined)?.id === "string" ? String((entry as { id: string }).id) : "";
    if (!id) continue;
    try {
      const provider = checkProvider(id, entry);
      if (seen.has(provider.id)) continue;
      seen.add(provider.id);
      providers.push(provider);
    } catch {
      // 这一项坏了：跳过
    }
  }
  return providers;
}

/** 每百万 token 的单价的四项，键名固定。 */
function normalizePrices(raw: unknown): Record<string, TokenPrice> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const prices: Record<string, TokenPrice> = {};
  for (const [model, price] of Object.entries(raw as Record<string, unknown>)) {
    const id = model.trim();
    if (!id) continue;
    try {
      prices[id] = checkPrice(price);
    } catch {
      // 这一项坏了：跳过，不影响其他模型
    }
  }
  return prices;
}

/** 把读到的（或补丁里的）内容规整成合法设置：不合法的项退回默认值，时区不合法直接报错。 */
function normalize(raw: unknown, base: Settings): Settings {
  const input = (raw ?? {}) as Partial<Settings>;
  const general = (input.general ?? {}) as Partial<Settings["general"]>;
  const about = (general.aboutYou ?? {}) as Partial<Settings["general"]["aboutYou"]>;
  const work = (input.work ?? {}) as Partial<Settings["work"]>;
  const push = (input.push ?? {}) as Partial<Settings["push"]>;
  const theme = text(general.theme, base.general.theme) as Theme;
  const prices = normalizePrices(input.usage?.prices);
  return {
    general: {
      theme: THEMES.includes(theme) ? theme : base.general.theme,
      timezone: checkTimezone(text(general.timezone, "") || base.general.timezone),
      showPage: typeof general.showPage === "boolean" ? general.showPage : base.general.showPage !== false,
      avatarBackground: typeof general.avatarBackground === "boolean" ? general.avatarBackground : base.general.avatarBackground !== false,
      aboutYou: {
        name: text(about.name, base.general.aboutYou.name),
        language: text(about.language, base.general.aboutYou.language),
        notes: text(about.notes, base.general.aboutYou.notes),
      },
    },
    models: normalizeModels(input.models, base.models),
    providers: normalizeProviders(input.providers ?? base.providers),
    image: normalizeImageSettings(input.image, base.image),
    knowledge: { embedding: normalizeEmbeddingSettings(input.knowledge?.embedding, base.knowledge?.embedding ?? { source: "off" }) },
    search: normalizeSearch(input.search ?? base.search),
    desktop: {
      url: typeof input.desktop?.url === "string" ? input.desktop.url : (base.desktop?.url ?? ""),
      enabled: typeof input.desktop?.enabled === "boolean" ? input.desktop.enabled : (base.desktop?.enabled ?? false),
      publicAssistants: Array.isArray(input.desktop?.publicAssistants) ? input.desktop.publicAssistants.filter((id): id is string => typeof id === "string") : (base.desktop?.publicAssistants ?? []),
    },
    claude: {
      enabled: input.claude?.enabled === true,
      plan: input.claude?.plan === "max" ? "max" : "pro",
      executable: typeof input.claude?.executable === "string" ? input.claude.executable.trim() : "",
    },
    skills: { disabled: Array.isArray(input.skills?.disabled) ? input.skills.disabled.filter((v): v is string => typeof v === "string") : (base.skills?.disabled ?? []) },
    work: {
      maxJobs: int(work.maxJobs, base.work.maxJobs, 1, 8),
      jobStallMinutes: int(work.jobStallMinutes, base.work.jobStallMinutes, 1, 24 * 60),
      routerStallMinutes: int(work.routerStallMinutes, base.work.routerStallMinutes, 1, 24 * 60),
    },
    push: { email: text(push.email, base.push.email) },
    ...(Object.keys(prices).length ? { usage: { prices } } : {}),
  };
}

/**
 * 旧 config.json 里那几项搬到 settings.json：只在 settings.json 还不存在时读一次，
 * 之后 config.json 里再出现这些键也不会被读。
 */
function legacySeed(home: string): SettingsPatch {
  const file = join(systemDir(home), "config.json");
  if (!existsSync(file)) return {};
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const seed: SettingsPatch = {};
  const general: Partial<Settings["general"]> = {};
  if (typeof stored.theme === "string") general.theme = stored.theme as Theme;
  if (typeof stored.timezone === "string" && stored.timezone.trim()) general.timezone = stored.timezone.trim();
  if (Object.keys(general).length) seed.general = general;
  const work: Partial<Settings["work"]> = {};
  if (typeof stored.maxJobs === "number") work.maxJobs = stored.maxJobs;
  if (typeof stored.routerStallMs === "number") {
    work.routerStallMinutes = Math.max(1, Math.round(stored.routerStallMs / 60_000));
  }
  if (Object.keys(work).length) seed.work = work;
  return seed;
}

export interface SettingsStoreOptions {
  /** config.json 里还没搬走的模型设置 */
  legacyModels?: LegacyModels;
}

export class SettingsStore {
  private file: SettingsFile;
  /** 没有 models 节时的兜底（迁移只发生一次，之后以 settings.json 为准） */
  private readonly base: Settings;
  /** 用户在设置里选过的记忆提供者；没选过就是 undefined（按有没有配好 Lore 决定） */
  private memoryProvider?: MemoryProvider;

  constructor(
    readonly home: string,
    options: SettingsStoreOptions = {},
  ) {
    this.base = defaultSettings(systemTimezone(), seedModels(options.legacyModels));
    const path = join(systemDir(home), FILE);
    if (!existsSync(path)) {
      this.file = { revision: 1, settings: normalize(legacySeed(home), this.base) };
      this.write();
      return;
    }
    let stored: Partial<SettingsFile> & { memory?: { provider?: unknown } } = {};
    try {
      stored = JSON.parse(readFileSync(path, "utf8")) as Partial<SettingsFile> & { memory?: { provider?: unknown } };
    } catch (error) {
      throw new Error(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (isMemoryProvider(stored.memory?.provider)) this.memoryProvider = stored.memory.provider;
    this.file = {
      revision: Number.isFinite(stored.revision) ? Number(stored.revision) : 1,
      settings: normalize(stored.settings, this.base),
    };
    // 旧文件没有 models 节：搬来的模型马上落盘，config.json 里的旧键已经删了，下次启动就读不到了
    if (!stored.settings?.models) this.write();
  }

  private write(): void {
    // 记忆提供者单独一个顶层键：没写过就不写，别把“没选过”写成“选了本地记忆”
    writeJsonAtomic(join(systemDir(this.home), FILE), {
      ...this.file,
      ...(this.memoryProvider ? { memory: { provider: this.memoryProvider } } : {}),
    });
  }

  get(): SettingsFile {
    return {
      revision: this.file.revision,
      settings: normalize(this.file.settings, this.base),
    };
  }

  get settings(): Settings {
    return this.get().settings;
  }

  /** 记忆提供者 + Lore 连接状态（Token 从不返回）。 */
  memory(): MemoryConfig {
    const lore = loreConnection(this.home);
    return {
      revision: this.file.revision,
      provider: resolveMemoryProvider(this.memoryProvider, lore.configured),
      providerExplicit: this.memoryProvider !== undefined,
      lore,
      lorePlugin: LORE_PLUGIN_VERSION,
    };
  }

  /**
   * 改记忆提供者（同一份 revision 做 CAS）。选 Lore 但连接没配好 → 报错，绝不静默回退。
   */
  setMemoryProvider(revision: number, provider: unknown): MemoryConfig | undefined {
    if (revision !== this.file.revision) return undefined;
    if (!isMemoryProvider(provider)) throw new Error("记忆来源无效：可选值为 local、lore 或 off。");
    if (provider === "lore" && !loreConnection(this.home).configured) {
      throw new Error("Lore 尚未配置完成：请填写服务地址与 Token，并通过连接测试。");
    }
    this.memoryProvider = provider;
    this.file = { ...this.file, revision: this.file.revision + 1 };
    this.write();
    return this.memory();
  }

  /**
   * 按节合并：revision 不是当前的 → 不动，返回 undefined（调用方回 409）。
   */
  patch(revision: number, patch: SettingsPatch): SettingsFile | undefined {
    if (revision !== this.file.revision) return undefined;
    const current = this.settings;
    const general = patch.general ?? {};
    const models = patch.models ?? {};
    if (models.thinkingChoice !== undefined && models.thinkingChoice !== "auto" && models.thinkingChoice !== "fixed") {
      throw new Error("任务思考档选择方式无效：可选值为 auto 或 fixed。");
    }
    if (Array.isArray(models.roster)) {
      for (const entry of models.roster) {
        if (entry?.scores !== undefined && !validScores(entry.scores)) throw new Error("模型分数须为 0–100 的整数。");
        if (entry?.scoresConfirmed !== undefined && typeof entry.scoresConfirmed !== "boolean") throw new Error("模型用途确认状态无效。");
      }
    }
    const merged = normalize(
      {
        general: {
          ...current.general,
          ...general,
          aboutYou: { ...current.general.aboutYou, ...(general.aboutYou ?? {}) },
        },
        models: {
          roster: models.roster ?? current.models.roster,
          conversation: models.conversation ?? current.models.conversation,
          work: models.work ?? current.models.work,
          thinkingChoice: models.thinkingChoice ?? current.models.thinkingChoice,
          ...((models.thinking ?? current.models.thinking) ? { thinking: models.thinking ?? current.models.thinking } : {}),
        },
        // image / providers 不在这份补丁里（各走自己的接口），别把它们冲回默认
        image: current.image,
        knowledge: current.knowledge,
        search: current.search,
        desktop: current.desktop,
        claude: current.claude,
        skills: patch.skills ?? current.skills,
        providers: current.providers,
        work: { ...current.work, ...(patch.work ?? {}) },
        push: { ...current.push, ...(patch.push ?? {}) },
        usage: current.usage,
      },
      current,
    );
    this.file = { revision: this.file.revision + 1, settings: merged };
    this.write();
    return this.get();
  }

  /**
   * 改图像生成配置（同一份 revision 做 CAS）。配置不合法直接抛错，界面显示原因。
   */
  setImage(revision: number, image: unknown): SettingsFile | undefined {
    if (revision !== this.file.revision) return undefined;
    const next = checkImageSettings(image);
    this.file = { revision: this.file.revision + 1, settings: { ...this.get().settings, image: next } };
    this.write();
    return this.get();
  }

  setEmbedding(revision: number, embedding: unknown): SettingsFile | undefined {
    if (revision !== this.file.revision) return undefined;
    const next = checkEmbeddingSettings(embedding);
    this.file = { revision: this.file.revision + 1, settings: { ...this.get().settings, knowledge: { embedding: next } } };
    this.write();
    return this.get();
  }

  setClaude(revision: number, claude: ClaudeCodeSettings): SettingsFile | undefined {
    if (revision !== this.file.revision) return undefined;
    if (typeof claude.enabled !== "boolean" || (claude.plan !== "pro" && claude.plan !== "max") || typeof claude.executable !== "string") throw new Error("Claude Code 设置无效。");
    this.file = { revision: this.file.revision + 1, settings: { ...this.get().settings, claude: { ...claude, executable: claude.executable.trim() } } };
    this.write();
    return this.get();
  }

  setDesktop(revision: number, desktop: { url: string; enabled: boolean; publicAssistants?: string[] }): SettingsFile | undefined {
    if (revision !== this.file.revision) return undefined;
    this.file = { revision: this.file.revision + 1, settings: { ...this.get().settings, desktop: { ...this.get().settings.desktop, ...desktop } } };
    this.write();
    return this.get();
  }

  setSearch(revision: number, search: unknown): SettingsFile | undefined {
    if (revision !== this.file.revision) return undefined;
    if (!Array.isArray(search)) throw new Error("联网搜索配置无效。");
    this.file = { revision: this.file.revision + 1, settings: { ...this.get().settings, search: normalizeSearch(search) } };
    this.write();
    return this.get();
  }

  /**
   * 存一个模型的自定义思考档（null = 恢复默认，只用默认规则）。不合法直接抛错，界面显示原因。
   * 存完模型名单缓存要重拉（ModelCatalog.reset()），引擎那边由服务商服务重新套一次。
   */
  setThinking(ref: string, levels: unknown): SettingsFile {
    const key = ref.trim();
    if (!key) throw new Error("未指定模型。");
    const models = { ...this.settings.models };
    if (levels === null) {
      const next = { ...(models.thinking ?? {}) };
      delete next[key];
      if (Object.keys(next).length) models.thinking = next;
      else delete models.thinking;
    } else {
      models.thinking = { ...(models.thinking ?? {}), [key]: checkThinkingMap(levels) };
    }
    this.file = {
      revision: this.file.revision + 1,
      settings: { ...this.get().settings, models },
    };
    this.write();
    return this.get();
  }

  /** 存一个模型的自定单价（price 为 null = 恢复默认）。不合法直接抛错，界面显示原因。 */
  setUsagePrice(revision: number, model: string, price: TokenPrice | null): SettingsFile | undefined {
    if (revision !== this.file.revision) return undefined;
    const id = model.trim();
    if (!id) throw new Error("未指定模型。");
    const prices = { ...(this.settings.usage?.prices ?? {}) };
    if (price === null) delete prices[id];
    else prices[id] = checkPrice(price);
    const settings = { ...this.settings };
    if (Object.keys(prices).length) settings.usage = { prices };
    else delete settings.usage;
    this.file = { revision: this.file.revision + 1, settings };
    this.write();
    return this.get();
  }

  /** 新建或改一个服务商（Key 不在这里，见 secrets.json）。 */
  setProvider(provider: ProviderSettings): SettingsFile {
    // 改已有的原地替换（列表顺序不跳），新的排到最后
    const providers = this.settings.providers;
    const next = providers.some((item) => item.id === provider.id)
      ? providers.map((item) => (item.id === provider.id ? provider : item))
      : [...providers, provider];
    this.file = {
      revision: this.file.revision + 1,
      settings: { ...this.get().settings, providers: next },
    };
    this.write();
    return this.get();
  }

  /** 删服务商；不在里面就返回 false。 */
  removeProvider(id: string): boolean {
    const providers = this.settings.providers;
    if (!providers.some((provider) => provider.id === id)) return false;
    this.file = {
      revision: this.file.revision + 1,
      settings: { ...this.get().settings, providers: providers.filter((provider) => provider.id !== id) },
    };
    this.write();
    return true;
  }
}
