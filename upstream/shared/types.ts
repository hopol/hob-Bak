// Hob 前后端共用的契约。改这里 = 两边一起改。说明见 docs/architecture.md。
import type { SearchSettings } from "./search.ts";

export type Iso = string; // ISO 8601 时间

/** 思考档，和 pi 的 ThinkingLevel 一致。 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 一个模型的自定义思考档：档位 → 发给服务商的字符。
 * 字符串 = 用户指定的字符；空串 = 这一档开着，但按服务商协议的默认（不写给引擎）；null = 这一档不要。
 * 没写的键按默认规则算（见 shared/thinking.ts）。
 */
export type ThinkingLevelMapSetting = Partial<Record<ThinkingLevel, string | null>>;

/** 一个能被 Hob 用的模型：来自引擎的模型注册表（有凭据的聊天模型）。 */
export interface ModelInfo {
  ref: string; // "provider/id"
  provider: string;
  id: string;
  name: string; // 显示名，注册表里没有名字时等于 id
  reasoning: boolean; // 会推理（有思考档）
  thinkingLevels: ThinkingLevel[]; // 这个模型能用的思考档（Hob 按设置里的自定义档位 / 默认规则算出来的）
  input: ("text" | "image")[]; // 能吃什么；含 image 才能看图
  contextWindow: number; // 上下文窗口（token）
  maxTokens: number; // 单次最多输出
  cost: { input: number; output: number }; // 每百万 token 的价格，货币由服务商决定
}

/** 模型 + 思考档。 */
export interface ModelPick {
  ref: string; // "provider/id"
  thinking: ThinkingLevel;
}

export interface ModelScores { smart: number; cost: number; speed: number }

/** 设置 → 模型：名单里的一项。 */
export interface RosterEntry {
  ref: string;
  note: string; // 可选的补充说明
  scores?: ModelScores; // 旧数据没有分数时按模型信息推测
  scoresConfirmed?: boolean; // 推测的分数是否已确认
  thinking?: ThinkingLevel; // 这个模型的默认思考档
}

/** 设置 → 模型。 */
export interface ModelSettings {
  roster: RosterEntry[]; // Hob 能用的模型
  conversation: ModelPick; // 对话（助手本身）
  work: ModelPick; // 任务执行（分派任务不指定就用它）
  thinkingChoice?: "auto" | "fixed"; // 缺省 auto：助手按任务选择；fixed：使用模型默认档
  /** 每个模型的自定义思考档，键是模型 ref（"服务商/模型"）；没存就用 Hob 的默认规则 */
  thinking?: Record<string, ThinkingLevelMapSetting>;
}

/** 设置 → 生图：关闭 / OpenAI 兼容接口。 */
export type ImageSettings = { source: "off" } | { source: "openai"; baseUrl: string; model: string; size?: string };

/** GET /api/image：生图接口的 Key 配没配（Key 永不回显）。 */
export interface ImageKeyView {
  keyConfigured: boolean;
}

/** PUT /api/image：保存生图配置，返回整份设置和 Key 状态。 */
export interface ImageSettingsSaved {
  settings: SettingsFile;
  keyConfigured: boolean;
}

/** POST /api/image/test：生成测试图片。失败也是 200，原因在这里。 */
export type ImageTestResult = { ok: true; path: string } | { ok: false; error: string };

/** GET /api/models：可用模型 + 名单里的模型当前是否还可用。 */
export interface ModelsView {
  models: ModelInfo[]; // 现在有凭据可用的聊天模型
  roster: (RosterEntry & { unavailable?: boolean })[]; // 名单（unavailable 表示服务商删了或者没有 Key）
}

/** 兼容接口的协议。 */
export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/** 兼容接口里的一个模型；extra 原样透传给引擎的模型配置（compat、thinkingLevelMap 之类）。 */
export interface ProviderModelSetting {
  id: string;
  name?: string;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  extra?: Record<string, unknown>;
}

/** 设置 → 服务商：引擎自带的服务商，只填 Key。 */
export interface BuiltinProviderSettings {
  kind: "builtin";
  id: string; // 引擎里的服务商 id，如 anthropic
}

