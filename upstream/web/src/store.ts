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
  ProviderImportView,
  ProvidersView,
  PushView,
  Routine,
  Rule,
  SendMessageBody,
  Settings,
  SettingsFile,
  SettingsPatch,
  ThinkingLevelMapSetting,
  TokenPrice,
  UsageModelPrice,
  UsageView,
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
  | { kind: "routines" | "skills" | "knowledge" | "rules" };
export interface WorklogState {
  jobs: Job[];
  assistantId: string | null;
  status: JobStatus | null;
  hasMore: boolean;
  loading: boolean;
}
export type MobilePage = "list" | "chat";
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

export interface State {
  phase: "loading" | "login" | "ready" | "error";
  error: string | null; // 致命错误（无法连接后端）
  notice: string | null; // 一次性的操作失败提示
  offline: string | null; // 实时连接断开
  assistants: AssistantSummary[];
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
  profiles: Record<string, Profile>;
  assistantSkills: Record<string, { skills: AssistantSkill[]; loaded: boolean; loading: boolean; error: string | null }>;
  sidebarJobs: Record<string, SidebarPage<Job>>;
  sidebarFiles: Record<string, SidebarPage<KnowledgeEntry>>;
  sel: string | null;
  panelStack: PanelPage[];
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
const SCENES: SceneId[] = ["readme-chat", "readme-cards", "readme-dark", "readme-rules", "readme-desktop", "readme-page", "readme-knowledge", "readme-list", "readme-question", "readme-profile", "image", "act-demo", "act-think", "act-tool", "act-dark", "act-home", "boot", "bubbles", "bubbles-dark", "card-130", "card-130-dark", "routine-check-dark", "routine-once", "routine-once-dark", "routine-once-list", "s1", "s2", "s3", "s4", "s6", "mlist", "mchat", "d-running", "d-waiting", "d-done", "d-dark", "d-source", "d-mobile", "h-hob", "h-dark", "h-source", "h-settings", "h-mobile"];
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
  return { kind: "now" };
}

function storedTheme(): Theme | null {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : null;
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
    assistantSkills: {},
    sidebarJobs: {},
    sidebarFiles: {},
    sel: "hob",
    panelStack: [],
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
    state.sel = ui.sel;
    const panel = parsePanel(ui.panel);
    state.panelStack = panel.kind === "now" ? [] : [panel];
    state.collapsed = ui.collapsed;
    state.mobile = ui.mobile;
    state.theme = ui.dark ? "dark" : "light";
  }
  const aParam = params.get("a");
  if (aParam) state.sel = aParam;
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

