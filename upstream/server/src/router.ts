import { pluginCommandToolsForAssistant, pluginToolsForAssistant } from "./plugin-host.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { parseStreamingJson } from "@earendil-works/pi-ai/utils/json-parse";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { newId } from "./ids.ts";
import type { AgentSession, AgentSessionEvent, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager as SessionManagerImpl } from "@earendil-works/pi-coding-agent";
import { t } from "../../shared/i18n.ts";
import { readTodos, releaseIdleTodos, todosBusy } from "./todos.ts";
import { assistantTodosPath, assistantWorkDir, engineDir } from "./config.ts";
import type {
  Assistant,
  AssistantSummary,
  Bootstrap,
  CardRecord,
  Group,
  Iso,
  Item,
  ItemsPage,
  Job,
  JobStatus,
  JobStep,
  NoteIcon,
  PageLive,
  Profile,
  SendMessageBody,
  RouterActivity,
} from "../../shared/types.ts";
import type { HobRuntime } from "./runtime.ts";
import { refreshSystemPrompt } from "./pi.ts";
import { conversationPick, assistantInGroup, defaultWorkRef, followUpPick, jobModel, nameOf, noteOf, thinkingForPick, thinkingLevelsOf, fitThinking, usableRefs, NO_MODEL_NOTE, NoModelError } from "./models.ts";
import { scriptToolList } from "./script-tools.ts";
import { proxyEnvironment } from "./network-proxy.ts";
import { buildRouterTools } from "./router-tools.ts";
import { isInPagesDir } from "./files.ts";
import { boundKnowledge, formatKnowledge, KNOWLEDGE_INTRO } from "./knowledge-tools.ts";
import { MEMORY_TOOL_PATTERNS } from "./memory.ts";
import { buildSystemPrompt, type PromptModel } from "./prompt.ts";
import { visibleSkills } from "./skills.ts";
import { activityLabel, thinkingLine } from "./router-activity.ts";
import { imageContents } from "./jobs.ts";
import { nowBlock } from "./now.ts";
import { loadWorkspaceAgentsFile, resolveWorkspaceCwd, validateWorkspaceCwd } from "./workspace.ts";

import { pushAssistantTurnEnd } from "./push.ts";
import { browserShellEnv, DesktopToolSession } from "./desktop-tools.ts";
import { textOfContent } from "./transcript.ts";
import { briefModelError } from "./text.ts";
import { saysNoReply, stripNoReply } from "../../shared/no-reply.ts";
import { reactionsList } from "./store.ts";
import { generateFollowUpSuggestions, groupHistory, routerHistory } from "./follow-up.ts";

export const IDLE_COMPACTION_IDLE_MS = 6 * 60 * 60 * 1000;
export const IDLE_COMPACTION_TOKEN_THRESHOLD = 150_000;
const IDLE_COMPACTION_INTERVAL_MS = 10 * 60 * 1000;

export const ITEM_TYPE = "hob.item";
export const ITEM_UPDATE_TYPE = "hob.item.update";
export const USER_TYPE = "hob.user";
export const EVENT_TYPE = "hob.event";
/** 只给助手知道、不开一轮的事（用户直接对任务说的话）。 */
const CONTEXT_TYPE = "hob.context";

/** 会话条目的 id 和 at 由会话文件给出，写卡片时不用传。 */
/** 事件附带的信息，落在会话的事件条目上：routine 给回复挂「⏱ 名字」，cont 见 walk。 */
export type EventText = string | (() => string);

export interface EventDetails {
  routine?: { id: string; name: string; jobId?: string };
  routineTrigger?: { id: string; name: string };
  cont?: true;
  returnedDelegationId?: string;
  delegationId?: string;
  /** 主助手交来的话题关了：送结论的会话条目按这个 id 去重 */
  handoverTopicId?: string;
  /** 任务事件按真正投递时的任务状态改写；同一任务排队时只留最新一条 */
  job?: { id: string; round: number; kind?: "result" | "question" | "timeout" };
  /** 任务或转交结果已送来：本轮收尾时统一通知，避免任务结束和助手回复各推一次 */
  workDone?: true;
}

interface PendingEvent {
  text: string;
  details?: EventDetails;
  knowledgeQuery?: string;
  jobId?: string;
  waiters: ((success: boolean) => void)[];
}

export type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id" | "at"> : never) : never;

/**
 * 群里给做事、沟通和管理本群规则、定时、技能的工具；页面按助手存，进群要另做。
 */
const GROUP_TOOL_NAMES = new Set([
  "read", "bash", "edit", "write", "search_history", "search_plugins", "check_job", "start_job", "reply_job", "stop_job", "ask_user", "send_card", "send_file", "react", "save_skill", "review_job", "set_rule", "remove_rule", "create_routine", "update_routine", "delete_routine", "delete_skill", "update_todos",
  "find_knowledge", "search_knowledge", "web_search", "web_fetch", "generate_image", "login", "fill_new_password",
  "open_topic", "close_topic",
]);

/**
 * 群里另外只给主助手的：管助手、群和话题的工具。
 * 别的成员在群里还是拿不到它们。
 */
const GROUP_PRIMARY_TOOL_NAMES = new Set([
  "show_assistant", "show_group", "create_assistant", "update_assistant", "create_group", "update_group", "manage_topic",
]);