/** 设置 → 服务商：兼容接口（地址 + 协议 + Key + 模型列表）。 */
export interface CustomProviderSettings {
  kind: "custom";
  id: string; // slug；模型 ref 是 "<id>/<模型 id>"
  name: string;
  api: ProviderApi;
  baseUrl: string;
  models: ProviderModelSetting[];
  /** 服务商级字段（compat、headers、authHeader 等）原样透传给引擎，界面不编辑 */
  extra?: Record<string, unknown>;
}

export type ProviderSettings = BuiltinProviderSettings | CustomProviderSettings;

/** 已配的服务商（Key 只报配没配，永不回显）。 */
export type ProviderView = ProviderSettings & { keyConfigured: boolean };

/** 一个模型现在的思考档：档位 + 发给服务商的字符（自定义或默认，Hob 算出来的）。 */
export interface ModelThinkingView {
  ref: string; // "服务商/模型"
  id: string;
  name: string; // 显示名
  reasoning: boolean; // 会推理才有思考档
  input?: ("text" | "image")[];
  contextWindow?: number;
  levels: { level: ThinkingLevel; text: string }[]; // 从低到高；text 空串 = 没改过，按服务商协议的默认
  custom: boolean; // 存过自定义档位（可以恢复默认）
}

export interface ClaudeCodeSettings {
  enabled: boolean;
  plan: "pro" | "max";
  executable: string;
}

export interface ClaudeCodeView {
  settings: SettingsFile;
  status: ClaudeCodeStatus;
}

/** 本机 Claude Code 状态，不包含凭据或程序原始输出。 */
export interface ClaudeCodeStatus {
  found: boolean;
  executable?: string;
  version?: string;
  loggedIn: boolean;
  email?: string;
  plan?: string;
  error?: string;
}

/** GET /api/providers：已配的服务商、引擎自带的服务商目录、跟着一起回的整份设置（前端要新 revision）。 */
export interface ProvidersView {
  providers: ProviderView[];
  builtin: { id: string; name: string }[];
  settings: SettingsFile;
  /** 每个已配置服务商的模型和思考档，键是服务商 id；服务商详情里列模型、编辑思考档 */
  models: Record<string, ModelThinkingView[]>;
}

/** PUT /api/models/thinking：存一个模型的自定义思考档。 */
export interface ModelThinkingPatch {
  ref: string; // "服务商/模型"
  /** 完整的档位表；null = 恢复默认（只用 Hob 的默认规则） */
  levels: ThinkingLevelMapSetting | null;
}

/** PUT /api/models/thinking：存完的整份设置（新 revision）+ 这个模型现在的思考档。 */
export interface ModelThinkingSaved {
  settings: SettingsFile;
  thinking: ModelThinkingView;
}

/** POST /api/providers/discover：从兼容接口拉到的模型列表。 */
export interface DiscoveredModels {
  models: { id: string; name?: string }[];
}

/** 导入时 Key 怎么来：字面值 / 环境变量 / 命令（不执行）/ 没有。 */
export type ProviderImportKey = "literal" | "env" | "command" | "none";

/** GET /api/providers/import：本机配置里能导入的一个服务商（不带 Key 明文）。 */
export interface ProviderImportItem {
  id: string;
  kind: "custom" | "builtin";
  api?: ProviderApi;
  baseUrl?: string;
  models: number;
  key: ProviderImportKey;
  exists: boolean; // 已经配置过，导入会覆盖
  selectable: boolean; // 不可选时 note 写原因
  note?: string;
}

/** GET /api/providers/import：本机能导入的服务商 + 来源目录（界面显示用）。 */
export interface ProviderImportView {
  source: string;
  items: ProviderImportItem[];
}

/** GET /api/memory/lore/import：本机的 Lore 连接（不带 Token 明文）。 */
export interface LoreImportView {
  source: string;
  found: boolean;
  baseUrl?: string;
  tokenPresent: boolean;
}

/** 头像：「道具」或「道具:颜色」，如 "server"、"wifi:green"；自画的记成 "custom" 或 "custom:颜色"（shared/sprites.ts） */
export type SpriteId = string;

