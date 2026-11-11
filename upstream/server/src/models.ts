// 模型名单：从引擎的模型注册表拿可用的聊天模型，解析每个角色 / 每个任务用哪个模型。
import type { Model } from "@earendil-works/pi-ai";
import type {
  Assistant,
  Group,
  GroupMemberModel,
  ModelInfo,
  ModelPick,
  ModelSettings,
  RosterEntry,
  SettingsPatch,
  ThinkingLevel,
  ThinkingLevelMapSetting,
} from "../../shared/types.ts";
import { contextText, guessModelScores, scoreSummary } from "../../shared/model-note.ts";
import {
  THINKING_LEVELS,
  THINKING_TEXT,
  THINKING_TEXT_MAX,
  isThinkingLevel,
  normalizeThinkingMap,
  thinkingPlan,
} from "../../shared/thinking.ts";
import type { PiHost } from "./pi.ts";

// 思考档的规则（档位、默认范围、默认字符、规整）在 shared/thinking.ts：前后端和假后端共用一份。
export { THINKING_LEVELS, isThinkingLevel };

/** 保存自定义思考档前的校验：不合法就报错（http 回 400），界面原样显示原因。 */
export function checkThinkingMap(raw: unknown): ThinkingLevelMapSetting {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("思考档格式无效：应为「档位: 字符」的对象。");
  }
  const input = raw as Record<string, unknown>;
  const map: ThinkingLevelMapSetting = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isThinkingLevel(key)) throw new Error(`思考档无效：可选值为 ${THINKING_LEVELS.join("、")}。`);
    if (value === null) {
      map[key] = null;
      continue;
    }
    if (typeof value !== "string") throw new Error(`「${THINKING_TEXT[key]}」这一档的字符无效。`);
    // 空串 = 按服务商协议的默认，不算错
    const text = value.trim();
    if (text.length > THINKING_TEXT_MAX) {
      throw new Error(`「${THINKING_TEXT[key]}」这一档的字符最多 ${THINKING_TEXT_MAX} 个字。`);
    }
    map[key] = text;
  }
  if (map.off === null) throw new Error("「关闭」这一档不能删。");
  return map;
}

/** 这个模型能用哪些思考档（Hob 按设置算出来的）：不会推理的模型只有 off。 */
export function thinkingLevelsOf(model: ModelInfo | undefined): ThinkingLevel[] {
  return model?.thinkingLevels ?? ["off"];
}

/** 想要的档模型没有时往下取最近的一档；一档都没有才是 off。 */
export function fitThinking(levels: ThinkingLevel[], wants: ThinkingLevel): ThinkingLevel {
  const rank = THINKING_LEVELS.indexOf(wants);
  return [...levels].reverse().find((level) => THINKING_LEVELS.indexOf(level) <= rank) ?? "off";
}

/** 这一轮（对话或任务）的思考档：设置里的档这个模型没有，就往下取最近的一档。 */
export function thinkingForPick(pick: ModelPick, catalog: ModelCatalog): ThinkingLevel {
  return fitThinking(thinkingLevelsOf(catalog.find(pick.ref)), pick.thinking);
}

function infoOf(model: Model<any>, settings: ModelSettings): ModelInfo {
  const ref = `${model.provider}/${model.id}`;
  const reasoning = Boolean(model.reasoning);
  const plan = thinkingPlan(model.id, reasoning, settings.thinking?.[ref], model.api);
  return {
    ref,
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning,
    thinkingLevels: plan.levels,
    input: model.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image"),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
  };
}

/** 有凭据可用的聊天模型，缓一小会儿（设置页和每次分派任务都要看它）。 */
export class ModelCatalog {
  private list: ModelInfo[] = [];
  private loadedAt = 0;
  private loading?: Promise<void>;

  constructor(
    private readonly pi: PiHost,
    /** 每次现读设置：思考档只看 Hob 自己的设置，不看引擎注册表里自带的映射 */
    private readonly settings: () => ModelSettings,
  ) {}

  /** 服务商变了：下一次 get() 重新拉。 */
  reset(): void {
    this.list = [];
    this.loadedAt = 0;
  }

  find(ref: string): ModelInfo | undefined {
    return this.list.find((model) => model.ref === ref);
  }

