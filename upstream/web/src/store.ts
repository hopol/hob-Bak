// 一个小的外部 store：bootstrap + 当前对话 + jobs/approvals/drafts 按 id 存，SSE 事件合并进来。
import { parseRoute, type SettingsSection } from "./route.ts";
import { useSyncExternalStore } from "react";
import type {
  AnswerApprovalBody,
  Approval,
  Assistant,
  AssistantSummary,
  Bootstrap,
  ClaudeCodeSettings,
  Delegation,
  Draft,
  FileMeta,
  Group,
  GroupItem,
  GroupItemsPage,
  GroupProfile,
  GroupSummary,
  HobEvent,
  JobFilesView,
  ImageKeyView,
  ImageSettings,
  ImageTestResult,
  Item,
  Job,
  JobsPage,
  JobStatus,
  JobStep,
  LoreImportView,
  ModelsView,
  MemoryConfig,
  MemoryProvider,
  PageLive,
  ModelThinkingView,
  Profile,
  Project,
  ProviderImportView,
  ProvidersView,
  PushView,
  Routine,
  RouterActivity,
  Rule,
  SendMessageBody,
  Settings,
  SettingsFile,
  SettingsPatch,
  ThinkingLevelMapSetting,
  TokenPrice,
  UsageModelPrice,
  UsageView,
  WorkflowId,
} from "../../shared/types.ts";
import type { AssistantSkill } from "../../shared/skills.ts";
import type { KnowledgeCollection, KnowledgeEntry, KnowledgeGroup } from "../../shared/knowledge.ts";
import { defaultSearch, type SearchProviderName, type SearchSettings } from "../../shared/search.ts";
import { ApiError, realApi, type HobApi } from "./api.ts";
import { applyDelta, mergeItems } from "./merge.ts";
import { shouldOpenLive } from "./page-live.ts";
import { clearFresh, flashItem, markFresh } from "./motion.ts";
import { isSentAs, localPath, pendingItem, type Attachment, type PendingMessage } from "./outbox.ts";
import { isImagePath } from "../../shared/media.ts";
import { createMock, SCENE_UI, type SceneId } from "./mock.ts";
import { currentSubscription, deviceLabel, subscribePush } from "./push.ts";
import { mergeStep, mergeSteps } from "./steps.ts";
import { resolveTheme, updateStatusColor } from "./theme.ts";
import { popPage, pushPage, removeMissingLivePages, replacePage, selectPanelStack, type PanelPage } from "./panel-stack.ts";
export type { FilePreviewState, PanelPage } from "./panel-stack.ts";

export type Theme = "system" | "light" | "dark";
export type PanelState =
  | { kind: "now" }
  | { kind: "routine"; id: string }
  | { kind: "newRoutine" } // 还没创建的定时任务：填好名称和任务内容才真正创建
  | { kind: "assistant" }
  | { kind: "routines" | "skills" | "knowledge" | "rules" }
  | { kind: "project"; groupId: string; id: string }; // 演示场景里直接打开某个事项页
export interface WorklogState {
  jobs: Job[];
  assistantId: string | null;
  status: JobStatus | null;
  hasMore: boolean;
  loading: boolean;
}
export type MobilePage = "list" | "topics" | "chat";
export type { SettingsSection } from "./route.ts";

/** 设置分栏下的一层：手机标题栏显示 title，返回回到分栏。 */
export type SettingsSub =
  | { kind: "model"; ref: string; title: string }
  | { kind: "addModels"; title: string }
  | { kind: "provider"; id: string; title: string }
  | { kind: "addProvider"; title: string }
  | { kind: "importProviders"; title: string }
  | { kind: "skill"; key: string; title: string }
  | { kind: "importSkills"; title: string }
  | { kind: "mcpServer"; name: string; title: string }
  | { kind: "addMcp"; title: string }
  | { kind: "importMcp"; title: string }
  | { kind: "searchProvider"; name: SearchProviderName; title: string };

const EMPTY_SETTINGS: Settings = {
  general: { theme: "system", timezone: "UTC", aboutYou: { name: "", language: "", notes: "" } },
  providers: [],
  models: {
    roster: [],
    conversation: { ref: "", thinking: "low" },
    work: { ref: "", thinking: "high" },
  },
  image: { source: "off" },
  search: defaultSearch(),
  work: { maxJobs: 2, jobStallMinutes: 15, routerStallMinutes: 6 },
  push: { email: "" },
};

export interface SidebarPage<T> { items: T[]; loaded: boolean; loading: boolean; loadingMore: boolean; hasMore: boolean; error: string | null; failedMore?: boolean; cursor?: string }

/**
 * 群的置顶、位置和展开状态：Group 契约里没有这几个字段（服务端管不上），先记在本地。
 * 位置和助手的 pinOrder 用同一条数轴，群和助手才能混在一起排序。
 */
export interface GroupPrefs {
  pinned: boolean;
  pinOrder?: number;
}

export interface State {
  phase: "loading" | "login" | "ready" | "error";
  error: string | null; // 致命错误（无法连接后端）
  notice: string | null; // 一次性的操作失败提示
  offline: string | null; // 实时连接断开
  assistants: AssistantSummary[];
  groups: GroupSummary[];
  groupPrefs: Record<string, GroupPrefs>;
  groupItems: Record<string, GroupItem[]>;
  projects: Record<string, Project[]>; // 群 id → 事项，新的在前
  projectsError: Record<string, string | null>;
  groupGen: Record<string, number>; // 重新拉这个群的整条时间线 +1
  groupPages: Record<string, { hasMore: boolean; loading: boolean; error: string | null }>;
  groupActivity: Record<string, Record<string, RouterActivity>>; // 群 id → 正在说话的成员 → 当前活动
  jobs: Record<string, Job>;
  delegations: Record<string, Delegation>;
  routines: Routine[];
  approvals: Record<string, Approval>;
  drafts: Record<string, Draft>;
  settings: SettingsFile;
  globalRules: { rules: Rule[] | null; error: string | null; busy: boolean };
  page: "main" | "settings" | "knowledge";
  knowledge: { category: string; q: string; kind: KnowledgeGroup | ""; assistantId: string; entries: (KnowledgeEntry & { snippet?: string })[]; collections: KnowledgeCollection[]; collectionsLoaded: boolean; hasMore: boolean; loading: boolean; error: string | null };
  section: SettingsSection | null; // 设置页当前分栏；null = 手机上的列表（桌面当通用看）
  sub: SettingsSub | null; // 分栏里再进一层（模型详情、添加模型）；null = 分栏本身
  items: Record<string, Item[]>;
  itemGen: Record<string, number>; // 每次重新拉这段对话 +1，聊天区据此判断“整批换了”而不是“新到一条”
  itemPages: Record<string, { hasMore: boolean; loading: boolean; error: string | null }>;
  groupProfiles: Record<string, { value?: GroupProfile; error?: string }>;
  profiles: Record<string, Profile>;
  assistantSkills: Record<string, { skills: AssistantSkill[]; loaded: boolean; loading: boolean; error: string | null }>;
  sidebarJobs: Record<string, SidebarPage<Job>>;
  sidebarFiles: Record<string, SidebarPage<KnowledgeEntry>>;
  sel: string | null;
  gsel: string | null; // 选中的群；和 sel 互斥（群和助手分开选中）
  /** 桌面左栏在首页列表：选中群时左栏换成这个群的二级页，点返回又回到首页 */
  sideHome: boolean;
  panelStack: PanelPage[];
  viewer: { path: string; name: string } | null; // 全屏看图
  livePages: Record<string, PageLive>;
  steps: Record<string, JobStep[]>; // 打开了详情的任务才有过程
  worklog: WorklogState | null;
  collapsed: boolean;
  nowWide: boolean; // 右栏「正在做」展开成宽栏：大屏桌面 + 完整日志
  theme: Theme;
  query: string;
  quote: { itemId: string; text: string } | null;
  text: string;
  attachments: Attachment[]; // 输入框里待发的附件（选了就出现，后台在传）
  pending: Record<string, PendingMessage[]>; // 发件箱：点了发送还没被服务端那条顶替的消息
  nonce: number; // 让输入框重新聚焦／重新量高度
  mobile: MobilePage;
  sheet: boolean; // 手机上右栏内容的全屏页
  search: boolean; // 手机上的搜索框
  menu: { id: string; x: number; y: number } | null; // 助手右键 / 长按菜单（视口坐标）
  tick: number; // 定时刷新“进行中 · N 分钟”
  updateReady: boolean; // 新版本装好了，等用户点「刷新」
  loggingIn: boolean;
}

const params = new URLSearchParams(location.search);
export const MOCK = params.get("mock") === "1";
const SCENES: SceneId[] = ["g-owns", "g-owns-dark", "readme-chat", "readme-cards", "readme-desktop", "readme-knowledge", "readme-profile", "readme-group-now", "readme-mobile-list", "readme-mobile-chat", "readme-mobile-project", "image", "act-demo", "act-think", "act-tool", "act-dark", "act-home", "boot", "bubbles", "bubbles-dark", "card-130", "card-130-dark", "job-after", "job-after-dark", "routine-check-dark", "routine-once", "routine-once-dark", "routine-once-list", "ask-rounds", "ask-rounds-answered", "ask-rounds-group", "ask-rounds-dark", "ask-rounds-mobile", "s1", "s2", "s3", "s4", "s6", "mlist", "mchat", "d-running", "d-waiting", "d-done", "d-dark", "d-source", "d-mobile", "h-hob", "h-dark", "h-source", "h-settings", "h-mobile", "g-chat", "g-mention", "g-mobile", "g-dark", "g-team", "p-clarify", "p-plan", "p-doing", "p-card", "p-check", "p-done", "p-dropped", "p-dark", "p-mobile", "topics", "topics-plain"];
const sceneParam = params.get("scene") as SceneId | null;
const scene: SceneId = sceneParam && SCENES.includes(sceneParam) ? sceneParam : "s1";
const api: HobApi = MOCK ? createMock(scene) : realApi;
const THEME_KEY = "hob.theme";
/** 这台页面客户端的标识：上报可见性；SSE 断了服务端就把这台当不可见。 */
const CLIENT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let watchingVisibility = false;

function parsePanel(raw: string): PanelState {
  if (raw === "assistant" || raw === "now" || raw === "routines" || raw === "skills" || raw === "knowledge" || raw === "rules" || raw === "newRoutine") return { kind: raw };
  if (raw.startsWith("routine:")) return { kind: "routine", id: raw.slice("routine:".length) };
  if (raw.startsWith("project:")) {
    const [groupId, id] = raw.slice("project:".length).split("/");
    return { kind: "project", groupId: groupId ?? "", id: id ?? "" };
  }
  return { kind: "now" };
}

function storedTheme(): Theme | null {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : null;
}

const GROUP_PREFS_KEY = "hob.groups.local";