/** AI 画的自定义道具：画法格式和 PROPS 里的一项相同，从第 0 行起逐行盖在火苗上，`.` 不动，其它字符查 pal。 */
export interface CustomProp {
  art: string[]; // 最多 16 行、每行 16 字符；字符只能是 `.`、`k`（描边色，固定）或 pal 里的键
  pal: Record<string, string>; // 单个小写字母 → #rrggbb；不能用火苗自己的 o y e 和描边 k，最多 6 种
  dx: 0 | 1 | 2; // 火苗在 16×16 里的横向位置（2 = 居中）
}

export interface Assistant {
  id: string; // 主助手固定 "hob"；其余为 slug（小写字母数字连字符）
  name: string; // 显示名，如 "写作"
  duty: string; // 一句话职责，左栏大头像下的小字，如 "周报和文章"；主助手为 "主助手"
  dutyLong?: string; // 详细职责
  sprite: SpriteId;
  /** sprite 是 custom / custom:* 时的画法；换成内置道具后保留，随时能换回来 */
  prop?: CustomProp;
  primary: boolean; // 只有 hob 为 true
  pinned: boolean; // 左栏顶部大头像
  /** 置顶区里的位置：小的在前，拖动头像换位置时改它；没排过的排在排过的后面，再按创建时间 */
  pinOrder?: number;
  hidden: boolean; // 收起的助手
  notify: boolean; // 需要确认时通知我
  instructions: string; // 补充说明：用户可直接编辑该助手需要知道的专属事实
  /** 这个助手用哪些模型；缺省全部跟随设置 → 模型 */
  models?: {
    conversation?: ModelPick; // 不填 = 跟随全局的对话模型
    work?: ModelPick; // 不填 = 跟随全局的任务模型
    allowed?: string[]; // 可分派的模型 ref；缺省 = 名单全部
  };
  /** 派出去的活能用的能力；缺省全开（读总是有） */
  abilities?: { exec: boolean; write: boolean; image: boolean };
  /** 知识库二期：绑定的用户知识库 id。缺省 = 没绑定：不自动查，也没有 search_knowledge */
  knowledge?: string[];
  createdAt: Iso;
  splitFrom?: { from: string; at: Iso; conversations: number };
}

export type RouterActivity = { state: "thinking" | "tool"; label: string };

export interface AssistantSummary extends Assistant {
  last?: { text: string; at: Iso }; // 对话最后一条（列表第二行）
  unread: number; // 未读条数（>0 时大头像右上角橙点）
  readAt?: Iso; // 上次看这个助手的时间：之前结束的任务不再挂完成/受阻标记
  busy: boolean; // Router 正在回复（在跑的任务不算，任务状态看任务卡）
  activity?: RouterActivity | null;
}

export interface Rule {
  id: string;
  text: string; // 规则内容，如 "发布公众号"
  mode: "ask" | "allow"; // ask=执行前确认；allow=直接执行
  changedAt: Iso; // 24 小时内变过 → 设置页显示 "最近修改"
}


export interface WorklogEntry {
  at: Iso;
  text: string; // 如 "每日简报：今天 6 条" / "完成任务：查页面卡顿"
  jobId?: string;
}

export interface RoutineRun {
  jobId: string;
  at: Iso;
  status: JobStatus;
  durationMs?: number; // 技能二期：这次用时
  tools?: number; // 技能二期：工具调用次数
  tokens?: number; // 技能二期：输入加输出 token
}

export interface RoutineCheck {
  script: string; // 到点先跑的 bash 脚本：没有输出就跳过这一次
  then: "notify" | "job"; // 有输出时：notify 把输出作为提醒发到对话；job 带着输出开始任务
}

export interface RoutineChecks {
  total: number; // 检查了几次
  hits: number; // 触发了几次
  failing?: string; // 最近一次失败的原因，下次成功就清掉
  lastAt?: Iso; // 上次检查的时间
}

/** 定时到点（或点「立即运行」）这一次的结果。 */
export interface RoutineTick {
  outcome: "job" | "notify" | "quiet" | "failed"; // job 开了任务；notify 已发到对话；quiet 没变化；failed 检查失败
  job?: Job;
  reason?: string; // failed 时的原因
}

