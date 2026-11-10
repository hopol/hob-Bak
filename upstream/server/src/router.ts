import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { parseStreamingJson } from "@earendil-works/pi-ai/utils/json-parse";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager as SessionManagerImpl } from "@earendil-works/pi-coding-agent";
import type {
  Assistant,
  AssistantSummary,
  Bootstrap,
  Iso,
  Item,
  ItemsPage,
  PageLive,
  Profile,
  SendMessageBody,
  RouterActivity,
} from "../../shared/types.ts";
import type { HobRuntime } from "./runtime.ts";
import { refreshSystemPrompt } from "./pi.ts";
import { conversationPick, defaultWorkRef, jobModel, nameOf, noteOf, thinkingForPick, thinkingLevelsOf, fitThinking, usableRefs, NO_MODEL_NOTE, NoModelError } from "./models.ts";
import { buildRouterTools } from "./router-tools.ts";
import { isInPagesDir } from "./files.ts";
import { boundKnowledge, formatKnowledge, KNOWLEDGE_INTRO } from "./knowledge-tools.ts";
import { MEMORY_WRITE_TOOLS, memoryNoteText } from "./memory.ts";
import { buildSystemPrompt, type PromptModel } from "./prompt.ts";
import { availableSkills } from "./skills.ts";
import { usableAssistantSkills } from "./assistant-skills.ts";
import { activityLabel, thinkingLine } from "./router-activity.ts";
import { imageContents } from "./jobs.ts";
import { nowBlock } from "./now.ts";
import { monthDayTimeText } from "./time.ts";
import { DesktopToolSession } from "./desktop-tools.ts";

export const ITEM_TYPE = "hob.item";
export const ITEM_UPDATE_TYPE = "hob.item.update";
export const USER_TYPE = "hob.user";
export const EVENT_TYPE = "hob.event";

/** 会话条目的 id 和 at 由会话文件给出，写卡片时不用传。 */
/** 事件附带的信息，落在会话的事件条目上：routine 给回复挂「⏱ 名字」，cont 见 walk。 */
export interface EventDetails {
  routine?: { id: string; name: string; jobId?: string };
  cont?: true;
  delegationId?: string;
  sourceUserId?: string;
}

export type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id" | "at"> : never) : never;

interface RouterState {
  assistantId: string;
  session?: AgentSession;
  manager?: SessionManager;
  opening?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  /** 还有几轮在跑（事件那一轮也要算），用来判断忙闲和等空闲 */
  running: number;
  activity?: RouterActivity | null;
  activityJson?: string;
  activityLast?: number;
  /** 这次思考到目前为止的原文：只用来取最后一段给状态行 */
  thinkingText?: string;
  /** 正在流式的助手消息：条目 id 和 GET /items 推导出来的一致；shown 表示已经在对话里露过面 */
  streaming?: { itemId: string; shown: boolean };
  /** 这一轮最后一次有动静的时间，看门狗用它判断“没响应” */
  lastEventAt: number;
  stallTimer?: NodeJS.Timeout;
  /** 这一轮已经被叫停（没响应，或用户按了停止）：之后的报错不再写「回复失败」 */
  stalled: boolean;
  /** 记忆提供者换了：跑着的这一轮结束就释放会话，下一轮按新提供者重新打开 */
  releaseAfterTurn?: boolean;
  /** 还在跑的记忆写入工具：参数只在 tool_execution_start 里有，按 toolCallId 存着给 note 用 */
  memoryWriteArgs: Map<string, Record<string, unknown>>;
  currentDelegationId?: string;
  currentUserId?: string;
  pendingUsers?: { prompt: string; id: string }[];
  pendingDelivery?: Promise<void>;
  knowledgeNames?: string[];
  delegationReply?: string[];
  terminatingTools?: Set<string>;
  desktop?: DesktopToolSession;
}

function readEntries(file: string): SessionEntry[] {
  if (!existsSync(file)) return [];
  const out: SessionEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string };
      if (entry.type && entry.type !== "session") out.push(entry as SessionEntry);
    } catch {
      // 半行忽略
    }
  }
  return out;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => Boolean(block) && block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** 模型服务的报错压成一句：「my-proxy API error (429): {"message":"…"}」→「模型服务返回 429：…」。 */
export function briefModelError(raw: string | undefined): string {
  if (!raw) return "模型服务出错";
  const code = raw.match(/\((\d{3})\)/)?.[1];
  const detail = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? raw.replace(/\s+/g, " ");
  const short = detail.length > 120 ? `${detail.slice(0, 119)}…` : detail;
  return code ? `模型服务返回 ${code}：${short}` : short;
}

/**
 * 从会话条目按顺序推导对话条目：用户消息来自 hob.user 自定义条目（不走 pi 的 user 消息，
 * 事件消息也是 user 角色但不该出气泡），助手文本来自 assistant 消息，卡片来自 hob.item。
 *
 * 事件之后的第一条标 lead（新一轮回复，前端拉开间距）；事件带 cont 表示任务的图片已经先开了这一组，回复接着图片走。
 * 返回值里的 lead 是“下一条该不该标”，实时推送的条目用它，和刷新后推导的一致。
 */