  async get(maxAgeMs = 30_000): Promise<ModelInfo[]> {
    if (this.list.length && Date.now() - this.loadedAt < maxAgeMs) return this.list;
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
    return this.list;
  }

  private async load(): Promise<void> {
    const runtime = await this.pi.runtime();
    const models = await runtime.getAvailableOfType("chat");
    this.list = models.map((model) => infoOf(model, this.settings())).sort((a, b) => a.ref.localeCompare(b.ref));
    this.loadedAt = Date.now();
  }
}

/** 旧名单没有分数时按模型名称推测，保留用户的补充说明。 */
export function noteOf(entry: RosterEntry, catalog: ModelCatalog): string {
  const info = catalog.find(entry.ref);
  const scores = entry.scores ?? guessModelScores(info ?? { id: entry.ref.split("/").at(-1) ?? entry.ref, name: "", reasoning: false });
  return [scoreSummary(scores), ...(info?.input.includes("image") ? ["能看图"] : []), ...(info ? [`上下文 ${contextText(info.contextWindow)}`] : []), ...(entry.note.trim() ? [`补充：${entry.note.trim()}`] : [])].join(" · ");
}

/** 助手的名字：注册表里有名字就用，没有就用 ref。 */
export function nameOf(ref: string, catalog: ModelCatalog): string {
  return catalog.find(ref)?.name ?? ref;
}

export function groupModelPick(assistant: Assistant, group: Group | undefined, catalog: ModelCatalog, settings: ModelSettings, key: "conversation" | "work"): GroupMemberModel {
  const candidates = [
    ["member", group?.memberModels?.[assistant.id]?.[key]],
    ["group", group?.models?.[key]],
    ["assistant", assistant.models?.[key]],
    ["global", settings[key]],
  ] as const;
  const choose = (start: number) => {
    const found = candidates.slice(start).find(([, pick]) => pick && catalog.find(pick.ref) && (key !== "work" || allowedRefs(settings.roster, assistant).includes(pick.ref)));
    const source = found?.[0] ?? "global";
    let pick = found?.[1] ?? settings[key];
    if (key === "work") {
      try {
        const effective = { ...assistant, models: { ...assistant.models, work: pick } };
        pick = jobModel({ settings, assistant: effective, catalog }).model;
      } catch { /* 没有可用模型时保留设置里的值供界面显示 */ }
    }
    return { source, pick };
  };
  const chosen = choose(0);
  const inherited = choose(1);
  return { ...chosen, inherited: { source: inherited.source === "member" ? "global" : inherited.source, pick: inherited.pick } };
}

/** 本群覆盖有效时只影响这次选模，不改助手档案。 */
export function assistantInGroup(assistant: Assistant, group: Group | undefined, catalog: ModelCatalog, settings: ModelSettings): Assistant {
  if (!group) return assistant;
  const conversation = groupModelPick(assistant, group, catalog, settings, "conversation").pick;
  const work = groupModelPick(assistant, group, catalog, settings, "work").pick;
  return { ...assistant, models: { ...assistant.models, conversation, work } };
}

/** 这个助手能派的模型 ref：缺省名单全部。 */
export function allowedRefs(roster: RosterEntry[], assistant: Assistant): string[] {
  const inRoster = new Set(roster.map((entry) => entry.ref));
  const allowed = assistant.models?.allowed?.length ? assistant.models.allowed : roster.map((entry) => entry.ref);
  return allowed.filter((ref) => inRoster.has(ref));
}

/** 这个助手能派、而且现在可用的模型 ref。 */
export function usableRefs(settings: ModelSettings, assistant: Assistant, catalog: ModelCatalog): string[] {
  return allowedRefs(settings.roster, assistant).filter((ref) => catalog.find(ref));
}

/** 不指定模型时用哪个：助手的默认任务模型 → 全局默认任务模型 → 名单里第一个可用的。 */
export function defaultWorkRef(
  settings: ModelSettings,
  assistant: Assistant,
  catalog: ModelCatalog,
): string | undefined {
  const usable = usableRefs(settings, assistant, catalog);
  const wanted = [assistant.models?.work?.ref, settings.work.ref];
  return wanted.find((ref): ref is string => !!ref && usable.includes(ref)) ?? usable[0];
}

export class NoModelError extends Error {}