function groupTool(name: string, primary: boolean): boolean {
  return GROUP_TOOL_NAMES.has(name) || (primary && GROUP_PRIMARY_TOOL_NAMES.has(name)) ||
    Object.values(MEMORY_TOOL_PATTERNS).flat().some((pattern) => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
}

interface RouterState {
  /** 会话键：单聊就是 assistantId，群会话是 `<assistantId>@<gid>` */
  key: string;
  assistantId: string;
  groupId?: string;
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
  /**
   * 事件那一轮：文字等这一轮结束再出（以 NO_REPLY 收尾就整轮不出）。
   * held 记着这一轮已经写好的各段字和条目 id。
   */
  eventTurn?: { held: { text: string; itemId?: string }[] };
  /** 这一轮最后一次有动静的时间，看门狗用它判断“没响应” */
  lastEventAt: number;
  /** 上一轮结束的时间；重启后从最后一条 assistant 会话条目恢复 */
  lastTurnEndedAt?: number;
  /** 闲置整理正在进行时，新消息等它完成再进入模型 */
  compactionPromise?: Promise<void>;
  /** 最近一次成功整理对应的回合结束时间；真实会话重启后由 compaction 条目判断 */
  compactedTurnAt?: number;
  stallTimer?: NodeJS.Timeout;
  /** 这一轮已经被叫停（没响应，或用户按了停止）：之后的报错不再写「没能回复」 */
  stalled: boolean;
  /** 这一轮最后一条模型回复是出错（连重试也放弃了）：这一轮收尾时写成一行给用户看 */
  turnError?: string;
  /** 这一轮最后一条可见回复，用于完成通知正文 */
  turnLastText?: string;
  /** 这一轮最后一段以 NO_REPLY 收尾：助手决定不出声，没有新内容给用户看，不推「做完了」 */
  turnSilent?: boolean;
  /** 这一轮成功点过表情回应：只点表情没出文字时不推「做完了」 */
  turnReacted?: boolean;
  /** 这一轮收到的用户消息（单聊）：以 NO_REPLY 收尾时替助手在它上面挂 👀 */
  turnUserItem?: string;
  /** agent_settled 捕获的失败原因，reportTurnFailure 会清掉 turnError */
  turnFailure?: string;
  /** 这一轮开始前或事件带来的工作状态 */
  turnHadWork: boolean;
  turnWorkDone: boolean;
  turnDelegation: boolean;
  releaseAfterTurn?: boolean;
  /** 还在跑的记忆写入工具：参数只在 tool_execution_start 里有，按 toolCallId 存着给 note 用 */
  currentDelegationId?: string;
  turnRoutine?: { id: string; name: string };
  pendingDelivery?: Promise<void>;
  /** 等会话空下来再送的事件。排着的每一条都记在 running 里：这一轮的收尾（完成通知、释放会话）等它们送完再做 */
  pendingEvents?: PendingEvent[];
  eventDispatch?: Promise<void>;
  /** 正在判断这一轮停没停下来（abortOrForget）：这期间排着的事件先不送 */
  stopping?: number;
  knowledgeNames?: string[];
  delegationReply?: string[];
  terminatingTools?: Set<string>;
  /** 本轮已经查看过的任务快照，用于无变化时压缩 check_job 返回。 */
  checkJobSnapshots?: Map<string, string>;
  scriptRevokes?: Set<() => void>;
  desktop?: DesktopToolSession;
  /** 这个会话装的工具在界面上叫什么名字（只盯 Hob 自己装的那批） */
  toolLabels?: Map<string, string>;
  /** 工具调用的对象（toolCallId → 「工具 + 对象」），有副作用的才记 */
  callSubjects?: Map<string, string>;
  /** 这一轮有副作用、还没办成的调用：对象 → 提示行要写的名字和原因 */
  turnCalls?: Map<string, { label: string; error: string }>;
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

/**
 * 有的服务商出错时把报错原文写进回复内容（如「API Error: Connection dropped」）：这条不是助手说的话，
 * 只留「回复失败」那行。断流前已经写出来的正文照常保留。
 */
function errorEcho(message: { stopReason?: string; errorMessage?: string; content: unknown }): boolean {
  const error = message.errorMessage?.trim();
  return (message.stopReason === "error" || message.stopReason === "aborted") && !!error && messageText(message.content).includes(error);
}

function messageText(content: unknown): string {
  return textOfContent(content).trim();
}

/**
 * 只读的工具失败了不留提示行：模型看得见，接着说就行，用户不需要知道这次没读到。
 * 其余工具都算有副作用，以后新加的也照样算。
 */
const READ_ONLY_TOOLS = new Set(["read", "search_history", "search_plugins", "check_job", "overview", "show_assistant", "show_group", "find_knowledge", "search_knowledge", "web_search", "web_fetch", "tool_search"]);

/**
 * 有副作用的调用按「工具 + 对象」分开算：转交看助手，交给群看群，其余看工具本身。
 * 同一个对象后来成功过就算办成了，所以只留最后没办成的那几条。
 */
function callSubject(name: string, args: unknown): string | undefined {
  if (READ_ONLY_TOOLS.has(name)) return undefined;
  const fields = (args ?? {}) as Record<string, unknown>;
  const object = name === "message_assistant" ? fields.assistantId : name === "message_group" ? fields.groupId : undefined;
  return `${name}:${object === undefined ? "" : String(object)}`;
}

/** 工具报错的原文：去掉统一加的那个开头，界面上看的就是工具自己说的话。 */
function failureText(result: unknown): string {
  const text = messageText((result as { content?: unknown } | undefined)?.content ?? []);
  return text.replace(/^调用失败：/, "");
}

/**
 * 事件那一轮（一条 [hob-event] 到下一个用户消息或下一条事件）的文字：最后一段以 NO_REPLY 收尾，
 * 这一轮的字一段都不给用户看。按助手消息的序号（对话条目的 a-N）返回要收起来的那些。
 * 卡片、文件、图片不受影响：它们不是这段文字。
 */
function silentEventTexts(entries: SessionEntry[]): Set<number> {
  const hidden = new Set<number>();
  let assistantIndex = 0;
  let inEvent = false;
  let texts: { index: number; text: string }[] = [];
  const close = () => {
    if (texts.length && saysNoReply(texts.at(-1)!.text)) for (const one of texts) hidden.add(one.index);
    texts = [];
  };
  for (const entry of entries) {
    // 用户那一轮从模型真正读到用户消息算起（和实时那边 message_start 一致）；hob.user 条目在用户按发送时
    // 就写了，事件那一轮还没跑完时它会夹在这一轮中间，不能拿它当分界
    if (entry.type === "message" && entry.message.role === "user") {
      close();
      inEvent = false;
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === EVENT_TYPE) {
      close();
      inEvent = true;
      continue;
    }
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    assistantIndex += 1;
    if (!inEvent || errorEcho(entry.message)) continue;
    const text = messageText(entry.message.content);
    if (text) texts.push({ index: assistantIndex, text });
  }
  close();
  return hidden;
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
  const silent = silentEventTexts(entries);
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
    // 定时任务那一轮一个字没出（只调工具或者回了 NO_REPLY）：「⏱ 名字」不能挂到用户下一轮的回复上
    if (entry.type === "message" && entry.message.role === "user") {
      routine = undefined;
      continue;
    }
    if (entry.type === "message" && entry.message.role === "assistant") {
      assistantIndex += 1;
      if (silent.has(assistantIndex)) continue;
      if (errorEcho(entry.message)) continue;
      const text = stripNoReply(messageText(entry.message.content));
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
  private idleCompactionTimer?: NodeJS.Timeout;
  private suggestions = new Map<string, string[]>();
  private suggestionEpoch = new Map<string, number>();
  /** 不在内存里的会话：上次查过的会话文件修改时间，文件没变就不再打开 */
  private idleChecked = new Map<string, number>();

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
    this.idleCompactionTimer = setInterval(() => { void this.compactIdleSessions().catch((error) => console.error("闲置会话检查失败：", error)); }, IDLE_COMPACTION_INTERVAL_MS);
    this.idleCompactionTimer.unref?.();
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

  private get timezone(): string {
    return this.runtime.settings.settings.general.timezone;
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

  async ensure(assistantId: string, groupId?: string): Promise<RouterState> {
    const assistant = this.assistant(assistantId);
    const key = this.keyOf(assistantId, groupId);
    let state = this.routers.get(key);
    if (!state) {
      state = { key, assistantId, ...(groupId ? { groupId } : {}), running: 0, lastEventAt: Date.now(), stalled: false, turnHadWork: false, turnWorkDone: false, turnDelegation: false };
      this.routers.set(key, state);
    }
    if (state.session) {
      await this.compactIfIdle(state);
      return state;
    }
    state.opening ??= this.openSession(state, assistant).catch((error: unknown) => {
      state!.opening = undefined;
      if (state!.desktop && !state!.session) {
        void state!.desktop.dispose();
        state!.desktop = undefined;
      }
      throw error;
    });
    await state.opening;
    return state;
  }

  /** 会话键：单聊是 assistantId，群会话是 `<assistantId>@<gid>`。 */
  private keyOf(assistantId: string, groupId?: string): string {
    return groupId ? `${assistantId}@${groupId}` : assistantId;
  }

  /** 这个会话的文件：群会话在 groups/<gid>/members/ 下，单聊还是 router.jsonl。 */
  private sessionFile(state: RouterState): string {
    return state.groupId ? this.store.groupMemberFile(state.groupId, state.assistantId) : this.store.routerFile(state.assistantId);
  }

  private async openSession(state: RouterState, assistant: Assistant): Promise<void> {
    // 提示词里要写模型的显示名和定位，所以先把注册表拉一遍
    await this.runtime.models.get();
    const effectiveAssistant = assistantInGroup(assistant, state.groupId ? this.store.group(state.groupId) : undefined, this.runtime.models, this.runtime.settings.settings.models);
    const pick = conversationPick(this.runtime.settings.settings.models, effectiveAssistant);
    state.knowledgeNames = (await boundKnowledge(this.runtime, assistant.id)).map((collection) => collection.name);
    const desktop = this.runtime.desktop.view();
    const desktopEnabled = desktop.enabled && !!desktop.url && desktop.tokenConfigured;
    let cliEnvironment: Awaited<ReturnType<DesktopToolSession["preparePlaywrightCli"]>> | undefined;
    if (desktopEnabled) {
      state.desktop = new DesktopToolSession(this.runtime, assistant.id, false, undefined, true);
      cliEnvironment = await state.desktop.preparePlaywrightCli();
    }
    const abilities = assistant.abilities ?? { exec: true, write: true, image: true };
    const directToolNames = ["read", ...(abilities.exec ? ["bash"] : []), ...(abilities.write ? ["edit", "write"] : [])];
    const ownWorkDir = assistantWorkDir(this.runtime.home, assistant.id);
    mkdirSync(ownWorkDir, { recursive: true });
    const resolved = resolveWorkspaceCwd(this.store, this.runtime.home, assistant.id, state.groupId);
    let sessionCwd = resolved.sessionCwd;
    let workspacePrompt: { cwd: string; source: "topic" | "group" | "assistant"; ownDir: string } | undefined;
    let workspaceWarning: string | undefined;
    let agentsFiles: Array<{ path: string; content: string }> = [];
    if (resolved.bound && resolved.source !== "default") {
      try {
        sessionCwd = validateWorkspaceCwd(resolved.bound, this.runtime.home);
        workspacePrompt = { cwd: sessionCwd, source: resolved.source, ownDir: ownWorkDir };
        agentsFiles = loadWorkspaceAgentsFile(sessionCwd);
      } catch {
        sessionCwd = ownWorkDir;
        workspaceWarning = resolved.bound;
      }
    }
    const customTools = buildRouterTools(this.runtime, assistant.id, state.groupId, sessionCwd, ownWorkDir);
    const existingNames = new Set([...directToolNames, ...customTools.map(tool => tool.name), "tool_search"]);
    const pluginTools = pluginToolsForAssistant(this.runtime.plugins, assistant.id, existingNames, {
      onCard: (payload) => this.addPluginCard(assistant.id, state.groupId, payload),
      onCardError: (pluginId, message) => this.addPluginCardError(assistant.id, state.groupId, message),
    });
    const availableToolNames = [...new Set([...directToolNames, ...customTools.map((tool) => tool.name)])];
    const allowedTools = state.groupId ? availableToolNames.filter((name) => groupTool(name, assistant.primary)) : availableToolNames;
    const tools = [...customTools.filter((tool) => allowedTools.includes(tool.name)), ...pluginTools];
    allowedTools.push(...pluginTools.map(tool => tool.name));
    const toolSearch = pluginTools.some(tool => tool.exposure === "deferred");
    if (toolSearch) allowedTools.push("tool_search");
    await this.runtime.scriptTools.start();
    const file = this.sessionFile(state);
    const groupId = state.groupId;
    const opened = await this.runtime.pi.open({
      file,
      spillDir: state.groupId ? join(dirname(file), `${assistant.id}-spill`) : join(dirname(file), "spill"),
      cwd: sessionCwd,
      agentsFiles,
      writeGuard: {
        home: this.runtime.home,
        roots: () => [
          ...new Set([
            sessionCwd,
            ownWorkDir,
            ...this.store.jobs().filter((job) => job.assistantId === assistant.id).map((job) => job.cwd ?? this.store.workDir(job.id)),
          ]),
        ],
      },
      model: pick.ref,
      thinking: thinkingForPick(pick, this.runtime.models),
      memory: this.runtime.settings.memory().provider,
      systemPrompt: () => {
        const { timezone, aboutYou, locale } = this.runtime.settings.settings.general;
        const desktop = this.runtime.desktop.view();
        // 群名、成员、负责什么改了下一条消息就用新的
        const group = groupId ? this.store.group(groupId) : undefined;
        return buildSystemPrompt(this.store, assistant.id, {
          timezone,
          locale,
          aboutYou,
          memory: this.runtime.settings.memory().provider,
          searchEnabled: this.runtime.settings.settings.search.some((provider) => provider.enabled),
          imageEnabled: tools.some((tool) => tool.name === "generate_image"),
          showPageEnabled: tools.some((tool) => tool.name === "show_page"),
          desktopEnabled: desktopEnabled,
          credentialsEnabled: desktopEnabled && this.runtime.plugins.hasCredentialProvider(assistant.id),
          models: this.promptModels(assistant.id, groupId),
          skills: visibleSkills(this.runtime, assistant.id, group),
          thinkingChoice: this.runtime.settings.settings.models.thinkingChoice,
          abilities,
          knowledgeNames: state.knowledgeNames,
          ...(group ? { group } : {}),
          ...(workspacePrompt ? { workspace: workspacePrompt } : {}),
          ...(workspaceWarning ? { workspaceWarning } : {}),
        });
      },
      tools: allowedTools,
      customTools: tools,
      toolSearch,
      stall: { milliseconds: () => this.stallMs(), onRetry: () => this.setActivity(state, { state: "thinking", label: t("模型没有响应，正在重试") }) },
      bashSpawnHook: ({ command, cwd, env }) => {
        const credential = this.runtime.scriptTools.issue({
          tools: async () => {
            const reserved = new Set(existingNames);
            const livePlugins = pluginToolsForAssistant(this.runtime.plugins, assistant.id, reserved);
            for (const tool of livePlugins) reserved.add(tool.name);
            const commandTools = pluginCommandToolsForAssistant(this.runtime.plugins, assistant.id, reserved);
            return scriptToolList(tools, !!(await boundKnowledge(this.runtime, assistant.id)).length, livePlugins, commandTools);
          },
          onCall: (tool) => this.setActivity(state, { state: "tool", label: tool.label }),
        });
        (state.scriptRevokes ??= new Set()).add(credential.revoke);
        const binDirs = [join(engineDir(this.runtime.home), "bin"), ...this.runtime.plugins.binDirsForAssistant(assistant.id)];
        return { command, cwd, env: this.runtime.scriptTools.environment(proxyEnvironment(browserShellEnv(env, cliEnvironment), this.runtime.settings.settings.general), credential.token, binDirs) };
      },
    });
    state.toolLabels = new Map(tools.map((tool) => [tool.name, tool.label]));
    state.session = opened.session;
    if (!state.knowledgeNames.length) refreshSystemPrompt(opened.session, opened.session.getActiveToolNames().filter((name) => name !== "search_knowledge"));
    state.manager = opened.manager;
    state.opening = undefined;
    opened.session.subscribe((event) => this.onSessionEvent(state, assistant.id, event));
    state.lastTurnEndedAt ??= this.lastTurnEndedAt(state);
    await this.compactIfIdle(state);
    this.touch(state);
  }

  private async refreshTools(state: RouterState): Promise<void> {
    state.knowledgeNames = (await boundKnowledge(this.runtime, state.assistantId)).map((collection) => collection.name);
    const primary = this.store.assistant(state.assistantId)?.primary === true;
    const names = state.session!.getActiveToolNames().filter((name) => name !== "search_knowledge" && (!state.groupId || name === "tool_search" || state.toolLabels?.has(name) || groupTool(name, primary)));
    if (state.knowledgeNames.length) names.push("search_knowledge");
    refreshSystemPrompt(state.session!, names);
  }

  private async automaticKnowledge(state: RouterState, query: string): Promise<string> {
    const ids = this.store.assistant(state.assistantId)?.knowledge ?? [];
    if ([...query.trim()].length < 4 || !ids.length || this.runtime.settings.settings.knowledge?.embedding.source !== "openai") return "";
    this.setActivity(state, { state: "tool", label: t("正在搜索知识库") });
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
      if (state.activity?.label === t("正在搜索知识库")) this.setActivity(state, null);
    }
  }

  /** 这个助手能派、当前可用的模型（提示词里那一节）。 */
  private promptModels(assistantId: string, groupId?: string): PromptModel[] {
    const found = this.store.assistant(assistantId);
    if (!found) return [];
    const assistant = assistantInGroup(found, groupId ? this.store.group(groupId) : undefined, this.runtime.models, this.runtime.settings.settings.models);
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
    const assistant = assistantInGroup(this.assistant(state.assistantId), state.groupId ? this.store.group(state.groupId) : undefined, this.runtime.models, this.runtime.settings.settings.models);
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
    if (event.type === "message_end" && event.message.role === "assistant") {
      // 这一次调模型没成（重试成功的话下一条会把这个清掉）
      const message = event.message;
      if (message.stopReason === "error" && message.errorMessage === "模型没有响应") {
        state.stalled = true;
        const assistant = this.store.assistant(state.assistantId);
        void this.note(state, "info", t("{assistant} 无响应，已停止，可重新发送", { assistant: assistant?.name ?? state.assistantId }));
      }
      state.turnError = message.stopReason === "error" || (message.stopReason === "aborted" && !!message.errorMessage)
        ? message.errorMessage ?? "模型服务出错"
        : undefined;
    }
    // 整轮结束（包括重试）：模型一直没答成就明说一句，用户和下一轮都看得到；
    // 答成了的这一轮，手上没活的待办在这里收起（出错的那一轮留到下一轮）
    if (event.type === "agent_settled") {
      state.lastTurnEndedAt = Date.now();
      const failed = Boolean(state.turnError);
      if (state.turnError) state.turnFailure = state.turnError;
      void this.reportTurnFailure(state).catch((error) => console.error("写失败说明失败：", error));
      if (!failed) releaseIdleTodos(this.runtime, assistantId, state.groupId);
    }
    if (event.type === "agent_end") {
      state.turnRoutine = undefined;
      this.flushEventTurn(state, assistantId);
    }
    this.progress(state);
    if (event.type === "agent_start" || (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start")) {
      state.thinkingText = "";
      this.setActivity(state, { state: "thinking", label: t("正在思考…") });
      if (event.type === "agent_start") state.turnCalls = undefined;
      if (event.type === "agent_start") {
        state.turnLastText = undefined;
        state.turnFailure = undefined;
        state.turnReacted = undefined;
        state.checkJobSnapshots = new Map();
      }
    }
    if (event.type === "message_update" && (event.assistantMessageEvent.type === "thinking_delta" || event.assistantMessageEvent.type === "thinking_end")) {
      if (event.assistantMessageEvent.type === "thinking_delta") state.thinkingText = (state.thinkingText ?? "") + event.assistantMessageEvent.delta;
      // 节流；思考结束时补发一次完整的最后一段
      if (event.assistantMessageEvent.type === "thinking_end" || Date.now() - (state.activityLast ?? 0) >= 200) {
        this.setActivity(state, { state: "thinking", label: thinkingLine(state.thinkingText ?? "") ?? t("正在思考…") });
        state.activityLast = Date.now();
      }
    }
    // 工具跑完、整理上下文时不再挂着上一个工具的名字
    if (event.type === "turn_end" && state.activity?.state === "tool") this.setActivity(state, { state: "thinking", label: t("正在思考…") });
    if (event.type === "compaction_start" && state.running > 0) this.setActivity(state, { state: "thinking", label: t("正在整理前面的对话…") });
    if (event.type === "compaction_end" && state.running > 0) this.setActivity(state, { state: "thinking", label: t("正在思考…") });
    if (event.type === "agent_end" || (event.type === "message_end" && event.message.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason))) this.setActivity(state, null);
    // 一轮结束：有副作用的调用里没办成、后来也没办成的，各留一行提示（原因是工具报错的原文）
    if (event.type === "agent_end") void this.flushTurnFailures(state).catch((error) => console.error("写失败提示失败：", error));
    if (event.type === "message_start" && event.message.role === "custom" && event.message.customType === EVENT_TYPE) {
      // 事件那一轮：文字先攒着，这一轮结束时再决定出不出现
      this.flushEventTurn(state, assistantId);
      if (!state.groupId) state.eventTurn = { held: [] };
      const details = event.message.details as EventDetails | undefined;
      state.turnDelegation ||= Boolean(details?.delegationId);
      state.turnWorkDone ||= Boolean(details?.workDone);
      state.turnRoutine = details?.routineTrigger;
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
      const subject = state.toolLabels?.has(event.toolName) ? callSubject(event.toolName, event.args) : undefined;
      if (subject) (state.callSubjects ??= new Map()).set(event.toolCallId, subject);
      return;
    }
    if (event.type === "tool_execution_end") {
      if (event.toolName === "bash") { state.scriptRevokes?.forEach((revoke) => revoke()); state.scriptRevokes?.clear(); }
      // 有副作用的调用：失败了先记着，后面同一个对象成功了就划掉
      const subject = state.callSubjects?.get(event.toolCallId);
      if (subject) {
        state.callSubjects!.delete(event.toolCallId);
        const label = state.toolLabels!.get(event.toolName)!;
        if (event.isError) (state.turnCalls ??= new Map()).set(subject, { label, error: failureText(event.result) });
        else state.turnCalls?.delete(subject);
      }
      if (event.toolName === "show_page") {
        const result = event.result as { details?: { path?: string }; content?: { text?: string }[] } | undefined;
        this.liveFinish(assistantId, event.toolCallId, event.isError ? undefined : result?.details?.path, result?.content?.[0]?.text);
      }
      if (event.toolName === "react" && !event.isError) state.turnReacted = true;
      if (state.currentDelegationId && (event.result as { terminate?: boolean } | undefined)?.terminate) state.terminatingTools?.add(event.toolCallId);
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      // 群会话的条目 id 和时间线由 GroupManager 管，这里只把文字转过去
      if (state.groupId) return;
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
      if (state.groupId) {
        this.runtime.groups?.delta(state.groupId, state.assistantId, event.assistantMessageEvent.delta);
        return;
      }
      if (state.eventTurn) return;
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
      const text = errorEcho(event.message) ? "" : messageText(event.message.content).trim();
      // 推送正文用用户看得到的文字：NO_REPLY 这个词不出现；以它收尾的一轮整轮不出声
      if (text) {
        state.turnSilent = saysNoReply(text);
        const shown = stripNoReply(text);
        if (shown && !state.turnSilent) state.turnLastText = shown;
      }
      if (state.groupId) {
        this.runtime.groups?.settle(state.groupId, state.assistantId, text);
        return;
      }
      const streaming = state.streaming;
      state.streaming = undefined;
      // 事件那一轮：文字先攒着，这一轮结束再按条目发，或者整轮收起
      if (state.eventTurn) {
        if (text) state.eventTurn.held.push({ text, ...(streaming ? { itemId: streaming.itemId } : {}) });
        return;
      }
      // NO_REPLY 这个词永远不显示：去掉之后什么都不剩，就当作这一段没说
      const clean = stripNoReply(text);
      if (!clean) {
        if (streaming?.shown) this.bus.emit({ type: "item", assistantId, item: { kind: "assistant", id: streaming.itemId, at: new Date().toISOString(), text: "" } });
        return;
      }
      // pi 在 message_end 之后才把消息写进会话文件，等一拍再按条目发，内容和 id 才和刷新后一致
      setTimeout(() => this.emitSettledAssistant(assistantId, clean, streaming?.itemId), 0);
    }
  }

  /** 一条系统提示：单聊进对话，群会话进群的时间线（发言人是这个成员）。 */
  private async note(state: RouterState, icon: NoteIcon, text: string, detail?: string): Promise<void> {
    if (state.groupId) {
      this.runtime.groups?.note(state.groupId, state.assistantId, text, icon, detail);
      return;
    }
    await this.addItem(state.assistantId, { kind: "note", icon, text, ...(detail ? { detail } : {}) });
  }

  /**
   * 这一轮里有副作用、又没办成的调用：一个工具一行（同一个对象失败多次也只留一行），
   * 原因是工具报错的原文，点开就能看。
   */
  private async flushTurnFailures(state: RouterState): Promise<void> {
    const calls = state.turnCalls;
    state.turnCalls = undefined;
    if (!calls?.size) return;
    for (const { label, error } of calls.values()) await this.note(state, "info", t("「{tool}」执行失败", { tool: label }), error);
  }

  /**
   * 事件那一轮结束：攒着的文字这时才出。最后一段以 NO_REPLY 收尾就不出这一轮的文字，
   * 卡片、文件、图片和工具提示照常（它们在各处已经实时发过了）。
   * 用户中途插话（会话里来了新的用户消息）、或者下一条事件到来时，上一轮也在这里收尾。
   */
  private flushEventTurn(state: RouterState, assistantId: string): void {
    const turn = state.eventTurn;
    state.eventTurn = undefined;
    if (!turn) return;
    const last = turn.held.at(-1);
    if (last && saysNoReply(last.text)) return;
    const visible = turn.held.map((one) => ({ itemId: one.itemId, text: stripNoReply(one.text) })).filter((one) => one.text);
    if (!visible.length) return;
    // pi 在 message_end 之后才把消息写进会话文件，等一拍再按条目发，内容和 id 才和刷新后一致
    setTimeout(() => {
      for (const one of visible) this.emitSettledAssistant(assistantId, one.text, one.itemId);
    }, 0);
  }

  private emitSettledAssistant(assistantId: string, text: string, expectedId?: string): void {
    const list = this.derived(assistantId).result.items.filter((item) => item.kind === "assistant");
    const item = list.find((entry) => entry.id === expectedId) ?? list.filter((entry) => entry.text === text).pop();
    if (item) this.bus.emit({ type: "item", assistantId, item });
    const state = this.routers.get(assistantId);
    if (state) this.touch(state);
  }

  private assistantCount(assistantId: string): number {
    return this.entries(assistantId).filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    ).length;
  }

  private setActivity(state: RouterState, activity: RouterActivity | null): void {
    if (state.activity?.state === activity?.state && state.activity?.label === activity?.label) return;
    state.activity = activity;
    if (state.groupId) this.bus.emit({ type: "group-activity", groupId: state.groupId, speaker: state.assistantId, activity });
    else this.bus.emit({ type: "router-activity", assistantId: state.assistantId, activity });
  }

  /** 一轮开始了：清掉上一轮的“已停”标记和没报完的失败，起看门狗。 */
  private armStall(state: RouterState): void {
    state.stalled = false;
    state.turnError = undefined;
    if (state.running === 1 && !state.session?.isStreaming) this.setActivity(state, { state: "thinking", label: t("正在思考…") });
    this.progress(state);
  }

  /** 这一轮还有动静：重置看门狗。没有事件就说明模型憋住了。 */
  /** 看门狗中断以后，等会话停下来的时间；过了还停不下就丢掉这份会话。测试里调短。 */
  stallReleaseMs = 10_000;

  private stallMs(): number {
    return this.stallOverrideMs ?? this.runtime.settings.settings.work.routerStallMinutes * 60_000;
  }

  private progress(state: RouterState): void {
    state.lastEventAt = Date.now();
    if (state.stallTimer) clearTimeout(state.stallTimer);
    state.stallTimer = undefined;
    // 模型请求和工具调用各自有时限；这里只照看尚未进入会话的准备过程。
    if (state.session?.isStreaming) return;
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
    const stopping = this.abortOrForget(state);
    const assistant = this.store.assistant(state.assistantId);
    await this.note(state, "info", t("{assistant} 无响应，已停止，可重新发送", { assistant: assistant?.name ?? state.assistantId }));
    await stopping;
  }

  /** 空闲 30 分钟释放 Router 内存，下次用再打开会话文件。 */
  private touch(state: RouterState): void {
    if (!state.session) return;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (!state.session || state.session.isStreaming || state.session.isCompacting || state.compactionPromise) {
        this.touch(state);
        return;
      }
      this.close(state);
    }, 30 * 60 * 1000);
    state.idleTimer.unref?.();
  }

  private close(state: RouterState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    state.scriptRevokes?.forEach((revoke) => revoke());
    state.scriptRevokes?.clear();
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

  releaseGroupMemberSessions(assistantId: string, groupIds: string[]): void {
    for (const groupId of groupIds) {
      const state = this.routers.get(this.keyOf(assistantId, groupId));
      if (!state) continue;
      state.releaseAfterTurn = true;
      this.maybeRelease(state);
    }
  }

  /** 助手没了（归档）：关掉它的会话（含它所在的群会话），内存里也不留 —— 它的目录随后会被移进归档。 */
  forget(assistantId: string): void {
    this.itemCache.delete(assistantId);
    for (const [key, state] of [...this.routers]) {
      if (state.assistantId !== assistantId) continue;
      this.close(state);
      this.routers.delete(key);
    }
  }

  /** 关掉一个会话（助手被移出群时用）。 */
  forgetSession(assistantId: string, groupId?: string): void {
    const key = this.keyOf(assistantId, groupId);
    const state = this.routers.get(key);
    if (!state) return;
    this.close(state);
    this.routers.delete(key);
  }

  /** 群归档了：关掉这个群里所有成员的会话。 */
  forgetGroup(groupId: string): void {
    for (const [key, state] of [...this.routers]) {
      if (state.groupId !== groupId) continue;
      this.close(state);
      this.routers.delete(key);
    }
  }

  private maybeRelease(state: RouterState): void {
    if (!state.releaseAfterTurn) return;
    if (state.running > 0 || state.session?.isStreaming || state.session?.isCompacting || state.compactionPromise) return;
    state.releaseAfterTurn = false;
    this.close(state);
  }

  private lastAssistantEntry(state: RouterState): SessionEntry | undefined {
    return state.manager?.getEntries().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  }

  private lastTurnEndedAt(state: RouterState): number | undefined {
    const timestamp = this.lastAssistantEntry(state)?.timestamp;
    if (!timestamp) return undefined;
    const endedAt = Date.parse(timestamp);
    return Number.isFinite(endedAt) ? endedAt : undefined;
  }

  private hasIdleWork(state: RouterState): boolean {
    const active = new Set(["running", "queued", "waiting"]);
    const jobs = this.store.jobs().some((job) => job.groupId === state.groupId && active.has(job.status) && (state.groupId !== undefined || job.assistantId === state.assistantId));
    if (jobs) return true;
    if (!state.groupId && this.store.delegations().some((record) => record.from === state.assistantId && !record.reportedAt && (record.status === "running" || record.status === "waiting"))) return true;
    return this.store.approvals().some((approval) => approval.status === "pending" && (state.groupId ? approval.groupId === state.groupId : approval.assistantId === state.assistantId && !approval.groupId));
  }

  private alreadyCompactedAfterLastTurn(state: RouterState): boolean {
    const assistant = this.lastAssistantEntry(state);
    if (!assistant) return false;
    const assistantAt = Date.parse(assistant.timestamp);
    if (!Number.isFinite(assistantAt)) return false;
    const compaction = state.manager?.getEntries().findLast((entry) => entry.type === "compaction");
    return !!compaction && Date.parse(compaction.timestamp) >= assistantAt;
  }

  private canCompactIdle(state: RouterState, now: number): boolean {
    if (!state.session || state.running > 0 || state.session.isStreaming || state.session.isCompacting || state.compactionPromise) return false;
    const endedAt = state.lastTurnEndedAt ?? this.lastTurnEndedAt(state);
    if (endedAt === undefined || now - endedAt < IDLE_COMPACTION_IDLE_MS || state.compactedTurnAt === endedAt || this.hasIdleWork(state) || this.alreadyCompactedAfterLastTurn(state)) return false;
    const tokens = state.session.getContextUsage()?.tokens;
    return tokens !== null && tokens !== undefined && tokens > IDLE_COMPACTION_TOKEN_THRESHOLD;
  }

  private async compactIfIdle(state: RouterState, now = Date.now()): Promise<void> {
    if (!this.canCompactIdle(state, now)) return;
    const session = state.session!;
    const endedAt = state.lastTurnEndedAt ?? this.lastTurnEndedAt(state);
    const run = (async () => {
      try {
        await session.compact();
        if (endedAt !== undefined) state.compactedTurnAt = endedAt;
      } catch (error) {
        console.error(`闲置会话整理失败：${state.key}`, error);
      }
    })();
    state.compactionPromise = run;
    try {
      await run;
    } finally {
      if (state.compactionPromise === run) state.compactionPromise = undefined;
      this.maybeRelease(state);
      this.touch(state);
    }
  }

  /**
   * 定时检查所有会话。会话空闲 30 分钟就从内存里放掉了，闲置满 6 小时的几乎都不在内存里，
   * 所以按会话文件找：文件够久没动的打开查一次（openSession 里走同一条判定），同一个版本的文件只查一次。
   * 一个一个来：整理要调一次模型，不同时压好几个。
   */
  async compactIdleSessions(now = Date.now()): Promise<void> {
    const sessions: { assistantId: string; groupId?: string }[] = [
      ...this.store.assistants().map((assistant) => ({ assistantId: assistant.id })),
      ...this.store.groups().flatMap((group) => group.members.map((assistantId) => ({ assistantId, groupId: group.id }))),
    ];
    for (const { assistantId, groupId } of sessions) {
      const key = this.keyOf(assistantId, groupId);
      const state = this.routers.get(key);
      if (state?.session) {
        await this.compactIfIdle(state, now);
        continue;
      }
      const file = groupId ? this.store.groupMemberFile(groupId, assistantId) : this.store.routerFile(assistantId);
      const changedAt = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
      if (changedAt === undefined || now - changedAt < IDLE_COMPACTION_IDLE_MS || this.idleChecked.get(key) === changedAt) continue;
      this.idleChecked.set(key, changedAt);
      await this.ensure(assistantId, groupId).catch((error) => console.error(`闲置会话检查失败：${key}`, error));
    }
  }

  private async waitForCompaction(state: RouterState): Promise<void> {
    while (state.compactionPromise) await state.compactionPromise;
  }

  /** 新条目的时间取会话条目自己的时间，和 GET /items 推导出来的一致。 */
  private entryAt(state: RouterState, id: string): string {
    return state.manager?.getEntries().find((entry) => entry.id === id)?.timestamp ?? new Date().toISOString();
  }

  // ---------- 事件与条目 ----------
  /** 这个群还在、这个助手也还在群里：卡片进群的时间线，事件进它的群会话。 */
  private groupFor(assistantId: string, groupId?: string): Group | undefined {
    if (!groupId) return undefined;
    const group = this.store.group(groupId);
    if (!group || !group.members.includes(assistantId)) return undefined;
    return group;
  }

  /**
   * 卡片进对话：在群里就进群的时间线（speaker 是这个助手），否则照旧进单聊。
   * 群已归档、成员已被移出时落回单聊，前端照常能看到，东西不丢。
   */
  async addItem(assistantId: string, item: NewItem, groupId?: string): Promise<Item> {
    const group = this.groupFor(assistantId, groupId);
    let full: Item;
    if (group) {
      full = this.runtime.groups.appendItem(group.id, assistantId, item);
    } else {
      const state = await this.ensure(assistantId);
      const lead = this.derived(assistantId).result.lead;
      const id = state.manager!.appendCustomEntry(ITEM_TYPE, item);
      full = { ...item, ...(lead ? { lead: true } : {}), id, at: this.entryAt(state, id) } as Item;
      this.bus.emit({ type: "item", assistantId, item: full });
    }
    if (full.kind === "file") {
      const page = isInPagesDir(relative(this.runtime.home, resolve(full.path)));
      void this.runtime.knowledge.collect({ origin: "output", path: full.path, assistantId, itemId: full.id, ...(page ? { name: full.name, description: full.meta } : {}) }).catch((error) => console.error("知识库收集失败：", error));
    }
    return full;
  }

  async addCard(assistantId: string, record: CardRecord, groupId?: string): Promise<Item> {
    const card: CardRecord = { ...record, ...(groupId ? { groupId } : {}) };
    this.store.saveCard(card);
    const item = await this.addItem(assistantId, { kind: "card", cardId: card.id }, groupId);
    this.bus.emit({ type: "card", card });
    return item;
  }

  updateCard(record: CardRecord): void {
    this.store.saveCard(record);
    this.bus.emit({ type: "card", card: record });
  }

  private async addPluginCard(assistantId: string, groupId: string | undefined, payload: { pluginId: string; pluginName: string; service: string; callbackTool?: string; card: CardRecord["card"] }): Promise<void> {
    const record: CardRecord = {
      id: newId("c-"),
      owner: { type: "plugin", pluginId: payload.pluginId, assistantId },
      plugin: { service: payload.service, ...(payload.callbackTool ? { callbackTool: payload.callbackTool } : {}), pluginName: payload.pluginName },
      ...(groupId ? { groupId } : {}),
      card: payload.card,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    await this.addCard(assistantId, record, groupId);
  }

  private async addPluginCardError(assistantId: string, groupId: string | undefined, message: string): Promise<void> {
    await this.addItem(assistantId, { kind: "note", icon: "info", text: message }, groupId);
  }

  async updateImage(
    assistantId: string,
    id: string,
    update: { status: "done" | "failed"; path?: string; error?: string },
    groupId?: string,
  ): Promise<void> {
    const group = this.groupFor(assistantId, groupId);
    if (group) {
      const item = this.runtime.groups.updateImageItem(group.id, id, update);
      if (!item) throw new Error(`图片条目不存在：${id}`);
      this.collectGeneratedImage(item, assistantId, update);
      return;
    }
    const state = await this.ensure(assistantId);
    const item = this.derived(assistantId).result.items.find((entry) => entry.id === id && entry.kind === "image");
    if (!item) throw new Error(`图片条目不存在：${id}`);
    state.manager!.appendCustomEntry(ITEM_UPDATE_TYPE, { id, ...update });
    this.bus.emit({ type: "item", assistantId, item: { ...item, ...update } });
    this.collectGeneratedImage(item, assistantId, update);
  }

  private collectGeneratedImage(item: Item, assistantId: string, update: { status: "done" | "failed"; path?: string }): void {
    if (item.kind === "image" && update.status === "done" && update.path) {
      void this.runtime.knowledge.collect({ origin: "output", path: update.path, description: item.prompt, assistantId, itemId: item.id }).catch((error) => console.error("知识库收集失败：", error));
    }
  }

  currentDelegation(assistantId: string, groupId?: string): string | undefined {
    return groupId ? undefined : this.routers.get(assistantId)?.currentDelegationId;
  }

  currentRoutineId(assistantId: string, groupId?: string): string | undefined {
    return this.routers.get(this.keyOf(assistantId, groupId))?.turnRoutine?.id;
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

  async event(assistantId: string, text: string, details?: EventDetails, groupId?: string): Promise<boolean> {
    const group = this.groupFor(assistantId, groupId);
    if (group) {
      // 进它的群会话，并且让 GroupManager 开一轮：它说的话才写得到时间线上；事件正文在真正开轮时再按任务状态取。
      void this.runtime.groups.deliverEvent(group.id, assistantId, () => this.eventText(text, details), "", details?.workDone).catch((error) => console.error("群事件投递失败：", error));
      return true;
    }
    try {
      await this.ensure(assistantId);
      void this.pushEvent(assistantId, text, details).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  /** 任务事件进会话前，检查任务是否已经进入下一轮；旧结果只留一条事实说明。 */
  private eventText(text: string, details?: EventDetails): string {
    const event = details?.job;
    if (!event) return text;
    const job = this.store.job(event.id);
    if (!job) return text;
    // 这里就是事件真正进会话的时候（单聊和群都在开这一轮前取正文）：任务的提问从这一刻起算送到了助手手上
    if (event.kind === "question" && job.status === "waiting" && (job.rounds?.length ?? 0) === event.round) this.runtime.jobs.questionDelivered(job.id);
    const currentRound = job.rounds?.length ?? 0;
    if (currentRound === event.round) {
      if (event.kind === "question" && job.status !== "waiting") return `任务「${job.title}」第 ${event.round + 1} 轮的提问已经处理，当前：${this.jobStatusText(job.status)}。`;
      if (event.kind === "timeout" && job.status !== "running") return `任务「${job.title}」第 ${event.round + 1} 轮现在：${this.jobStatusText(job.status)}。`;
      return text;
    }
    const current = currentRound + 1;
    const kind = event.kind === "question" ? "提问" : event.kind === "timeout" ? "提醒" : "结果";
    return `任务「${job.title}」第 ${event.round + 1} 轮的${kind}已经被第 ${current} 轮取代，第 ${current} 轮现在：${this.jobStatusText(job.status)}。`;
  }

  private jobStatusText(status: JobStatus): string {
    return ({ queued: "排队中", running: "进行中", waiting: "等你回复", done: "已完成", stuck: "受阻", failed: "失败", stopped: "已停止" } as Record<JobStatus, string>)[status];
  }

  /** 把事件放在 Hob 自己的队列里；等会话空闲后才交给 pi，避免引擎队列提前冻结正文。 */
  private async pushEvent(
    assistantId: string,
    text: string,
    details: EventDetails | undefined,
    knowledgeQuery?: string,
  ): Promise<boolean> {
    const state = await this.ensure(assistantId);
    return await new Promise<boolean>((resolve) => {
      const jobId = details?.job?.id;
      const existing = jobId ? state.pendingEvents?.find((event) => event.jobId === jobId) : undefined;
      if (existing) {
        existing.text = text;
        existing.details = details;
        existing.knowledgeQuery = knowledgeQuery;
        existing.waiters.push(resolve);
      } else {
        (state.pendingEvents ??= []).push({ text, details, knowledgeQuery, ...(jobId ? { jobId } : {}), waiters: [resolve] });
        state.running += 1;
      }
      this.drainEvents(state);
    });
  }

  private drainEvents(state: RouterState): void {
    if (state.eventDispatch || state.stopping) return;
    const dispatch = (async () => {
      while (state.pendingEvents?.length && !state.stopping) {
        if (state.session?.isStreaming) {
          await state.session.waitForIdle();
          continue;
        }
        const pending = state.pendingEvents.shift()!;
        const success = await this.pushEventNow(state, pending.text, pending.details, pending.knowledgeQuery).catch((error) => {
          console.error("事件投递失败：", error);
          return false;
        });
        pending.waiters.forEach((resolve) => resolve(success));
      }
    })();
    state.eventDispatch = dispatch;
    void dispatch.finally(() => {
      if (state.eventDispatch === dispatch) state.eventDispatch = undefined;
      if (state.pendingEvents?.length) this.drainEvents(state);
    });
  }

  /** 事件已经轮到发送：此处才生成状态正文和 nowBlock。 */
  private async pushEventNow(
    state: RouterState,
    text: string,
    details: EventDetails | undefined,
    knowledgeQuery?: string,
  ): Promise<boolean> {
    const assistantId = state.assistantId;
    const session = state.session;
    // 会话已经被丢掉（助手归档等）：这条事件没处可送
    if (!session) {
      state.running = Math.max(0, state.running - 1);
      return false;
    }
    try {
      this.touch(state);
      state.turnHadWork = state.turnHadWork || todosBusy(this.runtime, assistantId, state.groupId);
      state.turnWorkDone ||= Boolean(details?.workDone);
      state.turnDelegation ||= Boolean(details?.delegationId);
      this.armStall(state);
      this.publishBusy(state);
      await this.waitForCompaction(state);
      const knowledge = knowledgeQuery === undefined ? "" : await this.automaticKnowledge(state, knowledgeQuery);
      const message = { customType: EVENT_TYPE, content: `${nowBlock(this.runtime, assistantId)}\n\n[hob-event] ${this.eventText(text, details)}${knowledge}`, display: false, details };
      await this.refreshTools(state);
      await this.applyConversationModel(state);
      if (session.isStreaming) {
        // 上面几步等待的空当里用户的话先开了一轮：排在它后面，不插进那一轮中间
        await session.sendCustomMessage(message, { deliverAs: "followUp" });
        await session.waitForIdle();
      } else {
        await session.sendCustomMessage(message, { triggerTurn: true });
      }
      return true;
    } catch (error) {
      await this.fail(state, error);
      return false;
    } finally {
      // 这一轮真结束了（含出错、被停）：攒着没发的文字在这里收尾
      this.flushEventTurn(state, assistantId);
      state.running = Math.max(0, state.running - 1);
      if (!state.running) this.setActivity(state, null);
      this.clearStall(state);
      this.publishBusy(state);
      this.maybeRelease(state);
      this.finishTurn(state);
      this.touch(state);
    }
  }
  async delegationResult(assistantId: string, id: string, text: string): Promise<boolean> {
    const state = await this.ensure(assistantId);
    const received = () => state.manager!.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === EVENT_TYPE && (entry.details as EventDetails | undefined)?.returnedDelegationId === id);
    if (received()) return true;
    const success = await this.pushEvent(assistantId, text, { returnedDelegationId: id, workDone: true });
    return success && received();
  }

  /** 将主助手交来的话题的结论送进它的对话；会话条目是去重依据。 */
  async handoverResult(assistantId: string, topicId: string, text: string): Promise<boolean> {
    const state = await this.ensure(assistantId);
    const received = () => state.manager!.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === EVENT_TYPE && (entry.details as EventDetails | undefined)?.handoverTopicId === topicId);
    if (received()) return true;
    const success = await this.pushEvent(assistantId, text, { handoverTopicId: topicId, workDone: true });
    return success && received();
  }

  /** 这一轮的状态由调用方在真正收尾时判断；任务、转交和提问仍在时不发完成通知 */
  private finishTurn(state: RouterState): void {
    if (state.running > 0) return;
    const error = state.turnFailure;
    const busy = todosBusy(this.runtime, state.assistantId, state.groupId);
    if (!error && !busy) releaseIdleTodos(this.runtime, state.assistantId, state.groupId);
    // 收到了用户的消息、这一轮回了 NO_REPLY、自己也没点表情：替它挂 👀，用户看得出消息到了
    if (!state.groupId && state.turnSilent && state.turnUserItem && !this.store.state(state.assistantId).reactions?.[state.turnUserItem]?.[state.assistantId]) {
      this.react(state.assistantId, "👀", state.turnUserItem);
    }
    const reactedOnly = Boolean(state.turnReacted && !state.turnLastText);
    const silent = Boolean(state.turnSilent || reactedOnly);
    if ((state.turnHadWork || state.turnWorkDone || error) && !state.turnDelegation && !busy && (error || !silent)) {
      pushAssistantTurnEnd(
        { push: this.runtime.push, store: this.store },
        {
          assistantId: state.assistantId,
          ...(state.groupId ? { groupId: state.groupId } : {}),
          ...(error ? { error } : { text: state.turnLastText }),
        },
      );
    }
    void this.runtime.jobs.finishUnansweredQuestions(state.assistantId, state.groupId).catch((error) => console.error("收尾任务提问失败：", error));
    if (!state.groupId && !error && !busy && !state.stalled && !silent && state.turnLastText && !this.hasIdleWork(state)) {
      void this.generateSuggestionsFor(state.assistantId);
    }
    state.turnHadWork = false;
    state.turnWorkDone = false;
    state.turnDelegation = false;
    state.turnFailure = undefined;
    state.turnSilent = undefined;
    state.turnReacted = undefined;
    state.turnUserItem = undefined;
    state.turnLastText = undefined;
  }

  /** 同一模型回合内，判断 check_job 是否只是重复查看同一状态。 */
  checkJobUnchanged(assistantId: string, groupId: string | undefined, jobId: string, job: Job, steps: JobStep[]): boolean {
    const state = this.routers.get(this.keyOf(assistantId, groupId));
    if (!state) return false;
    const snapshot = JSON.stringify({
      status: job.status,
      statusReason: job.statusReason,
      steps: steps.map((step) => step.id),
    });
    const previous = state.checkJobSnapshots?.get(jobId);
    (state.checkJobSnapshots ??= new Map()).set(jobId, snapshot);
    return previous === snapshot;
  }

  /** 忙闲变了告诉前端（“正在想”要看它）。 */
  private publishBusy(state: RouterState): void {
    if (state.groupId) {
      this.runtime.groups?.publish(state.groupId);
      return;
    }
    const assistant = this.store.assistant(state.assistantId);
    if (assistant) this.bus.emit({ type: "assistant", assistant: this.summary(assistant) });
  }

  /**
   * 模型调用失败、连重试也放弃了：这一轮收尾时留一行给用户看（群里写在那位成员说话的位置），
   * 下一轮模型也知道上一轮没有回出去。用户按了停止、看门狗停下的不算：那时已经说过一句。
   */
  private async reportTurnFailure(state: RouterState): Promise<void> {
    const error = state.turnError;
    state.turnError = undefined;
    if (!error || state.stalled) return;
    const text = t("未能回复：模型调用失败（{error}）。可重新发送。", { error: briefModelError(error) });
    await this.note(state, "info", text);
    // 单聊里这一行是卡片，不进模型上下文：另记一句，下一轮它知道上一轮没有回出去。群里那行本来就在时间线上
    if (!state.groupId) await this.remember(state.assistantId, text).catch(() => undefined);
  }

  private async fail(state: RouterState, error: unknown): Promise<void> {
    if (state.stalled) return;
    const message = error instanceof Error ? error.message : String(error);
    await this.note(state, "info", t("发生错误：{error}", { error: message }));
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
    this.clearSuggestions(assistantId);
    this.runtime.delegations.takeOver(assistantId);
    for (const approval of this.store.approvals()) {
      if (approval.assistantId !== assistantId || approval.groupId || approval.source !== "router" || approval.status !== "pending") continue;
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
    // 模型收到这条时记下来：你的消息下面挂 👀，看得出到了
    const received = () => { state.turnUserItem = id; };
    void this.deliver(state, basePrompt, { ...(body.files?.length ? { files: body.files } : {}), knowledgeQuery: body.text, received });
    return item;
  }

  /** 群会话里的一轮：GroupManager 按时间线拼好输入，走同一条发消息路径（排队、看门狗、忙闲）。 */
  /**
   * 记进助手的会话但不开一轮：正在回复就等这一轮说完再记。
   * 用户在任务卡上直接对任务说的话走这里，之后任务来问、交结果时助手知道用户说过什么。
   */
  async remember(assistantId: string, text: string, groupId?: string): Promise<void> {
    const gid = this.groupFor(assistantId, groupId)?.id;
    const state = await this.ensure(assistantId, gid);
    await this.waitForCompaction(state);
    await state.session!.sendCustomMessage({ customType: CONTEXT_TYPE, content: `${nowBlock(this.runtime, assistantId, gid)}\n\n[hob-event] ${text}`, display: false }, { triggerTurn: false });
  }

  async deliverMember(groupId: string, assistantId: string, text: string, received?: () => void, files: string[] = [], workDone = false): Promise<void> {
    const state = await this.ensure(assistantId, groupId);
    await this.deliver(state, text, { received, files, workDone });
  }

  /**
   * 用户在这个群里又说话了，而这个成员正在这个群里说一轮：用 steer 插进那一轮（和单聊一样）。
   * 会话这时没在流式（刚好跑完、还没开始）→ 返回 false，由调用方照原来的路子排队。
   */
  private onUserReceived(state: RouterState, text: string, received?: () => void): () => void {
    if (!received) return () => {};
    const unsubscribe = state.session!.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "user" && messageText(event.message.content) === text.trim()) {
        unsubscribe();
        queueMicrotask(received);
      } else if (event.type === "agent_end") unsubscribe();
    });
    return unsubscribe;
  }

  async steerMember(groupId: string, assistantId: string, text: string, files: string[] = [], received?: () => void): Promise<boolean> {
    const state = this.routers.get(this.keyOf(assistantId, groupId));
    if (!state?.session?.isStreaming) return false;
    const images = state.session.model?.input.includes("image") ? imageContents(files) : [];
    const unsubscribe = this.onUserReceived(state, text, received);
    try { await state.session.steer(text, images.length ? images : undefined); }
    catch (error) { unsubscribe(); throw error; }
    return true;
  }

  /**
   * 把一段话送进这个会话（单聊和群共用）：同一会话里的话排队，前一段送出去才轮到下一段；
   * 正在流式回复时用 steer 插进去。这一轮跑完才返回。
   */
  private async deliver(
    state: RouterState,
    text: string,
    options: { files?: string[]; knowledgeQuery?: string; received?: () => void; workDone?: boolean } = {},
  ): Promise<void> {
    this.clearSuggestions(state.assistantId, state.groupId);
    const previousDelivery = state.pendingDelivery;
    let releaseDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    state.pendingDelivery = delivery;

    this.touch(state);
    state.running += 1;
    state.turnHadWork = state.turnHadWork || todosBusy(this.runtime, state.assistantId, state.groupId);
    // 用户发来的话（单聊、群里成员接话）这一轮也算在办事：答完、手上没别的活就通知
    state.turnWorkDone ||= options.workDone ?? true;
    state.turnLastText = undefined;
    state.turnFailure = undefined;
    this.armStall(state);
    this.publishBusy(state);
    let unsubscribeReceived = () => {};
    let queued = false;
    try {
      const promptText = options.knowledgeQuery === undefined ? text : text + await this.automaticKnowledge(state, options.knowledgeQuery);
      await previousDelivery;
      await this.waitForCompaction(state);
      await this.applyConversationModel(state);
      await this.refreshTools(state);
      // 对话模型能看图就把图片直接给它（路径照样写在「附件」里，派任务时还能交出去）；看不了图就只有路径
      const images = options.files?.length && state.session!.model?.input.includes("image") ? imageContents(options.files) : [];
      unsubscribeReceived = this.onUserReceived(state, promptText, options.received);
      if (state.session!.isStreaming) {
        await state.session!.steer(promptText, images.length ? images : undefined);
        queued = true;
        releaseDelivery();
      } else {
        await state.session!.prompt(promptText, { ...(images.length ? { images } : {}), preflightResult: releaseDelivery });
      }
    } catch (error) {
      await this.fail(state, error);
    } finally {
      if (!queued) unsubscribeReceived();
      releaseDelivery();
      if (state.pendingDelivery === delivery) state.pendingDelivery = undefined;
      state.running = Math.max(0, state.running - 1);
      if (!state.running) this.setActivity(state, null);
      this.clearStall(state);
      this.publishBusy(state);
      this.maybeRelease(state);
      this.finishTurn(state);
      this.touch(state);
    }
  }

  async stop(assistantId: string, groupId?: string): Promise<void> {
    const state = this.routers.get(this.keyOf(assistantId, groupId));
    if (state) {
      state.stalled = true;
      this.setActivity(state, null);
    }
    if (state) await this.abortOrForget(state);
  }

  /**
   * 停下这一轮。中断收不了尾（请求挂死）时，这份会话会一直算「还在跑」，之后的消息全排在它后面、永远没人回：
   * 等一小会儿还没停下，就把它从内存里丢掉，下一条消息从会话文件重新打开（对话都在文件里）。
   * 挂着的那次调用以后要是收尾，只会动到丢掉的这份状态，不影响新会话。
   */
  private async abortOrForget(state: RouterState): Promise<void> {
    const session = state.session;
    if (!session) return;
    // 判断停没停下来之前，排着的事件先不送：不然刚停下它们就开了新的一轮，看起来像没停住
    state.stopping = (state.stopping ?? 0) + 1;
    try {
      const aborted = session.abort().catch(() => undefined);
      await Promise.race([aborted, new Promise((resolve) => setTimeout(resolve, this.stallReleaseMs).unref?.())]);
      if (this.routers.get(state.key) !== state || state.session !== session) return;
      // 排着没送的事件也记在 running 里，它们不算没停下来
      if (state.running === (state.pendingEvents?.length ?? 0) && !session.isStreaming) return;
      state.turnHadWork = false;
      state.turnWorkDone = false;
      const pending = state.pendingEvents?.splice(0) ?? [];
      this.forgetSession(state.assistantId, state.groupId);
      this.publishBusy(state);
      // 排着的事件（多半是任务的结果）换到重新打开的会话里送，不跟这份会话一起丢
      for (const event of pending) {
        const settle = (success: boolean) => event.waiters.forEach((resolve) => resolve(success));
        void this.pushEvent(state.assistantId, event.text, event.details, event.knowledgeQuery).then(settle, () => settle(false));
      }
    } finally {
      state.stopping -= 1;
      if (!state.stopping) this.drainEvents(state);
    }
  }

  isBusy(assistantId: string, groupId?: string): boolean {
    const state = this.routers.get(this.keyOf(assistantId, groupId));
    // 只看助手自己在不在回复：任务不阻塞对话，任务的进度在任务卡上，不再算进来（不然任务跑多久「…」就挂多久）
    return (state?.running ?? 0) > 0 || (state?.session?.isStreaming ?? false);
  }

  /** 这个群里正在说话的成员（左栏小橙点、群状态行用）。 */
  busyMembers(groupId: string): string[] {
    const busy: string[] = [];
    for (const state of this.routers.values()) {
      if (state.groupId !== groupId) continue;
      if ((state.running ?? 0) > 0 || state.session?.isStreaming) busy.push(state.assistantId);
    }
    return busy;
  }

  /** 这个群里正在说话的成员各自在做什么（页面刚打开时补上「正在思考」）。 */
  groupActivity(groupId: string): Record<string, RouterActivity> {
    const activity: Record<string, RouterActivity> = {};
    for (const state of this.routers.values()) if (state.groupId === groupId && state.activity) activity[state.assistantId] = state.activity;
    return activity;
  }

  /** 等到这个助手没有在跑的回复，并且会话条目已经落定（测试和冒烟用）。 */
  async waitIdle(assistantId: string, timeoutMs = 15_000, groupId?: string): Promise<void> {
    const started = Date.now();
    let stable = 0;
    let lastCount = -1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    while (Date.now() - started < timeoutMs) {
      const state = this.routers.get(this.keyOf(assistantId, groupId));
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

  /**
   * 这个会话的实际消息记录（单聊或群里的那一份）：数轮次用。
   * 会话开着就取内存里的，没开就读文件；读不到就是空的。
   */
  sessionEntries(assistantId: string, groupId?: string): SessionEntry[] {
    const state = this.routers.get(this.keyOf(assistantId, groupId));
    if (state?.manager) return state.manager.getEntries();
    try {
      return readEntries(groupId ? this.store.groupMemberFile(groupId, assistantId) : this.store.routerFile(assistantId));
    } catch {
      return [];
    }
  }

  /** 单聊里用户和助手说过的可见消息；卡片、工具调用和系统事件已排除。 */
  messageHistory(assistantId: string): Array<Extract<Item, { kind: "user" | "assistant" }>> {
    return this.derived(assistantId).result.items.filter((item): item is Extract<Item, { kind: "user" | "assistant" }> => item.kind === "user" || item.kind === "assistant");
  }

  /** 给单聊里最新的一条用户消息（或指定的那条）点表情回应；再点会换掉。 */
  react(assistantId: string, emoji: string, itemId?: string): { ok: true; itemId: string } | { ok: false; error: string } {
    this.assistant(assistantId);
    const target = this.derived(assistantId).result.items.findLast((item) => item.kind === "user" && (!itemId || item.id === itemId));
    if (!target || target.kind !== "user") return { ok: false, error: "对话里还没有用户的消息，无法添加表情回应。" };
    const all = this.store.state(assistantId).reactions ?? {};
    const forItem = { ...(all[target.id] ?? {}), [assistantId]: emoji };
    this.store.saveState(assistantId, { reactions: { ...all, [target.id]: forItem } });
    const reactions = reactionsList(forItem);
    this.bus.emit({ type: "item", assistantId, item: { ...target, ...(reactions ? { reactions } : {}) } });
    return { ok: true, itemId: target.id };
  }

  items(assistantId: string, options: { before?: string; limit?: number } = {}): ItemsPage {
    const derived = this.derived(assistantId);
    const all = derived.result.items;
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const end = options.before ? derived.positions.get(options.before) ?? all.length : all.length;
    const start = Math.max(0, end - limit);
    const storedReactions = this.store.state(assistantId).reactions;
    const page = all.slice(start, end).map((item) => {
      if (item.kind !== "user") return item;
      const reactions = reactionsList(storedReactions?.[item.id]);
      return reactions ? { ...item, reactions } : item;
    });
    const jobIds = new Set(page.filter((item) => item.kind === "job").map((item) => (item as { jobId: string }).jobId));
    const draftIds = new Set(
      page.filter((item) => item.kind === "draft").map((item) => (item as { draftId: string }).draftId),
    );
    const approvalIds = new Set(
      page.filter((item) => item.kind === "question").map((item) => (item as { approvalId: string }).approvalId),
    );
    const cardIds = new Set(
      page.filter((item) => item.kind === "card").map((item) => (item as { cardId: string }).cardId),
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
      cards: this.store.cards().filter((card) => cardIds.has(card.id)),
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

  private suggestionKey(assistantId: string, groupId?: string): string {
    return groupId ? `group:${groupId}` : assistantId;
  }

  suggestionsFor(assistantId: string, groupId?: string): string[] | undefined {
    return this.suggestions.get(this.suggestionKey(assistantId, groupId));
  }

  clearSuggestions(assistantId: string, groupId?: string): void {
    const key = this.suggestionKey(assistantId, groupId);
    this.suggestionEpoch.set(key, (this.suggestionEpoch.get(key) ?? 0) + 1);
    const had = this.suggestions.delete(key);
    if (!had) return;
    if (groupId) this.runtime.groups?.publish(groupId);
    else {
      const assistant = this.store.assistant(assistantId);
      if (assistant) this.bus.emit({ type: "assistant", assistant: this.summary(assistant) });
    }
  }

  /** 在一轮真正停下后后台生成推荐提问；结果只接受当前这一轮。 */
  async generateSuggestionsFor(assistantId: string, groupId?: string): Promise<void> {
    const key = this.suggestionKey(assistantId, groupId);
    const epoch = this.suggestionEpoch.get(key) ?? 0;
    const assistant = this.store.assistant(assistantId);
    if (!assistant) return;
    try {
      await this.runtime.models.get();
      const group = groupId ? this.store.group(groupId) : undefined;
      const effective = assistantInGroup(assistant, group, this.runtime.models, this.runtime.settings.settings.models);
      const pick = followUpPick(this.runtime.settings.settings.models, effective, this.runtime.models);
      if (!pick) return;
      const model = await this.runtime.pi.model(pick.ref);
      const turns = groupId
        ? groupHistory(this.store.groupItems(groupId), (speaker) => speaker === "user" ? "用户" : this.store.assistant(speaker)?.name ?? speaker)
        : routerHistory(this.entries(assistantId));
      const suggestions = await generateFollowUpSuggestions(await this.runtime.pi.runtime(), model, turns);
      if ((this.suggestionEpoch.get(key) ?? 0) !== epoch || !suggestions.length) return;
      const state = this.routers.get(this.keyOf(assistantId, groupId));
      if (state && (state.running > 0 || state.session?.isStreaming || this.hasIdleWork(state))) return;
      this.suggestions.set(key, suggestions);
      if (groupId) this.runtime.groups?.publish(groupId);
      else this.bus.emit({ type: "assistant", assistant: this.summary(assistant) });
    } catch (error) {
      console.error("推荐提问准备失败：", error instanceof Error ? error.message : String(error));
    }
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
      todos: readTodos(assistantTodosPath(this.runtime.home, assistant.id)),
      ...(this.suggestionsFor(assistant.id)?.length ? { suggestions: this.suggestionsFor(assistant.id) } : {}),
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
    const update = this.runtime.update.status();
    return {
      assistants: this.store.assistants().map((assistant) => this.summary(assistant)),
      jobs: this.store
        .jobs()
        .filter((job) => job.status === "running" || job.status === "queued" || job.status === "waiting" || (job.endedAt ?? job.createdAt) > jobCutoff),
      routines: this.store.routines(),
      approvals: this.store.approvals().filter((approval) => approval.status === "pending" && approval.source !== "job"),
      delegations: this.store.delegations(),
      settings: this.runtime.settings.get(),
      ...(update ? { update } : {}),
    };
  }

  /** 进程退出或测试收尾：释放所有 Router 会话。 */
  disposeAll(): void {
    if (this.idleCompactionTimer) clearInterval(this.idleCompactionTimer);
    this.idleCompactionTimer = undefined;
    for (const state of this.routers.values()) this.close(state);
    this.routers.clear();
    this.itemCache.clear();
  }

  /** 直接走事件的 followUp 队列，实际收到这条消息时才开始关联任务。 */
  /** 把事件当作转交的一轮送给目标助手；这一轮没正常收尾就把转交记为受阻，不会一直挂着。 */
  async relay(targetAssistantId: string, text: string, delegationId: string, details?: EventDetails, knowledgeQuery?: string): Promise<boolean> {
    const success = await this.pushEvent(targetAssistantId, text, { ...details, delegationId }, knowledgeQuery);
    if (!success || !this.store.delegation(delegationId)?.turnFinished) {
      this.runtime.delegations.turnEnded(delegationId, "目标助手处理失败或转交被中断", true);
    }
    return success;
  }

  /** 审批答案回到 Router（router 来源的审批，答案作为事件进入上下文；群里提的问题回群会话）。 */
  async answerEvent(assistantId: string, text: string, groupId?: string): Promise<void> {
    await this.event(assistantId, text, undefined, groupId);
  }
}