function walk(entries: SessionEntry[]): { items: Item[]; lead: boolean } {
  const items: Item[] = [];
  let assistantIndex = 0;
  let routine: EventDetails["routine"];
  let lead = false;
  const push = (item: Item) => {
    items.push(lead ? { ...item, lead: true } : item);
    lead = false;
  };
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === USER_TYPE) {
      const data = (entry.data ?? {}) as { text?: string; quote?: { itemId: string; text: string }; files?: string[]; from?: { assistantId: string; name: string; delegationId: string } };
      items.push({
        kind: "user",
        id: entry.id,
        at: entry.timestamp,
        text: data.text ?? "",
        ...(data.quote ? { quote: data.quote } : {}),
        ...(data.files?.length ? { files: data.files } : {}),
        ...(data.from ? { from: data.from } : {}),
      });
      lead = false;
      continue;
    }
    if (entry.type === "custom" && entry.customType === ITEM_TYPE) {
      // 旧版本把别的助手的审批转述进主助手的对话（relay）；现在审批只在提问的助手那里，历史里的转述卡不再显示
      if ((entry.data as { kind?: string; relay?: boolean } | undefined)?.relay) continue;
      push({ ...(entry.data as object), id: entry.id, at: entry.timestamp } as Item);
      continue;
    }
    if (entry.type === "custom" && entry.customType === ITEM_UPDATE_TYPE) {
      const update = entry.data as { id: string; status: "done" | "failed"; path?: string; error?: string };
      const index = items.findIndex((item) => item.id === update.id && item.kind === "image");
      if (index !== -1) items[index] = { ...items[index], ...update } as Item;
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === EVENT_TYPE) {
      const details = entry.details as EventDetails | undefined;
      routine = details?.routine;
      lead = !details?.cont;
      continue;
    }
    if (entry.type === "message" && entry.message.role === "assistant") {
      assistantIndex += 1;
      const text = messageText(entry.message.content);
      if (!text) continue;
      push({
        kind: "assistant",
        id: `a-${assistantIndex}`,
        at: entry.timestamp,
        text,
        ...(routine ? { routine } : {}),
      });
      routine = undefined;
    }
  }
  return { items, lead };
}

export function deriveItems(entries: SessionEntry[]): Item[] {
  return walk(entries).items;
}

export class RouterManager {
  private routers = new Map<string, RouterState>();
  private itemCache = new Map<string, { manager?: SessionManager; version: string; result: ReturnType<typeof walk>; positions: Map<string, number>; assistantTimes: string[]; last?: { text: string; at: Iso } }>();
  private livePages = new Map<string, Map<string, { page: PageLive; timer?: NodeJS.Timeout; last: number }>>();
  private liveJson = new Map<string, string>();

  private liveUpdate(assistantId: string, callId: string, args: Record<string, unknown>, flush = false): void {
    let pages = this.livePages.get(assistantId);
    if (!pages) this.livePages.set(assistantId, pages = new Map());
    let live = pages.get(callId);
    if (!live) {
      live = { page: { assistantId, callId, html: "", state: "writing" }, last: 0 };
      pages.set(callId, live);
    }
    live.page = { ...live.page, ...(typeof args.title === "string" ? { title: args.title } : {}), ...(typeof args.summary === "string" ? { summary: args.summary } : {}), ...(typeof args.html === "string" ? { html: args.html } : {}) };
    const emit = () => { live!.timer = undefined; live!.last = Date.now(); this.bus.emit({ type: "page-live", ...live!.page }); };
    if (flush || Date.now() - live.last >= 200) {
      if (live.timer) clearTimeout(live.timer);
      emit();
    } else if (!live.timer) live.timer = setTimeout(emit, 200 - (Date.now() - live.last));
  }

  private liveFinish(assistantId: string, callId: string, path?: string, error?: string): void {
    const pages = this.livePages.get(assistantId);
    const live = pages?.get(callId);
    if (!live) return;
    this.liveUpdate(assistantId, callId, {}, true);
    live.page = { ...live.page, state: path ? "done" : "failed", ...(path ? { path } : { error: error || "页面生成中断" }) };
    this.bus.emit({ type: "page-live", ...live.page });
    this.liveJson.delete(callId);
    // 失败也不留：模型拿到错误通常会重写一页，留着的失败占位卡会一直钉在对话底部
    pages!.delete(callId);
  }
  /** 测试可改小：不给就看设置里的“回复多久无响应视为受阻” */
  stallOverrideMs?: number;

  constructor(private readonly runtime: HobRuntime) {
    for (const assistant of runtime.store.assistants()) {
      const file = runtime.store.routerFile(assistant.id);
      if (!existsSync(file)) continue;
      const pending = deriveItems(readEntries(file)).filter((item) => item.kind === "image" && item.status === "pending");
      if (!pending.length) continue;
      const manager = SessionManagerImpl.open(file, dirname(file), runtime.home);
      for (const item of pending) manager.appendCustomEntry(ITEM_UPDATE_TYPE, { id: item.id, status: "failed", error: "生成被中断" });
    }
  }

  private get store() {
    return this.runtime.store;
  }

  private get bus() {
    return this.runtime.bus;
  }

  private assistant(assistantId: string): Assistant {
    const assistant = this.store.assistant(assistantId);
    if (!assistant) throw new Error(`助手不存在：${assistantId}`);
    return assistant;
  }

  private entries(assistantId: string): SessionEntry[] {
    const state = this.routers.get(assistantId);
    if (state?.manager) return state.manager.getEntries();
    return readEntries(this.store.routerFile(assistantId));
  }