/** 一个模型都用不了时的说法：指到 设置 → 服务商 和 设置 → 模型。 */
export const NO_MODEL_NOTE =
  "尚未配置模型。请在「设置 → 服务商」中添加服务商，再到「设置 → 模型」选择模型";

function missingModel(): NoModelError {
  return new NoModelError(NO_MODEL_NOTE);
}

/** Router 这一轮用哪个模型：助手自己的对话模型，没有就全局。 */
export function conversationPick(settings: ModelSettings, assistant: Assistant): ModelPick {
  const pick = assistant.models?.conversation ?? settings.conversation;
  if (!pick.ref) throw missingModel();
  return pick;
}

export interface JobModelInput {
  settings: ModelSettings;
  assistant: Assistant;
  catalog: ModelCatalog;
  /** 助手分派任务时填的 model / thinking */
  requested?: { model?: string; thinking?: string };
  /** 任务带图片：所选模型不能看图就换一个能看的 */
  hasImages?: boolean;
}

export interface JobModelPick {
  model: ModelPick;
  modelReason?: string;
}

function thinkingFor(
  ref: string,
  settings: ModelSettings,
  role: { ref: string; thinking: ThinkingLevel },
  wants: ThinkingLevel | undefined,
  catalog: ModelCatalog,
): ThinkingLevel {
  const levels = thinkingLevelsOf(catalog.find(ref));
  // 角色指定的模型用角色的思考档；另选的模型用它自己在名单里的默认思考档
  const fallback =
    ref === role.ref
      ? role.thinking
      : (settings.roster.find((entry) => entry.ref === ref)?.thinking ?? role.thinking);
  // 填了模型没有的档不报错，往下取最近的一档（和设置里的默认档一样）
  return fitThinking(levels, wants ?? fallback);
}

/**
 * 分派任务时定模型：助手指定的优先，其次助手的默认任务模型，最后全局的。
 * 都要落在助手允许的范围里，并且当前可用。
 */
export function jobModel(input: JobModelInput): JobModelPick {
  const { settings, assistant, catalog, requested } = input;
  const allowed = allowedRefs(settings.roster, assistant);
  if (!allowed.length) {
    throw new Error("该助手暂无可用模型。请在「设置 → 服务商」中添加服务商，再到「设置 → 模型」选择模型。");
  }
  const usable = allowed.filter((ref) => catalog.find(ref));
  const listText = usable.length ? usable.join("、") : "（均不可用：服务商已删除或未配置 Key）";

  const wantedModel = requested?.model?.trim();
  if (wantedModel && !allowed.includes(wantedModel)) {
    throw new Error(`无法分派 ${wantedModel}：该助手可分派的模型为 ${listText}。`);
  }
  if (wantedModel && !catalog.find(wantedModel)) {
    throw new Error(
      `${wantedModel} 当前不可用（该模型的服务商已删除或未配置 Key）。可分派的模型为 ${listText}。`,
    );
  }

  const role = {
    ref: assistant.models?.work?.ref ?? settings.work.ref,
    thinking: assistant.models?.work?.thinking ?? settings.work.thinking,
  };
  let ref = wantedModel ?? defaultWorkRef(settings, assistant, catalog);
  if (!ref || !usable.includes(ref)) {
    if (!usable.length) throw new Error(`可分派的模型当前均不可用：${listText}。`);
    ref = usable[0];
  }

  const wants = settings.thinkingChoice === "fixed" ? undefined : requested?.thinking;
  if (wants !== undefined && !isThinkingLevel(wants)) {
    throw new Error(`思考档无效：可选值为 ${THINKING_LEVELS.join("、")}。`);
  }
  let thinking = thinkingFor(ref, settings, role, wants, catalog);

  let modelReason: string | undefined;
  if (input.hasImages) {
    const info = catalog.find(ref);
    if (!info?.input.includes("image")) {
      const withImage = usable.find((candidate) => catalog.find(candidate)?.input.includes("image"));
      if (!withImage) {
        throw new Error(
          `任务包含图片，但可分派的模型均不支持图片输入（${listText}）。请在「设置 → 模型」中添加支持图片输入的模型。`,
        );
      }
      modelReason = `任务包含图片，已更换为 ${nameOf(withImage, catalog)}`;
      ref = withImage;
      thinking = thinkingFor(ref, settings, role, wants, catalog);
    }
  }

  return { model: { ref, thinking }, ...(modelReason ? { modelReason } : {}) };
}