/** 本地记的群设置；坏了就当没有，不影响打开界面。 */
function loadGroupPrefs(): Record<string, GroupPrefs> {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUP_PREFS_KEY) ?? "{}") as Record<string, Partial<GroupPrefs>>;
    const out: Record<string, GroupPrefs> = {};
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      out[id] = {
        pinned: Boolean(value.pinned),
        ...(typeof value.pinOrder === "number" ? { pinOrder: value.pinOrder } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function saveGroupPrefs(prefs: Record<string, GroupPrefs>) {
  localStorage.setItem(GROUP_PREFS_KEY, JSON.stringify(prefs));
}

const themeFromUrl = params.get("dark") === "1";

/** 打开页面时地址里的 hash；读一次，后面 history 会改写地址。 */
const bootRoute = parseRoute(location.hash);

function initial(): State {
  const ui = SCENE_UI[MOCK ? scene : "s1"];
  const state: State = {
    phase: "loading",
    error: null,
    notice: null,
    offline: null,
    assistants: [],
    groups: [],
    groupPrefs: loadGroupPrefs(),
    groupItems: {},
    projects: {},
    projectsError: {},    groupGen: {},
    groupPages: {},
    groupActivity: {},
    jobs: {},
    delegations: {},
    routines: [],
    approvals: {},
    drafts: {},
    settings: { revision: 0, settings: EMPTY_SETTINGS },
    globalRules: { rules: null, error: null, busy: false },
    page: "main",
    knowledge: { category: "all", q: "", kind: "", assistantId: "", entries: [], collections: [], collectionsLoaded: false, hasMore: false, loading: false, error: null },
    section: null,
    sub: null,
    items: {},
    itemGen: {},
    itemPages: {},
    profiles: {},
    groupProfiles: {},
    assistantSkills: {},
    sidebarJobs: {},
    sidebarFiles: {},
    sel: null, // 没选中对话就是首页
    gsel: null,
    sideHome: true,
    panelStack: [],
    viewer: null,
    livePages: {},
    steps: {},
    worklog: null,
    collapsed: false,
    nowWide: false,
    theme: storedTheme() ?? "system",
    query: "",
    quote: null,
    text: "",
    attachments: [],
    pending: {},
    nonce: 0,
    mobile: "list",
    sheet: false,
    search: false,
    menu: null,
    tick: 0,
    updateReady: false,
    loggingIn: false,
  };
  if (MOCK) {
    state.sel = ui.gsel ? null : ui.sel;
    state.gsel = ui.gsel ?? null;
    state.sideHome = !ui.gsel;
    const panel = parsePanel(ui.panel);
    state.panelStack = panel.kind === "now" ? [] : [panel];
    state.collapsed = ui.collapsed;
    state.mobile = ui.mobile;
    state.theme = ui.dark ? "dark" : "light";
    if (ui.text) state.text = ui.text;
  }
  const aParam = params.get("a");
  if (aParam) state.sel = aParam;
  if (bootRoute.group) {
    state.gsel = bootRoute.group;
    state.sel = null;
    state.sideHome = false;
  }
  if (bootRoute.sel) state.sel = bootRoute.sel;
  if (bootRoute.panel) state.panelStack = [bootRoute.panel];
  if (bootRoute.knowledge) state.page = "knowledge";
  if (bootRoute.settings) {
    state.page = "settings";
    state.section = bootRoute.section;
  }
  const pParam = params.get("panel");
  if (pParam) { const panel = parsePanel(pParam); state.panelStack = panel.kind === "now" ? [] : [panel]; }
  if (params.get("collapsed") === "1") state.collapsed = true;
  if (themeFromUrl) state.theme = "dark";
  return state;
}

let state: State = initial();

/** 启动时要不要直接进对话页：手机默认停在列表，只有 URL/场景指定了才进对话。 */
function mobileWantsChat(): boolean {
  if (bootRoute.sel) return true;
  if (MOCK) return SCENE_UI[scene].mobile === "chat";
  return !!params.get("a") || window.innerWidth >= 768;
}
let themeExplicit = MOCK || themeFromUrl || storedTheme() !== null;
const listeners = new Set<() => void>();

function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  listeners.forEach((l) => l());
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getState = () => state;
export function useApp(): State {
  return useSyncExternalStore(subscribe, getState, getState);
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function index<T extends { id: string }>(list: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const x of list) out[x.id] = x;
  return out;
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const models = patch.models ?? {};
  return {
    ...base,
    ...(patch.skills ? { skills: patch.skills } : {}),
    general: {
      ...base.general,
      ...(patch.general ?? {}),
      aboutYou: { ...base.general.aboutYou, ...(patch.general?.aboutYou ?? {}) },
    },
    models: {
      roster: models.roster ?? base.models.roster,
      conversation: models.conversation ?? base.models.conversation,
      work: models.work ?? base.models.work,
      thinkingChoice: models.thinkingChoice ?? base.models.thinkingChoice,
      ...(models.thinking ?? base.models.thinking ? { thinking: models.thinking ?? base.models.thinking } : {}),
    },
    image: base.image,
    search: base.search,
    providers: base.providers,
    work: { ...base.work, ...(patch.work ?? {}) },
    push: { ...base.push, ...(patch.push ?? {}) },
  };
}

let settingsWrite: Promise<void> = Promise.resolve();

/** 同一页面的设置依次写入，避免连续操作使用同一 revision 相互覆盖。 */
export function saveSettings(patch: SettingsPatch | ((settings: SettingsFile["settings"]) => SettingsPatch)): Promise<boolean> {
  const result = settingsWrite.then(() => writeSettings(typeof patch === "function" ? patch(state.settings.settings) : patch));
  settingsWrite = result.then(() => undefined, () => undefined);
  return result;
}

/** 写设置：先乐观更新，409 就重新拉一份并提示已在别处修改。 */
async function writeSettings(patch: SettingsPatch): Promise<boolean> {
  const before = state.settings;
  const optimistic: SettingsFile = { revision: before.revision, settings: mergeSettings(before.settings, patch) };
  set({ settings: optimistic, theme: optimistic.settings.general.theme });
  if (patch.general?.theme) applyTheme(patch.general.theme);
  try {
    const next = await api.putSettings(before.revision, patch);
    set({ settings: next, theme: next.settings.general.theme });
    applyTheme(next.settings.general.theme);
    if (patch.models) refreshGroupProfiles();
    localStorage.setItem(THEME_KEY, next.settings.general.theme);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      try {
        const fresh = await api.settings();
        set({ settings: fresh, theme: fresh.settings.general.theme });
        applyTheme(fresh.settings.general.theme);
      } catch {
        set({ settings: before });
      }
      set({ notice: "设置已在别处修改，已刷新" });
      return false;
    }
    set({ settings: before, theme: before.settings.general.theme, notice: `保存失败：${errText(e)}` });
    applyTheme(before.settings.general.theme);
    return false;
  }
}

export async function changePassword(old: string, next: string): Promise<string | null> {
  try {
    await api.changePassword(old, next);
    return null;
  } catch (e) {
    return errText(e);
  }
}

export async function loadAbout() {
  try {
    return await api.about();
  } catch (e) {
    set({ notice: `无法读取版本信息：${errText(e)}` });
    return null;
  }
}

/** 设置 → 消耗：会话文件里的用量和价格表（打开页面时拉一次）。 */
export async function loadUsage(): Promise<{ ok: true; view: UsageView } | { ok: false; error: string }> {
  try {
    return { ok: true, view: await api.usage() };
  } catch (e) {
    return { ok: false, error: `无法读取消耗统计：${errText(e)}` };
  }
}

/** 改一个模型的单价（null = 恢复默认）；存完把新 revision 的整份设置收下来。 */
export async function saveUsagePrice(model: string, price: TokenPrice | null): Promise<{ ok: true; price: UsageModelPrice | null } | { ok: false; error: string }> {
  try {
    const saved = await api.putUsagePrice({ revision: getState().settings.revision, model, price });
    set({ settings: saved.settings });
    return { ok: true, price: saved.price };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** 设置 → 模型：可用模型名单（打开页面时拉一次）。 */
export async function loadModels(): Promise<ModelsView | null> {
  try {
    return await api.models();
  } catch (e) {
    set({ notice: `无法读取模型列表：${errText(e)}` });
    return null;
  }
}

/* ---------------- 全局规则 ---------------- */

let rulesGeneration = 0;
export async function loadRules() {
  const generation = ++rulesGeneration;
  try {
    const { rules } = await api.rules();
    if (generation === rulesGeneration) set((s) => ({ globalRules: { ...s.globalRules, rules, error: null } }));
  } catch (e) {
    if (generation === rulesGeneration) set((s) => ({ globalRules: { ...s.globalRules, error: `无法读取全局规则：${errText(e)}` } }));
  }
}

export async function saveRules(rules: { id?: string; text: string; mode: Rule["mode"] }[]): Promise<boolean> {
  if (state.globalRules.busy) return false;
  set((s) => ({ globalRules: { ...s.globalRules, busy: true, error: null } }));
  try {
    const saved = await api.saveRules(rules);
    ++rulesGeneration;
    set({ globalRules: { rules: saved.rules, error: null, busy: false } });
    return true;
  } catch (e) {
    set((s) => ({ globalRules: { ...s.globalRules, busy: false, error: `保存失败：${errText(e)}` } }));
    return false;
  }
}

/* ---------------- 服务商 ---------------- */

export async function loadClaude() {
  const view = await api.claude();
  set({ settings: view.settings });
  return view;
}

export async function saveClaude(claude: ClaudeCodeSettings) {
  const view = await api.saveClaude(state.settings.revision, claude);
  set({ settings: view.settings });
  return view;
}

/** 服务商变动后：整份设置（新 revision）一起更新，并拉一次新的模型名单。 */
async function adoptProviders(view: ProvidersView): Promise<ProvidersView> {
  set({ settings: view.settings });
  return view;
}

/** 设置 → 服务商：已配的服务商 + 引擎自带的服务商目录（打开页面时拉一次）。 */
export async function loadProviders(): Promise<{ ok: true; view: ProvidersView } | { ok: false; error: string }> {
  try {
    return { ok: true, view: await api.providers() };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** 新建或改一个服务商：Key 留空就沿用已存的。 */
export async function saveProvider(
  id: string,
  body: unknown,
): Promise<{ ok: true; view: ProvidersView } | { ok: false; error: string }> {
  try {
    return { ok: true, view: await adoptProviders(await api.putProvider(id, body)) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/**
 * 服务商详情里改一个模型的思考档：存完马上生效（下一轮对话 / 下一个任务就用新的档和字符），
 * 整份设置换成新的 revision。
 */
export async function saveThinking(
  ref: string,
  levels: ThinkingLevelMapSetting | null,
): Promise<{ ok: true; settings: SettingsFile; thinking: ModelThinkingView } | { ok: false; error: string }> {
  try {
    const saved = await api.putThinking({ ref, levels });
    set({ settings: saved.settings });
    return { ok: true, settings: saved.settings, thinking: saved.thinking };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** 删服务商：Key 一起删，名单里用到它的模型会变成不可用。 */
export async function removeProvider(id: string): Promise<{ ok: true; view: ProvidersView } | { ok: false; error: string }> {
  try {
    return { ok: true, view: await adoptProviders(await api.deleteProvider(id)) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function testProviderConnection(body: { kind: "builtin" | "custom"; id?: string; api?: string; baseUrl?: string; apiKey?: string }): Promise<string | null> {
  try {
    await api.testProvider(body);
    return null;
  } catch (e) {
    return errText(e);
  }
}

/** 从兼容接口拉模型列表（失败给具体原因）。 */
export async function discoverModels(
  body: { api: string; baseUrl: string; apiKey?: string; id?: string },
): Promise<{ ok: true; models: { id: string; name?: string }[] } | { ok: false; error: string }> {
  try {
    return { ok: true, models: (await api.discoverProvider(body)).models };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** 设置 → 服务商「从本机导入」：列出本机能导入的服务商（只读来源文件）。 */
export async function loadProviderImports(): Promise<
  { ok: true; view: ProviderImportView } | { ok: false; error: string }
> {
  try {
    return { ok: true, view: await api.providersImport() };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** 导入所选的服务商（同 id 覆盖，Key 由服务端写进密钥文件）。 */
export async function importProviders(
  ids: string[],
): Promise<{ ok: true; view: ProvidersView } | { ok: false; error: string }> {
  try {
    return { ok: true, view: await adoptProviders(await api.importProviders(ids)) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export const loadSkills = () => api.skills();
export const loadSkillImports = (source: import("../../shared/skills.ts").SkillImportSource) => api.skillsImport(source);
export const importSelectedSkills = (source: import("../../shared/skills.ts").SkillImportSource, ids: string[], overwrite: boolean) => api.importSkills(source, ids, overwrite);
export const deleteSkill = (id: string) => api.deleteSkill(id);
export const loadDesktop = () => api.desktop();
export async function saveDesktop(body: { revision: number; url: string; enabled: boolean; token?: string }) {
  const view = await api.saveDesktop(body);
  set({ settings: await api.settings() });
  return view;
}
export async function saveDesktopPublic(revision: number, assistants: string[]) {
  const view = await api.saveDesktopPublic(revision, assistants);
  set({ settings: await api.settings() });
  return view;
}
export const testDesktop = () => api.testDesktop();
export const loadMcp = () => api.mcp();
export const putMcpServer = (name: string, body: import("../../shared/mcp.ts").McpServerSave) => api.putMcp(name, body);
export const patchMcpServer = (name: string, patch: import("../../shared/mcp.ts").McpServerPatch) => api.patchMcp(name, patch);
export const deleteMcpServer = (name: string) => api.deleteMcp(name);
export const testMcpServer = (name: string, refresh = true) => api.testMcp(name, refresh);
export const loadMcpImports = () => api.mcpImports();
export const importMcpServers = (ids: string[]) => api.importMcp(ids);
export const loadSearch = () => api.search();
export const testSearch = (name: string, baseUrl?: string, apiKey?: string) => api.testSearch(name, baseUrl, apiKey);
export async function saveSearch(providers: SearchSettings, keys?: Record<string, string>) {
  try { const saved = await api.putSearch(state.settings.revision, providers, keys); set({ settings: saved }); return null; }
  catch (e) { if (e instanceof ApiError && e.status === 409) set({ settings: await api.settings() }); return errText(e); }
}

/* ---------------- 知识库索引 ---------------- */
export const loadEmbeddingKey = () => api.embeddingKey();
export const testEmbedding = (body: Parameters<typeof api.embeddingTest>[0]) => api.embeddingTest(body);
export async function saveEmbedding(embedding: import("../../shared/types.ts").EmbeddingSettings, apiKey?: string) {
  try {
    const saved = await api.putEmbedding(state.settings.revision, embedding, apiKey);
    set({ settings: saved.settings });
    return saved;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) set({ settings: await api.settings() });
    throw e;
  }
}
export const getKnowledgeEntry = (id: string, chunk?: number) => api.knowledgeEntry(id, chunk);
export const reindexKnowledge = (id: string) => api.reindexKnowledge(id);

/* ---------------- 图像生成 ---------------- */

/** 设置 → 图像生成：接口的 Key 配没配（打开页面时拉一次）。 */
export async function loadImageKey(): Promise<ImageKeyView | null> {
  try {
    return await api.imageKey();
  } catch (e) {
    set({ notice: `无法读取图像生成设置：${errText(e)}` });
    return null;
  }
}

/** 保存图像生成配置：Key 只写不读，留空则沿用已保存的。 */
export async function saveImage(
  image: ImageSettings,
  apiKey?: string,
): Promise<{ ok: true; keyConfigured: boolean } | { ok: false; error: string; conflict: boolean }> {
  try {
    const saved = await api.putImage(state.settings.revision, image, apiKey);
    set({ settings: saved.settings });
    return { ok: true, keyConfigured: saved.keyConfigured };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      try {
        set({ settings: await api.settings() });
      } catch {
        /* 拉不到就等下一次操作 */
      }
      return { ok: false, error: "设置已在别处修改，已刷新，请重新保存", conflict: true };
    }
    return { ok: false, error: errText(e), conflict: false };
  }
}

/** 生成测试图片：用给的表单值（没给就用已保存的配置）实际生成一张小图。 */
export async function testImage(body: {
  image?: ImageSettings;
  apiKey?: string;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    return await api.imageTest(body);
  } catch (e) {
    return { ok: false, error: `生成测试图片的请求失败：${errText(e)}` };
  }
}

/* ---------------- 记忆 ---------------- */

/** 结果带成功/失败：记忆页要原样显示失败原因，不能静默回退。 */
export type MemoryResult =
  | { ok: true; config: MemoryConfig }
  | { ok: false; error: string };

export async function loadMemory(): Promise<MemoryResult> {
  try {
    return { ok: true, config: await api.memory() };
  } catch (e) {
    return { ok: false, error: `无法读取记忆设置：${errText(e)}` };
  }
}

export async function saveMemoryProvider(revision: number, provider: MemoryProvider): Promise<MemoryResult> {
  try {
    const config = await api.putMemory(revision, provider);
    set((s) => ({ settings: { ...s.settings, revision: Math.max(s.settings.revision, config.revision) } }));
    return { ok: true, config };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function saveMemoryLore(body: { baseUrl: string; token?: string }): Promise<MemoryResult> {
  try {
    return { ok: true, config: await api.putLore(body) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function testMemoryLore(body: { baseUrl?: string; token?: string }) {
  try {
    return { ok: true as const, result: await api.loreTest(body) };
  } catch (e) {
    return { ok: false as const, error: `测试请求失败：${errText(e)}` };
  }
}

/** 设置 → 记忆「从本机导入」：本机的 Lore 连接（Token 只报有没有）。 */
export async function loadLoreImport(): Promise<{ ok: true; view: LoreImportView } | { ok: false; error: string }> {
  try {
    return { ok: true, view: await api.loreImport() };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** 把本机的 Lore 连接导进 Hob 自己的配置。 */
export async function importLore(): Promise<MemoryResult> {
  try {
    return { ok: true, config: await api.importLore() };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/* ---------------- 推送（设置 → 通知） ---------------- */

export type PushResult = { ok: true; view: PushView } | { ok: false; error: string };

export async function loadPush(): Promise<PushResult> {
  try {
    return { ok: true, view: await api.push() };
  } catch (e) {
    return { ok: false, error: `无法读取推送设置：${errText(e)}` };
  }
}

/** 本机推送开关：申请权限、订阅，再把订阅交给服务端存起来。 */
export async function connectPush(): Promise<PushResult> {
  const current = await loadPush();
  if (!current.ok) return current;
  try {
    const subscribed = await subscribePush(current.view.publicKey);
    if ("error" in subscribed) return { ok: false, error: subscribed.error };
    return {
      ok: true,
      view: await api.subscribePush(subscribed.subscription, deviceLabel(navigator.userAgent)),
    };
  } catch (e) {
    return { ok: false, error: `订阅推送失败：${errText(e)}` };
  }
}

/** 关闭本机推送：先在浏览器退订，再删服务端记录。 */
export async function disconnectPush(): Promise<PushResult> {
  try {
    const subscription = await currentSubscription();
    if (subscription) {
      try {
        await subscription.unsubscribe();
      } catch {
        // 浏览器自己已经失效了也一样删服务端那条
      }
    }
    return removePushDevice(subscription?.endpoint ?? (await currentEndpointFromServer()));
  } catch (e) {
    return { ok: false, error: `关闭推送失败：${errText(e)}` };
  }
}

/** 服务端保存的这台设备的 endpoint：浏览器里已经没订阅时靠它对齐。 */
async function currentEndpointFromServer(): Promise<string> {
  const result = await loadPush();
  return result.ok ? (result.view.devices[0]?.endpoint ?? "") : "";
}

export async function removePushDevice(endpoint: string): Promise<PushResult> {
  if (!endpoint) return loadPush();
  try {
    return { ok: true, view: await api.unsubscribePush(endpoint) };
  } catch (e) {
    return { ok: false, error: `删除设备失败：${errText(e)}` };
  }
}

/** 设置页的「发送测试通知」：发给这台设备。 */
export async function sendTestPush(): Promise<{ ok: true; sent: number; removed: number } | { ok: false; error: string }> {
  const subscription = await currentSubscription();
  try {
    const result = await api.testPush(subscription?.endpoint);
    return { ok: true, sent: result.sent, removed: result.removed };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/* ---------------- 主题 ---------------- */

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(theme: Theme) {
  const { dark } = resolveTheme(theme, darkQuery.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  updateStatusColor(state, window.innerWidth < 768);
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
  set({ theme });
  localStorage.setItem(THEME_KEY, theme); // 只是下次打开时先按它刷一下，避免闪白
  void saveSettings({ general: { theme } });
}

darkQuery.addEventListener("change", () => applyTheme(state.theme));

/* ---------------- 启动与事件 ---------------- */

let started = false;
let stopEvents: (() => void) | null = null;

export async function start() {
  if (started) return;
  started = true;
  applyTheme(state.theme);
  if (MOCK) {
    if (scene === "boot") return;
    await loadBootstrap();
    return;
  }
  try {
    await api.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      set({ phase: "login" });
      return;
    }
    set({ phase: "error", error: errText(e) });
    return;
  }
  await loadBootstrap();
}

export async function login(password: string) {
  if (state.loggingIn) return;
  set({ loggingIn: true, error: null });
  try {
    await api.login(password);
  } catch (e) {
    set({
      loggingIn: false,
      error: e instanceof ApiError && e.status === 401 ? "密码不正确" : `登录失败：${errText(e)}`,
    });
    return;
  }
  set({ loggingIn: false, phase: "loading" });
  await loadBootstrap();
}

export async function logout() {
  stopEvents?.();
  stopEvents = null;
  try {
    await api.logout();
  } catch {
    /* 后端没有退出接口时也要能把界面退回登录页 */
  }
  set({ phase: "login", assistants: [], items: {}, profiles: {}, assistantSkills: {}, jobs: {}, routines: [] });
}

let groupRetry: ReturnType<typeof setTimeout> | undefined;
/** 群列表不在 bootstrap 里，单独拉；手机从后台切回来时网络还没好，这一下常失败，失败了隔几秒再拉，不让群一直空着 */
async function loadGroups() {
  clearTimeout(groupRetry);
  try {
    set({ groups: await api.groups() });
  } catch (e) {
    set({ notice: `无法加载群：${errText(e)}，稍后自动重试` });
    groupRetry = setTimeout(() => void loadGroups(), 5000);
  }
}

async function loadBootstrap(reconnect = false) {
  try {
    const boot = await api.bootstrap();
    set({
      phase: "ready",
      error: null,
      offline: null,
      assistants: boot.assistants,
      jobs: index(boot.jobs),
      delegations: index(boot.delegations ?? []),
      routines: boot.routines,
      approvals: index(boot.approvals),
      settings: boot.settings,
      theme: boot.settings.settings.general.theme,
    });
    applyTheme(boot.settings.settings.general.theme);
    localStorage.setItem(THEME_KEY, boot.settings.settings.general.theme);
    if (!stopEvents) {
      stopEvents = api.events(
        {
          onEvent: applyEvent,
          onReconnect: () => {
            set({ offline: null });
            void loadBootstrap(true);
          },
          onDown: (reason) => set({ offline: reason }),
        },
        CLIENT_ID,
      );
      watchVisibility();
    }
    const sel =
      state.sel && boot.assistants.some((a) => a.id === state.sel)
        ? state.sel
        : (boot.assistants.find((a) => a.primary)?.id ?? boot.assistants[0]?.id ?? null);
    await loadGroups();
    // 实时连接断了又连上：只补拉正看着的对话，不换页、不收右栏，正在打字的输入框和引用都留着
    if (reconnect) {
      if (state.gsel) await Promise.all([loadGroupItems(state.gsel), loadProjects(state.gsel, true)]);
      else if (state.sel) await Promise.all([loadItems(state.sel), loadProfile(state.sel)]);
    }
    // 群地址代表综合时间线；手机刷新也应直接回到综合。
    else if (state.gsel && state.groups.some((g) => g.id === state.gsel)) await selectGroup(state.gsel, true, false, Boolean(bootRoute.group));
    // 没指定对话就停在首页
    else if (sel && state.sel) await select(sel, mobileWantsChat());
    if (state.page === "knowledge") void loadKnowledge();
    // 刷新前开着的任务页：内容要自己拉
    const top = state.panelStack.at(-1);
    if (top?.kind === "job") void loadTranscript(top.id);
    if (top?.kind === "jobs" && !state.worklog) void loadWorklog();
  } catch (e) {
    set({ phase: "error", error: errText(e) });
  }
}

const closedLivePages = new Set<string>();
export function applyEvent(ev: HobEvent) {
  if (ev.type === "item" || ev.type === "delta") itemEvents.get(ev.assistantId)?.push(ev);
  if (ev.type === "group-item" || ev.type === "group-delta") groupEvents.get(ev.groupId)?.push(ev);
  switch (ev.type) {
    case "rules":
      if (state.page === "settings" && state.section === "rules") void loadRules();
      break;
    case "page-live": {
      const first = !state.livePages[ev.callId];
      set((s) => ({
        livePages: { ...s.livePages, [ev.callId]: ev },
        ...(shouldOpenLive(ev, { seen: !first, closed: closedLivePages.has(ev.callId), assistantId: s.sel, inChat: s.page === "main" && (s.mobile === "chat" || !window.matchMedia("(max-width: 767px)").matches) })
          ? { panelStack: pushPage(s.panelStack, { kind: "file", path: "", full: false, liveId: ev.callId }) } : {}),
      }));
      break;
    }
    case "assistant": {
      // 正看着这个助手的对话：新回复直接算已读，不亮未读
      const read = ev.assistant.unread > 0 && viewing(ev.assistant.id);
      if (read) void api.markRead(ev.assistant.id).catch(() => {});
      // 设置页读的是档案里的助手：头像、名字在别处改了也跟着变
      const assistant = read ? { ...ev.assistant, unread: 0 } : ev.assistant;
      const oldModels = state.assistants.find((a) => a.id === assistant.id)?.models;
      if (JSON.stringify(oldModels) !== JSON.stringify(assistant.models)) refreshGroupProfiles(assistant.id);
      set((s) => ({
        assistants: upsert(s.assistants, assistant),
        profiles: s.profiles[assistant.id]
          ? { ...s.profiles, [assistant.id]: { ...s.profiles[assistant.id], assistant } }
          : s.profiles,
      }));
      break;
    }
    case "router-activity":
      set((s) => ({ assistants: s.assistants.map((a) => a.id === ev.assistantId ? { ...a, activity: ev.activity } : a) }));
      break;
    case "assistant_removed":
      set((s) => ({
        assistants: s.assistants.filter((a) => a.id !== ev.id),
        sel: s.sel === ev.id ? (s.assistants.find((a) => a.primary)?.id ?? null) : s.sel,
      }));
      break;
    case "item": {
      const list = state.items[ev.assistantId];
      if (!list) break;
      const outbox = state.pending[ev.assistantId] ?? [];
      const mine = outbox.find((p) => isSentAs(p, ev.item));
      if (!mine && !list.some((x) => x.id === ev.item.id)) markFresh([ev.item.id]);
      set((s) => ({
        items: { ...s.items, [ev.assistantId]: mergeItems(list, ev.item) },
        ...(mine ? { pending: { ...s.pending, [ev.assistantId]: outbox.filter((p) => p !== mine) } } : {}),
      }));
      break;
    }
    case "delta": {
      const list = state.items[ev.assistantId];
      if (!list) break;
      const next = applyDelta(list, ev.itemId, ev.text);
      if (next !== list) set((s) => ({ items: { ...s.items, [ev.assistantId]: next } }));
      break;
    }
    case "job":
      set((s) => ({ jobs: { ...s.jobs, [ev.job.id]: ev.job } }));
      // 任务刚结束：重新拉一份过程，拿到落盘的完整输出（实时事件里的输出截到了 4KB）
      if (endedStatus(ev.job.status) && state.panelStack.some((page) => page.kind === "job" && page.id === ev.job.id) && state.steps[ev.job.id]) {
        void loadTranscript(ev.job.id);
      }
      break;
    case "delegation":
      set((s) => ({ delegations: { ...s.delegations, [ev.delegation.id]: ev.delegation } }));
      break;
    case "job_step": {
      const list = state.steps[ev.jobId];
      if (!list) break;
      set((s) => ({ steps: { ...s.steps, [ev.jobId]: mergeStep(list, ev.step) } }));
      break;
    }
    case "activity": {
      const job = state.jobs[ev.jobId];
      if (!job) break;
      set((s) => ({
        jobs: {
          ...s.jobs,
          [ev.jobId]: {
            ...job,
            stats: ev.stats,
            activity: [...job.activity, ev.line].slice(-200),
          },
        },
      }));
      break;
    }
    case "approval":
      set((s) => ({ approvals: { ...s.approvals, [ev.approval.id]: ev.approval } }));
      break;
    case "draft":
      set((s) => ({ drafts: { ...s.drafts, [ev.draft.id]: ev.draft } }));
      break;
    case "routine":
      set((s) => ({ routines: upsert(s.routines, ev.routine) }));
      break;
    case "routine_removed":
      set((s) => ({
        routines: s.routines.filter((r) => r.id !== ev.id),
        panelStack: s.panelStack.filter((page) => page.kind !== "routine" || page.id !== ev.id),
      }));
      break;
    case "skills":
      void loadAssistantSkills(ev.assistantId);
      // 事件只带助手：群的技能（沉淀、改、删）也可能变了，已加载过的群一起重拉
      for (const id of Object.keys(state.assistantSkills)) if (state.groups.some((group) => group.id === id)) void loadAssistantSkills(id);
      break;
    case "group": {
      // 正看着这个群：新消息直接算已读，不亮未读
      const read = ev.group.unread > 0 && viewingGroup(ev.group.id);
      if (read) void api.markGroupRead(ev.group.id).catch(() => {});
      const previous = state.groups.find((group) => group.id === ev.group.id);
      set((s) => ({ groups: upsert(s.groups, read ? { ...ev.group, unread: 0 } : ev.group) }));
      if (previous && JSON.stringify([previous.ownerId, previous.members, previous.models, previous.memberModels]) !== JSON.stringify([ev.group.ownerId, ev.group.members, ev.group.models, ev.group.memberModels])) {
        for (const group of state.groups) if ((group.id === ev.group.id || group.parentId === ev.group.id) && state.groupProfiles[group.id]) void loadGroupProfile(group.id);
      }
      break;
    }
    case "group_removed":
      dropGroupPrefs(ev.id);
      set((s) => {
        const groups = s.groups.filter((g) => g.id !== ev.id);
        if (s.gsel !== ev.id) return { groups };
        const primary = s.assistants.find((a) => a.primary)?.id ?? s.assistants[0]?.id ?? null;
        return { groups, gsel: null, sel: primary ?? s.sel, mobile: "list" as const, panelStack: [] };
      });
      break;
    case "group-item": {
      const list = state.groupItems[ev.groupId];
      if (!list) break;
      const key = `group:${ev.groupId}`;
      const outbox = state.pending[key] ?? [];
      const mine = outbox.find((p) => isSentAs(p, ev.item));
      if (!mine && !list.some((x) => x.id === ev.item.id)) markFresh([ev.item.id]);
      set((s) => ({
        groupItems: { ...s.groupItems, [ev.groupId]: mergeItems(list, ev.item) as GroupItem[] },
        ...(mine ? { pending: { ...s.pending, [key]: outbox.filter((p) => p !== mine) } } : {}),
      }));
      break;
    }
    case "group-delta": {
      const list = state.groupItems[ev.groupId];
      if (!list) break;
      const next = applyDelta(list, ev.itemId, ev.text) as GroupItem[];
      if (next !== list) {
        // 文字开始输出了：这个人的「正在想」收起来
        const speaker = list.find((item) => item.id === ev.itemId)?.speaker;
        set((s) => ({
          groupItems: { ...s.groupItems, [ev.groupId]: next },
          ...(speaker ? { groupActivity: withoutActivity(s.groupActivity, ev.groupId, speaker) } : {}),
        }));
      }
      break;
    }
    case "group-activity":
      set((s) => {
        const current = { ...(s.groupActivity[ev.groupId] ?? {}) };
        if (ev.activity) current[ev.speaker] = ev.activity;
        else delete current[ev.speaker];
        return { groupActivity: { ...s.groupActivity, [ev.groupId]: current } };
      });
      break;
    case "project":
      set((s) => ({ projects: { ...s.projects, [ev.project.groupId]: upsertProject(s.projects[ev.project.groupId], ev.project) } }));
      break;
    case "knowledge":
      collectionsVersion++;
      set((s) => ({ knowledge: { ...s.knowledge, collectionsLoaded: false } }));
      if (state.page === "knowledge") void loadKnowledge(false, true);
      break;
    case "profile":
      void loadProfile(ev.assistantId);
      break;
  }
}

function endedStatus(status: JobStatus): boolean {
  return status === "done" || status === "stuck" || status === "failed" || status === "stopped";
}

/** 去掉群里某个成员的当前活动（他说起来了，或者已经说完）。 */
function withoutActivity(map: State["groupActivity"], groupId: string, speaker: string): State["groupActivity"] {
  if (!map[groupId]?.[speaker]) return map;
  const current = { ...map[groupId] };
  delete current[speaker];
  return { ...map, [groupId]: current };
}

/** 事项按 id 替换，新的在前面（按更新时间）。 */
function upsertProject(list: Project[] | undefined, project: Project): Project[] {
  return [...(list ?? []).filter((item) => item.id !== project.id), project].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 页面在前台就不推（服务端根据这个决定）。只存内存，SSE 断开会自动清掉。 */
function reportVisibility(): void {
  void api.visibility(CLIENT_ID, document.visibilityState === "visible").catch(() => undefined);
  // 切回来时正开着的那个助手 / 群攒下的未读算看过了
  const a = state.assistants.find((x) => x.id === state.sel);
  if (a && a.unread > 0 && viewing(a.id)) {
    set((s) => ({ assistants: s.assistants.map((x) => (x.id === a.id ? { ...x, unread: 0 } : x)) }));
    void api.markRead(a.id).catch(() => {});
  }
  const g = state.groups.find((x) => x.id === state.gsel);
  if (g && g.unread > 0 && viewingGroup(g.id)) {
    set((s) => ({ groups: s.groups.map((x) => (x.id === g.id ? { ...x, unread: 0 } : x)) }));
    void api.markGroupRead(g.id).catch(() => {});
  }
}

/** 用户正看着这个助手的对话：页面在前台、在主界面，手机上要进了对话页。 */
function viewing(id: string): boolean {
  return state.sel === id && state.page === "main" && globalThis.document?.visibilityState === "visible" && (window.innerWidth >= 768 || state.mobile === "chat");
}

function viewingGroup(id: string): boolean {
  return state.gsel === id && state.page === "main" && globalThis.document?.visibilityState === "visible" && (window.innerWidth >= 768 || state.mobile === "chat");
}

function watchVisibility(): void {
  if (watchingVisibility) return;
  watchingVisibility = true;
  document.addEventListener("visibilitychange", reportVisibility);
  reportVisibility();
}

/* ---------------- 群 ---------------- */

export function groupById(s: State, id: string | null | undefined): GroupSummary | undefined {
  return id ? s.groups.find((g) => g.id === id) : undefined;
}

/** 正在这个群里说话的成员（有活动状态的那几个）。 */
export function groupSpeaking(s: State, g: GroupSummary): string[] {
  const active = s.groupActivity[g.id] ?? {};
  return g.members.filter((id) => Boolean(active[id]));
}

/** 置顶和位置是本地状态；改完存在 localStorage 里，刷新还照旧。 */
export function setGroupPrefs(id: string, patch: Partial<GroupPrefs>) {
  const prefs = { ...state.groupPrefs, [id]: { ...(state.groupPrefs[id] ?? { pinned: false }), ...patch } };
  saveGroupPrefs(prefs);
  set({ groupPrefs: prefs });
}

function dropGroupPrefs(id: string) {
  if (!state.groupPrefs[id]) return;
  const prefs = { ...state.groupPrefs };
  delete prefs[id];
  saveGroupPrefs(prefs);
  set({ groupPrefs: prefs });
}

/** 建群：建好直接进这个群。 */
export async function createGroup(body: { name: string; purpose: string; ownerId: string; members: string[]; workflow?: WorkflowId | null }): Promise<string | null> {
  try {
    const group = await api.createGroup(body);
    set((s) => ({ groups: upsert(s.groups, { ...group, unread: 0, busy: [] }) }));
    await selectGroup(group.id);
    return null;
  } catch (e) {
    return errText(e);
  }
}

/** 改群（名字、负责什么、成员、群主、工作方式）；列表由 group 事件刷新。 */
export async function patchGroup(id: string, patch: Parameters<HobApi["patchGroup"]>[1]): Promise<string | null> {
  try {
    await api.patchGroup(id, patch);
    return null;
  } catch (e) {
    return errText(e);
  }
}

export async function patchGroupMemberModels(groupId: string, assistantId: string, patch: Parameters<HobApi["patchGroupMemberModels"]>[2]): Promise<string | null> {
  try {
    const group = await api.patchGroupMemberModels(groupId, assistantId, patch);
    set((s) => ({ groups: s.groups.map((g) => g.id === group.id || g.parentId === group.id ? { ...g, memberModels: group.memberModels } : g) }));
    return null;
  } catch (e) { return errText(e); }
}

/** 开一个话题：建好直接进这个话题。 */
export async function openTopic(groupId: string, title: string): Promise<string | null> {
  try {
    const topic = await api.createTopic(groupId, { title });
    set((s) => ({ groups: upsert(s.groups, { ...topic, unread: 0, busy: [] }) }));
    await selectGroup(topic.id);
    return null;
  } catch (e) {
    return errText(e);
  }
}

/** 关闭话题：里面没结束的事项按放弃处理，服务端会给原因。 */
export async function closeTopic(id: string, note?: string): Promise<string | null> {
  try {
    const topic = await api.closeTopic(id, note ? { note } : undefined);
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, ...topic } : g)) }));
    return null;
  } catch (e) {
    return errText(e);
  }
}

/** 重新打开关掉的话题。 */
export async function reopenTopic(id: string): Promise<string | null> {
  try {
    const topic = await api.reopenTopic(id);
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, ...topic } : g)) }));
    return null;
  } catch (e) {
    return errText(e);
  }
}

/** 结束这个群：归档后从列表里移除，正看着它的回到主助手。 */
export async function archiveGroup(id: string) {
  try {
    await api.archiveGroup(id);
  } catch (e) {
    set({ notice: `结束群失败：${errText(e)}` });
  }
}

export async function stopGroup(id: string) {
  try {
    await api.stopGroup(id);
  } catch (e) {
    set({ notice: `停止失败：${errText(e)}` });
  }
}

/** 群消息走自己的分页；发件箱按会话键分开存，群 id 和助手 id 不撞。 */
export function pendingKeyOf(s: State): string | null {
  return s.gsel ? `group:${s.gsel}` : s.sel;
}

/**
 * 打开一个群或话题。桌面上左栏换成这个群的二级页（话题页进它所属的群）；
 * 手机上点群先进话题列表，点话题才进对话。
 */
export async function selectGroup(id: string, nav = true, keepStack = false, forceChat = false) {
  const previous = state.gsel ?? state.sel;
  const group = state.groups.find((x) => x.id === id);
  const narrow = window.innerWidth < 768;
  const opensTopics = !forceChat && narrow && Boolean(group && !group.parentId);
  set((s) => ({
    gsel: id,
    sel: null,
    sideHome: false,
    panelStack: selectPanelStack(s.panelStack, previous, id, keepStack),
    ...(s.gsel !== id && !keepStack ? { worklog: null } : {}),
    ...(nav ? { mobile: (opensTopics ? "topics" : "chat") as MobilePage, ...(!keepStack ? { sheet: false } : {}), search: false } : {}),
    quote: null,
  }));
  if (group && group.unread > 0 && !opensTopics) {
    set((s) => ({ groups: s.groups.map((x) => (x.id === id ? { ...x, unread: 0 } : x)) }));
    void api.markGroupRead(id).catch(() => {});
  }
  await loadGroupItems(id);
  void loadProjects(id, true);
}

/** 手机上从话题列表进综合：还是这个群，手机切到对话页。 */
export async function openGroupHome(id: string) {
  await selectGroup(id, true, false, true);
}

/** 从管理提示进入目标群综合；群列表可能尚未收到新群事件。 */
export async function openNoteGroup(id: string) {
  try {
    let group = state.groups.find((entry) => entry.id === id);
    if (!group) {
      const groups = await api.groups();
      set({ groups });
      group = groups.find((entry) => entry.id === id);
    }
    if (!group || group.parentId) {
      set({ notice: "目标群不可用" });
      return;
    }
    await openGroupHome(id);
  } catch (e) {
    set({ notice: `无法打开目标群：${errText(e)}` });
  }
}

/** 回首页：对话、右栏的页、弹层、设置和知识库一次全收起（左栏二级页的返回、设置和知识库的返回、左栏的首页键都走这里）。 */
export function goHome() {
  for (const page of state.panelStack) if (page.kind === "file" && page.liveId) closedLivePages.add(page.liveId);
  set({ page: "main", sel: null, gsel: null, sideHome: true, panelStack: [], sheet: false, search: false, viewer: null, mobile: "list" });
}

export async function select(id: string, nav = true, keepStack = false) {
  set((s) => ({
    sel: id,
    gsel: null,
    sideHome: true,
    panelStack: selectPanelStack(s.panelStack, s.gsel ?? s.sel, id, keepStack),
    ...(s.sel !== id && !keepStack ? { worklog: null } : {}),
    ...(nav ? { mobile: "chat" as const, ...(!keepStack ? { sheet: false } : {}), search: false } : {}),
    quote: null,
  }));
  const a = state.assistants.find((x) => x.id === id);
  if (a && a.unread > 0) {
    set((s) => ({ assistants: s.assistants.map((x) => (x.id === id ? { ...x, unread: 0 } : x)) }));
    void api.markRead(id).catch(() => {});
  }
  await Promise.all([loadItems(id), loadProfile(id)]);
}

const itemRequests = new Map<string, number>();
const olderRequests = new Map<string, Promise<void>>();
const itemEvents = new Map<string, HobEvent[]>();
/** 拉时间线期间到的新条目/增量：拉完再按顺序合上，不然这一段就丢了。 */
const groupEvents = new Map<string, HobEvent[]>();

async function loadItems(id: string) {
  const request = (itemRequests.get(id) ?? 0) + 1;
  itemRequests.set(id, request);
  olderRequests.delete(id);
  itemEvents.set(id, []);
  set((s) => ({ itemPages: { ...s.itemPages, [id]: { hasMore: false, loading: false, error: null } } }));
  const knownLive = new Set(Object.keys(state.livePages));
  try {
    const page = await api.items(id);
    if (itemRequests.get(id) !== request) return;
    const events = itemEvents.get(id) ?? [];
    itemEvents.delete(id);
    clearFresh(); // 这一批是历史，不播入场
    const active = new Set((page.pageLive ?? []).map((live) => live.callId));
    set((s) => {
      const livePages = Object.fromEntries(Object.entries(s.livePages).filter(([key, live]) => live.assistantId !== id || live.state === "done" || !knownLive.has(key) || active.has(key)));
      return { livePages, panelStack: removeMissingLivePages(s.panelStack, livePages) };
    });
    for (const live of page.pageLive ?? []) applyEvent({ type: "page-live", ...live });
    set((s) => ({
      items: { ...s.items, [id]: page.items },
      itemGen: { ...s.itemGen, [id]: (s.itemGen[id] ?? 0) + 1 },
      itemPages: { ...s.itemPages, [id]: { hasMore: page.hasMore, loading: false, error: null } },
      jobs: { ...s.jobs, ...index(page.jobs) },
      approvals: { ...s.approvals, ...index(page.approvals) },
      drafts: { ...s.drafts, ...index(page.drafts) },
      delegations: { ...s.delegations, ...index(page.delegations ?? []) },
    }));
    for (const event of events) applyEvent(event);
  } catch (e) {
    if (itemRequests.get(id) !== request) return;
    itemEvents.delete(id);
    set({ notice: `无法加载对话：${errText(e)}` });
  }
}

export function loadOlderItems(id: string, retry = false): Promise<void> {
  const existing = olderRequests.get(id);
  if (existing) return existing;
  const paging = state.itemPages[id];
  const before = state.items[id]?.[0]?.id;
  if (!paging?.hasMore || !before || (paging.error && !retry)) return Promise.resolve();
  const request = itemRequests.get(id);
  set((s) => ({ itemPages: { ...s.itemPages, [id]: { ...paging, loading: true, error: null } } }));
  const work = (async () => {
    try {
      const page = await api.items(id, before);
      if (itemRequests.get(id) !== request || state.sel !== id) return;
      set((s) => {
        const current = s.items[id] ?? [];
        const known = new Set(current.map((item) => item.id));
        return {
          items: { ...s.items, [id]: [...page.items.filter((item) => !known.has(item.id)), ...current] },
          itemPages: { ...s.itemPages, [id]: { hasMore: page.hasMore, loading: false, error: null } },
          jobs: { ...index(page.jobs), ...s.jobs }, approvals: { ...index(page.approvals), ...s.approvals },
          drafts: { ...index(page.drafts), ...s.drafts }, delegations: { ...index(page.delegations ?? []), ...s.delegations },
        };
      });
    } catch (e) {
      if (itemRequests.get(id) === request && state.sel === id) set((s) => ({ itemPages: { ...s.itemPages, [id]: { ...s.itemPages[id], loading: false, error: errText(e) } } }));
    }
  })();
  olderRequests.set(id, work);
  void work.finally(() => { if (olderRequests.get(id) === work) olderRequests.delete(id); });
  return work;
}

const groupRequests = new Map<string, number>();
const olderGroupRequests = new Map<string, Promise<void>>();

/** 打开一个群：拉最新一页时间线，卡片要用的任务、提问一起收下来。 */
async function loadGroupItems(id: string) {
  const request = (groupRequests.get(id) ?? 0) + 1;
  groupRequests.set(id, request);
  olderGroupRequests.delete(id);
  groupEvents.set(id, []);
  set((s) => ({ groupPages: { ...s.groupPages, [id]: { hasMore: false, loading: false, error: null } } }));
  try {
    const page = await api.groupItems(id);
    if (groupRequests.get(id) !== request) return;
    const events = groupEvents.get(id) ?? [];
    groupEvents.delete(id);
    clearFresh(); // 这一批是历史，不播入场
    set((s) => ({
      groupItems: { ...s.groupItems, [id]: page.items },
      groupGen: { ...s.groupGen, [id]: (s.groupGen[id] ?? 0) + 1 },
      groupPages: { ...s.groupPages, [id]: { hasMore: page.hasMore, loading: false, error: null } },
      jobs: { ...s.jobs, ...index(page.jobs) },
      approvals: { ...s.approvals, ...index(page.approvals) },
    }));
    for (const event of events) applyEvent(event);
  } catch (e) {
    if (groupRequests.get(id) !== request) return;
    groupEvents.delete(id);
    set({ notice: `无法加载群消息：${errText(e)}` });
  }
}

const projectRequests = new Map<string, number>();

/** 拉这个群的事项（新的在前）；silent 表示后台拉，用户正在输消息时不打扰。 */
export async function loadProjects(gid: string, silent = false): Promise<void> {
  const request = (projectRequests.get(gid) ?? 0) + 1;
  projectRequests.set(gid, request);
  try {
    const list = await api.projects(gid);
    if (projectRequests.get(gid) !== request) return;
    set((s) => ({ projects: { ...s.projects, [gid]: list }, projectsError: { ...s.projectsError, [gid]: null } }));
  } catch (e) {
    if (projectRequests.get(gid) !== request) return;
    const message = errText(e);
    if (silent) set((s) => ({ projectsError: { ...s.projectsError, [gid]: message } }));
    else set({ notice: `无法加载事项：${message}` });
  }
}

export function loadOlderGroupItems(id: string, retry = false): Promise<void> {  const existing = olderGroupRequests.get(id);
  if (existing) return existing;
  const paging = state.groupPages[id];
  const before = state.groupItems[id]?.[0]?.id;
  if (!paging?.hasMore || !before || (paging.error && !retry)) return Promise.resolve();
  const request = groupRequests.get(id);
  set((s) => ({ groupPages: { ...s.groupPages, [id]: { ...paging, loading: true, error: null } } }));
  const work = (async () => {
    try {
      const page = await api.groupItems(id, before);
      if (groupRequests.get(id) !== request || state.gsel !== id) return;
      set((s) => {
        const current = s.groupItems[id] ?? [];
        const known = new Set(current.map((item) => item.id));
        return {
          groupItems: { ...s.groupItems, [id]: [...page.items.filter((item) => !known.has(item.id)), ...current] },
          groupPages: { ...s.groupPages, [id]: { hasMore: page.hasMore, loading: false, error: null } },
          jobs: { ...index(page.jobs), ...s.jobs },
          approvals: { ...index(page.approvals), ...s.approvals },
        };
      });
    } catch (e) {
      if (groupRequests.get(id) === request && state.gsel === id) set((s) => ({ groupPages: { ...s.groupPages, [id]: { ...s.groupPages[id], loading: false, error: errText(e) } } }));
    }
  })();
  olderGroupRequests.set(id, work);
  void work.finally(() => { if (olderGroupRequests.get(id) === work) olderGroupRequests.delete(id); });
  return work;
}

export async function loadProfile(id: string) {
  try {
    const p = await api.profile(id);
    set((s) => ({ profiles: { ...s.profiles, [id]: p } }));
  } catch (e) {
    set({ notice: `无法加载档案：${errText(e)}` });
  }
}

/* ---------------- 发消息 ---------------- */

export function setText(text: string) {
  set({ text });
}

export function setQuote(quote: { itemId: string; text: string } | null) {
  set({ quote, nonce: state.nonce + 1 });
}

/* ---------------- 附件和发件箱 ---------------- */

const uploadFiles = new Map<string, File>(); // 附件 id → 选中的文件（失败了重传用）
const uploads = new Map<string, Promise<string>>(); // 附件 id → 正在传 / 传好的服务器路径
const previews = new Map<string, string>(); // 图片的本地地址：占位路径和传好后的真路径都指向它，换过去不闪

/** 图片显示用的地址：自己刚发的图用本地那份（不等下载），别的走服务器。 */
export function photoUrl(path: string): string {
  return previews.get(path) ?? api.fileUrl(path, { thumb: true });
}

/** 输入框里刚选的图：本机原图的地址，还没传完也能看。 */
export function localImage(path: string): string | undefined {
  return previews.get(path);
}

function patchAttachment(id: string, patch: Partial<Attachment>) {
  const fix = (list: Attachment[]) => (list.some((a) => a.id === id) ? list.map((a) => (a.id === id ? { ...a, ...patch } : a)) : list);
  set((s) => ({
    attachments: fix(s.attachments),
    pending: Object.fromEntries(Object.entries(s.pending).map(([k, list]) => [k, list.map((p) => ({ ...p, attachments: fix(p.attachments) }))])),
  }));
}

function startUpload(att: Attachment, target: { assistantId?: string; groupId?: string }): Promise<string> {
  const file = uploadFiles.get(att.id)!;
  const job = api.upload(file, target).then(
    (path) => {
      const preview = previews.get(localPath(att));
      if (preview) previews.set(path, preview);
      patchAttachment(att.id, { status: "done", path });
      return path;
    },
    (e: unknown) => {
      uploads.delete(att.id);
      patchAttachment(att.id, { status: "failed" });
      throw e;
    },
  );
  job.catch(() => {}); // 失败在发送时再报，这里只防未处理的 rejection
  uploads.set(att.id, job);
  return job;
}

/** 选了文件：立刻出现在输入框里（图片用本地缩略图），后台开始传。传进当前会话的目录（助手或群）。 */
export function attach(files: FileList | File[]) {
  const target = state.gsel ? { groupId: state.gsel } : state.sel ? { assistantId: state.sel } : null;
  if (!target) return;
  const added: Attachment[] = Array.from(files).map((file) => {
    const att: Attachment = { id: `att-${Math.random().toString(36).slice(2, 10)}`, name: file.name, status: "uploading" };
    uploadFiles.set(att.id, file);
    if (isImagePath(file.name)) previews.set(localPath(att), URL.createObjectURL(file));
    return att;
  });
  set((s) => ({ attachments: [...s.attachments, ...added] }));
  added.forEach((att) => void startUpload(att, target));
}

export function removeAttachment(id: string) {
  set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) }));
}

/** 等这条消息的附件都传好（失败过的重传），拿到服务器路径。 */
async function uploadedPaths(p: PendingMessage): Promise<string[]> {
  const target = p.group ? { groupId: p.to } : { assistantId: p.to };
  return Promise.all(p.attachments.map((a) => uploads.get(a.id) ?? startUpload(a, target)));
}

function setPending(key: string, localId: string, patch: Partial<PendingMessage> | null) {
  set((s) => {
    const list = s.pending[key] ?? [];
    const next = patch ? list.map((p) => (p.localId === localId ? { ...p, ...patch } : p)) : list.filter((p) => p.localId !== localId);
    return { pending: { ...s.pending, [key]: next } };
  });
}

async function deliver(p: PendingMessage) {
  const key = p.group ? `group:${p.to}` : p.to;
  setPending(key, p.localId, { status: "sending", error: undefined });
  try {
    const files = await uploadedPaths(p);
    const body = { text: p.text, quote: p.quote, files: files.length ? files : undefined };
    // 服务端那条顶替待发的这条：不再播入场动画（已经在屏幕上了）
    if (p.group) {
      const sent = await api.sendGroupMessage(p.to, body);
      set((s) => ({
        pending: { ...s.pending, [key]: (s.pending[key] ?? []).filter((x) => x.localId !== p.localId) },
        groupItems: { ...s.groupItems, [p.to]: mergeItems(s.groupItems[p.to] ?? [], sent.item) as GroupItem[] },
      }));
      return;
    }
    const sent = await api.sendMessage(p.to, body);
    set((s) => ({
      pending: { ...s.pending, [key]: (s.pending[key] ?? []).filter((x) => x.localId !== p.localId) },
      items: { ...s.items, [p.to]: mergeItems(s.items[p.to] ?? [], sent.item) },
    }));
  } catch (e) {
    setPending(key, p.localId, { status: "failed", error: errText(e) });
  }
}

export async function send() {
  const groupId = state.gsel;
  const id = state.sel;
  const text = state.text.trim();
  // 只发图片 / 文件不写字也行（和 Telegram 一样）
  if ((!groupId && !id) || (!text && !state.attachments.length)) return;
  const key = groupId ? `group:${groupId}` : id!;
  const p: PendingMessage = {
    localId: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    to: (groupId ?? id)!,
    ...(groupId ? { group: true as const } : {}),
    at: new Date().toISOString(),
    text,
    ...(state.quote ? { quote: state.quote } : {}),
    attachments: state.attachments,
    status: "sending",
  };
  markFresh([p.localId]);
  set((s) => ({ text: "", quote: null, attachments: [], nonce: s.nonce + 1, pending: { ...s.pending, [key]: [...(s.pending[key] ?? []), p] } }));
  await deliver(p);
}

/** 事项页底部的补充说明：发到群里并引用那张事项卡，所以轮到群主；不点成员的话就由它接。 */
export async function sendProjectNote(groupId: string, project: Project, text: string): Promise<string | null> {
  try {
    const sent = await api.sendGroupMessage(groupId, { text, quote: { itemId: project.itemId, text: `事项「${project.title}」` } });
    set((s) => ({ groupItems: { ...s.groupItems, [groupId]: mergeItems(s.groupItems[groupId] ?? [], sent.item) as GroupItem[] } }));
    return null;
  } catch (e) {
    return errText(e);
  }
}

/** 点了「未送达」的重试。 */export function retryPending(p: PendingMessage) {
  void deliver(p);
}

export function discardPending(p: PendingMessage) {
  setPending(p.group ? `group:${p.to}` : p.to, p.localId, null);
}

/** 对话里要画的条目：服务端的列表 + 还没顶替掉的待发消息。 */
export function chatItems(s: State, assistantId: string | null): Item[] {
  if (!assistantId) return [];
  const pending = s.pending[assistantId] ?? [];
  const items = s.items[assistantId] ?? [];
  return pending.length ? [...items, ...pending.map(pendingItem)] : items;
}

/** 群里的条目同理；发言人是你自己。 */
export function groupChatItems(s: State, groupId: string | null): GroupItem[] {
  if (!groupId) return [];
  const pending = s.pending[`group:${groupId}`] ?? [];
  const items = s.groupItems[groupId] ?? [];
  return pending.length ? [...items, ...pending.map((p) => ({ ...pendingItem(p), speaker: "user" }) as GroupItem)] : items;
}

export function pendingOf(s: State, key: string | null, localId: string): PendingMessage | undefined {
  return key ? s.pending[key]?.find((p) => p.localId === localId) : undefined;
}

export async function stopAssistant(id: string) {
  try {
    await api.stopAssistant(id);
  } catch (e) {
    set({ notice: `停止失败：${errText(e)}` });
  }
}

/* ---------------- 审批 / 草稿 ---------------- */

export async function answer(approvalId: string, answer: AnswerApprovalBody) {
  const ap = state.approvals[approvalId];
  if (!ap) return false;
  // 点下去就先亮起来：选了选项报选项，自己写的报那段话；多问题卡按题显示答案
  set((s) => ({
    approvals: {
      ...s.approvals,
      [approvalId]: {
        ...ap,
        status: "answered",
        ...(answer.answers
          ? { answers: answer.answers, ...(answer.text?.trim() ? { answerText: answer.text.trim() } : {}) }
          : answer.key
            ? { chosen: answer.key }
            : { answerText: (answer.text ?? "").trim() }),
      },
    },
  }));
  try {
    await api.answerApproval(approvalId, answer);
    return true;
  } catch (e) {
    set({ approvals: { ...state.approvals, [approvalId]: ap }, notice: `提交失败：${errText(e)}` });
    return false;
  }
}

export async function createDraft(id: string) {
  try {
    await api.createDraft(id);
  } catch (e) {
    set({ notice: `创建助手失败：${errText(e)}` });
  }
}

export async function dismissDraft(id: string) {
  try {
    await api.dismissDraft(id);
  } catch (e) {
    set({ notice: `撤销失败：${errText(e)}` });
  }
}

/** 归档助手：列表由 assistant_removed 事件更新，正看着它的切到主助手。 */
export async function archiveAssistant(id: string) {
  try {
    await api.archiveAssistant(id);
    const primary = state.assistants.find((a) => a.primary);
    if (state.sel === id && primary) await select(primary.id);
  } catch (e) {
    set({ notice: `归档失败：${errText(e)}` });
  }
}

/* ---------------- 任务 ---------------- */

export async function retryDelegation(id: string) {
  try { await api.retryDelegation(id); }
  catch (e) { set({ notice: `重新转交失败：${errText(e)}` }); }
}

export async function jumpToHandback(assistantId: string, id: string, forwarded: boolean) {
  await jumpToLink(assistantId, id, forwarded ? "forward" : "handback");
}

export async function jumpToDelegation(assistantId: string, id: string, forwarded: boolean) {
  await jumpToLink(assistantId, id, forwarded ? "forward" : "delegation");
}

async function findConversationItem(assistantId: string, matches: (item: Item) => boolean): Promise<boolean> {
  while (state.sel === assistantId && !(state.items[assistantId] ?? []).some(matches) && state.itemPages[assistantId]?.hasMore) {
    const first = state.items[assistantId]?.[0]?.id;
    await loadOlderItems(assistantId);
    if (state.itemPages[assistantId]?.error) throw new Error(state.itemPages[assistantId].error!);
    if (!first || state.items[assistantId]?.[0]?.id === first) break;
  }
  return (state.items[assistantId] ?? []).some(matches);
}

async function jumpToLink(assistantId: string, id: string, kind: "forward" | "delegation" | "handback") {
  if (state.sel !== assistantId || !state.items[assistantId]) await select(assistantId);
  const matches = (item: Item) => kind === "forward" ? item.kind === "user" && item.from?.delegationId === id : kind === "handback" ? item.kind === "note" && item.handbackId === id : item.kind === "delegation" && item.delegationId === id;
  try {
    if (!await findConversationItem(assistantId, matches)) { set({ notice: "未找到对应的转交消息" }); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(`${kind}-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })));
  } catch (e) { set({ notice: `无法定位转交消息：${errText(e)}` }); }
}

export async function replyJob(jobId: string, text: string): Promise<boolean> {
  try {
    await api.replyJob(jobId, text);
    return true;
  } catch (e) {
    set({ notice: `发送失败：${errText(e)}` });
    return false;
  }
}

export async function stopJob(jobId: string) {
  try {
    await api.stopJob(jobId);
  } catch (e) {
    set({ notice: `停止失败：${errText(e)}` });
  }
}

const groupProfileRequests = new Map<string, number>();
function refreshGroupProfiles(assistantId?: string) {
  for (const group of state.groups) if (state.groupProfiles[group.id] && (!assistantId || group.members.includes(assistantId))) void loadGroupProfile(group.id);
}

export async function loadGroupProfile(id: string) {
  const request = (groupProfileRequests.get(id) ?? 0) + 1;
  groupProfileRequests.set(id, request);
  try { const value = await api.groupProfile(id); if (groupProfileRequests.get(id) === request) set((s) => ({ groupProfiles: { ...s.groupProfiles, [id]: { value } } })); }
  catch (e) { if (groupProfileRequests.get(id) === request) set((s) => ({ groupProfiles: { ...s.groupProfiles, [id]: { error: errText(e) } } })); }
}

const skillLoads: Record<string, number> = {};
export async function loadAssistantSkills(id: string) {
  const generation = skillLoads[id] = (skillLoads[id] ?? 0) + 1;
  set((s) => ({ assistantSkills: { ...s.assistantSkills, [id]: { skills: s.assistantSkills[id]?.skills ?? [], loaded: s.assistantSkills[id]?.loaded ?? false, loading: true, error: null } } }));
  try {
    const skills = state.groups.some((group) => group.id === id) ? await api.groupSkills(id) : await api.assistantSkills(id);
    if (skillLoads[id] === generation) set((s) => ({ assistantSkills: { ...s.assistantSkills, [id]: { skills, loaded: true, loading: false, error: null } } }));
  } catch (e) {
    if (skillLoads[id] === generation) set((s) => ({ assistantSkills: { ...s.assistantSkills, [id]: { skills: s.assistantSkills[id]?.skills ?? [], loaded: s.assistantSkills[id]?.loaded ?? false, loading: false, error: errText(e) } } }));
  }
}

export async function changeAssistantSkill(id: string, name: string, action: "enable" | "disable" | "rollback" | "delete") {
  try {
    const group = state.groups.some((item) => item.id === id);
    if (action === "rollback") await (group ? api.rollbackGroupSkill(id, name) : api.rollbackAssistantSkill(id, name));
    else if (action === "delete") await (group ? api.deleteGroupSkill(id, name) : api.deleteAssistantSkill(id, name));
    else await (group ? api.patchGroupSkill(id, name, action === "enable") : api.patchAssistantSkill(id, name, action === "enable"));
    await loadAssistantSkills(id);
  } catch (e) { set({ notice: `操作失败：${errText(e)}` }); }
}

export async function sedimentJob(id: string) {
  try { await api.sedimentJob(id); return true; }
  catch (e) {
    set({ notice: `沉淀失败：${errText(e)}` });
    return false;
  }
}

/* ---------------- 定时任务 ---------------- */

export async function saveRoutine(id: string, patch: Omit<Partial<Routine>, "skill"> & { skill?: string | null }) {
  const before = state.routines.find((r) => r.id === id);
  if (!before) return;
  const { skill, ...rest } = patch;
  set((s) => ({ routines: s.routines.map((r) => r.id === id ? { ...r, ...rest, ...(skill !== undefined ? { skill: skill ?? undefined } : {}) } : r) }));
  try {
    await api.patchRoutine(id, patch);
  } catch (e) {
    set({ routines: state.routines.map((r) => (r.id === id ? before : r)), notice: `保存失败：${errText(e)}` });
  }
}

export async function createRoutine(body: Omit<Routine, "id" | "createdAt" | "runs">) {
  try {
    const { routine } = await api.createRoutine(body);
    set((s) => ({ routines: upsert(s.routines, routine), panelStack: replacePage(s.panelStack, { kind: "routine", id: routine.id }) }));
  } catch (e) {
    set({ notice: `创建失败：${errText(e)}` });
  }
}

export async function deleteRoutine(id: string) {
  try {
    await api.deleteRoutine(id);
  } catch (e) {
    set({ notice: `删除失败：${errText(e)}` });
  }
}

export async function runRoutine(id: string) {
  try {
    const result = await api.runRoutine(id);
    if (result?.outcome === "quiet") set({ notice: "检查过了，没有变化" });
    else if (result?.outcome === "failed") set({ notice: `检查失败：${result.reason ?? "原因未知"}` });
    else if (result?.outcome === "notify") set({ notice: "检查有新内容，已发到对话" });
  } catch (e) {
    set({ notice: `运行失败：${errText(e)}` });
  }
}

/* ---------------- 助手档案 ---------------- */

export async function patchAssistant(id: string, patch: Partial<Assistant>) {
  const before = state.assistants.find((a) => a.id === id);
  const beforeProfile = state.profiles[id];
  if (!before) return "助手不存在。";
  set((s) => ({
    assistants: s.assistants.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    profiles: s.profiles[id]
      ? {
          ...s.profiles,
          [id]: { ...s.profiles[id], assistant: { ...s.profiles[id].assistant, ...patch } },
        }
      : s.profiles,
  }));
  try {
    await api.patchAssistant(id, patch);
    if (patch.models) refreshGroupProfiles(id);
    return null;
  } catch (e) {
    const message = `保存失败：${errText(e)}`;
    set((s) => ({
      assistants: s.assistants.map((a) => (a.id === id ? before : a)),
      profiles: beforeProfile ? { ...s.profiles, [id]: beforeProfile } : s.profiles,
      notice: message,
    }));
    return message;
  }
}

/** 把会话行拖进置顶区：助手写档案，群记在本地。 */
export async function pinConversation(id: string): Promise<string | null> {
  if (state.groups.some((g) => g.id === id)) {
    setGroupPrefs(id, { pinned: true });
    return null;
  }
  const a = state.assistants.find((x) => x.id === id);
  if (!a) return null;
  return patchAssistant(id, a.hidden ? { pinned: true, hidden: false } : { pinned: true });
}

/**
 * 会话列表（置顶区和日常行）换了先后：按新先后把位置写成 0、1、2…。
 * 助手记在档案的 pinOrder 里，群记在本地（Group 契约里没有这个字段）；两边的数字用同一条数轴，
 * 群和助手才能混在一起排。只发变了的几条；保存失败的助手恢复原先顺序并提示。
 */
export async function savePinOrder(ids: string[]): Promise<string | null> {
  const isGroup = (id: string) => state.groups.some((g) => g.id === id);
  const prefs = { ...state.groupPrefs };
  let groupsChanged = false;
  for (const [index, id] of ids.entries()) {
    if (!isGroup(id)) continue;
    const current = prefs[id] ?? { pinned: false };
    if (current.pinOrder === index) continue;
    prefs[id] = { ...current, pinOrder: index };
    groupsChanged = true;
  }
  if (groupsChanged) {
    saveGroupPrefs(prefs);
    set({ groupPrefs: prefs });
  }
  const changed = ids
    .map((id, pinOrder) => ({ id, pinOrder }))
    .filter(({ id }) => !isGroup(id))
    .filter(({ id, pinOrder }) => state.assistants.find((a) => a.id === id)?.pinOrder !== pinOrder);
  if (!changed.length) return null;
  const before = state.assistants;
  set((s) => ({
    assistants: s.assistants.map((a) => {
      const index = ids.indexOf(a.id);
      return index < 0 ? a : { ...a, pinOrder: index };
    }),
  }));
  const results = await Promise.allSettled(changed.map(({ id, pinOrder }) => api.patchAssistant(id, { pinOrder })));
  const failed = changed.filter((_, index) => results[index]?.status === "rejected");
  if (!failed.length) return null;
  const first = results.find((result) => result.status === "rejected");
  const message = `保存失败：${errText(first?.status === "rejected" ? first.reason : "未知错误")}`;
  set((s) => ({
    assistants: s.assistants.map((a) => failed.some((entry) => entry.id === a.id) ? before.find((old) => old.id === a.id) ?? a : a),
    notice: message,
  }));
  return message;
}

export async function addRule(assistantId: string, text: string, mode: "ask" | "allow"): Promise<string | null> {
  if (state.groups.some((group) => group.id === assistantId)) {
    try { await api.patchGroup(assistantId, { rule: { text, mode } }); await loadGroupProfile(assistantId); return null; }
    catch (e) { return `保存失败：${errText(e)}`; }
  }
  try {
    const result = await api.patchAssistant(assistantId, { rule: { text, mode } });
    if (!result?.rule) throw new Error("保存响应缺少规则。");
    const rule = result.rule;
    set((s) => {
      const profile = s.profiles[assistantId];
      if (!profile || profile.rules.some((item) => item.id === rule.id)) return {};
      return { profiles: { ...s.profiles, [assistantId]: { ...profile, rules: [...profile.rules, rule] } } };
    });
    return null;
  } catch (e) {
    return `保存失败：${errText(e)}`;
  }
}

export async function updateRule(assistantId: string, rule: { id: string; text?: string; mode?: "ask" | "allow" }): Promise<string | null> {
  if (state.groups.some((group) => group.id === assistantId)) {
    try { await api.patchGroup(assistantId, { rule }); await loadGroupProfile(assistantId); return null; }
    catch (e) { return `保存失败：${errText(e)}`; }
  }
  try {
    await api.patchAssistant(assistantId, { rule });
    set((s) => {
      const profile = s.profiles[assistantId];
      if (!profile) return {};
      return { profiles: { ...s.profiles, [assistantId]: { ...profile, rules: profile.rules.map((item) => item.id === rule.id ? { ...item, ...rule, changedAt: new Date().toISOString() } : item) } } };
    });
    return null;
  } catch (e) {
    return `保存失败：${errText(e)}`;
  }
}

export async function deleteRule(assistantId: string, ruleId: string) {
  if (state.groups.some((group) => group.id === assistantId)) {
    try { await api.deleteGroupRule(assistantId, ruleId); await loadGroupProfile(assistantId); }
    catch (e) { set({ notice: `删除失败：${errText(e)}` }); }
    return;
  }
  const p = state.profiles[assistantId];
  if (!p) return;
  set((s) => ({
    profiles: { ...s.profiles, [assistantId]: { ...p, rules: p.rules.filter((r) => r.id !== ruleId) } },
  }));
  try {
    await api.deleteRule(assistantId, ruleId);
  } catch (e) {
    set({ profiles: { ...state.profiles, [assistantId]: p }, notice: `删除失败：${errText(e)}` });
  }
}

/* ---------------- 界面状态 ---------------- */

/* ---------------- 任务详情 / 任务记录 ---------------- */

/** 详情页要全文时拉 transcript（从任务会话推导，长输出已落盘）。 */
export async function loadTranscript(jobId: string) {
  try {
    const { job, steps } = await api.transcript(jobId);
    set((s) => ({
      jobs: { ...s.jobs, [job.id]: job },
      steps: { ...s.steps, [job.id]: s.steps[job.id] ? mergeSteps(s.steps[job.id], steps) : steps },
    }));
  } catch (e) {
    set({ notice: `无法加载任务过程：${errText(e)}` });
  }
}

/** instant：和换对话一起打开，跟着对话直接出现，不再滑入 */
export function openJob(id: string, round?: number, instant = false) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "job", id, round, ...(instant ? { instant } : {}) }) }));
  void loadTranscript(id);
}

/** 任务记录：从右栏进来时只看这个助手的，从首页「全部」进来看所有助手的。 */
export function openJobs(assistantId: string | null = null) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "jobs" }) }));
  void loadWorklog({ assistantId, status: null });
}

export function backPanel() {
  const top = state.panelStack.at(-1);
  if (top?.kind === "file" && top.liveId) closedLivePages.add(top.liveId);
  set((s) => ({ panelStack: popPage(s.panelStack) }));
}

export function closePanelPages() {
  for (const page of state.panelStack) if (page.kind === "file" && page.liveId) closedLivePages.add(page.liveId);
  set({ panelStack: [] });
}

let worklogRequest = 0;

export async function loadWorklog(filter: { assistantId?: string | null; status?: JobStatus | null } = {}) {
  const request = ++worklogRequest;
  const assistantId = filter.assistantId ?? null;
  const status = filter.status ?? null;
  set({ worklog: { jobs: [], assistantId, status, hasMore: false, loading: true } });
  try {
    const page = await api.jobs({
      ...(assistantId ? { assistantId } : {}),
      ...(status ? { status } : {}),
      limit: 30,
    });
    if (request === worklogRequest) applyJobsPage(page, assistantId, status);
  } catch (e) {
    if (request === worklogRequest) set({ worklog: null, notice: `无法加载任务记录：${errText(e)}` });
  }
}

/** 往下滚时接一页。 */
export async function moreWorklog() {
  const log = state.worklog;
  if (!log || !log.hasMore || log.loading) return;
  const request = worklogRequest;
  const last = log.jobs[log.jobs.length - 1];
  set({ worklog: { ...log, loading: true } });
  try {
    const page = await api.jobs({
      ...(log.assistantId ? { assistantId: log.assistantId } : {}),
      ...(log.status ? { status: log.status } : {}),
      ...(last ? { before: last.id } : {}),
      limit: 30,
    });
    if (request === worklogRequest) applyJobsPage(page, log.assistantId, log.status);
  } catch (e) {
    if (request === worklogRequest) set((s) => ({ worklog: s.worklog ? { ...s.worklog, loading: false } : null, notice: `无法加载更多：${errText(e)}` }));
  }
}

/** 翻页结果接到列表后面（第一页直接替换），并把任务合并进 jobs 里好吃实时更新。 */
function applyJobsPage(page: JobsPage, assistantId: string | null, status: JobStatus | null) {
  set((s) => {
    const known = new Set((s.worklog?.jobs ?? []).map((job) => job.id));
    const jobs = s.worklog && s.worklog.assistantId === assistantId && s.worklog.status === status ? [...s.worklog.jobs, ...page.jobs.filter((job) => !known.has(job.id))] : page.jobs;
    return {
      worklog: { jobs, assistantId, status, hasMore: page.hasMore, loading: false },
      jobs: { ...s.jobs, ...index(page.jobs) },
    };
  });
}

export function focusComposer() {
  set({ nonce: state.nonce + 1, mobile: "chat", sheet: false });
}

/** 新建助手：进主助手的对话，输入框写好开头（助手由主助手按对话创建）。 */
export function newAssistant() {
  const primary = state.assistants.find((a) => a.primary);
  if (!primary) return;
  void select(primary.id);
  set({ text: "我想创建一个专属助手，负责：", nonce: state.nonce + 1, mobile: "chat", sheet: false });
}

/** 从定时运行记录打开任务所在对话及详情。 */
export async function jumpToJob(assistantId: string, jobId: string) {
  if (!state.jobs[jobId]) await loadTranscript(jobId);
  const job = state.jobs[jobId];
  if (!job) return;
  if (job.groupId && state.groups.some((group) => group.id === job.groupId)) await selectGroup(job.groupId, true, true, true);
  else if (state.assistants.some((assistant) => assistant.id === assistantId)) await select(assistantId, true, true);
  openJob(jobId);
}

export function openRoutine(id: string) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "routine", id }) }));
}

export function openNewRoutine() {
  const page = state.panelStack.at(-1);
  const groupId = page?.kind === "routines" ? page.groupId : undefined;
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "newRoutine", groupId }) }));
}

/** 打开一个事项页（群信息、事项卡都走它）。 */
export function openProject(groupId: string, id: string) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "project", groupId, id }) }));
  if (!state.projects[groupId]) void loadProjects(groupId, true);
}

/** 用户点了拆分卡片或事项页的「开始执行」：和 start_subtasks 走同一段。 */
export async function startProject(project: Pick<Project, "groupId" | "id">): Promise<string | null> {
  try {
    const saved = await api.startProject(project.groupId, project.id);
    set((s) => ({ projects: { ...s.projects, [project.groupId]: upsertProject(s.projects[project.groupId], saved) } }));
    return null;
  } catch (e) {
    return errText(e);
  }
}

/** 用户的子任务：按钮点了等服务器回来再改（不先改界面）。 */
export async function doneSubtask(project: Project, n: number): Promise<string | null> {
  try {
    const saved = await api.doneSubtask(project.groupId, project.id, n);
    set((s) => ({ projects: { ...s.projects, [project.groupId]: upsertProject(s.projects[project.groupId], saved) } }));
    return null;
  } catch (e) {
    return errText(e);
  }
}

/** 群信息里点成员：右栏推进这个助手的信息页（返回回到群信息），群聊不动。 */export function openMemberPanel(id: string) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "member", id }) }));
  void loadProfile(id);
}

export function openGroupSettings(id: string) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "groupSettings", id }) }));
}

export function openAssistantPanel() {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "assistant" }) }));
}

export function openSidebarPage(kind: "routines" | "skills" | "knowledge" | "rules", groupId?: string) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind, groupId }) }));
}

async function loadSidebarPage(kind: "sidebarJobs" | "sidebarFiles", assistantId: string, more: boolean) {
  const empty = { items: [], loaded: false, loading: false, loadingMore: false, hasMore: false, error: null };
  const previous = state[kind][assistantId] ?? empty;
  if (previous.loading || (more && (!previous.loaded || !previous.hasMore))) return;
  set((s) => ({ [kind]: { ...s[kind], [assistantId]: { ...previous, loading: true, loadingMore: more, error: null } } }));
  try {
    const before = more ? previous.cursor : undefined;
    const isGroup = state.groups.some((group) => group.id === assistantId);
    const scope = isGroup ? { groupId: assistantId } : { assistantId, groupId: "none" };
    const page = kind === "sidebarJobs"
      ? await api.jobs({ ...scope, before, limit: 20 }).then((p) => ({ items: p.jobs, hasMore: p.hasMore }))
      : await api.knowledge({ origin: "output", ...scope, before, limit: 30 }).then((p) => ({ items: p.entries, hasMore: p.hasMore }));
    const combined = more ? [...previous.items, ...page.items] : [...page.items, ...previous.items];
    const seen = new Set<string>();
    const items = combined.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
    const last = page.items.at(-1);
    const cursor = more || !previous.loaded ? (last && ("createdAt" in last && kind === "sidebarJobs" ? last.id : (last as KnowledgeEntry).updatedAt)) : previous.cursor;
    const hasMore = more || !previous.loaded ? page.hasMore : previous.hasMore || page.hasMore;
    set((s) => ({ [kind]: { ...s[kind], [assistantId]: { items, loaded: true, loading: false, loadingMore: false, hasMore, error: null, cursor } } }));
  } catch (e) {
    set((s) => ({ [kind]: { ...s[kind], [assistantId]: { ...previous, loading: false, loadingMore: false, failedMore: more, error: errText(e) } } }));
  }
}

export function loadSidebarJobs(assistantId: string, more = false) { return loadSidebarPage("sidebarJobs", assistantId, more); }
export function loadSidebarFiles(assistantId: string, more = false) { return loadSidebarPage("sidebarFiles", assistantId, more); }

let collectionsVersion = 0;
let collectionsRequest: Promise<void> | undefined;
export async function loadSidebarCollections(): Promise<void> {
  if (state.knowledge.collectionsLoaded) return;
  if (collectionsRequest) {
    await collectionsRequest;
    if (!state.knowledge.collectionsLoaded) return loadSidebarCollections();
    return;
  }
  const version = collectionsVersion;
  collectionsRequest = (async () => {
    const page = await api.knowledge({ limit: 1 });
    if (version === collectionsVersion) set((s) => ({ knowledge: { ...s.knowledge, collections: page.collections, collectionsLoaded: true } }));
  })();
  try { await collectionsRequest; } finally { collectionsRequest = undefined; }
  if (!state.knowledge.collectionsLoaded) await loadSidebarCollections();
}

/** 助手头像 / 助手行上的右键（桌面）或长按（手机）菜单。 */
export function openAssistantMenu(id: string, x: number, y: number) {
  set({ menu: { id, x, y } });
}

export function closeAssistantMenu() {
  if (state.menu) set({ menu: null });
}

let knowledgeRequest = 0;
export async function loadKnowledge(more = false, refresh = false) {
  if (more && (state.knowledge.loading || !state.knowledge.hasMore)) return;
  const k = state.knowledge;
  const request = ++knowledgeRequest;
  set({ knowledge: { ...k, loading: more || k.entries.length === 0, error: null } });
  try {
    const page = await api.knowledge({ ...(k.category === "output" || k.category === "chat" ? { origin: k.category } : k.category !== "all" ? { collection: k.category } : {}), q: k.q, kind: k.kind || undefined, assistantId: k.assistantId, before: more ? k.entries.at(-1)?.updatedAt : undefined, limit: refresh ? Math.min(200, Math.max(50, k.entries.length)) : 50 });
    if (request !== knowledgeRequest) return;
    set({ knowledge: { ...state.knowledge, entries: more ? [...k.entries, ...page.entries] : page.entries, collections: page.collections, collectionsLoaded: true, hasMore: page.hasMore, loading: false } });
  } catch (e) {
    if (request === knowledgeRequest) set({ knowledge: { ...state.knowledge, loading: false, error: errText(e) } });
  }
}
export function setKnowledgeFilter(patch: Partial<Pick<State["knowledge"], "category" | "q" | "kind" | "assistantId">>) {
  // 旧结果的 hasMore 不适用于新条件：新的一页回来前不许接着往下翻，免得新旧条目拼在一起
  set({ knowledge: { ...state.knowledge, ...patch, hasMore: false } });
  void loadKnowledge();
}
export async function createKnowledgeCollection(name: string, select = true) {
  try {
    const collection = await api.createKnowledgeCollection(name.trim());
    if (select) setKnowledgeFilter({ category: collection.id });
    else await loadKnowledge(false, true);
    return collection;
  } catch (e) { set({ notice: `新建失败：${errText(e)}` }); return null; }
}
export async function renameKnowledgeCollection(id: string, name: string) {
  try { await api.renameKnowledgeCollection(id, name.trim()); await loadKnowledge(false, true); return true; }
  catch (e) { set({ notice: `改名失败：${errText(e)}` }); return false; }
}
export async function deleteKnowledgeCollection(id: string) {
  try {
    const { deleted } = await api.deleteKnowledgeCollection(id);
    if (state.knowledge.category === id) setKnowledgeFilter({ category: "all" });
    else await loadKnowledge(false, true);
    set({ notice: deleted ? `已删除知识库，一起删掉 ${deleted} 个文件` : "已删除知识库" });
  } catch (e) { set({ notice: `删除失败：${errText(e)}` }); }
}
export async function patchKnowledgeEntry(id: string, patch: { name?: string; collections?: string[] }) {
  try { await api.patchKnowledgeEntry(id, patch); await loadKnowledge(false, true); return true; }
  catch (e) { set({ notice: `保存失败：${errText(e)}` }); return false; }
}
export async function deleteKnowledgeEntry(id: string) {
  try { await api.deleteKnowledgeEntry(id); await loadKnowledge(false, true); }
  catch (e) { set({ notice: `删除失败：${errText(e)}` }); }
}
export async function uploadKnowledge(collection: string, files: File[]) {
  try { await api.uploadKnowledge(collection, files); await loadKnowledge(false, true); }
  catch (e) { set({ notice: `上传失败：${errText(e)}` }); }
}
export function openKnowledge() {
  set({ page: "knowledge", panelStack: [], sheet: false });
  void loadKnowledge();
}
export function closeKnowledge() { goHome(); }
export async function jumpToItem(assistantId: string, itemId: string) {
  set({ page: "main", panelStack: [] });
  await select(assistantId);
  try {
    if (!await findConversationItem(assistantId, (item) => item.id === itemId)) { set({ notice: "未找到对应的对话消息" }); return; }
    const deadline = performance.now() + 1500;
    const locate = () => {
      if (state.page !== "main" || state.sel !== assistantId) return;
      const el = Array.from(document.querySelectorAll<HTMLElement>("[data-item-id]")).find((node) => node.dataset.itemId === itemId);
      if (!el) {
        if (performance.now() < deadline) requestAnimationFrame(locate);
        else set({ notice: "没能定位到这条消息" });
        return;
      }
      flashItem(el);
    };
    requestAnimationFrame(locate);
  } catch (e) { set({ notice: `无法定位对话消息：${errText(e)}` }); }
}

export function openSettings() {
  set({ page: "settings", section: null, sub: null, sheet: false, search: false, panelStack: [] });
}

export function closeSettings() {
  goHome();
}

/** 桌面点了左导航 / 手机点了列表里的一项。 */
export function setSection(section: SettingsSection | null) {
  set({ section, sub: null });
}

export function openSub(sub: SettingsSub) {
  set({ sub });
}

export function closeSub() {
  set({ sub: null });
}

export function toggleNowWide() {
  set((s) => ({ nowWide: !s.nowWide }));
}

export function collapsePanel() {
  set({ collapsed: true, sheet: false });
}

export function expandPanel() {
  set({ collapsed: false, panelStack: [] });
}

export function setQuery(query: string) {
  set({ query });
}

export function setMobile(page: MobilePage) {
  set({ mobile: page, sheet: false, search: false });
}

/** 手机上从对话返回：群里的对话先回话题列表，单聊回首页。 */
export function leaveChat() {
  set({ mobile: state.gsel ? "topics" : "list" });
}

/** 手机上从话题列表返回首页。 */
export function leaveTopicList() {
  set({ mobile: "list", gsel: null, sideHome: true });
}

export function openSheet() {
  set({ sheet: true });
}

export function closeSheet() {
  set({ sheet: false });
}

export function setSearch(on: boolean) {
  set({ search: on, query: on ? state.query : "" });
}

export function clearNotice() {
  set({ notice: null });
}

/** 一次性提示（操作失败的原因等），由底部浮层显示。 */
export function setNotice(text: string) {
  set({ notice: text });
}

/** 新版本已就绪：只提示，等用户点更新。 */
export function markUpdateReady() {
  set({ updateReady: true });
}

export function tick() {
  set({ tick: state.tick + 1 });
}

export function fileUrl(path: string, opts?: { inline?: boolean; truncate?: boolean; thumb?: boolean }): string {
  return api.fileUrl(path, opts);
}

/* ---------------- 文件预览 ---------------- */

/** 拿一个文件的预览元数据（类型、是否文本），失败时抛 ApiError。 */
export function fetchFileMeta(path: string): Promise<FileMeta> {
  return api.fileMeta(path);
}

/** 读取工作目录的一层；错误交给目录视图就地显示。 */
export function loadJobFiles(jobId: string, path?: string): Promise<JobFilesView> {
  return api.jobFiles(jobId, path);
}

/** 打开文件预览（盖在最上层；点 esc 或背景关闭）。 */
export function openFilePreview(path: string, title?: string, location?: { find?: string; page?: number }) {
  // 图片（含 svg）直接全屏看，不进侧栏预览
  if (isImagePath(path) || path.toLowerCase().endsWith(".svg")) return set({ viewer: { path, name: title ?? path.split("/").pop() ?? path } });
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "file", path, full: false, ...(title ? { title } : {}), ...location }) }));
}

export function closeImageViewer() {
  set({ viewer: null });
}

export function openLivePreview(callId: string) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "file", path: "", full: false, liveId: callId }) }));
}

/** 桌面右栏和全宽之间切换（文件预览、任务详情）。 */
export function togglePreviewFull() {
  set((s) => {
    const top = s.panelStack.at(-1);
    return top?.kind === "file" || top?.kind === "job" ? { panelStack: replacePage(s.panelStack, { ...top, full: !top.full }) } : {};
  });
}