  private derived(assistantId: string) {
    const manager = this.routers.get(assistantId)?.manager;
    const file = this.store.routerFile(assistantId);
    let version: string;
    if (manager) version = String(manager.getEntryCount());
    else {
      try {
        const stat = statSync(file);
        version = `${stat.size}:${stat.mtimeMs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        version = "missing";
      }
    }
    const cached = this.itemCache.get(assistantId);
    if (cached && cached.manager === manager && cached.version === version) return cached;
    const result = walk(manager ? manager.getEntries() : readEntries(file));
    const positions = new Map<string, number>();
    const assistantTimes: string[] = [];
    let last: { text: string; at: Iso } | undefined;
    result.items.forEach((item, index) => {
      positions.set(item.id, index);
      if (item.kind === "assistant") assistantTimes.push(item.at);
      if (item.kind === "assistant" || item.kind === "user" || item.kind === "note") last = { text: item.text, at: item.at };
    });
    assistantTimes.sort();
    const next = { manager, version, result, positions, assistantTimes, last };
    this.itemCache.set(assistantId, next);
    return next;
  }

  async ensure(assistantId: string): Promise<RouterState> {
    const assistant = this.assistant(assistantId);
    let state = this.routers.get(assistantId);
    if (!state) {
      state = { assistantId, running: 0, lastEventAt: Date.now(), stalled: false, memoryWriteArgs: new Map() };
      this.routers.set(assistantId, state);
    }
    if (state.session) return state;
    state.opening ??= this.openSession(state, assistant).catch((error: unknown) => {
      state!.opening = undefined;
      throw error;
    });
    await state.opening;
    return state;
  }

  private async openSession(state: RouterState, assistant: Assistant): Promise<void> {
    // 提示词里要写模型的显示名和定位，所以先把注册表拉一遍
    await this.runtime.models.get();
    const pick = conversationPick(this.runtime.settings.settings.models, assistant);
    state.knowledgeNames = (await boundKnowledge(this.runtime, assistant.id)).map((collection) => collection.name);
    state.desktop = new DesktopToolSession(this.runtime, assistant.id, () => !!state.session?.model?.input.includes("image"), undefined, true);
    const tools = [...buildRouterTools(this.runtime, assistant.id), ...state.desktop.tools().filter((tool) => tool.name.startsWith("browser_"))];
    const desktop = this.runtime.desktop.view();
    const enabled = desktop.enabled && !!desktop.url && desktop.tokenConfigured;
    const opened = await this.runtime.pi.open({
      file: this.store.routerFile(assistant.id),
      spillDir: join(dirname(this.store.routerFile(assistant.id)), "spill"),
      cwd: this.store.home,
      model: pick.ref,
      thinking: thinkingForPick(pick, this.runtime.models),
      memory: this.runtime.settings.memory().provider,
      systemPrompt: () => {
        const { timezone, aboutYou } = this.runtime.settings.settings.general;
        const desktop = this.runtime.desktop.view();
        return buildSystemPrompt(this.store, assistant.id, {
          timezone,
          aboutYou,
          memory: this.runtime.settings.memory().provider,
          searchEnabled: this.runtime.settings.settings.search.some((provider) => provider.enabled),
          imageEnabled: tools.some((tool) => tool.name === "generate_image"),
          showPageEnabled: tools.some((tool) => tool.name === "show_page"),
          desktopEnabled: desktop.enabled && !!desktop.url && desktop.tokenConfigured,
          publicDesktop: desktop.publicAssistants.includes(assistant.id),
          models: this.promptModels(assistant.id),
          skills: availableSkills(this.runtime.home, undefined, this.runtime.settings.settings.skills?.disabled, this.runtime.settings.memory().provider === "lore" ? this.runtime.pi.loreSkillPaths : []),
          assistantSkills: usableAssistantSkills(this.runtime.home, assistant.id),
          assistantSkillsDir: resolve(this.runtime.home, "assistants", assistant.id, "skills"),
          thinkingChoice: this.runtime.settings.settings.models.thinkingChoice,
          knowledgeNames: state.knowledgeNames,
        });
      },
      tools: tools.filter((tool) => enabled || !tool.name.startsWith("browser_")).map((tool) => tool.name),
      customTools: tools,
    });
    state.session = opened.session;
    if (!state.knowledgeNames.length) refreshSystemPrompt(opened.session, opened.session.getActiveToolNames().filter((name) => name !== "search_knowledge"));
    state.manager = opened.manager;
    state.opening = undefined;
    opened.session.subscribe((event) => this.onSessionEvent(state, assistant.id, event));
    this.touch(assistant.id);
  }

  private async refreshTools(state: RouterState): Promise<void> {
    state.knowledgeNames = (await boundKnowledge(this.runtime, state.assistantId)).map((collection) => collection.name);
    const names = state.session!.getActiveToolNames().filter((name) => name !== "search_knowledge" && !name.startsWith("browser_"));
    if (state.knowledgeNames.length) names.push("search_knowledge");
    const desktop = this.runtime.desktop.view();
    if (desktop.enabled && desktop.url && desktop.tokenConfigured) names.push(...state.desktop!.tools().filter((tool) => tool.name.startsWith("browser_")).map((tool) => tool.name));
    refreshSystemPrompt(state.session!, names);
  }

  private async automaticKnowledge(state: RouterState, query: string): Promise<string> {
    const ids = this.store.assistant(state.assistantId)?.knowledge ?? [];
    if ([...query.trim()].length < 4 || !ids.length || this.runtime.settings.settings.knowledge?.embedding.source !== "openai") return "";
    this.setActivity(state, { state: "tool", label: "正在查知识库" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.race([
        this.runtime.knowledge.search(query, ids, { limit: 3, gate: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("知识库检索超时")), 3000); }),
      ]);
      const text = formatKnowledge(results, 2400 - [...KNOWLEDGE_INTRO].length - 1);
      return text ? `\n\n${KNOWLEDGE_INTRO}\n${text}` : "";
    } catch {
      return "";
    } finally {
      if (timer) clearTimeout(timer);
      if (state.activity?.label === "正在查知识库") this.setActivity(state, null);
    }
  }

  /** 这个助手能派、当前可用的模型（提示词里那一节）。 */
  private promptModels(assistantId: string): PromptModel[] {
    const assistant = this.store.assistant(assistantId);
    if (!assistant) return [];
    const settings = this.runtime.settings.settings.models;
    const catalog = this.runtime.models;
    const def = defaultWorkRef(settings, assistant, catalog);
    return usableRefs(settings, assistant, catalog).map((ref) => {
      const entry = settings.roster.find((item) => item.ref === ref);
      return {
        name: nameOf(ref, catalog),
        ref,
        note: entry ? noteOf(entry, catalog) : "",
        thinking: jobModel({ settings, assistant, catalog, requested: { model: ref } }).model.thinking,
        levels: thinkingLevelsOf(catalog.find(ref)),
        isDefault: ref === def,
      };
    });
  }

  /** 换了对话模型或思考档：下一轮生效，不重建会话（上下文保留）。 */
  private async applyConversationModel(state: RouterState): Promise<void> {
    if (!state.session) return;
    const assistant = this.assistant(state.assistantId);
    const pick = conversationPick(this.runtime.settings.settings.models, assistant);
    const model = await this.runtime.pi.model(pick.ref);
    // 用拿到的模型本身算档：换服务商后名单缓存是空的，按缓存查会把思考档收成 off
    const thinking = fitThinking(getSupportedThinkingLevels(model), pick.thinking);
    const current = state.session.model;
    if (current?.provider !== model.provider || current?.id !== model.id) {
      await state.session.setModel(model);
    }
    if (state.session.thinkingLevel !== thinking) state.session.setThinkingLevel(thinking);
  }

  /**
   * 实时条目：助手消息在 message_start 就定好 id（会话条目还没落盘，它是第 assistantCount()+1 条），
   * 第一段文字到了才露面，message_end 之后等条目落盘再按条目发一次最终版。
   * 这样前端拿到的 id、时间、内容和 GET /items 推导出来的一样。
   */
  private onSessionEvent(state: RouterState, assistantId: string, event: AgentSessionEvent): void {
    this.progress(state);
    if (event.type === "agent_start" || (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start")) {
      state.thinkingText = "";
      this.setActivity(state, { state: "thinking", label: "正在想…" });
    }
    if (event.type === "message_update" && (event.assistantMessageEvent.type === "thinking_delta" || event.assistantMessageEvent.type === "thinking_end")) {
      if (event.assistantMessageEvent.type === "thinking_delta") state.thinkingText = (state.thinkingText ?? "") + event.assistantMessageEvent.delta;
      // 节流；思考结束时补发一次完整的最后一段
      if (event.assistantMessageEvent.type === "thinking_end" || Date.now() - (state.activityLast ?? 0) >= 200) {
        this.setActivity(state, { state: "thinking", label: thinkingLine(state.thinkingText ?? "") ?? "正在想…" });
        state.activityLast = Date.now();
      }
    }
    if (event.type === "agent_end" || (event.type === "message_end" && event.message.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason))) this.setActivity(state, null);
    if (event.type === "message_start" && event.message.role === "user") {
      const prompt = messageText(event.message.content);
      const index = state.pendingUsers?.findIndex((user) => user.prompt.trim() === prompt) ?? -1;
      if (index >= 0) state.currentUserId = state.pendingUsers!.splice(index, 1)[0].id;
    }
    if (event.type === "message_start" && event.message.role === "custom" && event.message.customType === EVENT_TYPE) {
      const details = event.message.details as EventDetails | undefined;
      const users = this.derived(assistantId).result.items.filter((item) => item.kind === "user");
      const source = details?.sourceUserId ? users.find((item) => item.id === details.sourceUserId) : undefined;
      state.currentUserId = (source ?? users.at(-1))?.id;
      if (details?.delegationId && details.delegationId !== state.currentDelegationId) {
        state.currentDelegationId = details.delegationId;
        state.delegationReply = [];
        state.terminatingTools = new Set();
      }
    }
    if (event.type === "turn_end" && event.message.role === "assistant" && state.currentDelegationId) {
      const text = messageText(event.message.content);
      if (text) state.delegationReply?.push(text);
      const failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
      if (failed || !event.toolResults.length || event.toolResults.every((tool) => state.terminatingTools?.has(tool.toolCallId))) {
        const id = state.currentDelegationId;
        const reply = state.delegationReply?.join("\n") || (failed ? event.message.errorMessage || "目标助手处理失败" : "");
        state.currentDelegationId = undefined;
        state.delegationReply = undefined;
        state.terminatingTools = undefined;
        this.runtime.delegations.turnEnded(id, reply, failed);
      }
    }
    if (event.type === "tool_execution_start") {
      if (MEMORY_WRITE_TOOLS.has(event.toolName)) state.memoryWriteArgs.set(event.toolCallId, event.args ?? {});
      return;
    }
    if (event.type === "tool_execution_end") {
      if (event.toolName === "show_page") {
        const result = event.result as { details?: { path?: string }; content?: { text?: string }[] } | undefined;
        this.liveFinish(assistantId, event.toolCallId, event.isError ? undefined : result?.details?.path, result?.content?.[0]?.text);
      }
      if (state.currentDelegationId && (event.result as { terminate?: boolean } | undefined)?.terminate) state.terminatingTools?.add(event.toolCallId);
      const args = state.memoryWriteArgs.get(event.toolCallId);
      state.memoryWriteArgs.delete(event.toolCallId);
      void this.onMemoryWrite(assistantId, event, args);
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      state.streaming = { itemId: `a-${this.assistantCount(assistantId) + 1}`, shown: false };
      return;
    }
    if (event.type === "message_update" && (event.assistantMessageEvent.type === "toolcall_start" || event.assistantMessageEvent.type === "toolcall_delta" || event.assistantMessageEvent.type === "toolcall_end")) {
      const update = event.assistantMessageEvent;
      const part = update.partial.content[update.contentIndex];
      if (part?.type === "toolCall") {
        if (update.type === "toolcall_start") state.activityJson = "";
        if (update.type === "toolcall_delta") state.activityJson = (state.activityJson ?? "") + update.delta;
        if (update.type !== "toolcall_delta" || Date.now() - (state.activityLast ?? 0) >= 200) {
          const args = Object.keys(part.arguments).length ? part.arguments : parseStreamingJson(state.activityJson);
          this.setActivity(state, { state: "tool", label: activityLabel(part.name, args, (id) => this.store.assistant(id)?.name) });
          state.activityLast = Date.now();
        }
      }
      if (part?.type === "toolCall" && part.name === "show_page") {
        if (update.type === "toolcall_start") this.liveJson.set(part.id, "");
        if (update.type === "toolcall_delta") this.liveJson.set(part.id, (this.liveJson.get(part.id) ?? "") + update.delta);
        const args = Object.keys(part.arguments).length ? part.arguments : parseStreamingJson(this.liveJson.get(part.id));
        this.liveUpdate(assistantId, part.id, args);
      }
    }
    if ((event.type === "message_end" && event.message.role === "assistant" && ["error", "aborted", "length"].includes(event.message.stopReason)) || event.type === "agent_end") {
      const reason = event.type === "message_end" && event.message.role === "assistant" ? event.message.errorMessage : undefined;
      for (const [id, live] of this.livePages.get(assistantId) ?? []) if (live.page.state === "writing") this.liveFinish(assistantId, id, undefined, reason || "页面生成中断");
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.setActivity(state, null);
      state.streaming ??= { itemId: `a-${this.assistantCount(assistantId) + 1}`, shown: false };
      const streaming = state.streaming;
      if (!streaming.shown) {
        streaming.shown = true;
        this.bus.emit({
          type: "item",
          assistantId,
          item: {
            kind: "assistant",
            id: streaming.itemId,
            at: new Date().toISOString(),
            text: "",
            streaming: true,
            ...(this.derived(assistantId).result.lead ? { lead: true } : {}),
          },
        });
      }
      this.bus.emit({ type: "delta", assistantId, itemId: streaming.itemId, text: event.assistantMessageEvent.delta });
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const streaming = state.streaming;
      state.streaming = undefined;
      const text = messageText(event.message.content).trim();
      if (!text) return;
      // pi 在 message_end 之后才把消息写进会话文件，等一拍再按条目发，内容和 id 才和刷新后一致
      setTimeout(() => this.emitSettledAssistant(assistantId, text, streaming?.itemId), 0);
    }
  }

  /** 记忆插件写成功了 → 对话里出一行「记忆已更新 · …」。 */
  private async onMemoryWrite(
    assistantId: string,
    event: { toolName: string; result?: unknown; isError?: boolean },
    args: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!MEMORY_WRITE_TOOLS.has(event.toolName) || event.isError) return;
    const details = (event.result as { details?: { ok?: boolean } } | undefined)?.details;
    if (details?.ok === false) return;
    const text = memoryNoteText(args);
    await this.addItem(assistantId, { kind: "note", icon: "memory", text: text ? `记忆已更新 · ${text}` : "记忆已更新" });
  }

  private emitSettledAssistant(assistantId: string, text: string, expectedId?: string): void {
    const list = this.derived(assistantId).result.items.filter((item) => item.kind === "assistant");
    const item = list.find((entry) => entry.id === expectedId) ?? list.filter((entry) => entry.text === text).pop();
    if (item) this.bus.emit({ type: "item", assistantId, item });
    this.touch(assistantId);
  }

  private assistantCount(assistantId: string): number {
    return this.entries(assistantId).filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    ).length;
  }

  private setActivity(state: RouterState, activity: RouterActivity | null): void {
    if (state.activity?.state === activity?.state && state.activity?.label === activity?.label) return;
    state.activity = activity;
    this.bus.emit({ type: "router-activity", assistantId: state.assistantId, activity });
  }

  /** 一轮开始了：清掉上一轮的“已停”标记并起看门狗。 */
  private armStall(state: RouterState): void {
    state.stalled = false;
    if (state.running === 1 && !state.session?.isStreaming) this.setActivity(state, { state: "thinking", label: "正在想…" });
    this.progress(state);
  }

  /** 这一轮还有动静：重置看门狗。没有事件就说明模型憋住了。 */
  private stallMs(): number {
    return this.stallOverrideMs ?? this.runtime.settings.settings.work.routerStallMinutes * 60_000;
  }

  private progress(state: RouterState): void {
    state.lastEventAt = Date.now();
    if (state.stallTimer) clearTimeout(state.stallTimer);
    state.stallTimer = setTimeout(() => void this.onStall(state), this.stallMs());
    state.stallTimer.unref?.();
  }

  private clearStall(state: RouterState): void {
    if (state.stallTimer) clearTimeout(state.stallTimer);
    state.stallTimer = undefined;
  }

  /** 一轮里长时间没有事件（模型憋着不出字）：停下这一轮，并明说可以再发一次。 */
  private async onStall(state: RouterState): Promise<void> {
    state.stallTimer = undefined;
    if (Date.now() - state.lastEventAt < this.stallMs()) {
      this.progress(state);
      return;
    }
    if (state.running === 0 && !state.session?.isStreaming) return;
    state.stalled = true;
    this.setActivity(state, null);
    // 不 await：模型的那次请求可能收不了尾，但这行提示必须先出来
    void state.session?.abort().catch(() => undefined);
    const assistant = this.store.assistant(state.assistantId);
    await this.addItem(state.assistantId, {
      kind: "note",
      icon: "info",
      text: `${assistant?.name ?? state.assistantId} 无响应，已停止，可重新发送`,
    });
  }

  /** 空闲 30 分钟释放 Router 内存，下次用再打开 router.jsonl。 */
  private touch(assistantId: string): void {
    const state = this.routers.get(assistantId);
    if (!state?.session) return;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (!state.session || state.session.isStreaming) return;
      this.close(state);
    }, 30 * 60 * 1000);
    state.idleTimer.unref?.();
  }

  private close(state: RouterState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    state.session?.dispose();
    void state.desktop?.dispose();
    state.desktop = undefined;
    state.session = undefined;
    state.manager = undefined;
    this.itemCache.delete(state.assistantId);
  }

  /**
   * 记忆提供者或能派的模型换了：空闲的 Router 立刻释放，下一轮从 router.jsonl 重新打开
   * （上下文还在，插件和 start_job 的模型说明按新设置来）；正在回复的等这一轮跑完再释放。
   */
  releaseSessions(): void {
    for (const state of this.routers.values()) {
      state.releaseAfterTurn = true;
      this.maybeRelease(state);
    }
  }

  /** 助手没了（归档）：关掉它的会话，内存里也不留 —— 它的目录随后会被移进归档。 */
  forget(assistantId: string): void {
    this.itemCache.delete(assistantId);
    const state = this.routers.get(assistantId);
    if (!state) return;
    this.close(state);
    this.routers.delete(assistantId);
  }

  private maybeRelease(state: RouterState): void {
    if (!state.releaseAfterTurn) return;
    if (state.running > 0 || state.session?.isStreaming) return;
    state.releaseAfterTurn = false;
    this.close(state);
  }

  /** 新条目的时间取会话条目自己的时间，和 GET /items 推导出来的一致。 */
  private entryAt(state: RouterState, id: string): string {
    return state.manager?.getEntries().find((entry) => entry.id === id)?.timestamp ?? new Date().toISOString();
  }

  // ---------- 事件与条目 ----------
  async addItem(assistantId: string, item: NewItem): Promise<Item> {
    const state = await this.ensure(assistantId);
    const lead = this.derived(assistantId).result.lead;
    const id = state.manager!.appendCustomEntry(ITEM_TYPE, item);
    const full = { ...item, ...(lead ? { lead: true } : {}), id, at: this.entryAt(state, id) } as Item;
    this.bus.emit({ type: "item", assistantId, item: full });
    if (full.kind === "file") {
      const page = isInPagesDir(relative(this.runtime.home, resolve(full.path)));
      void this.runtime.knowledge.collect({ origin: "output", path: full.path, assistantId, itemId: id, ...(page ? { name: full.name, description: full.meta } : {}) }).catch((error) => console.error("知识库收集失败：", error));
    }
    return full;
  }

  async updateImage(assistantId: string, id: string, update: { status: "done" | "failed"; path?: string; error?: string }): Promise<void> {
    const state = await this.ensure(assistantId);
    const item = this.derived(assistantId).result.items.find((entry) => entry.id === id && entry.kind === "image");
    if (!item) throw new Error(`图片条目不存在：${id}`);
    state.manager!.appendCustomEntry(ITEM_UPDATE_TYPE, { id, ...update });
    this.bus.emit({ type: "item", assistantId, item: { ...item, ...update } });
    if (item.kind === "image" && update.status === "done" && update.path) {
      void this.runtime.knowledge.collect({ origin: "output", path: update.path, description: item.prompt, assistantId, itemId: id }).catch((error) => console.error("知识库收集失败：", error));
    }
  }

  currentDelegation(assistantId: string): string | undefined {
    return this.routers.get(assistantId)?.currentDelegationId;
  }

  /** 取当前回合来源及其之前的可见对话；事件取最近用户消息。 */
  originalWords(assistantId: string, note?: string, recent = false, extraFiles: string[] = []): { text: string; files: string[] } {
    const items = this.derived(assistantId).result.items;
    const state = this.routers.get(assistantId);
    const source = items.find((item) => item.kind === "user" && item.id === state?.currentUserId)
      ?? items.findLast((item) => item.kind === "user");
    const user = source?.kind === "user" ? source : undefined;
    const files = [...new Set([...(user?.files ?? []), ...extraFiles])];
    const timezone = this.runtime.settings.settings.general.timezone;
    const name = this.assistant(assistantId).name;
    const sections: string[] = [];
    if (user) {
      const header = user.from ? `${user.from.name} 转来` : "用户原话";
      const lines = [`${header}（${monthDayTimeText(timezone, new Date(user.at))}）：`, user.text];
      if (user.quote) lines.push(`（引用：「${user.quote.text}」）`);
      sections.push(lines.filter(Boolean).join("\n"));
      if (recent) {
        const previous = items.slice(0, items.indexOf(user)).filter((item) => item.kind === "user" || item.kind === "assistant").slice(-6);
        if (previous.length) sections.push(`最近的对话：\n${previous.map((item) => {
          if (item.kind !== "user" && item.kind !== "assistant") return "";
          const clock = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(item.at));
          const characters = [...item.text];
          const text = characters.length > 1500 ? `${characters.slice(0, 1500).join("")}…` : item.text;
          return `${item.kind === "user" ? "用户" : name}（${clock}）：${text}`;
        }).join("\n")}`);
      }
    }
    if (files.length) sections.push(`附件：${files.join("、")}`);
    if (note) sections.push(`${name} 的备注：${note}`);
    return { text: sections.join("\n\n"), files };
  }

  async addForwarded(assistantId: string, text: string, delegationId: string, sourceId = "hob", files: string[] = []): Promise<Item> {
    const state = await this.ensure(assistantId);
    const from = { assistantId: sourceId, name: this.store.assistant(sourceId)?.name ?? sourceId, delegationId };
    const data = { text, from, ...(files.length ? { files } : {}) };
    const id = state.manager!.appendCustomEntry(USER_TYPE, data);
    const item: Item = { kind: "user", id, at: this.entryAt(state, id), ...data };
    this.bus.emit({ type: "item", assistantId, item });
    return item;
  }

  async event(assistantId: string, text: string, details?: EventDetails): Promise<void> {
    await this.ensure(assistantId);
    void this.pushEvent(assistantId, text, details).catch(() => undefined);
  }

  /** 事件进 Router 上下文（custom message，不进气泡）；这一轮跑完才返回。 */
  private async pushEvent(
    assistantId: string,
    text: string,
    details: EventDetails | undefined,
    knowledgeQuery?: string,
  ): Promise<boolean> {
    const state = await this.ensure(assistantId);
    const session = state.session!;
    this.touch(assistantId);
    state.running += 1;
    this.armStall(state);
    this.publishBusy(state);
    try {
      const knowledge = knowledgeQuery === undefined ? "" : await this.automaticKnowledge(state, knowledgeQuery);
      const message = { customType: EVENT_TYPE, content: `${nowBlock(this.runtime, assistantId)}\n\n[hob-event] ${text}${knowledge}`, display: false, details };
      await this.refreshTools(state);
      await this.applyConversationModel(state);
      if (session.isStreaming) {
        await session.sendCustomMessage(message, { deliverAs: "followUp" });
        await session.waitForIdle();
      } else {
        await session.sendCustomMessage(message, { triggerTurn: true });
        await this.reportTurnError(state);
      }
      return true;
    } catch (error) {
      await this.fail(state, error);
      return false;
    } finally {
      state.running = Math.max(0, state.running - 1);
      if (!state.running) this.setActivity(state, null);
      this.clearStall(state);
      this.publishBusy(state);
      this.maybeRelease(state);
      this.touch(assistantId);
    }
  }

  /** 忙闲变了告诉前端（“正在想”要看它）。 */
  private publishBusy(state: RouterState): void {
    const assistant = this.store.assistant(state.assistantId);
    if (assistant) this.bus.emit({ type: "assistant", assistant: this.summary(assistant) });
  }

  /**
   * 模型出错（限流、额度、网络）引擎不抛异常，只在最后一条助手消息上记 stopReason=error，重试完就停。
   * 不说一声的话对话里什么都没有，看着像助手不理人：这里补一行灰字。
   */
  private async reportTurnError(state: RouterState): Promise<void> {
    const last = state.session?.messages.findLast((message) => message.role === "assistant");
    // 停下的那一轮：有的服务商（Claude 订阅桥）把停止报成 error，不是回复失败
    if (state.stalled || !last || last.role !== "assistant" || last.stopReason !== "error") return;
    await this.addItem(state.assistantId, { kind: "note", icon: "info", text: `回复失败：${briefModelError(last.errorMessage)}。发送任意消息即可重试。` });
  }

  private async fail(state: RouterState, error: unknown): Promise<void> {
    if (state.stalled) return;
    const message = error instanceof Error ? error.message : String(error);
    await this.addItem(state.assistantId, { kind: "note", icon: "info", text: `发生错误：${message}` });
  }

  // ---------- 对话操作 ----------

  /**
   * 现在能不能开对话会话：没有服务商 / 没有勾模型时返回一句人话，
   * 让 send 重出一条说明而不是报错崩掉。
   */
  private async modelGap(assistantId: string): Promise<string | undefined> {
    const assistant = this.store.assistant(assistantId);
    if (!assistant) return NO_MODEL_NOTE;
    let ref: string;
    try {
      ref = conversationPick(this.runtime.settings.settings.models, assistant).ref;
    } catch (error) {
      if (error instanceof NoModelError) return NO_MODEL_NOTE;
      throw error;
    }
    await this.runtime.models.get();
    return this.runtime.models.find(ref) ? undefined : NO_MODEL_NOTE;
  }

  /**
   * 没有模型时也要把话完整接住：用户那句和一条说明都进对话（不需要模型，只开会话文件）。
   * 配好模型之后再发话就接着聊。
   */
  private sendWithoutModel(assistantId: string, body: SendMessageBody, note: string): Item {
    const file = this.store.routerFile(assistantId);
    mkdirSync(dirname(file), { recursive: true });
    // 会话文件先建空：引擎看到空文件会马上写头，之后的条目才落盘（不然只存在内存里，刷新就没了）
    if (!existsSync(file)) writeFileSync(file, "");
    const manager = SessionManagerImpl.open(file, dirname(file), this.store.home);
    const data = {
      text: body.text,
      ...(body.quote ? { quote: body.quote } : {}),
      ...(body.files?.length ? { files: body.files } : {}),
    };
    const id = manager.appendCustomEntry(USER_TYPE, data);
    const item: Item = { kind: "user", id, at: new Date().toISOString(), ...data };
    for (const path of body.files ?? []) void this.runtime.knowledge.collect({ origin: "chat", path, assistantId, itemId: id }).catch((error) => console.error("知识库收集失败：", error));
    this.bus.emit({ type: "item", assistantId, item });
    const noteId = manager.appendCustomEntry(ITEM_TYPE, { kind: "note", icon: "info", text: note });
    this.bus.emit({
      type: "item",
      assistantId,
      item: { kind: "note", id: noteId, at: new Date().toISOString(), icon: "info", text: note },
    });
    return item;
  }

  async send(assistantId: string, body: SendMessageBody): Promise<Item> {
    this.runtime.delegations.takeOver(assistantId);
    for (const approval of this.store.approvals()) {
      if (approval.assistantId !== assistantId || approval.source !== "router" || approval.status !== "pending") continue;
      const expired = { ...approval, status: "expired" as const };
      this.store.saveApproval(expired);
      this.bus.emit({ type: "approval", approval: expired });
    }
    const gap = await this.modelGap(assistantId);
    if (gap) return this.sendWithoutModel(assistantId, body, gap);
    const state = await this.ensure(assistantId);
    const data = {
      text: body.text,
      ...(body.quote ? { quote: body.quote } : {}),
      ...(body.files?.length ? { files: body.files } : {}),
    };
    const id = state.manager!.appendCustomEntry(USER_TYPE, data);
    const item: Item = {
      kind: "user",
      id,
      at: this.entryAt(state, id),
      text: body.text,
      ...(body.quote ? { quote: body.quote } : {}),
      ...(body.files?.length ? { files: body.files } : {}),
    };
    this.bus.emit({ type: "item", assistantId, item });
    for (const path of body.files ?? []) void this.runtime.knowledge.collect({ origin: "chat", path, assistantId, itemId: id }).catch((error) => console.error("知识库收集失败：", error));

    const lines = [body.text];
    if (body.quote) lines.unshift(`（引用我之前的话：「${body.quote.text}」）`);
    if (body.files?.length) lines.push(`附件：${body.files.join("、")}`);
    const basePrompt = `${nowBlock(this.runtime, assistantId)}\n\n${lines.filter(Boolean).join("\n")}`;
    const previousDelivery = state.pendingDelivery;
    let releaseDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    state.pendingDelivery = delivery;

    this.touch(assistantId);
    state.running += 1;
    this.armStall(state);
    this.publishBusy(state);
    void (async () => {
      try {
        const promptText = basePrompt + await this.automaticKnowledge(state, body.text);
        await previousDelivery;
        (state.pendingUsers ??= []).push({ prompt: promptText, id });
        await this.applyConversationModel(state);
        await this.refreshTools(state);
        // 对话模型能看图就把图片直接给它（路径照样写在「附件」里，派任务时还能交出去）；看不了图就只有路径
        const images = state.session!.model?.input.includes("image") ? imageContents(body.files) : [];
        if (state.session!.isStreaming) {
          await state.session!.steer(promptText, images.length ? images : undefined);
          releaseDelivery();
        } else {
          await state.session!.prompt(promptText, { ...(images.length ? { images } : {}), preflightResult: releaseDelivery });
          await this.reportTurnError(state);
        }
      } catch (error) {
        await this.fail(state, error);
      } finally {
        releaseDelivery();
        if (state.pendingDelivery === delivery) state.pendingDelivery = undefined;
        state.running = Math.max(0, state.running - 1);
        if (!state.running) this.setActivity(state, null);
        this.clearStall(state);
        this.publishBusy(state);
        this.maybeRelease(state);
        this.touch(assistantId);
      }
    })();
    return item;
  }

  async stop(assistantId: string): Promise<void> {
    const state = this.routers.get(assistantId);
    if (state) {
      state.stalled = true;
      this.setActivity(state, null);
    }
    if (state?.session) await state.session.abort();
  }

  isBusy(assistantId: string): boolean {
    const state = this.routers.get(assistantId);
    // 只看助手自己在不在回复：任务不阻塞对话，任务的进度在任务卡上，不再算进来（不然任务跑多久「…」就挂多久）
    return (state?.running ?? 0) > 0 || (state?.session?.isStreaming ?? false);
  }

  /** 等到这个助手没有在跑的回复，并且会话条目已经落定（测试和冒烟用）。 */
  async waitIdle(assistantId: string, timeoutMs = 15_000): Promise<void> {
    const started = Date.now();
    let stable = 0;
    let lastCount = -1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    while (Date.now() - started < timeoutMs) {
      const state = this.routers.get(assistantId);
      const busy = (state?.running ?? 0) > 0 || (state?.session?.isStreaming ?? false);
      const count = state?.manager?.getEntryCount() ?? -1;
      if (!busy) {
        stable = count === lastCount ? stable + 1 : 0;
        if (stable >= 2) return;
      } else {
        stable = 0;
      }
      lastCount = count;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  items(assistantId: string, options: { before?: string; limit?: number } = {}): ItemsPage {
    const derived = this.derived(assistantId);
    const all = derived.result.items;
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const end = options.before ? derived.positions.get(options.before) ?? all.length : all.length;
    const start = Math.max(0, end - limit);
    const page = all.slice(start, end);
    const jobIds = new Set(page.filter((item) => item.kind === "job").map((item) => (item as { jobId: string }).jobId));
    const draftIds = new Set(
      page.filter((item) => item.kind === "draft").map((item) => (item as { draftId: string }).draftId),
    );
    const approvalIds = new Set(
      page.filter((item) => item.kind === "question").map((item) => (item as { approvalId: string }).approvalId),
    );
    const ids = new Set(page.filter((item) => item.kind === "delegation").map((item) => (item as { delegationId: string }).delegationId));
    const delegations = this.store.delegations().filter((item) => ids.has(item.id));
    for (const delegation of delegations) {
      for (const id of delegation.jobIds) jobIds.add(id);
      for (const id of delegation.approvalIds ?? []) approvalIds.add(id);
    }
    return {
      ...(!options.before ? { pageLive: [...(this.livePages.get(assistantId)?.values() ?? [])].map((live) => live.page) } : {}),
      items: page,
      approvals: this.store.approvals().filter((approval) => approvalIds.has(approval.id)),
      jobs: [...jobIds].flatMap((id) => { const job = this.store.job(id); return job ? [job] : []; }),
      drafts: this.store.drafts().filter((draft) => draftIds.has(draft.id)),
      delegations,
      hasMore: start > 0,
    };
  }

  read(assistantId: string): void {
    this.store.saveState(assistantId, { readAt: new Date().toISOString() });
  }

  unread(assistantId: string): number {
    const readAt = this.store.state(assistantId).readAt;
    // 从没记过已读：从现在开始算，以前的都当读过。不记的话未读永远是 0，前端也就永远不会来标已读
    if (!readAt) {
      this.read(assistantId);
      return 0;
    }
    const times = this.derived(assistantId).assistantTimes;
    let lo = 0, hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid] <= readAt) lo = mid + 1;
      else hi = mid;
    }
    return times.length - lo;
  }

  last(assistantId: string): { text: string; at: Iso } | undefined {
    return this.derived(assistantId).last;
  }

  summary(assistant: Assistant): AssistantSummary {
    const last = this.last(assistant.id);
    return {
      ...assistant,
      ...(last ? { last } : {}),
      unread: this.unread(assistant.id),
      ...(this.store.state(assistant.id).readAt ? { readAt: this.store.state(assistant.id).readAt } : {}),
      busy: this.isBusy(assistant.id),
      activity: this.routers.get(assistant.id)?.activity ?? null,
    };
  }

  profile(assistantId: string): Profile {
    const assistant = this.assistant(assistantId);
    return {
      assistant: this.summary(assistant),
      rules: this.store.rules(assistantId),
      routines: this.store.routines().filter((routine) => routine.assistantId === assistantId),
      worklog: this.store.worklog(assistantId),
    };
  }

  bootstrap(): Bootstrap {
    const jobCutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    return {
      assistants: this.store.assistants().map((assistant) => this.summary(assistant)),
      jobs: this.store
        .jobs()
        .filter((job) => job.status === "running" || job.status === "queued" || job.status === "waiting" || (job.endedAt ?? job.createdAt) > jobCutoff),
      routines: this.store.routines(),
      approvals: this.store.approvals().filter((approval) => approval.status === "pending" && approval.source !== "job"),
      delegations: this.store.delegations(),
      settings: this.runtime.settings.get(),
    };
  }

  /** 进程退出或测试收尾：释放所有 Router 会话。 */
  disposeAll(): void {
    for (const state of this.routers.values()) this.close(state);
    this.routers.clear();
    this.itemCache.clear();
  }

  /** 直接走事件的 followUp 队列，实际收到这条消息时才开始关联任务。 */
  /** 把事件当作转交的一轮送给目标助手；这一轮没正常收尾就把转交记为受阻，不会一直挂着。 */
  async relay(targetAssistantId: string, text: string, delegationId: string, details?: EventDetails, knowledgeQuery?: string): Promise<void> {
    const success = await this.pushEvent(targetAssistantId, text, { ...details, delegationId }, knowledgeQuery);
    if (!success || !this.store.delegation(delegationId)?.turnFinished) {
      this.runtime.delegations.turnEnded(delegationId, "目标助手处理失败或转交被中断", true);
    }
  }

  /** 审批答案回到 Router（router 来源的审批，答案作为事件进入上下文）。 */
  async answerEvent(assistantId: string, text: string): Promise<void> {
    await this.event(assistantId, text);
  }
}