/** 设置里填的思考档只校验档位本身合法：模型没有这一档时不拒绝，用的时候往下收（见 fitThinking）。 */
function checkThinking(thinking: unknown): void {
  if (thinking === undefined) return;
  if (!isThinkingLevel(thinking)) throw new Error(`思考档无效：可选值为 ${THINKING_LEVELS.join("、")}。`);
}

/** PUT /api/settings 里 models 这一节的结构校验（可用性要现查，所以是异步的）。 */
export async function checkModelsPatch(
  patch: SettingsPatch,
  current: ModelSettings,
  catalog: ModelCatalog,
): Promise<void> {
  const next = patch.models;
  if (!next) return;
  await catalog.get();
  const currentRefs = new Set(current.roster.map((entry) => entry.ref));
  if (next.roster) {
    const seen = new Set<string>();
    for (const entry of next.roster) {
      const ref = typeof entry?.ref === "string" ? entry.ref.trim() : "";
      if (!ref) throw new Error("模型列表中存在空项。");
      if (seen.has(ref)) throw new Error(`模型列表中重复：${ref}。`);
      seen.add(ref);
      if (!catalog.find(ref) && !currentRefs.has(ref)) {
        throw new Error(`${ref} 当前不可用（该模型的服务商已删除或未配置 Key）。`);
      }
      checkThinking(entry.thinking);
    }
  }
  const rosterRefs = new Set((next.roster ?? current.roster).map((entry) => entry.ref));
  // 自定义思考档：走设置接口时也照规矩校验（界面用的是 /api/models/thinking）
  for (const [ref, levels] of Object.entries(next.thinking ?? {})) {
    if (!ref.trim()) throw new Error("思考档里存在空的模型项。");
    checkThinkingMap(levels);
  }
  // 只校补丁里真的改了的角色；只删名单里的模型时，角色会自动退到名单里的其他模型
  for (const [label, pick] of [
    ["对话", next.conversation],
    ["任务执行", next.work],
  ] as const) {
    if (!pick) continue;
    if (!pick.ref) throw new Error(`未选择${label}模型。`);
    if (!rosterRefs.has(pick.ref)) throw new Error(`${label}模型 ${pick.ref} 不在模型列表中。`);
    checkThinking(pick.thinking);
  }
}

/**
 * PATCH /api/assistants/:id 里的 models / abilities：不合法就抛错（http 回 400）。
 * models.allowed 为空数组 = 名单全部，等于没限制。
 */
export function checkAssistantModels(
  raw: { models?: Assistant["models"]; abilities?: Assistant["abilities"] },
  roster: RosterEntry[],
  catalog: ModelCatalog,
): { models?: Assistant["models"]; abilities?: Assistant["abilities"] } {
  const out: { models?: Assistant["models"]; abilities?: Assistant["abilities"] } = {};
  const rosterRefs = new Set(roster.map((entry) => entry.ref));
  if (raw.models) {
    const models: NonNullable<Assistant["models"]> = {};
    for (const key of ["conversation", "work"] as const) {
      const pick = raw.models[key];
      if (!pick) continue;
      const ref = typeof pick.ref === "string" ? pick.ref.trim() : "";
      if (!ref) continue; // 空 = 跟随全局
      if (!rosterRefs.has(ref)) throw new Error(`模型 ${ref} 不在模型列表中。`);
      if (!catalog.find(ref)) throw new Error(`模型 ${ref} 当前不可用（该模型的服务商已删除或未配置 Key）。`);
      checkThinking(pick.thinking);
      models[key] = { ref, thinking: pick.thinking };
    }
    if (raw.models.allowed) {
      const allowed = raw.models.allowed.map((ref) => String(ref));
      const unknown = allowed.filter((ref) => !rosterRefs.has(ref));
      if (unknown.length) throw new Error(`以下模型不在模型列表中：${unknown.join("、")}。`);
      models.allowed = allowed;
    }
    out.models = models;
  }
  if (raw.abilities) {
    out.abilities = {
      exec: raw.abilities.exec !== false,
      write: raw.abilities.write !== false,
      image: raw.abilities.image !== false,
    };
  }
  return out;
}
