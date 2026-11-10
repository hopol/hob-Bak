// 真实客户端：REST 路由见 docs/architecture.md，事件契约见 shared/types.ts。
import type {
  AboutInfo,
  AnswerApprovalBody,
  Assistant,
  Bootstrap,
  ClaudeCodeSettings,
  ClaudeCodeView,
  DiscoveredModels,
  Draft,
  DesktopView,
  DesktopTestResult,
  HobEvent,
  EmbeddingSettings,
  EmbeddingKeyView,
  EmbeddingSettingsSaved,
  EmbeddingTestResult,
  ImageKeyView,
  ImageSettings,
  ImageSettingsSaved,
  ImageTestResult,
  Item,
  ItemsPage,
  JobFilesView,
  JobsPage,
  JobStatus,
  JobTranscript,
  FileMeta,
  ModelsView,
  LoreImportView,
  LoreTestResult,
  MemoryConfig,
  MemoryProvider,
  ModelThinkingPatch,
  ModelThinkingSaved,
  Profile,
  ProviderImportView,
  ProvidersView,
  PushSubscriptionJson,
  PushView,
  Routine,
  RoutineTick,
  Rule,
  SendMessageBody,
  SettingsFile,
  SettingsPatch,
  UsagePricePatch,
  UsagePriceSaved,
  UsageView,
} from "../../shared/types.ts";

import type { KnowledgeCollection, KnowledgeEntry, KnowledgeGroup, KnowledgeOrigin, KnowledgePage, KnowledgeEntryView } from "../../shared/knowledge.ts";

import type { AssistantSkill, SkillImportResult, SkillImportSource, SkillImportView, SkillsView } from "../../shared/skills.ts";
import type { SearchSettings, SearchView } from "../../shared/search.ts";
import type { McpImportResult, McpImportView, McpSecretMutation, McpServerPatch, McpServerSave, McpServerView, McpTestResult, McpView } from "../../shared/mcp.ts";