export interface Routine {
  id: string;
  assistantId: string;
  name: string; // 如 "每日简报"
  instruction: string; // 要做什么
  schedules: string[]; // cron 表达式（如 "0 9 * * *"）或具体时间（如 "2026-11-08T09:00"）；可多个（"再加一个"）
  active: boolean;
  createdAt: Iso;
  runs: RoutineRun[]; // 最近 20 次，新的在前
  skill?: string; // 绑定这个助手自己的技能（AssistantSkill.name）：每次执行按它做
  check?: RoutineCheck; // 到点先跑脚本，多数时候没变化就不开任务
  checks?: RoutineChecks; // 检查计数和最近一次失败的原因
  once?: boolean; // 做成一次就停：没有检查脚本的跑完就停，有检查的第一次有输出就停
  stoppedAt?: Iso; // 上次停下的时间
  stopReason?: "hit" | "finished"; // hit=按 once 停了；finished=所有执行时间都跑完了
}

export interface Delegation {
  id: string;
  from: "hob";
  to: string;
  text: string;
  createdAt: Iso;
  status: "running" | "waiting" | "done" | "stuck" | "interrupted" | "returned" | "takenOver";
  jobIds: string[];
  reply?: string;
  returnedText?: string; // 退回时补充的用户要求
  endedAt?: Iso;
  approvalIds?: string[];
  turnFinished?: boolean;
  turnFailed?: boolean;
  reportedAt?: Iso;
}

export type JobStatus =
  | "queued"
  | "running"
  | "waiting" // 待确认（Worker 的 ask_user 未答）
  | "done" // 已完成
  | "stuck" // 受阻
  | "failed"
  | "stopped";

export interface ActivityLine {
  at: Iso;
  verb: "$" | "读" | "跑" | "改" | "写" | "搜" | "说";
  text: string;
}

/** 任务的 token 和花费（pi 消息里有的就汇总）。 */
export interface JobUsage {
  input: number;
  output: number;
  cost: number; // 美元
}

/**
 * 任务过程的一步：说明文字、模型思考摘要、一次工具调用。
 * 同 id 替换（工具输出流式更新用它），顺序就是时间顺序。
 */
export interface JobStep {
  id: string; // 工具调用用 toolCallId，文字用消息时间戳 + 序号
  kind: "text" | "thinking" | "tool";
  at: Iso;
  /** 文字是谁说的：助手回复 / 你补的那句 */
  from?: "assistant" | "user";
  /** text / thinking 的正文 */
  text?: string;
  /** tool：工具名（bash / read / edit / write / grep / find / ls / report / ask_user） */
  name?: string;
  /** tool：一行中文，如 跑 `npm test` / 改 server/src/jobs.ts */
  title?: string;
  /** tool：参数（bash 的 command、read 的 path 和行范围、edit 的 path 和 edits） */
  args?: Record<string, unknown>;
  /** tool：结果文本（transcript 最多 20KB，实时事件最多 4KB） */
  output?: string;
  /** tool：结果太长被截断，全文在这个文件里 */
  outputPath?: string;
  isError?: boolean;
  durationMs?: number;
  /** tool：还在跑 */
  running?: boolean;
  /** 你补的那句已经交给任务，但任务还在做当前这一步，做完才会读到 */
  queued?: boolean;
}

/** GET /api/jobs/:id/transcript */
export interface JobTranscript {
  job: Job;
  steps: JobStep[];
}

/** GET /api/jobs?assistantId&status&before&limit（工作记录） */
export interface JobsPage {
  jobs: Job[]; // 新的在前
  hasMore: boolean;
}

export type SedimentStatus =
  | { status: "running" }
  | { status: "saved"; name: string; title: string; version: number; updated: boolean }
  | { status: "empty"; reason: string }
  | { status: "failed"; reason: string };