async function loadBootstrap() {
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
            void loadBootstrap();
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
    if (sel) await select(sel, mobileWantsChat());
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
      break;
    case "knowledge":
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

/** 页面在前台就不推（服务端根据这个决定）。只存内存，SSE 断开会自动清掉。 */
function reportVisibility(): void {
  void api.visibility(CLIENT_ID, document.visibilityState === "visible").catch(() => undefined);
  // 切回来时正开着的那个助手攒下的未读算看过了
  const a = state.assistants.find((x) => x.id === state.sel);
  if (a && a.unread > 0 && viewing(a.id)) {
    set((s) => ({ assistants: s.assistants.map((x) => (x.id === a.id ? { ...x, unread: 0 } : x)) }));
    void api.markRead(a.id).catch(() => {});
  }
}

/** 用户正看着这个助手的对话：页面在前台、在主界面，手机上要进了对话页。 */
function viewing(id: string): boolean {
  return state.sel === id && state.page === "main" && globalThis.document?.visibilityState === "visible" && (window.innerWidth >= 768 || state.mobile === "chat");
}

function watchVisibility(): void {
  if (watchingVisibility) return;
  watchingVisibility = true;
  document.addEventListener("visibilitychange", reportVisibility);
  reportVisibility();
}

/* ---------------- 数据 ---------------- */

export async function select(id: string, nav = true, keepStack = false) {
  set((s) => ({
    sel: id,
    panelStack: selectPanelStack(s.panelStack, s.sel, id, keepStack),
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

function patchAttachment(id: string, patch: Partial<Attachment>) {
  const fix = (list: Attachment[]) => (list.some((a) => a.id === id) ? list.map((a) => (a.id === id ? { ...a, ...patch } : a)) : list);
  set((s) => ({
    attachments: fix(s.attachments),
    pending: Object.fromEntries(Object.entries(s.pending).map(([k, list]) => [k, list.map((p) => ({ ...p, attachments: fix(p.attachments) }))])),
  }));
}

function startUpload(att: Attachment, assistantId: string): Promise<string> {
  const file = uploadFiles.get(att.id)!;
  const job = api.upload(file, assistantId).then(
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

/** 选了文件：立刻出现在输入框里（图片用本地缩略图），后台开始传。传进当前选中的助手目录。 */
export function attach(files: FileList | File[], assistantId: string) {
  const added: Attachment[] = Array.from(files).map((file) => {
    const att: Attachment = { id: `att-${Math.random().toString(36).slice(2, 10)}`, name: file.name, status: "uploading" };
    uploadFiles.set(att.id, file);
    if (isImagePath(file.name)) previews.set(localPath(att), URL.createObjectURL(file));
    return att;
  });
  set((s) => ({ attachments: [...s.attachments, ...added] }));
  added.forEach((att) => void startUpload(att, assistantId));
}

export function removeAttachment(id: string) {
  set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) }));
}

/** 等这条消息的附件都传好（失败过的重传），拿到服务器路径。 */
async function uploadedPaths(p: PendingMessage): Promise<string[]> {
  return Promise.all(p.attachments.map((a) => uploads.get(a.id) ?? startUpload(a, p.assistantId)));
}

function setPending(assistantId: string, localId: string, patch: Partial<PendingMessage> | null) {
  set((s) => {
    const list = s.pending[assistantId] ?? [];
    const next = patch ? list.map((p) => (p.localId === localId ? { ...p, ...patch } : p)) : list.filter((p) => p.localId !== localId);
    return { pending: { ...s.pending, [assistantId]: next } };
  });
}

async function deliver(p: PendingMessage) {
  setPending(p.assistantId, p.localId, { status: "sending", error: undefined });
  try {
    const files = await uploadedPaths(p);
    const sent = await api.sendMessage(p.assistantId, { text: p.text, quote: p.quote, files: files.length ? files : undefined });
    // 服务端那条顶替待发的这条：不再播入场动画（已经在屏幕上了）
    set((s) => ({
      pending: { ...s.pending, [p.assistantId]: (s.pending[p.assistantId] ?? []).filter((x) => x.localId !== p.localId) },
      ...(sent?.item ? { items: { ...s.items, [p.assistantId]: mergeItems(s.items[p.assistantId] ?? [], sent.item) } } : {}),
    }));
  } catch (e) {
    setPending(p.assistantId, p.localId, { status: "failed", error: errText(e) });
  }
}

export async function send() {
  const id = state.sel;
  const text = state.text.trim();
  // 只发图片 / 文件不写字也行（和 Telegram 一样）
  if (!id || (!text && !state.attachments.length)) return;
  const p: PendingMessage = {
    localId: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    assistantId: id,
    at: new Date().toISOString(),
    text,
    ...(state.quote ? { quote: state.quote } : {}),
    attachments: state.attachments,
    status: "sending",
  };
  markFresh([p.localId]);
  set((s) => ({ text: "", quote: null, attachments: [], nonce: s.nonce + 1, pending: { ...s.pending, [id]: [...(s.pending[id] ?? []), p] } }));
  await deliver(p);
}

/** 点了「未送达」的重试。 */
export function retryPending(assistantId: string, localId: string) {
  const p = state.pending[assistantId]?.find((x) => x.localId === localId);
  if (p) void deliver(p);
}

export function discardPending(assistantId: string, localId: string) {
  setPending(assistantId, localId, null);
}

/** 对话里要画的条目：服务端的列表 + 还没顶替掉的待发消息。 */
export function chatItems(s: State, assistantId: string | null): Item[] {
  if (!assistantId) return [];
  const pending = s.pending[assistantId] ?? [];
  const items = s.items[assistantId] ?? [];
  return pending.length ? [...items, ...pending.map(pendingItem)] : items;
}

export function pendingOf(s: State, assistantId: string | null, localId: string): PendingMessage | undefined {
  return assistantId ? s.pending[assistantId]?.find((p) => p.localId === localId) : undefined;
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
  if (!ap) return;
  // 点下去就先亮起来：选了选项报选项，自己写的报那段话
  set((s) => ({
    approvals: {
      ...s.approvals,
      [approvalId]: {
        ...ap,
        status: "answered",
        ...(answer.key ? { chosen: answer.key } : { answerText: (answer.text ?? "").trim() }),
      },
    },
  }));
  try {
    await api.answerApproval(approvalId, answer);
  } catch (e) {
    set({ approvals: { ...state.approvals, [approvalId]: ap }, notice: `提交失败：${errText(e)}` });
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

const skillLoads: Record<string, number> = {};
export async function loadAssistantSkills(id: string) {
  const generation = skillLoads[id] = (skillLoads[id] ?? 0) + 1;
  set((s) => ({ assistantSkills: { ...s.assistantSkills, [id]: { skills: s.assistantSkills[id]?.skills ?? [], loaded: s.assistantSkills[id]?.loaded ?? false, loading: true, error: null } } }));
  try {
    const skills = await api.assistantSkills(id);
    if (skillLoads[id] === generation) set((s) => ({ assistantSkills: { ...s.assistantSkills, [id]: { skills, loaded: true, loading: false, error: null } } }));
  } catch (e) {
    if (skillLoads[id] === generation) set((s) => ({ assistantSkills: { ...s.assistantSkills, [id]: { skills: s.assistantSkills[id]?.skills ?? [], loaded: s.assistantSkills[id]?.loaded ?? false, loading: false, error: errText(e) } } }));
  }
}

export async function changeAssistantSkill(id: string, name: string, action: "enable" | "disable" | "rollback" | "delete") {
  try {
    if (action === "rollback") await api.rollbackAssistantSkill(id, name);
    else if (action === "delete") await api.deleteAssistantSkill(id, name);
    else await api.patchAssistantSkill(id, name, action === "enable");
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
  const before = new Set(state.routines.map((r) => r.id));
  let created: Routine | undefined;
  try {
    created = await api.createRoutine(body);
  } catch (e) {
    set({ notice: `创建失败：${errText(e)}` });
    return;
  }
  const added = created?.id ? created : state.routines.find((r) => !before.has(r.id));
  if (added) set((s) => ({ panelStack: replacePage(s.panelStack, { kind: "routine", id: added.id }) }));
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

/**
 * 置顶头像换了先后：按新先后把位置写成 0、1、2…（下标）存进各助手的档案。
 * 只发变了的几条；有任何一条没存上，把整套先后退回并提示。
 */
export async function savePinOrder(ids: string[]): Promise<string | null> {
  const changed = ids
    .map((id, index) => ({ id, pinOrder: index }))
    .filter(({ id, pinOrder }) => state.assistants.find((a) => a.id === id)?.pinOrder !== pinOrder);
  if (!changed.length) return null;
  const before = state.assistants;
  set((s) => ({
    assistants: s.assistants.map((a) => {
      const index = ids.indexOf(a.id);
      return index < 0 ? a : { ...a, pinOrder: index };
    }),
  }));
  try {
    await Promise.all(changed.map(({ id, pinOrder }) => api.patchAssistant(id, { pinOrder })));
    return null;
  } catch (e) {
    const message = `保存失败：${errText(e)}`;
    set({ assistants: before, notice: message });
    return message;
  }
}

export async function addRule(assistantId: string, text: string, mode: "ask" | "allow"): Promise<string | null> {
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

export function openJob(id: string, round?: number) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "job", id, round }) }));
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

export async function loadWorklog(filter: { assistantId?: string | null; status?: JobStatus | null } = {}) {
  const assistantId = filter.assistantId ?? null;
  const status = filter.status ?? null;
  set({ worklog: { jobs: [], assistantId, status, hasMore: false, loading: true } });
  try {
    const page = await api.jobs({
      ...(assistantId ? { assistantId } : {}),
      ...(status ? { status } : {}),
      limit: 30,
    });
    applyJobsPage(page, assistantId, status);
  } catch (e) {
    set({ worklog: null, notice: `无法加载任务记录：${errText(e)}` });
  }
}

/** 往下滚时接一页。 */
export async function moreWorklog() {
  const log = state.worklog;
  if (!log || !log.hasMore || log.loading) return;
  const last = log.jobs[log.jobs.length - 1];
  set({ worklog: { ...log, loading: true } });
  try {
    const page = await api.jobs({
      ...(log.assistantId ? { assistantId: log.assistantId } : {}),
      ...(log.status ? { status: log.status } : {}),
      ...(last ? { before: last.id } : {}),
      limit: 30,
    });
    applyJobsPage(page, log.assistantId, log.status);
  } catch (e) {
    set((s) => ({ worklog: s.worklog ? { ...s.worklog, loading: false } : null, notice: `无法加载更多：${errText(e)}` }));
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

/** 从定时任务运行记录跳到对话里那条任务卡片；找不到就什么都不做。 */
export async function jumpToJob(assistantId: string, jobId: string) {
  if (state.sel !== assistantId || !state.items[assistantId]) await select(assistantId);
  requestAnimationFrame(() => {
    document.getElementById(`job-${jobId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

export function openRoutine(id: string) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "routine", id }) }));
}

export function openNewRoutine() {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "newRoutine" }) }));
}

export function openAssistantPanel() {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "assistant" }) }));
}

export function openSidebarPage(kind: "routines" | "skills" | "knowledge" | "rules") {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind }) }));
}

async function loadSidebarPage(kind: "sidebarJobs" | "sidebarFiles", assistantId: string, more: boolean) {
  const empty = { items: [], loaded: false, loading: false, loadingMore: false, hasMore: false, error: null };
  const previous = state[kind][assistantId] ?? empty;
  if (previous.loading || (more && (!previous.loaded || !previous.hasMore))) return;
  set((s) => ({ [kind]: { ...s[kind], [assistantId]: { ...previous, loading: true, loadingMore: more, error: null } } }));
  try {
    const before = more ? previous.cursor : undefined;
    const page = kind === "sidebarJobs"
      ? await api.jobs({ assistantId, before, limit: 20 }).then((p) => ({ items: p.jobs, hasMore: p.hasMore }))
      : await api.knowledge({ origin: "output", assistantId, before, limit: 30 }).then((p) => ({ items: p.entries, hasMore: p.hasMore }));
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

let sidebarCollectionsLoaded = false;
export async function loadSidebarCollections() {
  if (sidebarCollectionsLoaded) return;
  const page = await api.knowledge({ limit: 1 });
  sidebarCollectionsLoaded = true;
  set((s) => ({ knowledge: { ...s.knowledge, collections: page.collections, collectionsLoaded: true } }));
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
export function closeKnowledge() { set({ page: "main", panelStack: [] }); }
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
  set({ page: "main", panelStack: [] });
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
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "file", path, full: false, ...(title ? { title } : {}), ...location }) }));
}

export function openLivePreview(callId: string) {
  set((s) => ({ panelStack: pushPage(s.panelStack, { kind: "file", path: "", full: false, liveId: callId }) }));
}

/** 桌面右栏和全宽之间切换。 */
export function togglePreviewFull() {
  set((s) => {
    const top = s.panelStack.at(-1);
    return top?.kind === "file" ? { panelStack: replacePage(s.panelStack, { ...top, full: !top.full }) } : {};
  });
}