export type KnowledgeQuery = { origin?: KnowledgeOrigin; collection?: string; kind?: KnowledgeGroup; assistantId?: string; q?: string; before?: string; limit?: number };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    throw new ApiError(0, `无法连接 Hob：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* 非 JSON 错误体，保留状态码 */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function json(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export interface EventHandlers {
  onEvent(ev: HobEvent): void;
  onReconnect(): void;
  onDown(reason: string): void;
}

export interface HobApi {
  knowledge(query?: KnowledgeQuery): Promise<KnowledgePage>;
  knowledgeEntry(id: string, chunk?: number): Promise<KnowledgeEntryView>;
  reindexKnowledge(id: string): Promise<{ ok: true }>;
  embeddingKey(): Promise<EmbeddingKeyView>;
  putEmbedding(revision: number, embedding: EmbeddingSettings, apiKey?: string): Promise<EmbeddingSettingsSaved>;
  embeddingTest(body: { embedding?: EmbeddingSettings; apiKey?: string }): Promise<EmbeddingTestResult>;
  createKnowledgeCollection(name: string): Promise<KnowledgeCollection>;
  renameKnowledgeCollection(id: string, name: string): Promise<KnowledgeCollection>;
  deleteKnowledgeCollection(id: string): Promise<{ deleted: number }>;
  patchKnowledgeEntry(id: string, patch: { name?: string; collections?: string[] }): Promise<KnowledgeEntry>;
  deleteKnowledgeEntry(id: string): Promise<{ ok: true }>;
  uploadKnowledge(collection: string, files: File[]): Promise<{ entries: KnowledgeEntry[] }>;
  me(): Promise<void>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  bootstrap(): Promise<Bootstrap>;
  settings(): Promise<SettingsFile>;
  rules(): Promise<{ rules: Rule[] }>;
  saveRules(rules: { id?: string; text: string; mode: Rule["mode"] }[]): Promise<{ rules: Rule[] }>;
  models(): Promise<ModelsView>;
  putSettings(revision: number, patch: SettingsPatch): Promise<SettingsFile>;
  providers(): Promise<ProvidersView>;
  claude(): Promise<ClaudeCodeView>;
  saveClaude(revision: number, claude: ClaudeCodeSettings): Promise<ClaudeCodeView>;
  putProvider(id: string, body: unknown): Promise<ProvidersView>;
  putThinking(body: ModelThinkingPatch): Promise<ModelThinkingSaved>;
  deleteProvider(id: string): Promise<ProvidersView>;
  testProvider(body: { kind: "builtin" | "custom"; id?: string; api?: string; baseUrl?: string; apiKey?: string }): Promise<void>;
  discoverProvider(body: {
    api: string;
    baseUrl: string;
    apiKey?: string;
    id?: string;
  }): Promise<DiscoveredModels>;
  providersImport(): Promise<ProviderImportView>;
  importProviders(ids: string[]): Promise<ProvidersView>;
  assistantSkills(assistantId: string): Promise<AssistantSkill[]>;
  patchAssistantSkill(assistantId: string, name: string, enabled: boolean): Promise<AssistantSkill>;
  rollbackAssistantSkill(assistantId: string, name: string): Promise<AssistantSkill>;
  deleteAssistantSkill(assistantId: string, name: string): Promise<{ ok: true }>;
  sedimentJob(jobId: string): Promise<{ ok: true }>;
  skills(): Promise<SkillsView>;
  skillsImport(source: SkillImportSource): Promise<SkillImportView>;
  importSkills(source: SkillImportSource, ids: string[], overwrite: boolean): Promise<SkillImportResult>;
  deleteSkill(id: string): Promise<void>;
  desktop(): Promise<DesktopView>;
  saveDesktop(body: { revision: number; url: string; enabled: boolean; token?: string }): Promise<DesktopView>;
  saveDesktopPublic(revision: number, assistants: string[]): Promise<DesktopView>;
  testDesktop(): Promise<DesktopTestResult>;
  mcp(): Promise<McpView>;
  putMcp(name: string, body: McpServerSave): Promise<McpView>;
  patchMcp(name: string, patch: McpServerPatch): Promise<McpView>;
  deleteMcp(name: string): Promise<McpView>;
  testMcp(name: string, refresh: boolean): Promise<McpTestResult>;
  mcpImports(): Promise<McpImportView>;
  importMcp(ids: string[]): Promise<McpImportResult>;
  search(): Promise<SearchView>;
  putSearch(revision: number, providers: SearchSettings, keys?: Record<string, string>): Promise<SettingsFile>;
  testSearch(name: string, baseUrl?: string, apiKey?: string): Promise<{ ok: boolean; count?: number; error?: string }>;
  imageKey(): Promise<ImageKeyView>;
  putImage(revision: number, image: ImageSettings, apiKey?: string): Promise<ImageSettingsSaved>;
  imageTest(body: { image?: ImageSettings; apiKey?: string }): Promise<ImageTestResult>;
  changePassword(old: string, next: string): Promise<void>;
  about(): Promise<AboutInfo>;
  usage(): Promise<UsageView>;
  putUsagePrice(body: UsagePricePatch): Promise<UsagePriceSaved>;
  memory(): Promise<MemoryConfig>;
  putMemory(revision: number, provider: MemoryProvider): Promise<MemoryConfig>;
  putLore(body: { baseUrl: string; token?: string }): Promise<MemoryConfig>;
  loreTest(body: { baseUrl?: string; token?: string }): Promise<LoreTestResult>;
  loreImport(): Promise<LoreImportView>;
  importLore(): Promise<MemoryConfig>;
  items(assistantId: string, before?: string): Promise<ItemsPage>;
  profile(assistantId: string): Promise<Profile>;
  sendMessage(assistantId: string, body: SendMessageBody): Promise<{ item: Item } | undefined>;
  stopAssistant(assistantId: string): Promise<void>;
  markRead(assistantId: string): Promise<void>;
  patchAssistant(assistantId: string, patch: Partial<Assistant> & { rule?: { id?: string; text?: string; mode?: "ask" | "allow" } }): Promise<{ rule?: Rule } | void>;
  archiveAssistant(assistantId: string): Promise<void>;
  deleteRule(assistantId: string, ruleId: string): Promise<void>;
  retryDelegation(id: string): Promise<void>;
  answerApproval(approvalId: string, answer: AnswerApprovalBody): Promise<void>;
  createDraft(draftId: string): Promise<void>;
  dismissDraft(draftId: string): Promise<void>;
  createRoutine(body: Omit<Routine, "id" | "createdAt" | "runs">): Promise<Routine | undefined>;
  patchRoutine(routineId: string, patch: Omit<Partial<Routine>, "skill"> & { skill?: string | null }): Promise<void>;
  deleteRoutine(routineId: string): Promise<void>;
  runRoutine(routineId: string): Promise<RoutineTick | undefined>;
  replyJob(jobId: string, text: string): Promise<void>;
  stopJob(jobId: string): Promise<void>;
  transcript(jobId: string): Promise<JobTranscript>;
  jobs(query?: { assistantId?: string; status?: JobStatus; before?: string; limit?: number }): Promise<JobsPage>;
  upload(file: File, assistantId: string): Promise<string>;
  /** thumb：对话里显示的缩略图（长边 720），点开预览才拉原图 */
  fileUrl(path: string, opts?: { inline?: boolean; truncate?: boolean; thumb?: boolean }): string;
  fileMeta(path: string): Promise<FileMeta>;
  jobFiles(jobId: string, path?: string): Promise<JobFilesView>;
  push(): Promise<PushView>;
  subscribePush(subscription: PushSubscriptionJson, label: string): Promise<PushView>;
  unsubscribePush(endpoint: string): Promise<PushView>;
  testPush(endpoint?: string): Promise<{ sent: number; removed: number; error?: string }>;
  visibility(clientId: string, visible: boolean): Promise<void>;
  events(handlers: EventHandlers, clientId?: string): () => void;
}

const EVENT_TYPES: HobEvent["type"][] = [
  "rules",
  "assistant",
  "assistant_removed",
  "item",
  "delta",
  "job",
  "delegation",
  "job_step",
  "activity",
  "approval",
  "draft",
  "routine",
  "routine_removed",
  "profile",
  "knowledge",
  "skills",
];

export const realApi: HobApi = {
  knowledge: (query = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
    return req<KnowledgePage>(`/api/knowledge?${params}`);
  },
  knowledgeEntry: (id, chunk) => req<KnowledgeEntryView>(`/api/knowledge/entries/${encodeURIComponent(id)}${chunk !== undefined ? `?chunk=${chunk}` : ""}`),
  reindexKnowledge: (id) => req<{ ok: true }>(`/api/knowledge/collections/${encodeURIComponent(id)}/reindex`, { method: "POST" }),
  embeddingKey: () => req<EmbeddingKeyView>("/api/knowledge/embedding"),
  putEmbedding: (revision, embedding, apiKey) => req<EmbeddingSettingsSaved>("/api/knowledge/embedding", json({ revision, embedding, ...(apiKey ? { apiKey } : {}) }, "PUT")),
  embeddingTest: (body) => req<EmbeddingTestResult>("/api/knowledge/embedding/test", json(body)),
  createKnowledgeCollection: (name) => req<{ collection: KnowledgeCollection }>("/api/knowledge/collections", json({ name })).then((result) => result.collection),
  renameKnowledgeCollection: (id, name) => req<{ collection: KnowledgeCollection }>(`/api/knowledge/collections/${encodeURIComponent(id)}`, json({ name }, "PATCH")).then((result) => result.collection),
  deleteKnowledgeCollection: (id) => req<{ deleted: number }>(`/api/knowledge/collections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  patchKnowledgeEntry: (id, patch) => req<{ entry: KnowledgeEntry }>(`/api/knowledge/entries/${encodeURIComponent(id)}`, json(patch, "PATCH")).then((result) => result.entry),
  deleteKnowledgeEntry: (id) => req<{ ok: true }>(`/api/knowledge/entries/${encodeURIComponent(id)}`, { method: "DELETE" }),
  uploadKnowledge: (collection, files) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    return req<{ entries: KnowledgeEntry[] }>(`/api/knowledge/upload?collection=${encodeURIComponent(collection)}`, { method: "POST", body: form });
  },
  me: () => req<void>("/api/me"),
  login: (password) => req<void>("/api/login", json({ password })),
  logout: () => req<void>("/api/logout", { method: "POST" }),
  bootstrap: () => req<Bootstrap>("/api/bootstrap"),
  settings: () => req<SettingsFile>("/api/settings"),
  rules: () => req<{ rules: Rule[] }>("/api/rules"),
  saveRules: (rules) => req<{ rules: Rule[] }>("/api/rules", json({ rules }, "PUT")),
  models: () => req<ModelsView>("/api/models"),
  putSettings: (revision, patch) => req<SettingsFile>("/api/settings", json({ revision, patch }, "PUT")),
  providers: () => req<ProvidersView>("/api/providers"),
  claude: () => req<ClaudeCodeView>("/api/claude"),
  saveClaude: (revision, claude) => req<ClaudeCodeView>("/api/claude", json({ revision, claude }, "PUT")),
  putProvider: (id, body) => req<ProvidersView>(`/api/providers/${encodeURIComponent(id)}`, json(body, "PUT")),
  putThinking: (body) => req<ModelThinkingSaved>("/api/models/thinking", json(body, "PUT")),
  deleteProvider: (id) => req<ProvidersView>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testProvider: (body) => req<void>("/api/providers/test", json(body)),
  discoverProvider: (body) => req<DiscoveredModels>("/api/providers/discover", json(body)),
  providersImport: () => req<ProviderImportView>("/api/providers/import"),
  importProviders: (ids) => req<ProvidersView>("/api/providers/import", json({ ids })),
  assistantSkills: (id) => req<AssistantSkill[]>(`/api/assistants/${encodeURIComponent(id)}/skills`),
  patchAssistantSkill: (id, name, enabled) => req<AssistantSkill>(`/api/assistants/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }),
  rollbackAssistantSkill: (id, name) => req<AssistantSkill>(`/api/assistants/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}/rollback`, { method: "POST" }),
  deleteAssistantSkill: (id, name) => req<{ ok: true }>(`/api/assistants/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
  sedimentJob: (id) => req<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/sediment`, { method: "POST" }),
  skills: () => req<SkillsView>("/api/skills"),
  skillsImport: (source) => req<SkillImportView>(`/api/skills/import/${source}`),
  importSkills: (source, ids, overwrite) => req<SkillImportResult>(`/api/skills/import/${source}`, json({ ids, overwrite })),
  deleteSkill: (id) => req<void>(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),
  desktop: () => req<DesktopView>("/api/desktop"),
  saveDesktop: (body) => req<DesktopView>("/api/desktop", json(body, "PUT")),
  saveDesktopPublic: (revision, assistants) => req<DesktopView>("/api/desktop/public", json({ revision, assistants }, "PUT")),
  testDesktop: () => req<DesktopTestResult>("/api/desktop/test", json({})),
  mcp: () => req<McpView>("/api/mcp"),
  putMcp: (name, body) => req<McpView>(`/api/mcp/${encodeURIComponent(name)}`, json(body, "PUT")),
  patchMcp: (name, patch) =>
    req<McpView>(`/api/mcp/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteMcp: (name) => req<McpView>(`/api/mcp/${encodeURIComponent(name)}`, { method: "DELETE" }),
  testMcp: (name, refresh) => req<McpTestResult>(`/api/mcp/${encodeURIComponent(name)}/test`, json({ refresh })),
  mcpImports: () => req<McpImportView>("/api/mcp/import"),
  importMcp: (ids) => req<McpImportResult>("/api/mcp/import", json({ ids })),
  search: () => req<SearchView>("/api/search"),
  putSearch: (revision, providers, keys) => req<SettingsFile>("/api/search", json({ revision, providers, keys }, "PUT")),
  testSearch: (name, baseUrl, apiKey) => req<{ ok: boolean; count?: number; error?: string }>("/api/search/test", json({ name, baseUrl, apiKey })),
  imageKey: () => req<ImageKeyView>("/api/image"),
  putImage: (revision, image, apiKey) =>
    req<ImageSettingsSaved>("/api/image", json({ revision, image, ...(apiKey ? { apiKey } : {}) }, "PUT")),
  imageTest: (body) => req<ImageTestResult>("/api/image/test", json(body)),
  changePassword: (old, next) => req<void>("/api/password", json({ old, new: next })),
  about: () => req<AboutInfo>("/api/about"),
  usage: () => req<UsageView>("/api/usage"),
  putUsagePrice: (body) => req<UsagePriceSaved>("/api/usage/price", json(body, "PUT")),
  memory: () => req<MemoryConfig>("/api/memory"),
  putMemory: (revision, provider) => req<MemoryConfig>("/api/memory", json({ revision, provider }, "PUT")),
  putLore: (body) => req<MemoryConfig>("/api/memory/lore", json(body, "PUT")),
  loreTest: (body) => req<LoreTestResult>("/api/memory/lore-test", json(body)),
  loreImport: () => req<LoreImportView>("/api/memory/lore/import"),
  importLore: () => req<MemoryConfig>("/api/memory/lore/import", { method: "POST" }),
  items: (assistantId, before) =>
    req<ItemsPage>(
      `/api/assistants/${encodeURIComponent(assistantId)}/items?limit=60${
        before ? `&before=${encodeURIComponent(before)}` : ""
      }`,
    ),
  profile: (assistantId) => req<Profile>(`/api/assistants/${encodeURIComponent(assistantId)}/profile`),
  sendMessage: (assistantId, body) =>
    req<{ item: Item }>(`/api/assistants/${encodeURIComponent(assistantId)}/messages`, json(body)),
  stopAssistant: (assistantId) =>
    req<void>(`/api/assistants/${encodeURIComponent(assistantId)}/stop`, { method: "POST" }),
  markRead: (assistantId) =>
    req<void>(`/api/assistants/${encodeURIComponent(assistantId)}/read`, { method: "POST" }),
  patchAssistant: (assistantId, patch) =>
    req<{ rule?: Rule }>(`/api/assistants/${encodeURIComponent(assistantId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  archiveAssistant: (assistantId) =>
    req<void>(`/api/assistants/${encodeURIComponent(assistantId)}/archive`, { method: "POST" }),
  deleteRule: (assistantId, ruleId) =>
    req<void>(`/api/assistants/${encodeURIComponent(assistantId)}/rules/${encodeURIComponent(ruleId)}`, {
      method: "DELETE",
    }),
  retryDelegation: (id) => req<void>(`/api/delegations/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  answerApproval: (approvalId, answer) =>
    req<void>(`/api/approvals/${encodeURIComponent(approvalId)}`, json(answer)),
  createDraft: (draftId) =>
    req<void>(`/api/drafts/${encodeURIComponent(draftId)}/create`, { method: "POST" }),
  dismissDraft: (draftId) =>
    req<void>(`/api/drafts/${encodeURIComponent(draftId)}/dismiss`, { method: "POST" }),
  createRoutine: (body) => req<Routine | undefined>("/api/routines", json(body)),
  patchRoutine: (routineId, patch) =>
    req<void>(`/api/routines/${encodeURIComponent(routineId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteRoutine: (routineId) =>
    req<void>(`/api/routines/${encodeURIComponent(routineId)}`, { method: "DELETE" }),
  runRoutine: (routineId) =>
    req<RoutineTick | undefined>(`/api/routines/${encodeURIComponent(routineId)}/run`, { method: "POST" }),
  replyJob: (jobId, text) => req<void>(`/api/jobs/${encodeURIComponent(jobId)}/reply`, json({ text })),
  stopJob: (jobId) => req<void>(`/api/jobs/${encodeURIComponent(jobId)}/stop`, { method: "POST" }),
  transcript: (jobId) => req<JobTranscript>(`/api/jobs/${encodeURIComponent(jobId)}/transcript`),
  jobs: (query = {}) => {
    const params = new URLSearchParams();
    if (query.assistantId) params.set("assistantId", query.assistantId);
    if (query.status) params.set("status", query.status);
    if (query.before) params.set("before", query.before);
    if (query.limit) params.set("limit", String(query.limit));
    const qs = params.toString();
    return req<JobsPage>(`/api/jobs${qs ? `?${qs}` : ""}`);
  },
  upload: async (file, assistantId) => {
    const form = new FormData();
    form.append("file", file);
    const out = await req<{ file: { path: string } }>(`/api/uploads?assistantId=${encodeURIComponent(assistantId)}`, { method: "POST", body: form });
    if (!out.file?.path) throw new Error("上传响应缺少文件路径");
    return out.file.path;
  },
  fileUrl: (path, opts) =>
    `/api/files?path=${encodeURIComponent(path)}${opts?.inline ? "&inline=1" : ""}${opts?.truncate ? "&truncate=1" : ""}${opts?.thumb ? "&thumb=1" : ""}`,
  fileMeta: (path) => req<FileMeta>(`/api/files/meta?path=${encodeURIComponent(path)}`),
  jobFiles: (jobId, path) => req<JobFilesView>(`/api/jobs/${encodeURIComponent(jobId)}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  push: () => req<PushView>("/api/push"),
  // 服务端回 { device, push }：取 push 那份视图
  subscribePush: (subscription, label) =>
    req<{ push: PushView }>("/api/push/subscribe", json({ subscription, label })).then((r) => r.push),
  unsubscribePush: (endpoint) =>
    req<PushView>("/api/push/subscribe", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }),
  testPush: (endpoint) =>
    req<{ sent: number; removed: number; error?: string }>("/api/push/test", json(endpoint ? { endpoint } : {})),
  visibility: (clientId, visible) => req<void>("/api/visibility", json({ clientId, visible })),
  events: ({ onEvent, onReconnect, onDown }, clientId) => {
    const es = new EventSource(`/api/events${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`);
    let wasDown = false;
    const handle = (e: MessageEvent) => {
      try {
        onEvent(JSON.parse(e.data) as HobEvent);
      } catch {
        /* 坏事件丢弃，不影响其他事件 */
      }
    };
    es.onmessage = handle;
    for (const type of EVENT_TYPES) es.addEventListener(type, handle as EventListener);
    es.onerror = () => {
      wasDown = true;
      onDown(es.readyState === EventSource.CLOSED ? "实时连接已断开" : "实时连接中断，正在重连");
    };
    es.onopen = () => {
      if (wasDown) {
        wasDown = false;
        onReconnect();
      }
    };
    return () => es.close();
  },
};