export interface Job {
  id: string; // "t-" + 4 位以上
  assistantId: string;
  assistantName?: string; // 建任务时的助手名：助手归档后，任务详情里照样显示
  title: string; // 如 "查页面卡顿"
  instruction: string;
  status: JobStatus;
  statusReason?: string; // stuck/failed 的原因
  createdAt: Iso;
  startedAt?: Iso;
  endedAt?: Iso;
  usage?: JobUsage; // 输入/输出 token 和花费
  durationMs?: number; // 用时（结束时间 − 开始时间）
  expect?: { minutes: number; source: "assistant" | "routine" | "default"; runs?: number };
  stats: { reads: number; commands: number; edits: number };
  summary?: string; // report 的完整结果
  reportPath?: string; // 完整报告
  files?: string[]; // 产出文件（绝对路径）
  cwd?: string; // 工作目录（缺省为 HOB_HOME/jobs/<id>/work）
  model?: string; // 这个任务用的模型（"provider/id"）
  thinking?: ThinkingLevel; // 这个任务的思考档
  modelReason?: string; // 换了模型的原因，如「需要看图，换成了 X」
  inputs?: string[]; // 交给任务的附件（绝对路径）
  routineId?: string; // 由定时触发
  sediment?: SedimentStatus; // 在原任务中沉淀技能，不改变任务状态
  skills?: string[]; // 派活时交给任务的本助手技能
  skillsUsed?: string[]; // 这次读过的本助手技能（AssistantSkill.name）
  delegationId?: string; // 转交回合创建的任务
  /** 续做前每一轮结束时的样子（第 0 轮起）。对话里前面几张任务卡照它显示，最后一张跟着任务实时变 */
  rounds?: JobRound[];
  activity: ActivityLine[]; // 最近 200 行
}

export interface JobRound {
  summary?: string;
  files?: string[];
  usage?: JobUsage;
  reportPath?: string;
  followUp?: string;
  status: JobStatus;
  statusReason?: string;
  startedAt?: Iso;
  endedAt?: Iso;
  durationMs?: number;
}

export interface ApprovalOption {
  key: "A" | "B" | "C";
  label: string; // 如 "以后同类内容直接发布，无需确认"
  always?: boolean; // 选中后写一条 allow 规则
}

export interface Approval {
  id: string;
  assistantId: string; // 提问的助手
  title: string; // 如 "发到公众号吗？"
  detail?: string; // 如 "发出去就撤不回了。你选之前我不会发。"
  options: ApprovalOption[];
  status: "pending" | "answered" | "expired";
  chosen?: ApprovalOption["key"];
  /** 用户没选选项、而是自己写的那句（走 chosen 时没有这个字段） */
  answerText?: string;
  source: "router" | "job";
  jobId?: string;
  ruleText?: string; // always 选项要写进规则的文字，如 "发布公众号"
  createdAt: Iso;
  answeredAt?: Iso;
}

export interface Draft {
  id: string;
  assistantId: string; // 提议者（hob）
  status: "pending" | "created" | "dismissed";
  name: string;
  sprite: SpriteId;
  /** sprite 是 custom 时的画法（propose_assistant 的 prop_art） */
  prop?: CustomProp;
  duty: string; // 一句话职责
  dutyLong: string; // 草稿卡 "职责" 行
  routines: { name: string; instruction: string; schedule: string }[]; // 草稿卡 "定时任务" 行
  routinesText: string; // 草稿卡 "定时任务" 行的展示文字
  askFirst: string[]; // 执行前确认的事项
  instructions: string[]; // 补充说明（建好后写进新助手的 instructions）
  carry: { conversations: number }; // 迁移几段对话（记忆是所有助手共用的一份，不用迁移）
  createdAssistantId?: string;
  createdAt: Iso;
}

export type NoteIcon = "memory" | "rule" | "routine" | "split" | "info" | "skill";

export type Item = (
  | { kind: "user"; id: string; at: Iso; text: string; quote?: { itemId: string; text: string }; files?: string[]; from?: { assistantId: string; name: string; delegationId: string } }
  | { kind: "assistant"; id: string; at: Iso; text: string; streaming?: boolean; routine?: { id: string; name: string; jobId?: string } }
  | { kind: "note"; id: string; at: Iso; icon: NoteIcon; text: string; handbackId?: string; path?: string } // path：点了预览这个文件（如技能的 SKILL.md） // 居中灰色一行，如 "记忆已更新 · 不看融资新闻"
  | { kind: "question"; id: string; at: Iso; approvalId: string }
  | { kind: "job"; id: string; at: Iso; jobId: string; round?: number } // 第几轮（续做一次 +1），缺省是第 0 轮
  | { kind: "delegation"; id: string; at: Iso; delegationId: string }
  | { kind: "draft"; id: string; at: Iso; draftId: string }
  | { kind: "image"; id: string; at: Iso; prompt: string; size?: string; startedAt: Iso; status: "pending" | "done" | "failed"; path?: string; error?: string }
  | { kind: "file"; id: string; at: Iso; path: string; name: string; meta?: string } // meta 如 "3200 字 · 4 张图"
) & {
  /** 这条开启新的一组，前端在它上面拉开间距：事件触发的新一轮回复，或任务直接发进对话的图片、提问卡 */
  lead?: true;
};

export interface PageLive {
  assistantId: string;
  callId: string;
  title?: string;
  summary?: string;
  html: string;
  state: "writing" | "done" | "failed";
  path?: string;
  error?: string;
}

export interface ItemsPage {
  pageLive?: PageLive[];
  items: Item[]; // 旧 → 新
  approvals: Approval[];
  jobs: Job[];
  drafts: Draft[];
  delegations?: Delegation[];
  hasMore: boolean;
}

export interface Profile {
  assistant: AssistantSummary;
  rules: Rule[];
  routines: Routine[];
  worklog: WorklogEntry[]; // 最近 30 条，新的在前
}

export type MemoryProvider = "local" | "lore" | "off";

/** Lore 连接信息（永远不带 Token，只有 "配没配"）。 */
export interface LoreConnectionInfo {
  configured: boolean; // 地址和 Token 都有
  baseUrl: string | null;
  source: "config" | "none"; // 地址从哪来：Hob 自己的 lore/config.json / 没有
  tokenConfigured: boolean;
}

/** GET /api/memory：记忆提供者 + Lore 连接状态。 */
export interface MemoryConfig {
  revision: number;
  provider: MemoryProvider;
  providerExplicit: boolean; // 用户在设置里明确选过（没选过就是按有没有配好 Lore 推出的）
  lore: LoreConnectionInfo;
  lorePlugin: string; // Hob 自带的 Lore 插件版本（Lore 正式版的版本号）
}

/** POST /api/memory/lore-test：测试失败也是 200，原因在这里。 */
export type LoreTestResult =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: "invalid_url" | "insecure_http" | "missing_token" | "unauthorized" | "unreachable" };

export type Theme = "system" | "light" | "dark";

/** 设置 → 通用。 */
export interface GeneralSettings {
  /** 是否允许助手生成展示页面；旧设置缺省为开启。 */
  showPage?: boolean;
  /** 头像带不带彩色圆底；旧设置缺省为带。 */
  avatarBackground?: boolean;
  theme: Theme;
  timezone: string; // IANA 时区名，默认系统时区
  aboutYou: { name: string; language: string; notes: string }; // 空字符串 = 没填，提示词里就不出这一节
}

/** 设置 → 工作。 */
export interface WorkSettings {
  maxJobs: number; // 最大并行任务数，1–8
  jobStallMinutes: number; // 任务多久无响应视为受阻
  routerStallMinutes: number; // 助手回复多久无响应视为受阻
}

/** 设置 → 通知。 */
export interface PushSettings {
  /** VAPID subject 用的邮箱；空就用 mailto:hob@localhost */
  email: string;
}

/** 每百万 token 的单价（美元），四项。 */
export interface TokenPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 设置 → 消耗：按模型改过的单价，键是模型 id（服务商 id 是用户自己起的，价格按模型 id 对）。 */
export interface UsageSettings {
  prices: Record<string, TokenPrice>;
}

/** 用量的来源：助手自己的对话 / 任务的会话。 */
export type UsageSource = "chat" | "job";

/** GET /api/usage 的一行：按天 × 助手 × 来源 × 服务商 × 模型汇总；day 是设置时区下的日期。 */
export interface UsageRow {
  day: string; // 2026-11-06
  assistantId: string;
  source: UsageSource;
  provider: string;
  model: string;
  requests: number; // assistant 消息条数
  input: number; // 没命中缓存的输入 token
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 有会话文件的助手（归档的也算），「按助手」一节用它的名字。 */
export interface UsageAssistant {
  id: string;
  name: string;
  archived: boolean;
}

/** 一个模型现在的单价：改过的是自定，default 是价格表里的默认值（恢复默认和对比用）。 */
export interface UsageModelPrice {
  price: TokenPrice;
  custom: boolean;
  default?: TokenPrice;
}

/** 价格表：默认单价从 models.dev 拉，一天最多更新一次。 */
export interface UsagePrices {
  updatedAt: Iso | null; // 价格表拉到的时间；从没拉到过为 null
  error: string | null; // 这次更新价格表失败的原因；成功为 null
  models: Record<string, UsageModelPrice>; // 键是模型 id
}

/** GET /api/usage：按天、助手、来源、服务商、模型分组的明细 + 价格；前端自己汇总。 */
export interface UsageView {
  timezone: string;
  rows: UsageRow[];
  assistants: UsageAssistant[];
  prices: UsagePrices;
}

/** PUT /api/usage/price：改一个模型的单价，price 为 null 就恢复默认。 */
export interface UsagePricePatch {
  revision: number;
  model: string;
  price: TokenPrice | null;
}

/** PUT /api/usage/price：新 revision 的整份设置 + 这个模型现在的单价（既没价格表也没自定时为 null）。 */
export interface UsagePriceSaved {
  settings: SettingsFile;
  price: UsageModelPrice | null;
}

export interface Settings {
  general: GeneralSettings;
  /** 服务商（Key 在 secrets.json，这里只放不敏感的） */
  providers: ProviderSettings[];
  models: ModelSettings;
  image: ImageSettings;
  search: SearchSettings;
  /** 云桌面令牌保存在 secrets.json，不包含在设置中。 */
  desktop?: { url: string; enabled: boolean; publicAssistants?: string[] };
  claude?: ClaudeCodeSettings;
  /** 停用的技能，键为来源和技能名。 */
  skills?: { disabled: string[] };
  work: WorkSettings;
  push: PushSettings;
  /** 知识库二期：向量模型（Key 在 secrets.json 的 embedding）；缺省 = 关闭，只按关键词查 */
  knowledge?: { embedding: EmbeddingSettings };
  /** 消耗：按模型改过的单价；没改过的模型用 models.dev 的价格 */
  usage?: UsageSettings;
}

/** 设置 → 知识库：向量模型，照图像生成的做法（兼容接口的地址 + 模型，Key 单独存）。 */
export type EmbeddingSettings = { source: "off" } | { source: "openai"; baseUrl: string; model: string };

/** GET /api/knowledge/embedding：Key 配没配（永不回显）。 */
export interface EmbeddingKeyView {
  keyConfigured: boolean;
}

/** PUT /api/knowledge/embedding 的返回：整份设置和 Key 状态。 */
export interface EmbeddingSettingsSaved {
  settings: SettingsFile;
  keyConfigured: boolean;
}

/** POST /api/knowledge/embedding/test：失败也是 200，原因在这里。 */
export type EmbeddingTestResult = { ok: true; dims: number } | { ok: false; error: string };

/** HOB_HOME/settings.json：界面可改的设置，写入走 revision 比对（CAS）。 */
export interface DesktopView {
  revision: number;
  url: string;
  enabled: boolean;
  deployed: boolean;
  tokenConfigured: boolean;
  publicAssistants: string[];
}

export interface DesktopScreen { id: string; running: boolean; browserRunning: boolean; viewers: number; lastActiveAt: string | null }
export type DesktopTestResult = { ok: true; health: { version: string; display: { width: number; height: number }; screens: DesktopScreen[] } } | { ok: false; error: string };

export interface SettingsFile {
  revision: number;
  settings: Settings;
}

/** PUT /api/settings：按节合并，没给的项保持原样。 */
export interface SettingsPatch {
  general?: Omit<Partial<GeneralSettings>, "aboutYou"> & { aboutYou?: Partial<GeneralSettings["aboutYou"]> };
  models?: Partial<ModelSettings>;
  skills?: { disabled: string[] };
  work?: Partial<WorkSettings>;
  push?: Partial<PushSettings>;
}

/** 一台订阅了推送的设备（密钥只存服务端，不回给页面）。 */
export interface PushDevice {
  endpoint: string;
  label: string; // 设备名，如 "iPhone" / "Chrome"
  createdAt: Iso;
}

/** GET /api/push：浏览器订阅要的 publicKey + 已订阅设备。 */
export interface PushView {
  publicKey: string; // VAPID 公钥（base64url）
  email: string; // subject 用的邮箱（设置 → 通知）
  devices: PushDevice[]; // 新的在前
}

/** 浏览器 PushSubscription.toJSON() 的形状（POST /api/push/subscribe 回传）。 */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** GET /api/about：设置 → 关于 里显示的那几项。 */
export interface AboutInfo {
  version: string; // Hob 的版本（package.json）
  home: string; // 数据目录
}

/** 文件预览的种类（按扩展名判定，见 shared/files.ts）；不认识的扩展名服务端嗅探内容后归成 code/text/other。 */
export type FileKind =
  | "image"
  | "svg"
  | "pdf"
  | "audio"
  | "video"
  | "markdown"
  | "json"
  | "csv"
  | "html"
  | "xml"
  | "code"
  | "text"
  | "other";

/** GET /api/files/meta：预览面板要的文件信息（文件必须在这个任务的目录范围内）。 */
export interface FileMeta {
  path: string; // 真实路径（符号链接已解开）
  name: string;
  size: number; // 字节
  modifiedAt: Iso;
  mime: string;
  kind: FileKind;
  text: boolean; // 按文本预览（二进制 false）
  page?: boolean; // 展示页面目录中的渲染产物
}

/** 工作目录中的一项，目录的 count 是其下一层可见项数。 */
export type JobFileEntry = { path: string; rel: string; name: string } & (
  | { type: "file"; size: number; modifiedAt: Iso; kind: FileKind }
  | { type: "directory"; count: number }
);

/** 一层最多返回 200 项，total 为截断前的总数。 */
export interface JobFilesView {
  files: JobFileEntry[];
  total: number;
  fileCount: number;
  directoryCount: number;
}

export interface Bootstrap {
  assistants: AssistantSummary[];
  jobs: Job[]; // 在跑的 + 最近 24 小时结束的
  routines: Routine[];
  approvals: Approval[]; // pending
  settings: SettingsFile;
  delegations?: Delegation[];
}

export type HobEvent =
  | { type: "rules" }
  | { type: "desktop-control"; screen: string; taken: boolean }
  | { type: "desktop-screens"; screens: DesktopScreen[] }
  | ({ type: "page-live" } & PageLive)
  | { type: "assistant"; assistant: AssistantSummary } // 新建或变化
  | { type: "assistant_removed"; id: string }
  | { type: "item"; assistantId: string; item: Item } // 新条目，或按 id 替换
  | { type: "delta"; assistantId: string; itemId: string; text: string } // 流式追加到 assistant 条目
  | { type: "job"; job: Job }
  | { type: "delegation"; delegation: Delegation }
  | { type: "job_step"; jobId: string; step: JobStep } // 新的一步，或按 id 替换（输出流式更新、跑完补结果）
  | { type: "router-activity"; assistantId: string; activity: RouterActivity | null }
  | { type: "activity"; jobId: string; line: ActivityLine; stats: Job["stats"] }
  | { type: "approval"; approval: Approval }
  | { type: "draft"; draft: Draft }
  | { type: "routine"; routine: Routine }
  | { type: "routine_removed"; id: string }
  | { type: "profile"; assistantId: string } // rules/memories/worklog 变了，前端重拉 profile
  | { type: "knowledge" } // 知识库有变化，打开着的知识库页面重拉
  | { type: "skills"; assistantId: string }; // 这个助手的技能有变化，打开着的技能列表重拉

/** POST /api/assistants/:id/messages 的请求体 */
export interface SendMessageBody {
  text: string;
  quote?: { itemId: string; text: string };
  files?: string[]; // /api/uploads 返回的路径
}

/** POST /api/approvals/:id 的请求体：选一个选项（key），或者用户自己写的一段（text）。 */
export interface AnswerApprovalBody {
  key?: ApprovalOption["key"];
  text?: string;
}
