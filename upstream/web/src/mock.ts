// 浏览器内的假后端：只有 URL 带 ?mock=1 时才会用它。数据照 docs/design/v2 的 6 张效果图。
import type {
  Approval,
  ApprovalQuestion,
  AssistantSummary,
  Bootstrap,
  Delegation,
  DesktopView,
  Draft,
  Group,
  GroupItem,
  GroupItemsPage,
  GroupSummary,
  HobEvent,
  ImageKeyView,
  ImageSettings,
  ImageTestResult,
  Item,
  Job,
  JobFilesView,
  JobsPage,
  JobStep,
  FileMeta,
  LoreTestResult,
  MemoryConfig,
  MemoryProvider,
  Profile,
  Routine,
  RoutineRun,
  Rule,
  ThinkingLevelMapSetting,
  ModelsView,
  ModelThinkingView,
  ProviderImportItem,
  ProviderSettings,
  ProvidersView,
  PushSubscriptionJson,
  PushView,
  TokenPrice,
  UsageAssistant,
  UsageModelPrice,
  UsagePrices,
  UsageRow,
  UsageView,
  WorklogEntry,
} from "../../shared/types.ts";
import { defaultSearch } from "../../shared/search.ts";
import { knowledgeGroup, type KnowledgeCollection, type KnowledgeEntry } from "../../shared/knowledge.ts";
import type { McpView } from "../../shared/mcp.ts";
import type { AssistantSkill } from "../../shared/skills.ts";
import { ApiError, type HobApi } from "./api.ts";
import { currentLocale } from "../../shared/i18n.ts";
import { normalizeThinkingMap, thinkingPlan } from "../../shared/thinking.ts";

export type SceneId = "g-owns" | "g-owns-dark" | "readme-chat" | "readme-cards" | "readme-desktop" | "readme-knowledge" | "readme-profile" | "readme-group-now" | "readme-mobile-list" | "readme-mobile-chat" | "readme-mobile-todos" | "image" | "act-demo" | "act-think" | "act-tool" | "act-dark" | "act-home" | "boot" | "bubbles" | "bubbles-dark" | "card-130" | "card-130-dark" | "job-after" | "job-after-dark" | "routine-check-dark" | "routine-once" | "routine-once-dark" | "routine-once-list" | "ask-rounds" | "ask-rounds-answered" | "ask-rounds-group" | "ask-rounds-dark" | "ask-rounds-mobile" | "s1" | "s2" | "s3" | "s4" | "s6" | "mlist" | "mchat" | "d-running" | "d-waiting" | "d-done" | "d-dark" | "d-source" | "d-mobile" | "h-hob" | "h-dark" | "h-source" | "h-settings" | "h-mobile" | "g-chat" | "g-mention" | "g-mobile" | "g-dark" | "g-team" | "todo-chat" | "todo-topic" | "todo-job" | "topics" | "topics-plain";

/** 每个截图场景对应的界面状态（选中哪个助手或群、右栏开什么）。 */
export const SCENE_UI: Record<
  SceneId,
  { sel: string | null; gsel?: string | null; panel: string; collapsed: boolean; dark: boolean; mobile: "list" | "chat"; text?: string }
> = {
  "readme-chat": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "readme-cards": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "readme-desktop": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "readme-knowledge": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "readme-profile": { sel: "page", panel: "assistant", collapsed: false, dark: false, mobile: "chat" },
  "readme-group-now": { sel: null, gsel: "t-readme", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "readme-mobile-list": { sel: null, panel: "now", collapsed: false, dark: false, mobile: "list" },
  "readme-mobile-chat": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "readme-mobile-todos": { sel: null, gsel: "t-readme", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  image: { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "act-demo": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "act-think": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "act-tool": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "act-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "act-home": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "list" },
  boot: { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "list" },
  bubbles: { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "bubbles-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "card-130": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "card-130-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "job-after": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "job-after-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "routine-check-dark": { sel: "hob", panel: "routine:r-pr-watch", collapsed: false, dark: true, mobile: "chat" },
  "routine-once": { sel: "hob", panel: "routine:r-pay-rent", collapsed: false, dark: false, mobile: "chat" },
  "routine-once-dark": { sel: "hob", panel: "routine:r-watch-files", collapsed: false, dark: true, mobile: "chat" },
  "routine-once-list": { sel: "hob", panel: "routines", collapsed: false, dark: false, mobile: "chat" },
  "ask-rounds": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "ask-rounds-answered": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "ask-rounds-group": { sel: null, gsel: "g-home", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "ask-rounds-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "ask-rounds-mobile": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  s1: { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "list" },
  s2: { sel: "bird", panel: "routine:r-daily", collapsed: false, dark: false, mobile: "list" },
  s3: { sel: "page", panel: "assistant", collapsed: false, dark: false, mobile: "list" },
  s4: { sel: "hob", panel: "now", collapsed: true, dark: false, mobile: "list" },
  s6: { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "list" },
  mlist: { sel: null, panel: "now", collapsed: false, dark: false, mobile: "list" },
  mchat: { sel: "page", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "d-running": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "d-waiting": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "d-done": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "d-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "d-source": { sel: "server", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "d-mobile": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "h-hob": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "h-dark": { sel: "hob", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "h-source": { sel: "server", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "h-settings": { sel: "server", panel: "assistant", collapsed: false, dark: false, mobile: "chat" },
  "h-mobile": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  // 群：桌面群聊、@ 点名、手机、深色、左栏展开（敏捷团队）
  "g-chat": { sel: null, gsel: "g-home", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "g-mention": { sel: null, gsel: "g-home", panel: "now", collapsed: false, dark: false, mobile: "chat", text: "@" },
  "g-mobile": { sel: null, gsel: "g-home", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "g-dark": { sel: null, gsel: "g-home", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "g-owns-dark": { sel: null, gsel: "g-dev", panel: "now", collapsed: false, dark: true, mobile: "chat" },
  "g-owns": { sel: null, gsel: "g-dev", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "g-team": { sel: null, gsel: "g-dev", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  // 待办：单聊里一份在做、话题里一份在做、一张带进度的任务卡
  "todo-chat": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "todo-topic": { sel: null, gsel: "t-remember", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "todo-job": { sel: "hob", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  // 话题（票 152）：一个敏捷团队群、一个家用群
  topics: { sel: null, gsel: "g-topics", panel: "now", collapsed: false, dark: false, mobile: "chat" },
  "topics-plain": { sel: null, gsel: "g-home", panel: "now", collapsed: false, dark: false, mobile: "chat" },
};

const uid = (() => {
  let n = 0;
  return (p: string) => `${p}${++n}`;
})();

/** 效果图里的时间都是相对“今天”的，按天回推，截图时看到的日期才自然。 */
function at(daysAgo: number, h: number, m = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function minsAgo(n: number): string {
  return new Date(Date.now() - n * 60000).toISOString();
}

/** 具体时间点的写法（设置时区里的钟点）：相对今天的那一天几点几分，形如 2026-11-08T09:00。 */
function point(daysAgo: number, h: number, m = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 消耗页的假数据：四个模型、三个助手（一个有归档），一年的用量；工作日多、周末少，最近几个月用得更多。 */
const USAGE_MODELS: { id: string; provider: string; input: number; output: number; cache: number; weight: number; price: TokenPrice }[] = [
  { id: "claude-sonnet-4-5", provider: "anthropic", input: 3200, output: 350, cache: 0.68, weight: 1, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { id: "gpt-5", provider: "openai", input: 2900, output: 320, cache: 0.55, weight: 0.62, price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },
  { id: "deepseek-chat", provider: "deepseek", input: 2100, output: 260, cache: 0.71, weight: 0.3, price: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 } },
  { id: "glm-4.6", provider: "zhipuai", input: 1300, output: 150, cache: 0.4, weight: 0.12, price: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 } },
];

const USAGE_ASSISTANTS: (UsageAssistant & { weight: number; chat: number })[] = [
  { id: "hob", name: "Hob", archived: false, weight: 0.55, chat: 0.61 },
  { id: "page", name: "写稿搭子", archived: false, weight: 0.3, chat: 0.22 },
  { id: "ledger", name: "记账管家", archived: true, weight: 0.15, chat: 0.35 },
];

function mockUsageRows(timezone: string): { rows: UsageRow[]; assistants: UsageAssistant[] } {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const base = Date.parse(`${today}T00:00:00Z`);
  const days = Array.from({ length: 365 }, (_, index) => new Date(base - (364 - index) * 86_400_000).toISOString().slice(0, 10));
  let seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const weightSum = USAGE_MODELS.reduce((sum, model) => sum + model.weight, 0);
  const rows: UsageRow[] = [];
  days.forEach((day, index) => {
    const age = days.length - 1 - index;
    const ramp = age > 300 ? 0 : age > 200 ? 0.35 : age > 90 ? 0.7 : 1;
    const weekend = ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) >= 5;
    let total = ramp * (weekend ? 0.35 : 1) * (0.3 + rnd() * 1.1) * 520;
    if (rnd() < 0.12) total = 0;
    for (const model of USAGE_MODELS) {
      for (const assistant of USAGE_ASSISTANTS) {
        for (const source of ["chat", "job"] as const) {
          const requests = Math.round((total * model.weight * assistant.weight * (source === "chat" ? assistant.chat : 1 - assistant.chat)) / weightSum);
          if (requests <= 0) continue;
          const input = requests * model.input;
          const cacheRead = Math.round(input * model.cache);
          rows.push({
            day,
            assistantId: assistant.id,
            source,
            provider: model.provider,
            model: model.id,
            requests,
            input: input - cacheRead,
            output: Math.round(requests * model.output),
            cacheRead,
            cacheWrite: Math.round((input - cacheRead) * 0.15),
          });
        }
      }
    }
  });
  return { rows, assistants: USAGE_ASSISTANTS.map(({ id, name, archived }) => ({ id, name, archived })) };
}

/** 演示模式里的云桌面状态，地址栏 ?desktop=none（缺省）/ ready / deployed / failed。 */
type DesktopScene = "none" | "ready" | "deployed" | "failed";

export function desktopMockScene(): DesktopScene {
  const value = new URLSearchParams(globalThis.location?.search ?? "").get("desktop");
  return value === "ready" || value === "deployed" || value === "failed" ? value : "none";
}

const DESKTOP_HEALTH = {
  version: "1.7.0",
  display: { width: 1280, height: 800 },
  screens: [{ id: "hob", running: true, browserRunning: true, viewers: 0, lastActiveAt: null }],
};

const DESKTOP_VIEWS: Record<DesktopScene, DesktopView> = {
  none: { revision: 1, url: "", enabled: false, deployed: false, tokenConfigured: false, publicAssistants: [] },
  ready: { revision: 1, url: "http://127.0.0.1:30196", enabled: true, deployed: false, tokenConfigured: true, publicAssistants: [] },
  deployed: { revision: 1, url: "http://desktop:6080", enabled: true, deployed: true, tokenConfigured: true, publicAssistants: [] },
  failed: { revision: 1, url: "http://127.0.0.1:30196", enabled: true, deployed: false, tokenConfigured: true, publicAssistants: [] },
};

interface Db {
  assistants: AssistantSummary[];
  groups: GroupSummary[];
  groupItems: Record<string, GroupItem[]>;
  items: Record<string, Item[]>;
  jobs: Record<string, Job>;
  delegations: Record<string, Delegation>;
  approvals: Record<string, Approval>;
  drafts: Record<string, Draft>;
  routines: Routine[];
  assistantSkills: Record<string, AssistantSkill[]>;
  rules: Record<string, Rule[]>;
  worklog: Record<string, WorklogEntry[]>;
  settings: Bootstrap["settings"];
}

/**
 * 演示数据按界面语言出两份。只有 README 截图用到的场景有英文版：界面英文时这些场景的数据
 * 也换成英文，免得截图里一半英文一半中文。别的场景照旧只有中文数据。
 */
const ENGLISH_DEMO_SCENES: SceneId[] = ["s1", "s6", "readme-group-now", "readme-mobile-list", "readme-mobile-chat", "readme-mobile-todos"];

function englishDemo(scene: SceneId): boolean {
  return currentLocale() === "en" && ENGLISH_DEMO_SCENES.includes(scene);
}

type Say = (zh: string, en: string) => string;

function hobTaskActivity(L: Say): Job["activity"] {
  return [
    { at: minsAgo(6), verb: "$", text: "npm run typecheck" },
    { at: minsAgo(5), verb: "读", text: "protocol/src/projection.ts" },
    { at: minsAgo(4), verb: "读", text: "client/src/runtime/store.ts" },
    { at: minsAgo(3), verb: "跑", text: L("浏览器 打开 http://localhost:3000/pricing", "open http://localhost:3000/pricing in the browser") },
    { at: minsAgo(3), verb: "跑", text: "npm test -w protocol" },
    { at: minsAgo(2), verb: "读", text: "client/src/chat/Transcript.tsx" },
    { at: minsAgo(1), verb: "读", text: "client/src/chat/ToolRow.tsx" },
  ];
}

function buildDb(scene: SceneId): Db {
  const s1 = scene === "s1" || scene === "s6";
  const en = englishDemo(scene);
  const L: Say = (zh, english) => (en ? english : zh);
  const draftPending = scene === "s4";
  // 需要演示“待确认”的场景：桌面的 s1 和手机列表的 mlist（两边截图看同一套内容）
  const pending = s1 || scene === "mlist";
  const publishAnswered = !pending && scene !== "mchat";

  const assistants: AssistantSummary[] = [
    {
      id: "hob",
      name: "Hob",
      duty: L("主助手", "Main assistant"),
      sprite: "hob",
      primary: true,
      pinned: true,
      hidden: false,
      notify: true,
      instructions: L("输出用中文短句；编写代码的任务先询问项目目录。", "Keep replies short; for coding jobs, ask for the project folder first."),
      createdAt: at(30, 9, 0),
      last: { text: L("已交给任务处理，完成后通知你。", "Handed it to a job. I'll tell you when it's done."), at: at(0, 10, 5) },
      unread: 0,
      busy: true,
    },
    {
      id: "page",
      name: L("写作", "Writing"),
      duty: L("周报和文章", "Weekly reports and articles"),
      sprite: "page",
      primary: false,
      pinned: true,
      hidden: false,
      notify: true,
      instructions: L("口语化短句；标题不超过 20 字；配图自行生成；周报每周五提交。", "Short, conversational lines; titles under 60 characters; make your own images; send the weekly report on Fridays."),
      models: {
        work: { ref: "faux/smart", thinking: "high" },
        allowed: ["faux/smart", "faux/vision"],
      },
      abilities: { exec: false, write: true, image: true },
      createdAt: at(30, 9, 0),
      last: { text: L("好的。每周五 17:00 撰写初稿，存入草稿箱，完成后通知你。", "Sure. Every Friday at 17:00 I'll write the draft, save it to the drafts folder, and tell you when it's done."), at: at(0, 10, 20) },
      unread: 2,
      busy: false,
    },
    {
      id: "server",
      name: L("服务器", "Ops"),
      duty: L("线上和机器", "Servers and machines"),
      sprite: "server",
      primary: false,
      pinned: true,
      hidden: false,
      notify: true,
      instructions: L("清理日志前先查看保留天数的规则。", "Check the retention rule before cleaning up logs."),
      createdAt: at(28, 9, 0),
      last: { text: L("凌晨 3 点清理 2.1GB 旧日志", "Cleaned 2.1 GB of old logs at 3 am"), at: at(1, 3, 5) },
      unread: 0,
      busy: false,
    },
    {
      id: "bird",
      name: L("行业动态", "Industry news"),
      duty: L("每天 6 条行业动态", "Six industry updates a day"),
      sprite: "bird",
      primary: false,
      pinned: false,
      hidden: false,
      notify: true,
      instructions: L("关注 agent 编排和本地部署，不包含融资新闻。", "Follow agent orchestration and local deployment; skip funding news."),
      createdAt: at(7, 9, 0),
      splitFrom: { from: "hob", at: at(7, 9, 0), conversations: 8 },
      last: { text: L("今天 6 条，挑选了 2 条重点", "Six items today, two worth your time"), at: at(0, 9, 0) },
      unread: 0,
      busy: false,
    },
    {
      id: "house",
      name: L("家里 NAS", "Photos"),
      duty: L("相册和备份", "Photos and backups"),
      sprite: "house",
      primary: false,
      pinned: false,
      hidden: false,
      notify: false,
      instructions: "",
      createdAt: at(25, 9, 0),
      last: { text: L("相册备份完成，新增 312 张", "Photo backup done: 312 new photos"), at: at(0, 7, 30) },
      unread: 0,
      busy: false,
    },
    {
      id: "coin",
      name: L("记账", "Budget"),
      duty: L("账单和预算", "Bills and budgets"),
      sprite: "coin",
      primary: false,
      pinned: false,
      hidden: false,
      notify: false,
      instructions: "",
      createdAt: at(24, 9, 0),
      last: { text: L("10 月账单已整理完成，比上月减少 12%", "October bills are done, 12% less than last month"), at: at(1, 21, 10) },
      unread: 0,
      busy: false,
    },
    {
      id: "book",
      name: L("读书", "Reading"),
      duty: L("读书笔记", "Reading notes"),
      sprite: "book",
      primary: false,
      pinned: false,
      hidden: true,
      notify: false,
      instructions: "",
      createdAt: at(20, 9, 0),
      last: { text: L("本周读书笔记已整理完成", "This week's reading notes are done"), at: at(3, 20, 0) },
      unread: 0,
      busy: false,
    },
    {
      id: "leaf",
      name: L("健身", "Fitness"),
      duty: L("每周训练", "Weekly training"),
      sprite: "leaf",
      primary: false,
      pinned: false,
      hidden: true,
      notify: false,
      instructions: "",
      createdAt: at(18, 9, 0),
      last: { text: L("本周三次训练已记录", "Three sessions recorded this week"), at: at(2, 19, 0) },
      unread: 0,
      busy: false,
    },
    // 自带的敏捷团队（收起的助手）：g6、g7 里的五个人
    {
      id: "po",
      name: L("产品负责人", "Product owner"),
      duty: L("统筹和优先级", "Coordination and priorities"),
      dutyLong: L("接住用户和定时任务带来的事，按分量安排：一个任务能做完的，自己派任务或者叫合适的成员来做，结果回来核一遍再告诉用户；要几个人接力的，开一个话题，在里面安排，做完给用户一个结论。", "Take on what the user and the schedules bring and size it up: if one job can finish it, start that job yourself or bring in the right member, then check the result before telling the user; if it needs several people handing off, open a topic, run it there, and give the user a conclusion when it is done."),
      sprite: "sticky:purple",
      primary: false,
      pinned: false,
      hidden: true,
      notify: true,
      instructions: "",
      createdAt: at(5, 10, 0),
      last: { text: L("列了 4 项待办，第 4 项要你在手机上试一下", "4 to-dos listed; item 4 is yours to try on a phone"), at: at(0, 9, 41) },
      unread: 0,
      busy: false,
    },
    {
      id: "arch",
      name: L("架构师", "Architect"),
      duty: L("方案和设计", "Design and boundaries"),
      dutyLong: L("定方案、拆边界，写清接口和数据结构，让动手的人不用猜。", "Settle the approach, draw the boundaries, and write down the interfaces and data structures so whoever builds it doesn't have to guess."),
      sprite: "blocks:slate",
      primary: false,
      pinned: false,
      hidden: true,
      notify: true,
      instructions: "",
      createdAt: at(5, 10, 0),
      last: { text: L("30 天的长效 token 放 httpOnly cookie", "The 30-day token goes in an httpOnly cookie"), at: at(0, 9, 44) },
      unread: 0,
      busy: false,
    },
    {
      id: "dev",
      name: L("开发", "Developer"),
      duty: L("写代码", "Code"),
      dutyLong: L("按待办实现，先写一个会失败的测试，做完自审。", "Build what the to-dos ask for, start with a test that fails, and review your own work."),
      sprite: "code:green",
      primary: false,
      pinned: false,
      hidden: true,
      notify: true,
      instructions: "",
      createdAt: at(5, 10, 0),
      last: { text: L("开工", "Started"), at: at(0, 9, 45) },
      unread: 0,
      busy: true,
    },
    {
      id: "qa",
      name: L("测试", "Tester"),
      duty: L("测试和回归", "Testing and regression"),
      dutyLong: L("没参与做的时候，对照要做成什么样逐条查，附上证据。", "When you didn't build it, go through what was asked, item by item, and attach evidence."),
      sprite: "bug:red",
      primary: false,
      pinned: false,
      hidden: true,
      notify: true,
      instructions: "",
      createdAt: at(5, 10, 0),
      unread: 0,
      busy: false,
    },
    {
      id: "release",
      name: L("发布", "Release"),
      duty: L("上线和回滚", "Deploy and roll back"),
      dutyLong: L("发版、上线和回滚，写清这次上了什么、怎么退回去。", "Ship, deploy and roll back; say what went out and how to undo it."),
      sprite: "rocket:orange",
      primary: false,
      pinned: false,
      hidden: true,
      notify: true,
      instructions: "",
      createdAt: at(5, 10, 0),
      unread: 0,
      busy: false,
    },
  ];

  const approval = (
    id: string,
    assistantId: string,
    title: string,
    detail: string | undefined,
    options: Approval["options"],
    answered: boolean,
    chosen: Approval["chosen"],
    createdAt: string,
    ruleText?: string,
  ): Approval => ({
    id,
    assistantId,
    title,
    detail,
    options,
    status: answered ? "answered" : "pending",
    chosen: answered ? chosen : undefined,
    source: "router",
    ruleText,
    createdAt,
    answeredAt: answered ? createdAt : undefined,
  });

  const publishOptions: Approval["options"] = [
    { key: "A", label: L("发布", "Publish") },
    { key: "B", label: L("暂不发布", "Not now") },
    { key: "C", label: L("以后同类内容直接发布，无需确认", "Always publish this kind of content without asking"), always: true },
  ];

  const approvals: Record<string, Approval> = {
    "ap-publish": approval(
      "ap-publish",
      "page",
      L("发到公众号吗？", "Publish it to the blog?"),
      undefined,
      clone(publishOptions),
      publishAnswered,
      "C",
      at(0, 7, 42),
      L("发公众号", "Publish to the blog"),
    ),
    "ap-split": approval(
      "ap-split",
      "hob",
      L("是否创建一个专属助手「行业动态」？", "Create a dedicated \"Industry news\" assistant?"),
      s1
        ? L("这两周你让我查询了 8 次模型和 agent 产品的动态。创建后它会记住你关注的内容，每天早上 9 点提供一份简报。", "You asked me for model and agent news 8 times in the last two weeks. Once it exists, it remembers what you follow and sends a brief at 9 every morning.")
        : L("这两周你让我查询了 8 次模型和 agent 产品的动态。", "You asked me for model and agent news 8 times in the last two weeks."),
      [
        { key: "A", label: L("创建专属助手", "Create the assistant") },
        { key: "B", label: L("暂不创建", "Not now") },
      ],
      !pending,
      "A",
      at(0, 10, 15),
    ),
  };

  const draft: Draft = {
    id: "d-bird",
    assistantId: "hob",
    status: draftPending ? "pending" : "created",
    name: "行业动态",
    sprite: "bird",
    duty: "跟踪模型发布、agent 产品和开源项目",
    dutyLong: "跟踪模型发布、agent 产品和开源项目",
    routines: [{ name: "每日简报", instruction: "挑最值得看的几条，最多 6 条", schedule: "0 9 * * *" }],
    routinesText: "每天 09:00 简报，最多 6 条；重要发布随时提醒",
    askFirst: ["花钱订阅", "替你对外发消息"],
    instructions: ["关心 agent 编排和本地部署", "不看融资新闻"],
    carry: { conversations: 8 },
    createdAssistantId: draftPending ? undefined : "bird",
    createdAt: at(0, 10, 17),
  };

  const jobRunning: Job = {
    id: "t-0931",
    assistantId: "hob",
    title: L("排查页面卡顿", "Why the page is slow"),
    instruction: L("排查页面卡顿的原因，不要修改代码。", "Find out why the page is slow. Don't change any code."),
    status: "running",
    createdAt: minsAgo(6),
    startedAt: minsAgo(6),
    stats: { reads: 14, commands: 3, edits: 0 },
    cwd: "/srv/example/site",
    activity: hobTaskActivity(L),
  };

  const jobRounds: Job = {
    id: "t-rounds", assistantId: "hob", title: L("整理项目资料", "Tidy project files"), instruction: L("整理项目资料并列出缺失项。", "Tidy the project files and list what's missing."),
    status: "running", createdAt: minsAgo(40), startedAt: minsAgo(5),
    stats: { reads: 5, commands: 2, edits: 0 },
    rounds: [
      { status: "done", startedAt: minsAgo(40), endedAt: minsAgo(30), durationMs: 600000, summary: L("已整理资料清单。", "Filed a list of the materials."), files: ["/srv/example/list.md"], followUp: L("核对缺失的文档。", "Check the missing documents.") },
      { status: "stuck", startedAt: minsAgo(25), endedAt: minsAgo(15), durationMs: 600000, summary: L("缺少接口文档，暂时无法核对。", "No API docs, so I can't check them yet."), followUp: L("先根据现有资料继续。", "Carry on with what we have.") },
    ],
    activity: [
      { at: minsAgo(35), verb: "读", text: L("/srv/example/资料", "/srv/example/docs") },
      { at: minsAgo(20), verb: "搜", text: L("接口文档", "API docs") },
      { at: minsAgo(3), verb: "读", text: L("/srv/example/项目资料", "/srv/example/project-docs") },
    ],
  };

  const jobDone: Job = {
    id: "t-0927",
    assistantId: "server",
    title: L("清理旧日志", "Clean old logs"),
    instruction: L("清理三天前的旧日志，不要影响正在运行的服务。", "Delete logs older than three days without disturbing running services."),
    status: "done",
    createdAt: at(1, 3, 0),
    startedAt: at(1, 3, 0),
    endedAt: at(1, 3, 5),
    stats: { reads: 4, commands: 2, edits: 0 },
    summary: L("已清理 2.1GB 旧日志，服务均正常运行。", "Cleaned 2.1 GB of old logs; services are running normally."),
    cwd: "/srv/example/reports",
    files: ["/srv/example/reports/log-cleanup-1031.md", "/srv/example/reports/stats.csv"],
    activity: [
      { at: at(1, 3, 0), verb: "$", text: "du -sh /var/log/*" },
      { at: at(1, 3, 1), verb: "读", text: "/var/log/nginx" },
      { at: at(1, 3, 3), verb: "跑", text: "find /var/log -mtime +3 -delete" },
      ...Array.from({ length: 9 }, (_, i) => ({ at: at(1, 3, 4), verb: "读" as const, text: `/srv/example/reports/src/check-${i}.ts` })),
      { at: at(1, 3, 5), verb: "说", text: "已清理 2.1GB，服务均正常运行。" },
    ],
  };

  const jobBackup: Job = {
    id: "t-0929",
    assistantId: "house",
    title: L("整理相册备份", "Photo backup"),
    instruction: L("把手机里这个月的照片备份到 NAS，重复的跳过。", "Back up this month's photos from my phone; skip duplicates."),
    status: "done",
    createdAt: minsAgo(58),
    startedAt: minsAgo(58),
    endedAt: minsAgo(51),
    stats: { reads: 6, commands: 2, edits: 0 },
    summary: L("新增 312 张，重复跳过 87 张，占用 4.2GB。", "312 new photos, 87 duplicates skipped, 4.2 GB."),
    activity: [
      { at: minsAgo(57), verb: "读", text: L("/mnt/nas/photos", "/srv/photos") },
      { at: minsAgo(55), verb: "跑", text: L("rsync -a --ignore-existing /sdcard/DCIM /mnt/nas/photos/", "rsync -a --ignore-existing /sdcard/DCIM /srv/photos/") },
      { at: minsAgo(51), verb: "说", text: L("新增 312 张，占用 4.2GB。", "312 new photos, 4.2 GB.") },
    ],
  };

  const routines: Routine[] = [
    {
      id: "r-morning",
      assistantId: "hob",
      name: L("早报", "Morning brief"),
      instruction: L("汇总昨天交代的事和今天要紧的事，早上汇报一次。", "Summarize what you asked for yesterday and what matters today, once in the morning."),
      schedules: ["0 8 * * *"],
      active: true,
      createdAt: at(20, 21, 0),
      runs: [{ jobId: "t-0901", at: at(0, 8, 0), status: "done" }],
    },
    {
      id: "r-weekly-reminder",
      assistantId: "hob",
      name: L("周报提醒", "Weekly report reminder"),
      instruction: L("周五下午提醒查看本周周报。", "On Friday afternoon, remind me to check this week's report."),
      schedules: ["0 17 * * 5"],
      active: true,
      createdAt: at(20, 21, 2),
      runs: [],
    },
    {
      id: "r-reconcile",
      assistantId: "hob",
      name: L("月底对账", "Month-end check"),
      instruction: L("月末核对账单，列出不一致的项目。", "At month end, check the bills and list anything that doesn't match."),
      schedules: ["0 9 28 * *"],
      active: false,
      createdAt: at(19, 10, 0),
      runs: [{ jobId: "t-0820", at: at(4, 9, 0), status: "done" }],
    },
    {
      id: "r-daily",
      skill: "daily-brief",
      assistantId: "bird",
      name: L("每日简报", "Daily brief"),
      instruction: L(
        "挑模型发布、agent 产品和开源项目里最值得看的几条，每条一句话说清为什么重要。最多 6 条，不看融资新闻。",
        "Pick the few most useful items from model releases, agent products and open-source projects, one line each on why it matters. Six items at most; skip funding news.",
      ),
      schedules: ["0 9 * * *"],
      active: true,
      createdAt: at(7, 9, 0),
      runs: [
        { jobId: "t-0926", at: at(0, 9, 0), status: "done", durationMs: 372000, tools: 95, tokens: 198000 },
        { jobId: "t-0925", at: at(1, 9, 0), status: "done" },
        { jobId: "t-0924", at: at(2, 9, 1), status: "done" },
        { jobId: "t-0923", at: at(3, 9, 0), status: "done" },
      ],
    },
    {
      id: "r-weekly-draft",
      assistantId: "page",
      name: L("周报初稿", "Weekly report draft"),
      instruction: L("每周五 17:00 撰写周报初稿，存入草稿箱，完成后通知我。", "Every Friday at 17:00 write the weekly report draft, save it to the drafts folder, and tell me when it's done."),
      schedules: ["0 17 * * 5"],
      active: true,
      createdAt: at(0, 10, 21),
      runs: [],
    },
    {
      id: "r-pr-watch",
      assistantId: "hob",
      name: L("盯新 PR", "Watch new pull requests"),
      instruction: L("有新的 PR 就看改了哪些文件、值不值得细看，告诉我要不要评审。", "When a new pull request opens, see which files changed and whether it's worth a close read, then tell me whether to review it."),
      schedules: ["*/10 * * * *"],
      active: true,
      createdAt: at(3, 14, 20),
      runs: [{ jobId: "t-0901", at: at(1, 11, 20), status: "done" }],
      check: {
        then: "notify",
        script: String.raw`#!/bin/bash
# 只报上次之后新开的 PR
seen=.seen
touch "$seen"
curl -s "https://api.github.com/repos/FFatTiger/hob/pulls?state=open&sort=created&direction=desc" |
  jq -r '.[] | "#\(.number) \(.title) · \(.user.login)"' > now.txt
grep -Fxv -f "$seen" now.txt
cat now.txt >> "$seen"`,
      },
      checks: { total: 288, hits: 3, lastAt: minsAgo(4) },
    },
    {
      id: "r-issue-watch",
      assistantId: "hob",
      name: L("盯 issue 回复", "Watch issue replies"),
      instruction: L("有新回复的 issue 看一下，要我回的就拟一份回复草稿。", "Read issues with new replies, and draft a reply when it's mine to answer."),
      schedules: ["*/30 * * * *"],
      active: true,
      createdAt: at(6, 9, 40),
      runs: [],
      check: { then: "job", script: "gh api repos/FFatTiger/hob/issues --jq '.[] | select(.comments | length > 0)'" },
      checks: { total: 96, hits: 1, lastAt: minsAgo(6), failing: "退出码 128：fatal: could not read Username for 'https://github.com': terminal prompts disabled" },
    },
    {
      id: "r-pay-rent",
      assistantId: "hob",
      name: L("交房租", "Pay rent"),
      instruction: L("提醒我这个月交房租，别忘了把转账截图存下来。", "Remind me to pay rent this month, and keep the transfer screenshot."),
      schedules: [point(1, 9)],
      active: false,
      createdAt: at(5, 20, 12),
      runs: [{ jobId: "t-0902", at: at(1, 9, 0), status: "done", durationMs: 96000, tools: 12, tokens: 24000 }],
      stoppedAt: at(1, 9, 1),
      stopReason: "finished",
    },
    {
      id: "r-watch-files",
      assistantId: "hob",
      name: L("盯下载目录", "Watch the downloads folder"),
      instruction: L("下载目录里出现新的报销单就告诉我一声。", "Tell me when a new expense form shows up in the downloads folder."),
      schedules: ["*/15 * * * *"],
      active: false,
      createdAt: at(2, 10, 5),
      runs: [],
      once: true,
      stoppedAt: minsAgo(31),
      stopReason: "hit",
      check: {
        then: "notify",
        script: String.raw`#!/bin/bash
# 只报上次之后新放进来的报销单
seen=.seen
mkdir -p ~/Downloads
ls ~/Downloads | grep 报销单 > now.txt
comm -13 <(sort "$seen" 2>/dev/null) <(sort now.txt)
cp now.txt "$seen"`,
      },
      checks: { total: 42, hits: 1, lastAt: minsAgo(31) },
    },
  ];

  const asst = (id: string, time: string, text: string, routine?: { id: string; name: string; jobId?: string }): Item => ({
    kind: "assistant",
    id,
    at: time,
    text,
    routine,
  });

  const morning = L(
    "早上好。昨晚交代的两件事均已完成：\n\n- 写作已将周报初稿存入草稿箱\n- 服务器凌晨 3 点清理了 2.1GB 旧日志",
    "Morning. Both things from last night are done:\n\n- Writing put the weekly report draft in the drafts folder\n- Ops cleaned 2.1 GB of old logs at 3 am",
  );

  const hobItems: Item[] = [
    asst("i-h1", at(0, 8, 0), morning),
    { kind: "user", id: "i-h3", at: at(0, 10, 5), text: L("页面为什么这么卡？排查一下原因，不要修改代码。", "Why is the page so slow? Find the cause, but don't change any code.") },
    asst("i-h4", at(0, 10, 5), L("已交给任务处理，完成后通知你。", "Handed it to a job. I'll tell you when it's done.")),
    { kind: "job", id: "i-h5", at: at(0, 10, 5), jobId: "t-0931" },
    { kind: "question", id: "i-h6", at: at(0, 10, s1 ? 9 : 15), approvalId: "ap-split" },
    { kind: "job", id: "i-round-1", at: minsAgo(40), jobId: "t-rounds", round: 0 },
    { kind: "job", id: "i-round-2", at: minsAgo(25), jobId: "t-rounds", round: 1 },
    { kind: "job", id: "i-round-3", at: minsAgo(5), jobId: "t-rounds", round: 2 },
  ];
  if (!s1) {
    hobItems.push(
      { kind: "user", id: "i-h7", at: at(0, 10, 16), text: "创建专属助手吧。最多 6 条即可，不要包含融资新闻。" },
      asst("i-h8", at(0, 10, 17), "草稿如下，需要修改请直接说："),
      { kind: "draft", id: "i-h9", at: at(0, 10, 17), draftId: "d-bird" },
    );
  }
  // s4 是“草稿卡 + 右栏收起”那一屏，只保留草稿前后的几段
  const hobList = draftPending ? hobItems.filter((x) => !["i-h2", "i-h3", "i-h4", "i-h5"].includes(x.id)) : hobItems;

  const pageItems: Item[] = [
    asst("i-p1", at(1, 17, 5), "周报初稿已完成，存放在草稿箱。"),
    {
      kind: "user",
      id: "i-p2",
      at: at(1, 17, 6),
      text: scene === "mchat" ? "好，周一发布。" : "标题再短一些。",
    },
    asst(
      "i-p3",
      at(1, 17, 8),
      scene === "mchat" ? "好的，周一发布时我会再提醒你。" : "已改为《这周：Hob 立项》。",
    ),
    asst("i-p4", at(0, 7, 40), "《Grok Bot 能借鉴什么》已完成，3200 字，包含 4 张配图。"),
    {
      kind: "file",
      id: "i-p5",
      at: at(0, 7, 41),
      path: "/srv/example/notes/Grok Bot 能借鉴什么.md",
      name: "Grok Bot 能借鉴什么.md",
      meta: "3200 字 · 4 张图",
    },
    { kind: "question", id: "i-p6", at: at(0, 7, 42), approvalId: "ap-publish" },
  ];
  if (scene !== "mchat") {
    pageItems.push(
      { kind: "note", id: "i-p7", at: at(0, 7, 43), icon: "rule", text: "已记入写作的规则 · 发布公众号无需确认" },
      asst("i-p8", at(0, 7, 44), "已发布。[查看文章](https://mp.weixin.qq.com/)"),
      { kind: "user", id: "i-p9", at: at(0, 10, 20), text: "以后周报也由你负责，周五下午提供初稿。" },
      asst("i-p10", at(0, 10, 20), "好的。每周五 17:00 撰写初稿，存入草稿箱，完成后通知你。"),
      { kind: "note", id: "i-p11", at: at(0, 10, 21), icon: "routine", text: "新增定时任务 · 周报初稿 · 每周五 17:00" },
    );
  }

  const birdItems: Item[] = [
    {
      kind: "note",
      id: "i-b0",
      at: at(7, 9, 0),
      icon: "split",
      text: `${new Date(at(7, 9, 0)).getMonth() + 1}月${new Date(at(7, 9, 0)).getDate()}日 由 Hob 创建`,
    },
    asst("i-b1", at(1, 9, 0), "昨天 5 条，没有特别要紧的。[看全部 5 条](https://example.com/)", {
      id: "r-daily",
      name: "每日简报",
    }),
    { kind: "job", id: "i-b-job", at: at(0, 9, 0), jobId: "t-0926" },
    asst("i-b2", at(0, 9, 0), "今天 6 条，挑选 2 条重点：", { id: "r-daily", name: "每日简报", jobId: "t-0926" }),
    asst(
      "i-b3",
      at(0, 9, 0),
      "1. DeepSeek 公开 Super-agent 设计：路由只分派，任务隔离执行。\n2. xAI 的 Grok Bot：常驻 Bot 加定时任务，结果直接回到对话。\n\n[看全部 6 条](https://example.com/)",
    ),
    {
      kind: "user",
      id: "i-b4",
      at: at(0, 9, 12),
      text: "这个和 Hob 相比，差异在哪里？",
      quote: { itemId: "i-b3", text: "xAI 的 Grok Bot：常驻 Bot 加定时任务…" },
    },
    asst(
      "i-b5",
      at(0, 9, 12),
      "它的 Bot 有一台云电脑，能直接操作网页；Bot 之间也能互相发消息。定时任务、审批、助手创建，我们均已具备。",
    ),
    { kind: "user", id: "i-b6", at: at(0, 9, 14), text: "以后不需要包含融资新闻。" },
    asst("i-b7", at(0, 9, 14), "好的，已记录。"),
    { kind: "note", id: "i-b8", at: at(0, 9, 14), icon: "memory", text: "记忆已更新 · 不包含融资新闻，优先关注人工智能产品和模型的重要更新与实际应用" },
    { kind: "note", id: "i-b8-en", at: at(0, 9, 14), icon: "memory", text: "记忆已更新 · Follow important AI product and model updates, focusing on practical applications." },
    { kind: "note", id: "i-b9", at: at(0, 9, 15), icon: "skill", text: "已沉淀技能「每日行业简报」，以后定时执行按它做", path: "/mock/assistants/bird/skills/daily-brief/SKILL.md" },
  ];

  const small = (id: string, a: string, b: string, c: string): Item[] => [
    asst(`${id}-1`, at(1, 20, 0), a),
    { kind: "user", id: `${id}-2`, at: at(1, 20, 2), text: b },
    asst(`${id}-3`, at(1, 20, 3), c),
  ];

  const items: Record<string, Item[]> = {
    hob: hobList,
    page: pageItems,
    bird: birdItems,
    server: [
      ...small(
        "i-s",
        "凌晨清理日志的任务已完成，清理 2.1GB，服务均正常运行。",
        "好的，以后每月清理一次。",
        "已记录：每月 1 号凌晨 3 点清理一次。",
      ),
      { kind: "job", id: "i-s4", at: at(1, 3, 5), jobId: "t-0927" },
    ],
    house: small(
      "i-ho",
      "相册备份已完成，新增 312 张，占用 4.2GB。",
      "硬盘还剩多少？",
      "剩余 1.8TB，可用约半年。",
    ),
    coin: small(
      "i-c",
      "10 月账单已整理完成，比上月减少 12%。",
      "哪一类支出较多？",
      "餐饮和打车，比上月增加 800。",
    ),
    book: small("i-bk", "本周读书笔记已整理完成，共三条。", "发给我看看。", "已放入文件中。"),
    leaf: small("i-lf", "本周三次训练已记录。", "下周增加到四次。", "好的，下周安排四次。"),
  };

  if (scene === "image") {
    items.hob = [
      { kind: "user", id: "image-user", at: minsAgo(3), text: "画几张图片给我看看。" },
      { kind: "image", id: "image-done", at: minsAgo(3), startedAt: minsAgo(3), prompt: "海边的日落", size: "1536x1024", status: "done", path: "/mock/photo.jpg" },
      { kind: "image", id: "image-failed", at: minsAgo(2), startedAt: minsAgo(2), prompt: "山间的早晨", status: "failed", error: "图像服务暂时不可用，请稍后重试。" },
      { kind: "image", id: "image-pending", at: minsAgo(1), startedAt: minsAgo(1), prompt: "安静的街道", status: "pending" },
    ];
  }

  if (scene === "bubbles" || scene === "bubbles-dark") {
    items.hob = [
      { kind: "user", id: "bubble-user", at: minsAgo(3), text: "给我看看公式、代码和媒体。" },
      asst("bubble-text", minsAgo(2), "行内公式 $E=mc^2$，整行公式：\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\n```js\nconst answer = 42;\n```\n\n```sh\necho hello\n```\n\n价格是 $5 和 $10。"),
      asst("bubble-md", minsAgo(2), "我把刚才的示意图整理成 `.md` 文件，图用 Mermaid 写，方便你看源码或直接预览。"),
      { kind: "job", id: "bubble-job", at: minsAgo(2), jobId: "t-0927" },
      { kind: "file", id: "bubble-file", at: minsAgo(2), path: "/mock/火星日落示意图.md", name: "火星日落示意图.md", meta: "349 字" },
      asst("bubble-after-file", minsAgo(2), "《火星日落示意图.md》已发给你。直接打开能看 Markdown 源码，用支持 Mermaid 的预览器可以看到光路图。"),
      { kind: "file", id: "bubble-page", at: minsAgo(2), path: "/mock/sunset.html", name: "如果在地球和火星同时看日落", meta: "两幅同视角示意图：看太阳周围，再看远离太阳的天空。" },
      asst("bubble-list", minsAgo(2), "五个模块：\n\n1. **两层架构。** Router 长期在线，只负责人机交互、全局协调和派发，**故意不执行任务，甚至可以没有 Bash 工具**；Worker 上下文隔离，**但从不直接对人说话**，只向 Router 报告。\n2. **全双工。** 把同步 `run()` 换成异步 `start()` / `stop()`，立刻回一句\"已开始\"。\n   - 工具跑完再作为新事件送回来\n   - **这个机制默认没开。**\n3. 普通的一行\n4. 第四\n5. 第五\n6. 第六\n7. 第七\n8. 第八\n9. 第九\n10. 第十项，两位数的序号也要对齐"),
      { kind: "file", id: "bubble-audio", at: minsAgo(1), path: "/mock/audio.mp3", name: "语音样本.mp3" },
      { kind: "file", id: "bubble-video", at: minsAgo(1), path: "/mock/video.mp4", name: "视频样本.mp4" },
      { kind: "user", id: "bubble-photo", at: minsAgo(1), text: "这个是什么", files: ["/mock/photo.jpg"] },
      { kind: "user", id: "bubble-photo-only", at: minsAgo(1), text: "", files: ["/mock/photo2.jpg"] },
      { kind: "user", id: "bubble-photos", at: minsAgo(1), text: "两张对比一下", files: ["/mock/photo.jpg", "/mock/photo2.jpg"] },
      { kind: "user", id: "bubble-user-file", at: minsAgo(1), text: "帮我看看这份报告", files: ["/mock/u-k2m9xq-季度报告.pdf"] },
      { kind: "user", id: "bubble-user-2", at: minsAgo(1), text: "画个简单的表格给我，有几种方式？" },
      asst("bubble-table", minsAgo(0), "主要有四种：\n\n| 方式 | 适合什么情况 | 能不能改 |\n| --- | --- | --- |\n| 聊天里直接画 | 简单的表，看一眼就行 | 让我重画 |\n| 发 Excel 或 CSV 文件 | 要下载、自己改或者算 | 能 |\n| 做成页面 | 能排序、筛选，以后还要更新 | 能 |\n| 做成图片 | 要转发给别人或者发朋友圈 | 不能 |\n\n想要哪种？告诉我放什么内容。"),
    ];
  }

  const delegations: Record<string, Delegation> = {};
  const jobs: Record<string, Job> = { "t-0931": jobRunning, "t-rounds": jobRounds, "t-0927": jobDone, "t-0929": jobBackup,
    "t-0926": { id: "t-0926", assistantId: "bird", title: L("每日简报", "Daily brief"), instruction: L("整理每日简报", "Put together the daily brief"), status: "done", createdAt: at(0, 8, 54), startedAt: at(0, 8, 54), endedAt: at(0, 9, 0), durationMs: 372000, stats: { reads: 30, commands: 60, edits: 5 }, usage: { input: 180000, output: 18000, cost: 0 }, routineId: "r-daily", summary: L("今天 6 条，挑选 2 条重点。", "Six items today, two worth your time."), activity: [] },
  };
  if (scene === "s1" || scene === "s6") {
    delegations["dg-sidebar-running"] = { id: "dg-sidebar-running", from: "hob", to: "page", text: L("整理文章。", "Tidy the articles."), createdAt: minsAgo(6), status: "running", jobIds: [] };
    delegations["dg-sidebar-waiting"] = { id: "dg-sidebar-waiting", from: "hob", to: "server", text: L("检查服务器。", "Check the servers."), createdAt: minsAgo(5), status: "waiting", jobIds: [] };
    items.hob.push({ kind: "delegation", id: "sidebar-running", at: minsAgo(6), delegationId: "dg-sidebar-running" }, { kind: "delegation", id: "sidebar-waiting", at: minsAgo(5), delegationId: "dg-sidebar-waiting" });
  }
  if (scene.startsWith("d-")) {
    const status = scene === "d-waiting" || scene === "d-mobile" ? "waiting" : scene === "d-done" ? "done" : "running";
    // 转过去的话和真的一样带着段头：原话、最近的对话（界面上折起来）、备注
    const brief = L("用户原话（11月13日 09:13）：\n检查一下服务器的磁盘和服务状态。\n\n最近的对话：\n用户（09:10）：昨晚的备份好像跑得很慢\nHob（09:11）：我先看看备份任务的记录。\n\nHob 的备注：清理前先确认，不要影响正在运行的服务。", "Your words (Nov 13, 09:13):\nCheck the server disks and services.\n\nHob's note: confirm before cleaning; don't disturb running services.");
    const delegation: Delegation = { id: "dg-demo", from: "hob", to: "server", text: brief, createdAt: minsAgo(6), status, jobIds: ["t-delegated"], approvalIds: [] };
    delegations[delegation.id] = delegation;
    jobs["t-delegated"] = { ...jobRunning, id: "t-delegated", assistantId: "server", delegationId: delegation.id, title: "检查服务器状态", instruction: brief, status: status === "waiting" ? "waiting" : status };
    if (status === "waiting") approvals["ap-delegation"] = { id: "ap-delegation", assistantId: "server", title: "清理旧日志吗？", detail: "将清理七天前的日志。", options: [{ key: "A", label: "清理旧日志" }, { key: "B", label: "暂不清理" }], recommended: "A", status: "pending", source: "job", jobId: "t-delegated", createdAt: minsAgo(2) };
    items.hob = [{ kind: "user", id: "d-user", at: minsAgo(7), text: "检查一下服务器的磁盘和服务状态。" }, { kind: "delegation", id: "d-card", at: minsAgo(6), delegationId: delegation.id }];
    items.server = [{ kind: "user", id: "d-forward", at: minsAgo(6), text: delegation.text, from: { assistantId: "hob", name: "Hob", delegationId: delegation.id } }, { kind: "job", id: "d-job", at: minsAgo(5), jobId: "t-delegated" }, ...(status === "waiting" ? [{ kind: "question" as const, id: "d-question", at: minsAgo(2), approvalId: "ap-delegation" }] : [])];
  }

  if (scene.startsWith("h-")) {
    const server = assistants.find((assistant) => assistant.id === "server");
    if (server) server.dutyLong = "维护服务器、监控服务状态和磁盘空间；代理配置由其他助手负责。";
    delegations["dg-returned"] = { id: "dg-returned", from: "hob", to: "server", text: "检查代理节点为什么无法连接。", createdAt: minsAgo(4), status: "returned", reply: "退回：代理配置不属于服务器维护职责。", jobIds: [] };
    items.hob = [
      { kind: "user", id: "h-forward", at: minsAgo(8), text: "检查代理节点为什么无法连接。", from: { assistantId: "server", name: "服务器", delegationId: "hb-demo" } },
      { kind: "delegation", id: "h-card", at: minsAgo(4), delegationId: "dg-returned" },
    ];
    items.server = [
      { kind: "user", id: "h-user", at: minsAgo(9), text: "检查代理节点为什么无法连接。" },
      { kind: "note", id: "h-note", at: minsAgo(8), icon: "info", text: "已交回 Hob：代理配置不属于我的职责。", handbackId: "hb-demo" },
      { kind: "user", id: "h-delegation-forward", at: minsAgo(4), text: "检查代理节点为什么无法连接。", from: { assistantId: "hob", name: "Hob", delegationId: "dg-returned" } },
    ];
  }

  if (scene.startsWith("act-")) {
    const hob = assistants.find((a) => a.id === "hob")!;
    hob.busy = true;
    hob.activity = scene === "act-think" || scene === "act-demo" ? { state: "thinking", label: "正在想…" } : { state: "tool", label: "搜索：最新 AI 动态" };
    items.hob = [{ kind: "user", id: "act-user", at: minsAgo(1), text: "帮我搜索最新 AI 动态。" }];
    if (scene === "act-home") assistants.find((a) => a.id === "page")!.busy = true;
  }

  if (scene.startsWith("readme-")) {
    const writing = assistants.find((a) => a.id === "page")!;
    writing.instructions = L("周报发到团队群；素材在共享盘的周报文件夹。", "Post the weekly report to the team group; the source material is in the weekly folder on the shared drive.");
    writing.models = { work: { ref: "anthropic/claude-sonnet", thinking: "high" }, allowed: ["anthropic/claude-sonnet", "openai/gpt-5"] };
    writing.last = { text: L("周报已整理好，发送前请确认。", "The weekly report is ready; check it before I send."), at: minsAgo(2) };
    const hob = assistants.find((a) => a.id === "hob")!;
    hob.busy = false;
    hob.instructions = "";
    hob.last = { text: L("整理好了，适合用共享文档协作。", "Done. A shared doc fits how your team works."), at: minsAgo(1) };
    assistants.splice(0, assistants.length, ...assistants.filter((a) => ["hob", "page", "bird", "coin"].includes(a.id)));
    const done: Job = {
      id: "readme-job", assistantId: "hob", title: L("比较团队知识整理方案", "Compare ways to organize team docs"), instruction: L("比较团队资料的整理方式。", "Compare a few ways to organize the team's docs."),
      status: "done", createdAt: minsAgo(8), startedAt: minsAgo(8), endedAt: minsAgo(2), durationMs: 360000,
      stats: { reads: 3, commands: 1, edits: 0 }, summary: L("已比较三种方案并整理建议。", "Compared three options and wrote up a recommendation."),
      activity: [
        { at: minsAgo(7), verb: "读", text: L("团队资料/资料清单.md", "team-docs/index.md") },
        { at: minsAgo(6), verb: "搜", text: L("团队知识整理方案", "organize team docs") },
        { at: minsAgo(4), verb: "读", text: L("团队资料/现有流程.md", "team-docs/current-process.md") },
        { at: minsAgo(2), verb: "说", text: L("已完成三种方案的比较。", "Finished comparing the three options.") },
      ],
    };
    const active: Job = { ...done, id: "readme-active", assistantId: "bird", title: L("整理行业动态", "Collect industry updates"), status: "running", endedAt: undefined, durationMs: undefined, createdAt: minsAgo(4), startedAt: minsAgo(4), activity: [{ at: minsAgo(1), verb: "搜", text: L("本周行业动态", "industry news this week") }] };
    for (const key of Object.keys(jobs)) delete jobs[key];
    jobs[done.id] = done;
    jobs["readme-weekly"] = {
      id: "readme-weekly", assistantId: "page", title: L("整理本周周报", "Draft this week's report"), instruction: L("整理本周周报初稿。", "Draft this week's weekly report."),
      status: "done", createdAt: minsAgo(5), startedAt: minsAgo(5), endedAt: minsAgo(3), durationMs: 120000,
      stats: { reads: 3, commands: 0, edits: 1 }, summary: L("已整理周报初稿，等待确认后发送。", "Draft is ready; waiting for your OK to send."),
      activity: [{ at: minsAgo(4), verb: "读", text: L("周报/本周素材.md", "weekly/source.md") }, { at: minsAgo(3), verb: "说", text: L("周报初稿已整理。", "Draft is ready.") }],
    };
    if (scene === "readme-chat") jobs["readme-active"] = { ...active, assistantId: "hob", title: L("整理实施清单", "Draft an implementation checklist"), instruction: L("整理团队资料的实施清单。", "Draft an implementation checklist for the team's docs."), activity: [{ at: minsAgo(1), verb: "读", text: L("团队资料/资料清单.md", "team-docs/index.md") }] };
    for (const key of Object.keys(approvals)) delete approvals[key];
    approvals["readme-approval"] = { id: "readme-approval", assistantId: "page", title: L("将周报发到团队群吗？", "Send the weekly report to the team group?"), detail: L("周报初稿已整理好，发送前请确认。", "The draft is ready; check it before I send."), options: [{ key: "A", label: L("发送", "Send") }, { key: "B", label: L("暂不发送", "Not now") }], status: "pending", source: "router", createdAt: minsAgo(1) };
    items.hob = [
      { kind: "user", id: "readme-user", at: minsAgo(9), text: L("我们团队的资料有点散，比较几种整理方案，给我一个建议。", "Our team's docs are scattered. Compare a few ways to organize them and tell me what you'd do.") },
      asst("readme-reply", minsAgo(8), L("我会比较几种方式，整理成一页给你。", "I'll compare the options and put it on one page for you.")),
      { kind: "job", id: "readme-job-card", at: minsAgo(8), jobId: done.id },
      asst("readme-result", minsAgo(1), L("建议先用共享文档统一入口，现有资料不用搬家；下面是三种方案的比较。", "Start with a shared doc as the single entry point; nothing has to move. The comparison is below.")),
      { kind: "file", id: "readme-page-card", at: minsAgo(1), path: "/mock/readme-page.html", name: L("团队资料整理方案", "Organizing team docs"), meta: L("三种方式的对比与实施建议", "Three options compared, with a rollout plan") },
    ];
    if (scene === "readme-desktop") items.hob = [
      { kind: "user", id: "readme-browser-user", at: minsAgo(3), text: "打开示例网站，发一张截图给我看看。" },
      asst("readme-browser-reply", minsAgo(2), "已在浏览器中打开示例网站，这是当前页面的截图。"),
      { kind: "file", id: "readme-browser-shot", at: minsAgo(1), path: "/mock/desktop.jpg", name: "网页截图.jpg" },
    ];
    if (scene === "readme-chat" || scene === "readme-mobile-chat") {
      approvals["readme-chat-approval"] = { id: "readme-chat-approval", assistantId: "hob", title: L("将方案发给团队吗？", "Send the plan to the team?"), options: [{ key: "A", label: L("发送", "Send") }, { key: "B", label: L("暂不发送", "Not now") }], status: "pending", source: "router", createdAt: minsAgo(1) };
      items.hob = [
        { kind: "user", id: "readme-user", at: minsAgo(9), text: L("比较团队资料的整理方式，给我一个建议和实施清单。", "Compare ways to organize our team docs, then give me a recommendation and an implementation checklist.") },
        { kind: "job", id: "readme-job-card", at: minsAgo(8), jobId: done.id },
        asst("readme-result", minsAgo(3), L("建议先用**共享文档**统一入口，现有资料不用搬家。\n\n- 先建立目录，明确负责人\n- 再逐步整理高频使用的资料", "Start with a **shared doc** as the single entry point; existing files don't have to move.\n\n- Set up the folders first and name an owner\n- Then tidy the docs people use most")),
        { kind: "file", id: "readme-page-card", at: minsAgo(3), path: "/mock/readme-page.html", name: L("团队资料整理方案", "Organizing team docs"), meta: L("三种方式的对比与实施建议", "Three options compared, with a rollout plan") },
        { kind: "file", id: "readme-file-card", at: minsAgo(2), path: "/mock/knowledge/资料目录.md", name: L("资料目录.md", "docs-index.md"), meta: L("团队常用资料入口", "Where the team's docs live") },
        { kind: "job", id: "readme-active-card", at: minsAgo(2), jobId: "readme-active" },
        { kind: "question", id: "readme-chat-question", at: minsAgo(1), approvalId: "readme-chat-approval" },
      ];
    }
    if (scene === "readme-cards") {
      Object.assign(draft, { status: "pending", createdAssistantId: undefined, name: "资料助手", dutyLong: "整理团队资料，维护共享目录", routinesText: "每周整理资料", askFirst: ["对外发送"], instructions: ["优先整理常用资料"], carry: { conversations: 3 } });
      delegations["readme-delegation"] = { id: "readme-delegation", from: "hob", to: "page", text: "整理团队资料的使用方法。", createdAt: minsAgo(3), status: "running", jobIds: [] };
      items.hob = [
        { kind: "image", id: "readme-image", at: minsAgo(4), startedAt: minsAgo(4), status: "done", prompt: "团队资料封面", size: "1536x1024", path: "/mock/readme-cover.svg" },
        { kind: "delegation", id: "readme-delegation-card", at: minsAgo(3), delegationId: "readme-delegation" },
        { kind: "draft", id: "readme-draft-card", at: minsAgo(2), draftId: draft.id },
        { kind: "note", id: "readme-note", at: minsAgo(1), icon: "memory", text: "记忆已更新 · 优先整理常用资料" },
      ];
    }
    items.page = [
      { kind: "user", id: "readme-weekly-user", at: minsAgo(5), text: L("整理本周周报，完成后发到团队群。", "Draft this week's report, then send it to the team group.") },
      { kind: "job", id: "readme-weekly-card", at: minsAgo(5), jobId: "readme-weekly" },
      asst("readme-weekly-reply", minsAgo(3), L("周报初稿已整理好。对外发送前，请先确认。", "The draft is ready. Please confirm before I send it out.")),
      { kind: "question", id: "readme-question-card", at: minsAgo(1), approvalId: "readme-approval" },
    ];
  }

  if (scene === "card-130" || scene === "card-130-dark") {
    // 票 130 的验收场景：每种状态一张任务卡，看卡上的状态原因和沉淀状态
    const card = (id: string, title: string, patch: Partial<Job>): Job => ({
      id, assistantId: "hob", title, instruction: title,
      status: "done", createdAt: minsAgo(50), startedAt: minsAgo(50), endedAt: minsAgo(40), durationMs: 600000,
      stats: { reads: 4, commands: 2, edits: 0 }, activity: [], ...patch,
    });
    const cards: Job[] = [
      card("t-130-stop", "整理项目资料", { status: "stopped", statusReason: "你叫停了", summary: "整理到一半停下了。" }),
      card("t-130-stuck", "核对接口文档", { status: "stuck", statusReason: "沙箱里没有网络，装不上依赖，换镜像也一样；接口文档在共享盘里也没找到，问了两个同事都说不知道放在哪里，先把已经核对过的部分记下来，等你处理网络和文档之后再继续。" }),
      card("t-130-running", "写周报初稿", { sediment: { status: "running" } }),
      card("t-130-saved", "整理行业动态", { sediment: { status: "saved", name: "daily-brief", title: "每日行业简报", version: 1, updated: false } }),
      card("t-130-updated", "对比团队资料方案", { sediment: { status: "saved", name: "daily-brief", title: "每日行业简报", version: 3, updated: true } }),
      card("t-130-failed", "清理旧日志", { sediment: { status: "failed", reason: "技能目录不可写" } }),
      card("t-130-empty", "备份相册", { sediment: { status: "empty", reason: "一次性的事情" } }),
    ];
    for (const job of cards) jobs[job.id] = job;
    items.hob = [
      { kind: "user", id: "c-130-user", at: minsAgo(60), text: "看看任务卡现在的样子。" },
      ...cards.map((job, index): Item => ({ kind: "job", id: `c-130-${index}`, at: job.endedAt ?? job.createdAt, jobId: job.id })),
    ];
  }

  if (scene === "job-after" || scene === "job-after-dark") {
    // 票 142 的验收场景：排队里的任务卡在等前面的任务
    const waiting = (id: string, title: string, after: string[]): Job => ({ id, assistantId: "hob", title, instruction: title, status: "queued", createdAt: minsAgo(3), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], after });
    const first: Job = { id: "t-after-a", assistantId: "hob", title: "先查目录", instruction: "查一下目录里有几个文件", status: "running", createdAt: minsAgo(5), startedAt: minsAgo(5), stats: { reads: 1, commands: 1, edits: 0 }, activity: [{ at: minsAgo(1), verb: "跑", text: "ls /tmp/资料 | wc -l" }] };
    const second = waiting("t-after-b", "再写总结", [first.id]);
    const third = waiting("t-after-c", "发布总结", [first.id, second.id]);
    for (const job of [first, second, third]) jobs[job.id] = job;
    items.hob = [
      { kind: "user", id: "after-user", at: minsAgo(6), text: "先查一下目录里有几个文件，查完再按数量写一句总结，最后发给我。" },
      asst("after-plan", minsAgo(5), "分三步：先查目录，按数量写一句总结，最后发布。后面两步等前面做完再开始。"),
      { kind: "job", id: "after-card-a", at: minsAgo(5), jobId: first.id },
      { kind: "job", id: "after-card-b", at: minsAgo(4), jobId: second.id },
      { kind: "job", id: "after-card-c", at: minsAgo(3), jobId: third.id },
    ];
  }

  /* ---------------- 群 ---------------- */
  // 群里的一段对话：两件事穿插、@、引用、任务卡、提问卡（效果图 g2 ~ g5 用的就是这一段）
  const groupJob = (patch: Partial<Job> & { id: string; assistantId: string; title: string }): Job => ({
    instruction: patch.title,
    status: "done",
    createdAt: at(0, 9, 10),
    startedAt: at(0, 9, 12),
    endedAt: at(0, 9, 14),
    durationMs: 120_000,
    stats: { reads: 3, commands: 1, edits: 0 },
    activity: [],
    groupId: "g-home",
    ...patch,
  });
  const homeJobs = [
    groupJob({ id: "t-g-log", assistantId: "house", title: L("查看昨晚的备份日志", "Check last night's backup log"), endedAt: at(0, 9, 14), durationMs: 60_000 }),
    groupJob({ id: "t-g-clean", assistantId: "server", title: L("清理 /backup 旧快照", "Clean old snapshots in /backup"), startedAt: at(0, 9, 15), endedAt: at(0, 9, 17) }),
    groupJob({ id: "t-g-backup", assistantId: "house", title: L("重新备份相册", "Back up photos again"), startedAt: at(0, 9, 19), endedAt: at(0, 9, 25), durationMs: 360_000 }),
    {
      ...groupJob({ id: "t-g-dl", assistantId: "server", title: L("检查下载目录", "Check the downloads folder"), startedAt: minsAgo(2) }),
      status: "running" as const,
      endedAt: undefined,
      instruction: L("看看下载目录里有什么能清，清之前列出来。", "See what can be cleaned from the downloads folder; list it before deleting."),
      stats: { reads: 2, commands: 4, edits: 0 },
      activity: [
        { at: minsAgo(2), verb: "$" as const, text: "du -sh /data/downloads/*" },
        { at: minsAgo(1), verb: "读" as const, text: "/data/downloads" },
      ],
    },
  ];
  for (const job of homeJobs) jobs[job.id] = job;
  approvals["ap-g-snap"] = {
    id: "ap-g-snap",
    assistantId: "server",
    groupId: "g-home",
    title: "删掉 /backup 里 30 天前的 11 个快照吗？",
    detail: "一共 86 GB，最近 30 天的都留着。",
    options: [{ key: "A", label: "删除" }],
    status: "answered",
    chosen: "A",
    source: "router",
    createdAt: at(0, 9, 15),
    answeredAt: at(0, 9, 16),
  };

  const homeItems: GroupItem[] = [
    { kind: "note", id: "gh-1", at: at(2, 15, 0), icon: "split", text: "Hob 建了群「家里机器」：家里 NAS、服务器", speaker: "user" },
    { kind: "user", id: "gh-2", at: at(0, 9, 12), text: "昨晚相册好像没备份上，看看怎么回事", speaker: "user" },
    { kind: "assistant", id: "gh-3", at: at(0, 9, 12), text: "@家里 NAS 先看下昨晚的备份日志，找到出错的地方。", speaker: "hob" },
    { kind: "job", id: "gh-4", at: at(0, 9, 13), jobId: "t-g-log", speaker: "house" },
    { kind: "assistant", id: "gh-5", at: at(0, 9, 14), text: "备份在 02:14 中断：服务器上的 /backup 只剩 1.2 GB，这次要传 4.6 GB。\n@服务器 能腾点空间出来吗？", speaker: "house" },
    { kind: "user", id: "gh-6", at: at(0, 9, 15), text: "顺便看下下载目录，好像也快满了", speaker: "user" },
    { kind: "job", id: "gh-7", at: at(0, 9, 15), jobId: "t-g-clean", speaker: "server" },
    { kind: "question", id: "gh-8", at: at(0, 9, 15), approvalId: "ap-g-snap", speaker: "server" },
    { kind: "assistant", id: "gh-9", at: at(0, 9, 16), text: "删好了，/backup 现在空出 87 GB。@家里 NAS 可以重新备份了。", quote: { itemId: "gh-5", text: "能腾点空间出来吗？" }, speaker: "server" },
    { kind: "assistant", id: "gh-10", at: at(0, 9, 18), text: "@服务器 这件也交给你：看看下载目录里有什么能清，清之前列给我们看。", quote: { itemId: "gh-6", text: "顺便看下下载目录，好像也快满了" }, speaker: "hob" },
    { kind: "job", id: "gh-11", at: at(0, 9, 19), jobId: "t-g-backup", speaker: "house" },
    { kind: "assistant", id: "gh-12", at: at(0, 9, 19), text: "补上了：新增 312 张，共 4.6 GB。", speaker: "house" },
    { kind: "assistant", id: "gh-13", at: at(0, 9, 26), text: "相册这件办完了：服务器的备份盘满了，删掉 11 个旧快照后，相册已经补上。", quote: { itemId: "gh-2", text: "昨晚相册好像没备份上，看看怎么回事" }, speaker: "hob" },
    { kind: "job", id: "gh-14", at: at(0, 9, 27), jobId: "t-g-dl", speaker: "server" },
  ];

  jobs["t-g-dev"] = { ...groupJob({ id: "t-g-dev", assistantId: "server", title: L("实现「记住我」", "Build \"Remember me\""), startedAt: minsAgo(6) }), groupId: "g-dev", status: "running", endedAt: undefined };
  approvals["ap-g-dev"] = {
    id: "ap-g-dev",
    assistantId: "po",
    groupId: "g-dev",
    title: "换了设备还要记住登录吗？",
    detail: "这决定 token 绑不绑设备。",
    options: [{ key: "A", label: "不用，换设备重新登录" }],
    status: "answered",
    chosen: "A",
    source: "router",
    createdAt: at(0, 9, 40),
    answeredAt: at(0, 9, 41),
  };

  // 敏捷团队的综合：用户说一件事，成员回了话；要几步的事他们会开话题、列待办。
  const devItems: GroupItem[] = [
    { kind: "note", id: "gd-1", at: at(5, 10, 0), icon: "split", text: "你建了群「敏捷团队」：产品负责人、架构师、开发、测试、发布", speaker: "user" },
    { kind: "user", id: "gd-2", at: at(0, 9, 38), text: "登录页加一个「记住我」，下周发版前要上", speaker: "user" },
    { kind: "question", id: "gd-3", at: at(0, 9, 40), approvalId: "ap-g-dev", speaker: "po" },
    { kind: "assistant", id: "gd-4", at: at(0, 9, 41), text: "这件事要分几步，我开个话题列上待办，做完给你结论。", speaker: "po" },
  ];

  const groups: GroupSummary[] = [
    {
      id: "g-home",
      name: L("家里机器", "Home servers"),
      purpose: L("家里 NAS 和服务器上的存储、备份和服务", "Storage, backups and services on the home machines"),
      ownerId: "hob",
      members: ["hob", "house", "server"],
      createdAt: at(2, 15, 0),
      last: { at: at(0, 9, 27), speaker: "server", text: L("开始检查下载目录", "Started checking the downloads folder") },
      unread: 0,
      busy: ["server"],
    },
    {
      id: "g-dev",
      name: L("敏捷团队", "Agile team"),
      purpose: L("小工具和页面：方案、开发、测试和发布", "Small tools and pages: design, build, test and release"),
      ownerId: "po",
      members: ["po", "arch", "dev", "qa", "release"],
      createdAt: at(5, 10, 0),
      last: { at: at(0, 9, 49), speaker: "po", text: L("按方案做，做完先在本地跑一遍测试", "Follow the plan, then run the tests locally.") },
      unread: 1,
      busy: scene === "g-team" ? ["dev"] : [],
    },
  ];

  // 待办演示：单聊里一份在做、任务卡上一份带进度（话题里的在下面 topics 段落里给）
  if (scene === "todo-chat" || scene === "todo-job") {
    const hob = assistants.find((item) => item.id === "hob")!;
    hob.busy = false;
    hob.last = { text: L("找出变慢的那个接口", "Finding the endpoint that got slow"), at: minsAgo(3) };
    hob.todos = [
      { text: L("看这周的报错日志", "Read this week's error logs"), status: "done" },
      { text: L("找出变慢的那个接口", "Find the endpoint that got slow"), status: "doing" },
      { text: L("把结论和证据写成一段话", "Write the conclusion with its evidence"), status: "todo" },
    ];
    items.hob = [
      {
        kind: "todos",
        id: "todo-archived",
        at: minsAgo(48),
        why: "cleared",
        items: [
          { text: L("整理上个月的访问日志", "Sort last month's access logs"), status: "done" },
          { text: L("按天导出成 CSV", "Export one CSV per day"), status: "done" },
          { text: L("核对两天的数字对得上", "Check two days add up"), status: "todo" },
        ],
      },
      { kind: "user", id: "todo-user", at: minsAgo(9), text: L("这周页面有时候很慢，帮我看看为什么。", "The page is slow at times this week. Find out why.") },
      asst("todo-kick", minsAgo(9), L("要做几步，我列了待办，边做边更新，你在输入框上面就看得到。", "This takes a few steps. I listed them and will keep them updated; you can see the progress above the input box.")),
    ];
    if (scene === "todo-job") {
      items.hob.push({ kind: "job", id: "todo-job-card", at: minsAgo(6), jobId: "t-0931" });
    }
  }

  // 票 147 的验收场景：一张卡问几个问题（待回答、已回答、群里、深色、手机）
  if (scene.startsWith("ask-rounds")) {
    const hob = assistants.find((item) => item.id === "hob")!;
    hob.busy = false;
    hob.last = { text: "有三处会改变做法，一起问清楚。", at: minsAgo(4) };
    const answered = scene === "ask-rounds-answered";
    const questions: ApprovalQuestion[] = [
      {
        title: "月份筛选放在导出对话框里，还是页面上直接选？",
        why: "放在哪决定要不要动页面布局，也决定这一版谁改。",
        options: [{ key: "A", label: "导出对话框里选月份" }, { key: "B", label: "页面上加一个月份选择器" }],
        recommended: "A",
      },
      {
        title: "默认导出哪一段时间？",
        why: "默认值决定大多数人一路点下去的后果。",
        options: [{ key: "A", label: "当前月份" }, { key: "B", label: "最近三个月" }, { key: "C", label: "全部" }],
        recommended: "A",
      },
      {
        title: "查不到订单的月份怎么出文件？",
        why: "导出的文件要给同事直接用表格软件打开。",
        options: [{ key: "A", label: "只出表头，写一句没有记录" }, { key: "B", label: "不导出，提示没有订单" }],
        recommended: "A",
      },
    ];
    approvals["ap-ask-rounds"] = {
      id: "ap-ask-rounds",
      assistantId: "hob",
      title: "导出加按月筛选，这几处定一下",
      detail: "定完就能开工；同意推荐的话直接提交。",
      options: [],
      questions,
      status: answered ? "answered" : "pending",
      ...(answered
        ? { answers: [{ key: "A" }, { key: "B" }, { text: "空月份也出表头，备注一句没有记录" }], answerText: "先按这个做，下周我看效果。", answeredAt: minsAgo(2) }
        : {}),
      source: "router",
      createdAt: minsAgo(4),
    };
    items.hob = [
      { kind: "user", id: "ask-user", at: minsAgo(8), text: "给导出的订单加上按月筛选，你先把要定的问清楚，别自己拍。" },
      asst("ask-plan", minsAgo(6), "有三处会改变做法，一起问清楚；按推荐来回复就行。"),
      { kind: "question", id: "ask-card", at: minsAgo(4), approvalId: "ap-ask-rounds" },
      ...(answered ? [asst("ask-done", minsAgo(2), "好，按这个来；空月份的备注我按你说的先定下。")] : []),
    ];

    const groupQuestions: ApprovalQuestion[] = [
      {
        title: "30 GB 以上的电影怎么处理？",
        why: "外置盘只剩 40 GB，删了要重新下载。",
        options: [{ key: "A", label: "删掉" }, { key: "B", label: "挪到外置盘" }],
        recommended: "A",
      },
      {
        title: "旧安装包还留着吗？",
        why: "留着能回滚，删了省 8 GB。",
        options: [{ key: "A", label: "留着" }, { key: "B", label: "删掉" }],
        recommended: "A",
      },
    ];
    approvals["ap-ask-group"] = {
      id: "ap-ask-group",
      assistantId: "server",
      groupId: "g-home",
      title: "下载目录里这几个大文件怎么处理",
      detail: "删了要重新下载，不动的话这周就满了。",
      options: [],
      questions: groupQuestions,
      status: "pending",
      source: "router",
      createdAt: minsAgo(2),
    };
    homeItems.push(
      { kind: "assistant", id: "ask-g1", at: minsAgo(3), text: "下载目录看完了：四个电影占 130 GB，旧安装包 8 GB。", speaker: "server" },
      { kind: "question", id: "ask-g2", at: minsAgo(2), approvalId: "ap-ask-group", speaker: "server" },
    );
  }

  // 票 152：话题和待办的演示场景。服务端 151 的行为在下面 createMock 里模拟；
  // 这里只摆数据：敏捷团队群三个进行中的话题（等你回答、进行中、等结论）和两个关了的，
  // 另一个群两个进行中的话题（没有待办，所以没有标签）。
  const topicItems: Record<string, GroupItem[]> = {};
  const readmeTopicItems: Record<string, GroupItem[]> = {};

  if (scene === "readme-group-now" || scene === "readme-mobile-list" || scene === "readme-mobile-chat" || scene === "readme-mobile-todos") {
    const product = assistants.find((assistant) => assistant.id === "page")!;
    const developer = assistants.find((assistant) => assistant.id === "bird")!;
    const tester = assistants.find((assistant) => assistant.id === "coin")!;
    product.name = L("产品负责人", "Product owner");
    product.duty = L("统筹和结论", "Coordination and conclusions");
    product.sprite = "sticky:purple";
    developer.name = L("开发", "Developer");
    developer.duty = L("写代码", "Code");
    developer.sprite = "code:green";
    developer.last = { text: L("深色模式正在实现。", "Dark mode is in progress."), at: minsAgo(3) };
    tester.name = L("测试", "Tester");
    tester.duty = L("测试和验证", "Testing and review");
    tester.sprite = "bug:red";
    tester.last = { text: L("主要页面的测试准备好了。", "The tests for the main pages are ready."), at: minsAgo(5) };
    const readmeGroup: GroupSummary = {
      id: "g-readme",
      name: L("网站项目", "Website project"),
      purpose: L("网站体验、开发和发布", "Website experience, build and release"),
      ownerId: product.id,
      members: [product.id, developer.id, tester.id],
      createdAt: at(4, 10, 0),
      last: { at: minsAgo(10), speaker: "page", text: L("已建立深色模式话题", "Started the dark mode topic") },
      unread: 1,
      busy: [developer.id],
    };
    const readmeTopic: GroupSummary = {
      id: "t-readme",
      name: L("网站加深色模式", "Dark mode for the website"),
      purpose: readmeGroup.purpose,
      ownerId: readmeGroup.ownerId,
      members: [...readmeGroup.members],
      createdAt: minsAgo(8),
      parentId: readmeGroup.id,
      createdBy: product.id,
      last: { at: minsAgo(1), speaker: developer.id, text: L("深色主题正在实现。", "Building the dark theme.") },
      unread: 1,
      busy: [developer.id],
    };
    // 左栏的群二级页：一件刚写好说明、一件已经做完关了，和正在做的那件一起
    const readmeSearch: GroupSummary = {
      ...readmeTopic, id: "t-readme-search", name: L("博客加站内搜索", "Search for the blog"), createdAt: minsAgo(50), createdBy: product.id, unread: 0, busy: [],
      last: { at: minsAgo(20), speaker: product.id, text: L("正在列待办。", "Listing the to-dos.") },
    };
    const readmeLazy: GroupSummary = {
      ...readmeTopic, id: "t-readme-lazy", name: L("图片懒加载", "Lazy-loaded images"), createdAt: at(3, 10, 0), createdBy: product.id, unread: 0, busy: [],
      closedAt: at(1, 17, 0), closeNote: L("测试都过了，已上线", "The tests pass; shipped."),
      last: { at: at(1, 17, 0), speaker: product.id, text: L("测试都过了，已上线", "The tests pass; shipped.") },
    };
    groups.splice(0, groups.length, readmeGroup, readmeTopic, readmeSearch, readmeLazy);
    for (const [id, job] of Object.entries(jobs)) {
      if (job.groupId && job.groupId !== readmeTopic.id) delete jobs[id];
    }
    const readmePlan: Job = {
      id: "readme-site-plan", assistantId: tester.id, groupId: readmeTopic.id, title: L("检查页面颜色对比度", "Check color contrast"),
      instruction: L("检查网站现有页面的颜色对比度。", "Check color contrast on the site's existing pages."), status: "done", createdAt: minsAgo(7), startedAt: minsAgo(7), endedAt: minsAgo(5), durationMs: 120000,
      stats: { reads: 5, commands: 2, edits: 0 }, summary: L("已记录主要页面的颜色对比度。", "Recorded color contrast on the main pages."), activity: [],
    };
    const readmeBuild: Job = {
      id: "readme-site-build", assistantId: developer.id, groupId: readmeTopic.id, title: L("实现深色模式", "Build dark mode"),
      instruction: L("按颜色变量为网站加入深色模式，带上切换入口和测试。", "Add dark mode to the site through the color variables, with a toggle and tests."), status: "running", createdAt: minsAgo(4), startedAt: minsAgo(4),
      stats: { reads: 12, commands: 4, edits: 8 }, activity: [{ at: minsAgo(1), verb: "改", text: "web/src/theme.css" }],
    };
    jobs[readmePlan.id] = readmePlan;
    jobs[readmeBuild.id] = readmeBuild;
    readmeTopic.todos = [
      { text: L("检查页面颜色对比度", "Check color contrast"), status: "done" },
      { text: L("实现深色模式", "Build dark mode"), status: "doing" },
      { text: L("检查主要页面", "Check the main pages"), status: "todo" },
    ];
    readmeTopicItems[readmeTopic.id] = [
      { kind: "user", id: "readme-topic-request", at: minsAgo(8), text: L("给网站加深色模式，手机和电脑都要好用。", "Add dark mode to the website; it should work well on phones and desktops."), speaker: "user" },
      { kind: "question", id: "readme-topic-question", at: minsAgo(7), approvalId: "readme-topic-approval", speaker: product.id },
      { kind: "assistant", id: "readme-topic-summary", at: minsAgo(6), text: L("跟随系统，保留手动开关；列了 3 项待办。", "Follow the system and keep a manual toggle. Listed 3 to-dos."), speaker: product.id },
      { kind: "job", id: "readme-topic-plan-card", at: minsAgo(5), jobId: readmePlan.id, speaker: tester.id },
      { kind: "assistant", id: "readme-topic-plan-result", at: minsAgo(5), text: L("主要页面的对比度已记录。", "Contrast on the main pages is recorded."), speaker: tester.id },
      { kind: "job", id: "readme-topic-build-card", at: minsAgo(4), jobId: readmeBuild.id, speaker: developer.id },
    ];
    approvals["readme-topic-approval"] = { id: "readme-topic-approval", assistantId: product.id, groupId: readmeTopic.id, title: L("深色模式怎么切换？", "How should dark mode switch?"), detail: L("这决定入口放在哪里，也影响首次打开时的颜色。", "This decides where the toggle goes and the color you see on first open."), options: [{ key: "A", label: L("跟随系统，也保留手动切换", "Follow the system, keep a manual toggle") }, { key: "B", label: L("只提供手动切换", "Manual toggle only") }], status: "answered", chosen: "A", source: "router", createdAt: minsAgo(7), answeredAt: minsAgo(6) };
    readmeTopicItems[readmeGroup.id] = [
      { kind: "note", id: "readme-group-note", at: at(4, 10), icon: "split", text: L("你建了群「网站项目」：产品负责人、开发、测试", "You created the group \"Website project\": Product owner, Developer, Tester"), speaker: "user" },
      { kind: "topic", id: "readme-topic-card", at: minsAgo(8), topicId: readmeTopic.id, speaker: product.id },
    ];
  }

  if (scene === "topics" || scene === "topics-plain" || scene === "todo-topic") {
    const software = scene !== "topics-plain";
    const host: GroupSummary = software
      ? {
          id: "g-topics",
          name: "Hob 开发",
          purpose: "Hob 仓库的方案、开发、测试和发布",
          ownerId: "po",
          members: ["po", "arch", "dev", "qa", "release"],
          createdAt: at(30, 10, 0),
          last: { at: at(0, 9, 52), speaker: "po", text: "按方案做，做完先在本地跑一遍测试" },
          unread: 0,
          busy: [],
        }
      : groups.find((g) => g.id === "g-home")!;
    if (software) groups.push(host);

    const topic = (patch: Partial<GroupSummary> & { id: string; name: string }): GroupSummary => ({
      purpose: host.purpose,
      ownerId: host.ownerId,
      members: [...host.members],
      createdAt: at(0, 9, 30),
      parentId: host.id,
      createdBy: "po",
      unread: 0,
      busy: [],
      ...patch,
    });

    // 进行中 3：一个等你回答、一个进行中、一个快做完了
    const tExport = topic({
      id: "t-export",
      name: "导出月度报表",
      createdAt: at(0, 9, 30),
      last: { at: at(0, 9, 31), speaker: "po", text: "有两个问题要你定：按自然月还是按账期？导出 Excel 还是 CSV？" },
      unread: 2,
      ...(software ? { todos: [{ text: "定两件事：按自然月还是账期，导出 Excel 还是 CSV", status: "doing" as const }] } : {}),
    });
    const tRemember = topic({
      id: "t-remember",
      name: "登录页加「记住我」",
      createdAt: at(0, 9, 38),
      last: { at: at(0, 9, 50), speaker: "dev", text: "「实现记住我」在做，方案按架构师定的 httpOnly cookie。" },
      ...(software ? { todos: [
        { text: "定方案", status: "done" as const },
        { text: "实现「记住我」", status: "doing" as const },
        { text: "检查用例和回归", status: "todo" as const },
        { text: "上线前用手机试一次", status: "todo" as const },
      ] } : {}),
    });
    const tUpload = topic({
      id: "t-upload",
      name: "上传大文件失败",
      createdAt: at(0, 9, 44),
      last: { at: at(0, 9, 47), speaker: "qa", text: "过了两条，断网续传那条在复查" },
      ...(software ? { todos: [
        { text: "查日志定位", status: "done" as const },
        { text: "修合并逻辑", status: "done" as const },
        { text: "检查和回归", status: "doing" as const },
      ] } : {}),
    });
    // 已关闭 2：一件做完了、一件关了
    const tExportMonth = topic({
      id: "t-export-month",
      name: "导出加按月筛选",
      createdAt: at(14, 10, 0),
      closedAt: at(3, 16, 0),
      closeNote: "测试都过了，已上线",
      last: { at: at(3, 16, 0), speaker: "po", text: "测试都过了，已上线" },
      ...(software ? { todos: [{ text: "加月份筛选", status: "done" as const }] } : {}),
    });
    const tColorway = topic({
      id: "t-colorway",
      name: "首页配色改版",
      createdAt: at(6, 11, 0),
      closedAt: at(5, 11, 0),
      closeNote: "你说先不做了，等下个版本再看",
      last: { at: at(5, 11, 0), speaker: "po", text: "先不动配色，等下个版本一起改。" },
    });

    if (software) {
      groups.push(tExport, tRemember, tUpload, tExportMonth, tColorway);
    } else {
      // 另一个群：两个进行中的话题，都没列待办
      const tDisk = topic({ id: "t-disk", name: "换新硬盘", createdAt: at(1, 20, 0), createdBy: "hob", last: { at: at(1, 20, 10), speaker: "hob", text: "新盘到了告诉我，迁移步骤已经在话题里列好。" } });
      const tBackup = topic({ id: "t-backup", name: "相册备份出错", createdAt: at(0, 9, 10), createdBy: "hob", unread: 1, last: { at: at(0, 9, 10), speaker: "house", text: "补上了 312 张，有 3 张读不出来，原图可能坏了，要你看一眼。" } });
      const tDownload = topic({ id: "t-download", name: "清理下载目录", createdAt: at(4, 21, 0), createdBy: "hob", closedAt: at(2, 22, 0), closeNote: "清出来 11 GB，安装包都删了" });
      const tNas = topic({ id: "t-nas", name: "NAS 换盘位", createdAt: at(9, 19, 0), createdBy: "hob", closedAt: at(7, 19, 0), closeNote: "盘位换好了，拷贝校验通过" });
      groups.push(tDisk, tBackup, tDownload, tNas);
      topicItems[tDisk.id] = [
        { kind: "user", id: "td-1", at: at(1, 20, 0), text: "新硬盘到了，怎么换", speaker: "user" },
        { kind: "assistant", id: "td-2", at: at(1, 20, 10), text: "新盘到了告诉我，迁移步骤已经在话题里列好。", speaker: "hob" },
      ];
      topicItems[tBackup.id] = [
        { kind: "user", id: "tb-1", at: at(0, 9, 10), text: "相册备份好像少了图片", speaker: "user" },
        { kind: "assistant", id: "tb-2", at: at(0, 9, 10), text: "补上了 312 张，有 3 张读不出来，原图可能坏了，要你看一眼。", speaker: "house" },
      ];
      topicItems[tDownload.id] = [
        { kind: "user", id: "tn-1", at: at(4, 21, 0), text: "下载目录满了", speaker: "user" },
        { kind: "assistant", id: "tn-2", at: at(2, 22, 0), text: "清出来 11 GB，旧安装包都删了。", speaker: "server" },
      ];
      topicItems[tNas.id] = [
        { kind: "user", id: "ts-1", at: at(9, 19, 0), text: "NAS 的盘位换一下", speaker: "user" },
        { kind: "assistant", id: "ts-2", at: at(7, 19, 0), text: "盘位换好了，拷贝校验通过。", speaker: "hob" },
      ];
      homeItems.push(
        { kind: "topic", id: "gh-1", at: at(1, 20, 20), topicId: tDisk.id, speaker: "hob" },
        { kind: "topic", id: "gh-2", at: at(0, 9, 12), topicId: tBackup.id, speaker: "hob" },
      );
    }

    topicItems[tRemember.id] = [
      { kind: "user", id: "tr-1", at: at(0, 9, 38), text: "登录页加一个「记住我」，下周发版前要上", speaker: "user", ...(software ? { forwardedFrom: { groupId: host.id, itemId: "gt-4" } } : {}) },
      { kind: "assistant", id: "tr-2", at: at(0, 9, 40), text: "换了设备还要记住登录吗？\n这决定 token 绑不绑设备。", speaker: "po" },
      { kind: "assistant", id: "tr-3", at: at(0, 9, 41), text: "列了 4 项待办，第 4 项要你在手机上试一下。", speaker: "po" },
      ...(software ? [{ kind: "job" as const, id: "tr-4", at: at(0, 9, 43), jobId: "t-tp-1", speaker: "arch" }] : []),
      { kind: "assistant", id: "tr-5", at: at(0, 9, 46), text: "方案定了：30 天的长效 token 放 httpOnly cookie，库里只存哈希。", speaker: "arch" },
      ...(software ? [{ kind: "job" as const, id: "tr-6", at: at(0, 9, 47), jobId: "t-tp-2", speaker: "dev" }] : []),
      { kind: "assistant", id: "tr-7", at: at(0, 9, 49), text: "@开发 按方案做，做完先在本地跑一遍测试。", speaker: "po" },
      { kind: "assistant", id: "tr-8", at: at(0, 9, 50), text: "收到，在做了，预计 20 分钟。", speaker: "dev" },
    ];
    topicItems[tExport.id] = [
      { kind: "user", id: "te-1", at: at(0, 9, 30), text: "每月的报表想按月份导出", speaker: "user" },
      { kind: "assistant", id: "te-2", at: at(0, 9, 31), text: "有两个问题要你定：按自然月还是按账期？导出 Excel 还是 CSV？", speaker: "po" },
    ];
    topicItems[tUpload.id] = [
      { kind: "user", id: "tu-1", at: at(0, 9, 44), text: "上传 2 GB 的文件卡在 99%", speaker: "user" },
      { kind: "assistant", id: "tu-2", at: at(0, 9, 45), text: "看了日志：分片传完最后一块后没有合并，是我这边的问题。修好了，测试现在过两条。", speaker: "dev" },
      { kind: "assistant", id: "tu-3", at: at(0, 9, 47), text: "过了两条，断网续传那条在复查。", speaker: "qa" },
    ];
    topicItems[tExportMonth.id] = [
      { kind: "user", id: "tx-1", at: at(14, 10, 0), text: "导出的表格想按月份筛", speaker: "user" },
      { kind: "assistant", id: "tx-2", at: at(3, 16, 0), text: "测试都过了，已上线。", speaker: "po" },
    ];
    topicItems[tColorway.id] = [
      { kind: "user", id: "tc-1", at: at(6, 11, 0), text: "首页的颜色换一换", speaker: "user" },
      { kind: "assistant", id: "tc-2", at: at(5, 11, 0), text: "先不动配色，等下个版本一起改。", speaker: "po" },
    ];

    if (software) {
      // 待办：进行中那件有完整的说明和待办，等结论的那件有检查结果，关掉的两件留着结论
      jobs["t-tp-1"] = groupJob({ id: "t-tp-1", assistantId: "arch", title: "定方案", groupId: tRemember.id, startedAt: at(0, 9, 42), endedAt: at(0, 9, 46), durationMs: 240_000 });
      jobs["t-tp-2"] = groupJob({ id: "t-tp-2", assistantId: "dev", title: "实现「记住我」", groupId: tRemember.id, status: "running", startedAt: minsAgo(6), endedAt: undefined });

      // 综合：闲聊 + 三张话题卡
      topicItems[host.id] = [
        { kind: "note", id: "gt-1", at: at(30, 10, 0), icon: "split", text: "你建了群「Hob 开发」：产品负责人、架构师、开发、测试、发布", speaker: "user" },
        { kind: "topic", id: "gt-2", at: at(0, 9, 30), topicId: tExport.id, speaker: "po" },
        { kind: "user", id: "gt-4", at: at(0, 9, 39), text: "今天线上好像有点慢，是不是我们昨天发的版本？", speaker: "user" },
        { kind: "assistant", id: "gt-5", at: at(0, 9, 40), text: "@架构师 看一下线上昨天以后的响应时间，和昨天的发版对得上吗？", speaker: "po" },
        { kind: "topic", id: "gt-6", at: at(0, 9, 41), topicId: tRemember.id, speaker: "po" },
        { kind: "topic", id: "gt-7", at: at(0, 9, 44), topicId: tUpload.id, speaker: "po" },
        { kind: "assistant", id: "gt-8", at: at(0, 9, 46), text: "对不上。慢的是 09:10 以后，是备份任务把磁盘占满了，和发版无关；已经告诉服务器那边。", speaker: "arch" },
        { kind: "note", id: "gt-9", at: at(0, 9, 52), icon: "split", text: "产品负责人开了话题「登录页加「记住我」」", speaker: "po" },
      ];
    }
  }

  return {
    assistants,
    groups,
    groupItems: { "g-home": homeItems, "g-dev": devItems, ...readmeTopicItems, ...topicItems },
    items,
    jobs,
    delegations,
    approvals,
    drafts: { "d-bird": draft },
    routines: scene.startsWith("readme-") ? routines.filter((r) => r.id === "r-weekly-draft" || r.id === "r-daily") : routines,
    assistantSkills: { bird: [
      { name: "daily-brief", title: "每日行业简报", description: "整理值得关注的行业动态。", path: "/mock/assistants/bird/skills/daily-brief/SKILL.md", version: 2, createdAt: at(7, 9), updatedAt: at(1, 9), uses: 3, lastUsedAt: at(0, 9), enabled: true },
      { name: "release-watch", title: "重要发布追踪", description: "追踪模型和产品的重要发布。", path: "/mock/assistants/bird/skills/release-watch/SKILL.md", version: 1, createdAt: at(2, 9), updatedAt: at(2, 9), uses: 0, enabled: true },
    ] },
    rules: {
      hob: [
        { id: "rule-1", text: "花钱", mode: "ask", changedAt: at(10, 9, 0) },
        { id: "rule-2", text: "改线上服务", mode: "ask", changedAt: at(10, 9, 0) },
        { id: "rule-3", text: "清理我的文件", mode: "ask", changedAt: at(3, 9, 0) },
      ],
      page: scene.startsWith("readme-") ? [{ id: "readme-rule", text: L("向团队群发送周报", "Send the weekly report to the team group"), mode: "ask", changedAt: at(9, 9) }] : [
        { id: "rule-4", text: "删除草稿", mode: "ask", changedAt: at(9, 9, 0) },
        { id: "rule-5", text: "花钱", mode: "ask", changedAt: at(9, 9, 0) },
        { id: "rule-6", text: "发公众号", mode: "allow", changedAt: minsAgo(120) },
      ],
      bird: [{ id: "rule-7", text: "花钱订阅", mode: "ask", changedAt: at(7, 9, 0) }],
    },
    worklog: {
      hob: [
        { at: at(0, 10, 5), text: "任务已完成：排查页面卡顿", jobId: "t-0931" },
        { at: at(0, 8, 2), text: "转述写作的审批：发布公众号" },
        { at: at(0, 8, 0), text: "早报：两件事均已完成" },
      ],
      page: [
        { at: at(0, 10, 21), text: "新增定时任务：周报初稿", jobId: "r-weekly-draft" },
        { at: at(0, 7, 44), text: "发布的文章：Grok Bot 能借鉴什么" },
        { at: at(0, 7, 40), text: "完成《Grok Bot 能借鉴什么》，3200 字" },
        { at: at(1, 17, 8), text: "周报初稿修改标题" },
      ],
      bird: [
        { at: at(0, 9, 0), text: "每日简报：今天 6 条", jobId: "t-0926" },
        { at: at(1, 9, 0), text: "每日简报：昨天 5 条", jobId: "t-0925" },
      ],
      server: [{ at: at(1, 3, 5), text: "任务已完成：清理旧日志", jobId: "t-0927" }],
      house: [{ at: at(0, 7, 30), text: "相册备份：新增 312 张" }],
      coin: [{ at: at(1, 21, 10), text: "10 月账单已整理" }],
      book: [],
      leaf: [],
    },
    settings: {
      revision: 1,
      settings: {
        general: {
          theme: scene.endsWith("-dark") ? "dark" : "system",
          timezone: "Asia/Tokyo",
          aboutYou: { name: L("小林", "Sam"), language: L("中文", "English"), notes: "" },
        },
        providers: [
          { kind: "builtin", id: "anthropic" },
          {
            kind: "custom",
            id: "my-proxy",
            name: "我的代理",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:8080/v1",
            models: [{ id: "gpt-x", name: "GPT X", input: ["text", "image"], reasoning: true, contextWindow: 200_000 }],
          },
        ],
        models: scene.startsWith("readme-") ? {
          roster: [{ ref: "openai/gpt-5", note: L("日常对话", "Everyday chat"), thinking: "low" }, { ref: "anthropic/claude-sonnet", note: L("整理资料", "Organizing docs"), thinking: "high" }],
          conversation: { ref: "openai/gpt-5", thinking: "low" },
          work: { ref: "anthropic/claude-sonnet", thinking: "high" },
        } : {
          roster: [
            { ref: "faux/fast", note: "响应快、成本低，适合日常对话", thinking: "low" },
            { ref: "faux/smart", note: "能力最强但速度较慢，适合复杂问题", thinking: "high" },
            { ref: "faux/vision", note: "支持图像输入，适合截图和图片", thinking: "medium" },
          ],
          conversation: { ref: "faux/fast", thinking: "low" },
          work: { ref: "faux/smart", thinking: "high" },
        },
        image: { source: "off" },
        search: [
          { name: "searxng", enabled: true, baseUrl: "http://127.0.0.1:8888" },
          { name: "exa", enabled: true },
          ...defaultSearch().filter((p) => p.name !== "searxng" && p.name !== "exa"),
        ],
        work: { maxJobs: 2, jobStallMinutes: 15, routerStallMinutes: 6 },
        push: { email: "" },
      },
    },
  };
}

/** 浏览器内假模型名单：界面截图用，不呼叫真模型。 */
const MOCK_MODELS: ModelsView = {
  models: [
    {
      ref: "faux/fast",
      provider: "faux",
      id: "fast",
      name: "Faux Fast",
      reasoning: false,
      thinkingLevels: ["off"],
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 0.1, output: 0.4 },
    },
    {
      ref: "faux/smart",
      provider: "faux",
      id: "smart",
      name: "Faux Smart",
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      input: ["text"],
      contextWindow: 400_000,
      maxTokens: 32_000,
      cost: { input: 3, output: 15 },
    },
    {
      ref: "faux/vision",
      provider: "faux",
      id: "vision",
      name: "Faux Vision",
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 16_000,
      cost: { input: 2, output: 8 },
    },
    // 两个还没进名单的，用来演示「添加模型」的分组
    {
      ref: "faux/tiny",
      provider: "faux",
      id: "tiny",
      name: "Faux Tiny",
      reasoning: false,
      thinkingLevels: ["off"],
      input: ["text"],
      contextWindow: 64_000,
      maxTokens: 4_096,
      cost: { input: 0.05, output: 0.2 },
    },
    {
      ref: "sample/deep",
      provider: "sample",
      id: "deep",
      name: "Sample Deep",
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 8, output: 40 },
    },
  ],
  roster: [],
};

/** 假图像生成 Key 状态：演示模式里只看界面。 */
const MOCK_IMAGE_KEY: ImageKeyView = { keyConfigured: true };

/** 演示模式的引擎自带服务商目录。 */
const MOCK_BUILTIN = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "google", name: "Google" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "openrouter", name: "OpenRouter" },
];

/** 演示模式里内置服务商的模型（真数据来自引擎目录，这里只要形状对）。 */
const MOCK_BUILTIN_MODELS: Record<string, { id: string; name: string; reasoning: boolean }[]> = {
  anthropic: [
    { id: "claude-x", name: "Claude X", reasoning: true },
    { id: "claude-x-haiku", name: "Claude X Haiku", reasoning: false },
  ],
  openai: [{ id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: true }],
};

/** 演示模式里一个服务商的模型和思考档：和 Hob 一样按默认规则算，存了自定义就按自定义。 */
function mockThinking(
  provider: ProviderSettings,
  thinking: Record<string, ThinkingLevelMapSetting> | undefined,
): ModelThinkingView[] {
  const models =
    provider.kind === "custom"
      ? provider.models.map((model) => ({
          id: model.id,
          name: model.name?.trim() || model.id,
          reasoning: model.reasoning === true,
        }))
      : (MOCK_BUILTIN_MODELS[provider.id] ?? []);
  return models.map((model) => {
    const ref = `${provider.id}/${model.id}`;
    const custom = thinking?.[ref];
    const plan = thinkingPlan(model.id, model.reasoning, custom, provider.kind === "custom" ? provider.api : undefined);
    return {
      ref,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      levels: plan.levels.map((level) => ({ level, text: plan.chars[level] ?? "" })),
      custom: custom !== undefined,
    };
  });
}

/** 演示模式里的「本机配置」：来源目录和能导入的项。 */
const MOCK_IMPORT_SOURCE = "/Users/me/.pi/agent";
const MOCK_LORE_SOURCE = "/Users/me/.lore";
const MOCK_PROVIDER_IMPORTS: ProviderImportItem[] = [
  { id: "anthropic", kind: "builtin", models: 12, key: "literal", exists: true, selectable: true },
  {
    id: "my-proxy",
    kind: "custom",
    api: "openai-completions",
    baseUrl: "https://proxy.example/v1",
    models: 4,
    key: "literal",
    exists: false,
    selectable: true,
  },
  {
    id: "cmd-proxy",
    kind: "custom",
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:8080",
    models: 2,
    key: "command",
    exists: false,
    selectable: true,
    note: "Key 需通过命令获取，请导入后手动填写。",
  },
  {
    id: "work-laptop",
    kind: "builtin",
    models: 6,
    key: "none",
    exists: false,
    selectable: false,
    note: "登录授权类凭据无法导入。",
  },
];
/** 导入时写进设置的服务商（演示模式里只要形状对）。 */
const MOCK_IMPORTED_PROVIDERS: Record<string, ProviderSettings> = {
  anthropic: { kind: "builtin", id: "anthropic" },
  "my-proxy": {
    kind: "custom",
    id: "my-proxy",
    name: "my-proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example/v1",
    models: [
      { id: "gpt-x", name: "GPT X" },
      { id: "gpt-x-mini" },
    ],
  },
  "cmd-proxy": {
    kind: "custom",
    id: "cmd-proxy",
    name: "cmd-proxy",
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:8080",
    models: [{ id: "claude-x" }],
  },
};

/** 假后端：和 realApi 同一套接口，操作真的改内存里的状态并发事件。 */
const mockUploads = new Map<string, string>();

const MCP_MOCK: McpView = {
  servers: [
    { name: "filesystem", valid: true, kind: "stdio", enabled: true, exposure: "direct", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], description: "读写指定目录的文件" },
    { name: "docs", valid: true, kind: "http", enabled: false, exposure: "deferred", url: "https://example.com/mcp", headers: { Authorization: { redacted: true } } },
  ],
};

export function createMock(scene: SceneId = "s1"): HobApi {
  const db = buildDb(scene);
  const en = englishDemo(scene);
  const L: Say = (zh, english) => (en ? english : zh);
  const groupRules: Record<string, Rule[]> = {};
  if (scene === "g-owns" || scene === "g-owns-dark") {
    const group = db.groups.find((item) => item.id === "g-dev")!;
    group.instructions = "先明确要做成什么样，再分给合适的成员；发布前请用户确认。";
    const topic: GroupSummary = { ...group, id: "g-owns-topic", parentId: group.id, name: "监听项目动态", busy: [], unread: 0 };
    db.groups.push(topic);
    db.groupItems[topic.id] = [];
    groupRules[group.id] = ["发布前先确认", "删除数据前先确认"].map((text, i) => ({ id: `owns-rule-${i}`, text, mode: "ask", changedAt: at(0, 9) }));
    db.assistantSkills[group.id] = ["问清要做什么", "代码审查", "发布前确认"].map((title, i) => ({ name: `team-${i}`, title, description: `团队${title}的做法`, path: `/mock/groups/${group.id}/skills/team-${i}/SKILL.md`, version: 1, createdAt: at(3, 9), updatedAt: at(1, 9), uses: 0, enabled: true }));
    for (let i = 0; i < 2; i++) db.routines.push({ id: `owns-routine-${i}`, assistantId: group.ownerId, groupId: i ? topic.id : group.id, name: i ? "监听项目动态" : "每日进度汇总", instruction: "检查进展并汇报", schedules: [i ? "*/15 * * * *" : "0 9 * * *"], active: true, createdAt: at(2, 9), runs: [{ at: at(0, 9), status: "handed" }] });
    (db.groupItems[group.id] ??= []).push({ id: "owns-routine-note", kind: "note", icon: "routine", speaker: group.ownerId, at: at(0, 9), text: "定时任务「监听项目动态」到点了，检查到：\n问题一：登录异常\n问题二：保存失败\n问题三：加载缓慢\n问题四：显示错位\n问题五：链接失效\n问题六：通知延迟\n问题七：搜索错误" });
    const example = Object.values(db.jobs)[0]!;
    delete db.jobs["t-g-dev"];
    group.busy = ["dev"];
    for (let i = 0; i < 5; i++) { const id = `owns-job-${i}`; db.jobs[id] = { ...example, id, groupId: i % 2 ? topic.id : group.id, assistantId: i === 0 ? "dev" : group.members[i % group.members.length]!, title: ["整理资料", "确定实现方案", "完成开发", "跑测试", "确认发布准备"][i]!, status: i === 0 ? "running" : "done", createdAt: at(0, 9, i * 5), startedAt: at(0, 9, i * 5), endedAt: i === 0 ? undefined : at(0, 9, i * 5 + 4), durationMs: i === 0 ? undefined : 240000, activity: [] }; }
  }
  let globalRules: Rule[] = scene.startsWith("readme-") ? [
    ...["删除或覆盖文件、数据和备份", "对外发送（消息、邮件、发布）、付费、充值、改计费", "停止或重启别人正在使用的服务和设备", "修改可能让你失去远程访问的设置（网络、防火墙、登录方式）"].map((text, i) => ({ id: `ask-${i}`, text, mode: "ask" as const, changedAt: at(10, 9) })),
    ...["过去的记录是线索不是现状：动手前先核实实际状态。", "改配置、改数据前先留好退路（备份或记下原值）；改完用实际效果验证，不只看命令返回。", "凭据（密码、密钥、令牌、Cookie）只在用的时候读取，不回显，不写进文件和报告，也不存起来。"].map((text, i) => ({ id: `allow-${i}`, text, mode: "allow" as const, changedAt: at(10, 9) })),
  ] : [];
  if (new URLSearchParams(globalThis.location?.search ?? "").has("citation")) (db.items.hob ??= []).push({ kind: "assistant", id: "mock-citation", at: new Date().toISOString(), text: "这里是资料里的结论：[工作记录.md](#k/k-2/0)。" });
  let collections: KnowledgeCollection[] = [{ id: "kc-1", name: L("工作资料", "Work docs"), createdAt: minsAgo(1000), count: 0 }, { id: "kc-2", name: L("灵感收藏", "Ideas"), createdAt: minsAgo(900), count: 0 }];
  let entries: KnowledgeEntry[] = [
    ["项目封面.png", "Project cover.png"],
    ["产品设计页面.html", "Product design page.html"],
    ["工作记录.md", "Work log.md"],
    ["数据汇总.csv", "Data summary.csv"],
    ["参考文档.pdf", "Reference doc.pdf"],
    ["插画.png", "Illustration.png"],
    ["会议纪要.md", "Meeting notes.md"],
    ["网站方案.html", "Website plan.html"],
    ["预算表.csv", "Budget.csv"],
    ["资料.txt", "Notes.txt"],
    ["附件.json", "Attachments.json"],
    ["录音.mp3", "Recording.mp3"],
  ].map(([zhName, enName], i) => {
    const name = L(zhName!, enName!);
    return {
    id: `k-${i}`, origin: i % 3 === 0 ? "chat" : i % 3 === 1 ? "output" : "upload", name,
    description: en ? `Project file · ${name}, notes on the design and progress so far.` : `项目资料 · ${name}，记录设计与工作进展。`, kind: name.endsWith(".png") ? "image" : name.endsWith(".html") ? "html" : name.endsWith(".csv") ? "csv" : name.endsWith(".pdf") ? "pdf" : name.endsWith(".json") ? "json" : name.endsWith(".mp3") ? "audio" : "markdown",
    path: `/mock/knowledge/${name}`, hash: `hash-${i}`, size: 2048 + i * 1000, createdAt: minsAgo(i < 6 ? i * 60 : 14 * 24 * 60 + i), updatedAt: minsAgo(i < 6 ? i * 60 : 14 * 24 * 60 + i),
    source: { assistantId: "hob", itemId: scene === "bubbles" || scene === "bubbles-dark" ? ["bubble-file", "bubble-page", "bubble-audio", "bubble-video", "bubble-job"][i % 5] : scene === "image" ? "image-done" : db.items.hob?.[0]?.id }, collections: i % 2 ? ["kc-1"] : ["kc-2"],
    };
  });
  const indexStates = ["queued", "indexing", "ready", "failed", "unsupported"] as const;
  entries.forEach((entry, i) => { entry.index = { state: indexStates[i % indexStates.length]!, ...(i % indexStates.length === 3 ? { error: "无法读取文件" } : {}) }; });
  if (scene === "readme-knowledge") {
    collections = [{ id: "kc-1", name: L("工作资料", "Work docs"), createdAt: minsAgo(1000), count: 0 }];
    const documents: { name: string; description: string; kind: KnowledgeEntry["kind"] }[] = [
      { name: "团队资料整理方案.html", description: "比较共享文档、知识库和文件夹的适用场景。", kind: "html" },
      { name: "周报进度表.csv", description: "汇总本周各项工作、负责人和进度。", kind: "csv" },
      { name: "团队活动封面.png", description: "团队活动通知使用的封面图片。", kind: "image" },
      { name: "项目会议纪要.md", description: "记录项目讨论的决定与后续安排。", kind: "markdown" },
      { name: "资料目录.md", description: "收录团队常用资料及其访问入口。", kind: "markdown" },
    ];
    entries = documents.map((doc, i) => ({
      ...doc, id: `readme-k-${i}`, origin: i === 2 ? "upload" : "output", path: `/mock/knowledge/${doc.name}`,
      hash: `readme-hash-${i}`, size: 2048 + i * 1000, createdAt: minsAgo(i * 60), updatedAt: minsAgo(i * 60),
      source: { assistantId: "hob" }, collections: ["kc-1"], index: { state: "ready", chunks: 1 },
    }));
  }
  const hob = db.assistants.find((a) => a.id === "hob");
  if (hob) hob.knowledge = ["kc-1"];
  let embeddingKeyConfigured = false;
  const listeners = new Set<(ev: HobEvent) => void>();
  const emit = (ev: HobEvent) => listeners.forEach((l) => l(ev));
  const assistant = (id: string) => db.assistants.find((a) => a.id === id);
  /** 模拟模式里的记忆设置：没配 Lore 时缺省本地记忆。 */
  const keys = new Set<string>(["anthropic", "my-proxy"]);
  let desktop = clone(DESKTOP_VIEWS[desktopMockScene()]);
  const providersView = (): ProvidersView => ({
    providers: db.settings.settings.providers.map((provider) => ({ ...provider, keyConfigured: keys.has(provider.id) })),
    builtin: clone(MOCK_BUILTIN),
    settings: clone(db.settings),
    models: Object.fromEntries(
      db.settings.settings.providers.map((provider) => [
        provider.id,
        mockThinking(provider, db.settings.settings.models.thinking),
      ]),
    ),
  });
  const memory: MemoryConfig = {
    revision: db.settings.revision,
    provider: "local",
    providerExplicit: false,
    lorePlugin: "1.12.5",
    lore: { configured: false, baseUrl: null, source: "none", tokenConfigured: false },
  };
  /** 模拟模式里已经订阅的设备：看图用的假设备。 */
  const devices: PushView["devices"] = [
    { endpoint: "https://push.example/mock-iphone", label: "iPhone", createdAt: new Date(Date.now() - 3 * 86400_000).toISOString() },
  ];
  const pushView = (): PushView => ({
    publicKey: "BOmockVapidPublicKeyForPreviewOnly",
    email: db.settings.settings.push.email,
    devices: clone(devices),
  });

  /** 模拟模式的任务过程：拿活动流拼一份，只为看界面。 */
  const stepsOf = (job: Job): JobStep[] => {
    const steps: JobStep[] = [];
    // 英文界面里工具行用英文动词，和真服务的工具名对得上
    const verb: Record<string, string> = en
      ? { "读": "read", "跑": "bash", "改": "edit", "说": "report", "搜": "search", "写": "write" }
      : { "读": "读", "跑": "跑", "改": "改", "说": "说", "搜": "搜", "写": "写" };
    job.activity.forEach((line, index) => {
      if (line.verb === "$") return;
      // 「浏览器 打开 地址」是云桌面里开网页的动作，演成 browser_* 步骤（任务详情里有“看桌面”入口）
      const browser = line.text.match(/^(?:浏览器 打开|open) (\S+)/);
      const name = browser ? "browser_open" : line.verb === "读" ? "read" : line.verb === "跑" ? "bash" : line.verb === "改" ? "edit" : line.verb === "说" ? "report" : "ls";
      steps.push({
        id: `mock-${job.id}-${index}`,
        kind: "tool",
        at: line.at,
        name,
        title: name === "report" ? L("提交结果", "Submit result") : `${verb[line.verb] ?? line.verb} ${line.text}`,
        args:
          browser
            ? { url: browser[1] }
            : name === "bash"
              ? { command: line.text }
              : name === "report"
                ? { outcome: "done", summary: line.text }
                : { path: line.text },
        output: name === "report" ? "结果已记录。" : browser ? "已打开页面。" : `${line.text}\n`,
        durationMs: 120,
      });
    });
    if (job.id === "t-0931") steps.push({ id: "mock-search", kind: "tool", at: job.createdAt, name: "web_search", title: "联网搜索：浏览器页面性能优化", args: { query: "浏览器页面性能优化" }, output: "演示结果：网页性能优化指南。", durationMs: 120 });
    return steps;
  };

  function setAssistant(id: string, patch: Partial<AssistantSummary>) {
    const a = assistant(id);
    if (!a) return;
    Object.assign(a, patch);
    emit({ type: "assistant", assistant: clone(a) });
  }

  function pushItem(assistantId: string, item: Item) {
    const list = (db.items[assistantId] ??= []);
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item;
    else list.push(item);
    emit({ type: "item", assistantId, item });
  }

  function touch(assistantId: string, text: string) {
    setAssistant(assistantId, { last: { text, at: new Date().toISOString() } });
  }

  const assistantName = (id: string) => db.assistants.find((a) => a.id === id)?.name ?? id;

  function matchesGroup(actual: string | undefined, requested: string): boolean {
    if (requested === "none") return !actual;
    const selected = db.groups.find((group) => group.id === requested);
    const root = selected?.parentId ?? requested;
    return actual === root || db.groups.some((group) => group.id === actual && group.parentId === root);
  }

  function emitGroup(groupId: string) {
    const group = db.groups.find((g) => g.id === groupId);
    if (group) emit({ type: "group", group: clone(group) });
  }

  /** 消耗页的价格：默认价 + 设置里改过的。 */
  const usagePrices = (): UsagePrices => {
    const overrides = db.settings.settings.usage?.prices ?? {};
    const models: Record<string, UsageModelPrice> = {};
    for (const model of USAGE_MODELS) {
      const custom = overrides[model.id];
      models[model.id] = custom ? { price: custom, custom: true, default: model.price } : { price: model.price, custom: false };
    }
    return { updatedAt: minsAgo(90), error: null, models };
  };
  let usageData: { timezone: string; rows: UsageRow[]; assistants: UsageAssistant[] } | undefined;

  return {
    usage: async (): Promise<UsageView> => {
      const timezone = db.settings.settings.general.timezone;
      if (usageData?.timezone !== timezone) usageData = { timezone, ...mockUsageRows(timezone) };
      return { timezone, rows: usageData.rows, assistants: usageData.assistants, prices: usagePrices() };
    },
    putUsagePrice: async (body) => {
      if (body.revision !== db.settings.revision) throw new ApiError(409, "设置已在别处修改，已刷新");
      const prices = { ...(db.settings.settings.usage?.prices ?? {}) };
      if (body.price) prices[body.model] = body.price;
      else delete prices[body.model];
      db.settings = {
        revision: db.settings.revision + 1,
        settings: { ...db.settings.settings, ...(Object.keys(prices).length ? { usage: { prices } } : { usage: undefined }) },
      };
      return { settings: clone(db.settings), price: usagePrices().models[body.model] ?? null };
    },
    knowledge: async (query = {}) => {
      const q = query.q?.toLowerCase();
      const matches = entries.filter((e) => (!query.origin || e.origin === query.origin) && (!query.collection || e.collections.includes(query.collection)) && (!query.kind || knowledgeGroup(e.kind) === query.kind) && (!query.assistantId || e.source?.assistantId === query.assistantId) && (!query.groupId || matchesGroup(e.source?.jobId ? db.jobs[e.source.jobId]?.groupId : undefined, query.groupId)) && (!query.before || e.updatedAt < query.before) && (!q || `${e.name} ${e.description}`.toLowerCase().includes(q)));
      const limit = query.limit ?? 50;
      return { entries: clone(matches.slice(0, limit).map((e) => q ? { ...e, snippet: e.description ?? e.name } : e)), hasMore: matches.length > limit, collections: clone(collections.map((c) => ({ ...c, count: entries.filter((e) => e.collections.includes(c.id)).length, indexed: entries.filter((e) => e.collections.includes(c.id) && e.index?.state === "ready").length, failed: entries.filter((e) => e.collections.includes(c.id) && e.index?.state === "failed").length, unsupported: entries.filter((e) => e.collections.includes(c.id) && e.index?.state === "unsupported").length }))) };
    },
    knowledgeEntry: async (id, chunk) => { const entry = entries.find((e) => e.id === id); if (!entry) throw new ApiError(404, "文件不存在"); return { entry: clone(entry), ...(chunk !== undefined ? { chunk: { index: chunk, heading: entry.name, text: "模拟模式中的项目资料。" } } : {}) }; },
    reindexKnowledge: async (id) => { if (!collections.some((c) => c.id === id)) throw new ApiError(404, "知识库不存在"); entries.filter((e) => e.collections.includes(id) && e.index?.state === "failed").forEach((e) => { e.index = { state: "queued" }; }); emit({ type: "knowledge" }); return { ok: true }; },
    embeddingKey: async () => ({ keyConfigured: embeddingKeyConfigured }),
    putEmbedding: async (revision, embedding, apiKey) => { if (revision !== db.settings.revision) throw new ApiError(409, "设置已在别处修改"); db.settings = { revision: revision + 1, settings: { ...db.settings.settings, knowledge: { embedding } } }; if (apiKey) embeddingKeyConfigured = true; return { settings: clone(db.settings), keyConfigured: embeddingKeyConfigured }; },
    embeddingTest: async () => ({ ok: true, dims: 1024 }),
    createKnowledgeCollection: async (name) => { const c = { id: `kc-${Date.now()}`, name, createdAt: new Date().toISOString(), count: 0 }; collections.push(c); emit({ type: "knowledge" }); return clone(c); },
    renameKnowledgeCollection: async (id, name) => { const c = collections.find((c) => c.id === id); if (!c) throw new ApiError(404, "知识库不存在"); c.name = name; emit({ type: "knowledge" }); return clone(c); },
    deleteKnowledgeCollection: async (id) => { collections = collections.filter((c) => c.id !== id); const before = entries.length; entries = entries.filter((e) => !(e.origin === "upload" && e.collections.length === 1 && e.collections[0] === id)).map((e) => ({ ...e, collections: e.collections.filter((c) => c !== id) })); emit({ type: "knowledge" }); return { deleted: before - entries.length }; },
    patchKnowledgeEntry: async (id, patch) => { const e = entries.find((e) => e.id === id); if (!e) throw new ApiError(404, "文件不存在"); Object.assign(e, patch); emit({ type: "knowledge" }); return clone(e); },
    deleteKnowledgeEntry: async (id) => { entries = entries.filter((e) => e.id !== id); emit({ type: "knowledge" }); return { ok: true }; },
    uploadKnowledge: async (collection, files) => { const added = files.map((file, i): KnowledgeEntry => ({ id: `k-${Date.now()}-${i}`, origin: "upload", name: file.name, kind: "other", path: URL.createObjectURL(file), hash: `mock-${Date.now()}-${i}`, size: file.size, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), collections: [collection] })); entries.unshift(...added); emit({ type: "knowledge" }); return { entries: clone(added) }; },
    me: async () => {},
    login: async () => {},
    logout: async () => {},
    bootstrap: async () => ({
      assistants: clone(db.assistants),
      jobs: clone(Object.values(db.jobs)),
      delegations: clone(Object.values(db.delegations)),
      routines: clone(db.routines),
      approvals: clone(Object.values(db.approvals).filter((a) => a.status === "pending")),
      settings: clone(db.settings),
    }),
    settings: async () => clone(db.settings),
    rules: async () => ({ rules: clone(globalRules) }),
    saveRules: async (rules) => {
      globalRules = rules.map((rule) => ({ ...rule, id: rule.id ?? `rule-${crypto.randomUUID()}`, changedAt: globalRules.find((old) => old.id === rule.id && old.text === rule.text && old.mode === rule.mode)?.changedAt ?? new Date().toISOString() }));
      emit({ type: "rules" });
      return { rules: clone(globalRules) };
    },
    models: async () => ({ ...clone(MOCK_MODELS), models: scene.startsWith("readme-") ? clone(MOCK_MODELS.models.slice(0, 2)).map((model, i) => ({ ...model, ref: i ? "anthropic/claude-sonnet" : "openai/gpt-5", name: i ? "Claude Sonnet" : "GPT-5" })) : clone(MOCK_MODELS.models), roster: clone(db.settings.settings.models.roster) }),
    providers: async () => providersView(),
    claude: async () => ({ settings: clone(db.settings), status: { found: false, loggedIn: false } }),
    saveClaude: async (revision, claude) => {
      if (revision !== db.settings.revision) throw new ApiError(409, "设置已更改，请刷新后重试。");
      db.settings = { revision: revision + 1, settings: { ...db.settings.settings, claude } };
      return { settings: clone(db.settings), status: { found: false, loggedIn: false } };
    },
    putThinking: async (body) => {
      const provider = db.settings.settings.providers.find((item) => body.ref.startsWith(`${item.id}/`));
      const current = provider
        ? mockThinking(provider, db.settings.settings.models.thinking).find((item) => item.ref === body.ref)
        : undefined;
      if (!provider || !current) throw new ApiError(400, `模型 ${body.ref} 不在已配置的服务商里。`);
      const next = { ...(db.settings.settings.models.thinking ?? {}) };
      const levels = body.levels === null ? undefined : normalizeThinkingMap(body.levels);
      if (levels) next[body.ref] = levels;
      else delete next[body.ref];
      db.settings = {
        revision: db.settings.revision + 1,
        settings: {
          ...db.settings.settings,
          models: {
            roster: db.settings.settings.models.roster,
            conversation: db.settings.settings.models.conversation,
            work: db.settings.settings.models.work,
            ...(Object.keys(next).length ? { thinking: next } : {}),
          },
        },
      };
      const thinking = mockThinking(provider, db.settings.settings.models.thinking).find(
        (item) => item.ref === body.ref,
      )!;
      return { settings: clone(db.settings), thinking };
    },
    putProvider: async (id: string, body: unknown) => {
      const input = body as { key?: string } & Record<string, unknown>;
      const next = { ...input, id } as unknown as ProviderSettings;
      delete (next as { key?: string }).key;
      const providers = db.settings.settings.providers.filter((provider) => provider.id !== id);
      db.settings = {
        revision: db.settings.revision + 1,
        settings: { ...db.settings.settings, providers: [...providers, next] },
      };
      if (input.key) keys.add(id);
      return providersView();
    },
    deleteProvider: async (id: string) => {
      db.settings = {
        revision: db.settings.revision + 1,
        settings: {
          ...db.settings.settings,
          providers: db.settings.settings.providers.filter((provider) => provider.id !== id),
        },
      };
      keys.delete(id);
      return providersView();
    },
    discoverProvider: async () => ({
      models: [
        { id: "gpt-x", name: "GPT X" },
        { id: "gpt-x-mini", name: "GPT X mini" },
        { id: "gpt-x-vision" },
      ],
    }),
    providersImport: async () => ({
      source: MOCK_IMPORT_SOURCE,
      items: MOCK_PROVIDER_IMPORTS.map((item) => ({
        ...item,
        exists:
          item.exists || db.settings.settings.providers.some((provider) => provider.id === item.id),
      })),
    }),
    importProviders: async (ids: string[]) => {
      const picked = ids
        .map((id) => MOCK_IMPORTED_PROVIDERS[id])
        .filter((provider): provider is ProviderSettings => provider !== undefined);
      if (!picked.length) throw new ApiError(400, "没有可导入的服务商：请选择状态为可导入的项目。");
      const providers = db.settings.settings.providers.filter(
        (provider) => !picked.some((item) => item.id === provider.id),
      );
      db.settings = {
        revision: db.settings.revision + 1,
        settings: { ...db.settings.settings, providers: [...providers, ...picked] },
      };
      for (const provider of picked) keys.add(provider.id);
      return providersView();
    },
    testProvider: async () => undefined,
    imageKey: async () => clone(MOCK_IMAGE_KEY),
    putImage: async (revision: number, image: ImageSettings, apiKey?: string) => {
      if (revision !== db.settings.revision) throw new ApiError(409, "设置已在别处修改，已刷新");
      db.settings = { revision: db.settings.revision + 1, settings: { ...db.settings.settings, image } };
      return { settings: clone(db.settings), keyConfigured: Boolean(apiKey) || MOCK_IMAGE_KEY.keyConfigured };
    },
    assistantSkills: async (id) => clone(db.assistantSkills[id] ?? []),
    patchAssistantSkill: async (id, name, enabled) => {
      const skill = db.assistantSkills[id]?.find((s) => s.name === name);
      if (!skill) throw new Error("技能不存在");
      skill.enabled = enabled;
      emit({ type: "skills", assistantId: id });
      return clone(skill);
    },
    rollbackAssistantSkill: async (id, name) => {
      const skill = db.assistantSkills[id]?.find((s) => s.name === name);
      if (!skill || skill.version <= 1) throw new Error("没有上一版");
      skill.version--;
      emit({ type: "skills", assistantId: id });
      return clone(skill);
    },
    deleteAssistantSkill: async (id, name) => {
      db.assistantSkills[id] = (db.assistantSkills[id] ?? []).filter((s) => s.name !== name);
      emit({ type: "skills", assistantId: id });
      return { ok: true };
    },
    sedimentJob: async (id) => {
      if (!db.jobs[id]) throw new Error("任务不存在");
      if (db.jobs[id].status !== "done") throw new Error("任务尚未完成");
      db.jobs[id].sediment = { status: "running" };
      emit({ type: "job", job: clone(db.jobs[id]) });
      setTimeout(() => {
        db.jobs[id].sediment = { status: "empty", reason: "没有需要沉淀的" };
        emit({ type: "job", job: clone(db.jobs[id]) });
      }, 0);
      return { ok: true };
    },
    skills: async () => {
      const off = db.settings.settings.skills?.disabled ?? [];
      const skill = (id: string, source: "hob" | "common" | "lore", description: string, content: string, overridden = false, extra: { title?: string; version?: number; updatedAt?: string; rollbackable?: boolean } = {}) =>
        ({ id, name: id, description, source, content, enabled: !off.includes(`${source}:${id}`), overridden, ...extra });
      const at = new Date(Date.now() - 86400_000 * 2).toISOString();
      return { skills: [
        skill("weekly-report", "hob", "按固定结构整理本周进展、风险和下周计划，生成可直接发出的周报。", "# 周报\n\n1. 汇总本周做完的事\n2. 列出风险和需要的支持\n3. 写下周计划", false, { title: "每周周报", version: 3, updatedAt: at, rollbackable: true }),
        skill("research", "hob", "查阅可靠来源，交叉核对后整理结论，并为每条结论注明出处。", "# 研究\n\n查阅可靠来源，整理结论并注明出处。", false, { title: "资料研究", version: 1, updatedAt: at, rollbackable: false }),
        skill("server-checkup", "hob", "检查主机的磁盘、内存、服务状态和最近的错误日志，给出处理建议。", "# 主机巡检\n\n逐台检查磁盘、内存、服务与日志。", false, { title: "主机巡检", version: 2, updatedAt: at, rollbackable: true }),
        skill("browser", "common", "在浏览器中打开页面、操作并截图，验证改动是否生效。", "# 浏览器\n\n通过浏览器检查和验证页面。"),
        skill("pdf", "common", "读取、拆分、合并 PDF，提取其中的表格和文字。", "# PDF\n\n处理 PDF 文件。"),
        skill("research", "common", "通用的资料检索流程。", "# research", true),
        skill("meeting-notes", "lore", "把会议记录整理成带待办的纪要。", "# 纪要\n\n1. 分段\n2. 列出待办"),
        skill("release-notes", "lore", "把一批变更整理成可直接发出的发布说明。", "# 发布说明\n\n按模块分组，标注影响面。"),
      ], loreActive: true, loreUrl: "https://lore.example.com" };
    },
    skillsImport: async () => ({ found: true, skipped: [], skills: [{ id: "review", name: "review", description: "检查代码和资料。", exists: false }, { id: "research", name: "research", description: "整理研究结果。", exists: true }] }),
    importSkills: async (_source, ids) => ({ imported: ids, skipped: [], errors: [] }),
    deleteSkill: async () => {},
    rollbackGeneralSkill: async (name) => ({ name, title: name, description: "回退后的技能", path: `/skills/${name}/SKILL.md`, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), uses: 0, enabled: true }),
    visibleSkills: async (assistantId, groupId) => {
      const base = [
        { name: "weekly-report", title: "每周周报", description: "按固定结构整理本周进展", path: `/skills/weekly-report/SKILL.md`, dir: "/skills/weekly-report", scope: "assistant" as const, editable: true, version: 3, updatedAt: new Date().toISOString(), enabled: true },
        { name: "browser", description: "在浏览器中操作并截图", path: "/home/.agents/skills/browser/SKILL.md", dir: "/home/.agents/skills/browser", scope: "general" as const, editable: false, source: "local" as const, enabled: true },
      ];
      if (!groupId) return clone(base);
      return clone([
        { name: "trip-plan", title: "旅行行程", description: "排旅行行程", path: `/groups/${groupId}/skills/trip-plan/SKILL.md`, dir: `/groups/${groupId}/skills/trip-plan`, scope: "group" as const, editable: true, version: 1, updatedAt: new Date().toISOString(), enabled: true },
        { name: "shared-notes", title: "共享纪要", description: "所有人共用的纪要做做法", path: "/skills/shared-notes/SKILL.md", dir: "/skills/shared-notes", scope: "general" as const, editable: true, version: 2, updatedAt: new Date().toISOString(), enabled: true },
        ...base.filter((skill) => skill.name !== "weekly-report"),
      ]);
    },
    desktop: async () => clone(desktop),
    desktopScreens: async () => ({ screens: desktopMockScene() === "failed" ? [] : [{ id: "hob", running: true, browserRunning: true, viewers: 0, lastActiveAt: null }], profiles: { hob: "hob" } }),
    saveDesktop: async (body) => {
      desktop = { ...desktop, revision: desktop.revision + 1, url: body.url, enabled: body.enabled, tokenConfigured: desktop.tokenConfigured || Boolean(body.token) };
      return clone(desktop);
    },
    saveDesktopPublic: async (revision, assistants) => {
      if (revision !== desktop.revision) throw new ApiError(409, "设置已在别处修改，已刷新");
      desktop = { ...desktop, revision: desktop.revision + 1, publicAssistants: [...assistants] };
      return clone(desktop);
    },
    testDesktop: async () => {
      if (desktopMockScene() === "failed") return { ok: false, error: `无法连接 ${desktop.url}，请确认云桌面已部署并启动。` };
      if (!desktop.url) return { ok: false, error: "请先填写云桌面地址。" };
      return { ok: true, health: clone(DESKTOP_HEALTH) };
    },
    mcp: async () => ({ servers: MCP_MOCK.servers.map((server) => ({ ...server })) }),
    putMcp: async () => ({ servers: MCP_MOCK.servers.map((server) => ({ ...server })) }),
    patchMcp: async () => ({ servers: MCP_MOCK.servers.map((server) => ({ ...server })) }),
    deleteMcp: async () => ({ servers: [] }),
    testMcp: async () => ({ ok: true, tools: [{ name: "read_file", description: "读取一个文件" }, { name: "list_directory", description: "列出目录内容" }] }),
    mcpImports: async () => ({ sources: ["pi（~/.pi/agent/mcp.json）"], items: [{ id: "pi:github", name: "github", source: "pi", kind: "http", exists: false, selectable: true }] }),
    importMcp: async (ids) => ({ imported: ids, skipped: [] }),
    search: async () => ({ providers: db.settings.settings.search.map((p) => ({ ...p, keyConfigured: p.name === "exa" || p.name === "tavily" })) }),
    putSearch: async (revision, providers) => {
      if (revision !== db.settings.revision) throw new ApiError(409, "设置已在别处修改，已刷新");
      db.settings = { revision: revision + 1, settings: { ...db.settings.settings, search: providers } };
      return clone(db.settings);
    },
    testSearch: async () => ({ ok: false, error: "演示模式不连接搜索服务商。" }),
    imageTest: async (): Promise<ImageTestResult> => ({
      ok: false,
      error: "演示模式不连接图像生成接口；正式运行时会实际生成图片。",
    }),
    putSettings: async (revision, patch) => {
      if (revision !== db.settings.revision) throw new ApiError(409, "设置已在别处修改，已刷新");
      const models = patch.models ?? {};
      db.settings = {
        revision: db.settings.revision + 1,
        settings: {
          general: {
            ...db.settings.settings.general,
            ...(patch.general ?? {}),
            aboutYou: { ...db.settings.settings.general.aboutYou, ...(patch.general?.aboutYou ?? {}) },
          },
          models: {
            roster: models.roster ?? db.settings.settings.models.roster,
            conversation: models.conversation ?? db.settings.settings.models.conversation,
            work: models.work ?? db.settings.settings.models.work,
            thinkingChoice: models.thinkingChoice ?? db.settings.settings.models.thinkingChoice,
            ...(models.thinking ?? db.settings.settings.models.thinking
              ? { thinking: models.thinking ?? db.settings.settings.models.thinking }
              : {}),
          },
          providers: db.settings.settings.providers,
          image: db.settings.settings.image,
          search: db.settings.settings.search,
          skills: patch.skills ?? db.settings.settings.skills,
          usage: db.settings.settings.usage,
          work: { ...db.settings.settings.work, ...(patch.work ?? {}) },
          push: { ...db.settings.settings.push, ...(patch.push ?? {}) },
        },
      };
      return clone(db.settings);
    },
    changePassword: async (old) => {
      if (old !== "test") throw new ApiError(403, "旧密码不正确");
    },
    about: async () => ({
      version: "0.1.0",
      home: "/var/lib/hob",
    }),
    memory: async () => clone({ ...memory, revision: db.settings.revision }),
    putMemory: async (revision, provider: MemoryProvider) => {
      if (revision !== db.settings.revision) throw new ApiError(409, "设置已在别处修改，已刷新");
      if (provider === "lore" && !memory.lore.configured) {
        throw new ApiError(400, "Lore 尚未配置：请先填写服务地址和 Token 并测试连接");
      }
      memory.provider = provider;
      memory.providerExplicit = true;
      db.settings.revision += 1;
      memory.revision = db.settings.revision;
      return clone(memory);
    },
    putLore: async (body) => {
      const baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
      if (!baseUrl) throw new ApiError(400, "Lore 服务地址不能为空");
      const sameBase = memory.lore.baseUrl === baseUrl;
      memory.lore = {
        configured: sameBase ? memory.lore.tokenConfigured : Boolean(body.token),
        baseUrl,
        source: "config",
        tokenConfigured: sameBase ? memory.lore.tokenConfigured : Boolean(body.token),
      };
      return clone({ ...memory, revision: db.settings.revision });
    },
    loreTest: async (body): Promise<LoreTestResult> => {
      const baseUrl = (body.baseUrl ?? memory.lore.baseUrl ?? "").trim().replace(/\/+$/, "");
      if (!baseUrl) return { ok: false, reason: "invalid_url" };
      if (baseUrl.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.)/.test(baseUrl)) {
        return { ok: false, reason: "insecure_http" };
      }
      if (!body.token && !memory.lore.tokenConfigured) return { ok: false, reason: "missing_token" };
      return { ok: true, baseUrl };
    },
    loreImport: async () => ({
      source: MOCK_LORE_SOURCE,
      found: true,
      baseUrl: "https://api.loremem.com",
      tokenPresent: true,
    }),
    importLore: async () => {
      memory.lore = {
        configured: true,
        baseUrl: "https://api.loremem.com",
        source: "config",
        tokenConfigured: true,
      };
      return clone({ ...memory, revision: db.settings.revision });
    },
    items: async (assistantId) => ({
      items: clone(db.items[assistantId] ?? []),
      approvals: clone(Object.values(db.approvals)),
      jobs: clone(Object.values(db.jobs)),
      drafts: clone(Object.values(db.drafts)),
      delegations: clone(Object.values(db.delegations)),
      hasMore: false,
    }),
    profile: async (assistantId) => {
      const a = assistant(assistantId);
      if (!a) throw new Error(`没有这个助手：${assistantId}`);
      const p: Profile = {
        assistant: clone(a),
        rules: clone(db.rules[assistantId] ?? []),
        routines: clone(db.routines.filter((r) => r.assistantId === assistantId)),
        worklog: clone(db.worklog[assistantId] ?? []),
      };
      return p;
    },
    sendMessage: async (assistantId, body) => {
      // 演示「未送达」：发这句就当网络断了
      if (body.text === "模拟发送失败") throw new Error("网络连接已断开");
      const time = new Date().toISOString();
      for (const delegation of Object.values(db.delegations)) {
        if (delegation.to !== assistantId || delegation.reportedAt || delegation.status === "interrupted") continue;
        Object.assign(delegation, { status: "takenOver", endedAt: time, reportedAt: time });
        emit({ type: "delegation", delegation: clone(delegation) });
      }
      for (const approval of Object.values(db.approvals)) {
        if (approval.assistantId !== assistantId || approval.source !== "router" || approval.status !== "pending") continue;
        approval.status = "expired";
        emit({ type: "approval", approval: clone(approval) });
      }
      const item: Item = {
        kind: "user",
        id: uid("mock-u"),
        at: time,
        text: body.text,
        quote: body.quote,
        files: body.files && body.files.length ? body.files : undefined,
      };
      pushItem(assistantId, item);
      touch(assistantId, body.text);
      setAssistant(assistantId, { busy: true });
      setTimeout(() => {
        pushItem(assistantId, {
          kind: "assistant",
          id: uid("mock-a"),
          at: new Date().toISOString(),
          text: "收到。",
        });
        touch(assistantId, "收到。");
        setAssistant(assistantId, { busy: false });
      }, 320);
      return { item };
    },
    stopAssistant: async (assistantId) => setAssistant(assistantId, { busy: false }),
    markRead: async (assistantId) => setAssistant(assistantId, { unread: 0 }),
    groupProfile: async (id) => {
      const selected = db.groups.find((g) => g.id === id);
      const group = db.groups.find((g) => g.id === (selected?.parentId ?? id));
      if (!group) throw new ApiError(404, "群不存在。");
      const models = db.settings.settings.models;
      const memberModels = Object.fromEntries(group.members.map((aid) => {
        const member = db.assistants.find((a) => a.id === aid);
        const resolved = (key: "conversation" | "work") => {
          const override = group.memberModels?.[aid]?.[key];
          const inheritedPick = group.models?.[key] ?? member?.models?.[key] ?? models[key];
          const inheritedSource = group.models?.[key] ? "group" as const : member?.models?.[key] ? "assistant" as const : "global" as const;
          const pick = override ?? inheritedPick;
          const source = override ? "member" as const : inheritedSource;
          return { source, pick, inherited: { source: inheritedSource, pick: inheritedPick } };
        };
        return [aid, { conversation: resolved("conversation"), work: resolved("work") }];
      }));
      return clone({ group, rules: groupRules[group.id] ?? [], memberModels });
    },
    groupSkills: async (id) => clone(db.assistantSkills[id] ?? []),
    patchGroupSkill: async (id, name, enabled) => {
      const skill = db.assistantSkills[id]?.find((s) => s.name === name);
      if (!skill) throw new ApiError(404, "技能不存在。");
      skill.enabled = enabled;
      return clone(skill);
    },
    rollbackGroupSkill: async (id, name) => {
      const skill = db.assistantSkills[id]?.find((s) => s.name === name);
      if (!skill || skill.version < 2) throw new ApiError(400, "没有可回退的版本。");
      skill.version--;
      return clone(skill);
    },
    deleteGroupSkill: async (id, name) => { db.assistantSkills[id] = (db.assistantSkills[id] ?? []).filter((s) => s.name !== name); return { ok: true }; },
    deleteGroupRule: async (id, ruleId) => { groupRules[id] = (groupRules[id] ?? []).filter((rule) => rule.id !== ruleId); },
    groups: async () => clone(db.groups),
    createGroup: async (body) => {
      const members = [...new Set(body.members)];
      if (!body.name.trim()) throw new ApiError(400, "群名不能为空。");
      if (members.length < 1) throw new ApiError(400, "群里至少要有一个助手。");
      if (!members.includes(body.ownerId)) throw new ApiError(400, "群主必须是群里的一员。");
      const group: Group = {
        id: `g-${Date.now().toString(36)}`,
        name: body.name.trim(),
        purpose: body.purpose.trim(),
        ownerId: body.ownerId,
        members,
        createdAt: new Date().toISOString(),
      };
      db.groups.push({ ...group, unread: 0, busy: [] });
      db.groupItems[group.id] = [
        { kind: "note", id: uid("g"), at: group.createdAt, icon: "split", text: `你建了群「${group.name}」：${members.map(assistantName).join("、")}`, speaker: "user" },
      ];
      emitGroup(group.id);
      return clone(group);
    },
    createTopic: async (groupId, body) => {
      const group = db.groups.find((g) => g.id === groupId);
      if (!group) throw new ApiError(404, "群不存在。");
      if (group.parentId) throw new ApiError(400, "话题里不能再开话题。");
      const title = body.title.trim();
      if (!title) throw new ApiError(400, "话题名不能为空。");
      if (title.length > 40) throw new ApiError(400, "话题名最多 40 个字。");
      const now = new Date().toISOString();
      const topic: Group = {
        id: `g-${Date.now().toString(36)}`,
        name: title,
        purpose: group.purpose,
        ownerId: group.ownerId,
        members: [...group.members],
        createdAt: now,
        parentId: group.id,
        createdBy: "user",
      };
      db.groups.push({ ...topic, unread: 0, busy: [] });
      db.groupItems[topic.id] = [];
      // 综合里落一张话题卡
      const card: GroupItem = { kind: "topic", id: uid("g"), at: now, topicId: topic.id, speaker: "user" };
      (db.groupItems[group.id] ??= []).push(card);
      group.last = { at: now, speaker: "user", text: `开了话题「${title}」` };
      emit({ type: "group-item", groupId: group.id, item: clone(card) });
      emitGroup(group.id);
      emitGroup(topic.id);
      return clone(topic);
    },
    closeTopic: async (topicId, body) => {
      const topic = db.groups.find((g) => g.id === topicId);
      if (!topic?.parentId) throw new ApiError(404, "话题不存在。");
      if (topic.closedAt) throw new ApiError(400, "这个话题已经关闭了。");
      const now = new Date().toISOString();
      topic.closedAt = now;
      if (body?.note?.trim()) topic.closeNote = body.note.trim();
      topic.busy = [];
      emitGroup(topicId);
      emitGroup(topic.parentId);
      return clone(topic);
    },
    reopenTopic: async (topicId) => {
      const topic = db.groups.find((g) => g.id === topicId);
      if (!topic?.parentId) throw new ApiError(404, "话题不存在。");
      delete topic.closedAt;
      delete topic.closeNote;
      emitGroup(topicId);
      emitGroup(topic.parentId);
      return clone(topic);
    },
    patchGroup: async (groupId, patch) => {
      const group = db.groups.find((g) => g.id === groupId);
      if (!group) throw new ApiError(404, "群不存在。");
      if (patch.rule) {
        const rules = groupRules[group.id] ??= [];
        const existing = rules.find((r) => r.id === patch.rule?.id);
        if (existing) Object.assign(existing, patch.rule, { changedAt: new Date().toISOString() });
        else if (patch.rule.text && patch.rule.mode) rules.push({ id: `rule-${Date.now()}`, text: patch.rule.text, mode: patch.rule.mode, changedAt: new Date().toISOString() });
      }
      // 话题只能改名字：成员、群主都取所属的群
      if (group.parentId && (patch.members || patch.ownerId || patch.purpose !== undefined)) {
        throw new ApiError(400, "话题只能改名字。");
      }
      if (patch.members) {
        const members = [...new Set(patch.members)];
        if (members.length < 1) throw new ApiError(400, "群里至少要留一个成员。");
        if (!members.includes(patch.ownerId ?? group.ownerId)) throw new ApiError(400, "群主必须留在群里。");
        group.members = members;
        // 话题的成员跟着群走
        for (const topic of db.groups.filter((g) => g.parentId === groupId)) topic.members = [...members];
      }
      if (patch.ownerId) {
        if (!group.members.includes(patch.ownerId)) throw new ApiError(400, "群主必须是群里的一员。");
        group.ownerId = patch.ownerId;
        for (const topic of db.groups.filter((g) => g.parentId === groupId)) topic.ownerId = patch.ownerId;
      }
      if (patch.instructions !== undefined) group.instructions = patch.instructions;
      if (patch.models !== undefined) {
        const models = { ...group.models };
        for (const key of ["conversation", "work"] as const) {
          if (patch.models[key] === null) delete models[key];
          else if (patch.models[key]) models[key] = patch.models[key];
        }
        group.models = models;
      }
      if (patch.name !== undefined) group.name = patch.name.trim() || group.name;
      if (patch.purpose !== undefined) {
        group.purpose = patch.purpose;
        for (const topic of db.groups.filter((g) => g.parentId === groupId)) topic.purpose = patch.purpose;
      }
      emitGroup(groupId);
      return clone(group);
    },
    patchGroupMemberModels: async (groupId, assistantId, patch) => {
      const selected = db.groups.find((g) => g.id === groupId);
      const group = db.groups.find((g) => g.id === (selected?.parentId ?? groupId));
      if (!group) throw new ApiError(404, "群不存在。");
      if (!group.members.includes(assistantId)) throw new ApiError(400, "助手不是这个群的成员。");
      const models = { ...group.memberModels?.[assistantId] };
      for (const key of ["conversation", "work"] as const) {
        if (patch[key] === null) delete models[key];
        else if (patch[key]) models[key] = patch[key];
      }
      group.memberModels = { ...group.memberModels, [assistantId]: models };
      for (const topic of db.groups.filter((g) => g.parentId === group.id)) { topic.memberModels = group.memberModels; emitGroup(topic.id); }
      emitGroup(group.id);
      return clone(group);
    },
    archiveGroup: async (groupId) => {
      if (!db.groups.some((g) => g.id === groupId)) throw new ApiError(404, "群不存在。");
      const topics = db.groups.filter((g) => g.parentId === groupId).map((g) => g.id);
      db.groups = db.groups.filter((g) => g.id !== groupId);
      emit({ type: "group_removed", id: groupId });
      // 群归档，话题跟着归档：每个话题各发一个 group_removed
      for (const id of topics) emit({ type: "group_removed", id });
    },
    groupItems: async (groupId): Promise<GroupItemsPage> => ({
      items: clone(db.groupItems[groupId] ?? []),
      approvals: clone(Object.values(db.approvals).filter((a) => a.groupId === groupId)),
      jobs: clone(Object.values(db.jobs).filter((j) => j.groupId === groupId)),
      hasMore: false,
    }),
    sendGroupMessage: async (groupId, body) => {
      const group = db.groups.find((g) => g.id === groupId);
      if (!group) throw new ApiError(404, "群不存在。");
      if (group.closedAt) throw new ApiError(400, "这个话题已关闭，重新打开后才能发消息");
      if (body.text === "模拟发送失败") throw new Error("网络连接已断开");
      const time = new Date().toISOString();
      const list = (db.groupItems[groupId] ??= []);
      const item: GroupItem = {
        kind: "user",
        id: uid("g"),
        at: time,
        text: body.text,
        ...(body.quote ? { quote: body.quote } : {}),
        ...(body.files?.length ? { files: body.files } : {}),
        speaker: "user",
      };
      list.push(item);
      emit({ type: "group-item", groupId, item: clone(item) });
      // 谁接：@ 了谁就是谁，没点名是群主
      const named = group.members.find((id) => {
        const name = assistantName(id);
        return name !== id && body.text.includes(`@${name}`);
      });
      const speaker = named ?? group.ownerId;
      group.last = { at: time, speaker: "user", text: body.text };
      group.busy = [speaker];
      emitGroup(groupId);
      emit({ type: "group-activity", groupId, speaker, activity: { state: "thinking", label: "正在想…" } });
      setTimeout(() => {
        const reply: GroupItem = { kind: "assistant", id: uid("g"), at: new Date().toISOString(), text: `收到，我看一下。`, speaker };
        list.push(reply);
        emit({ type: "group-item", groupId, item: clone(reply) });
        group.last = { at: reply.at, speaker, text: reply.text };
        group.busy = [];
        emitGroup(groupId);
        emit({ type: "group-activity", groupId, speaker, activity: null });
      }, 700);
      return { item };
    },
    markGroupRead: async (groupId) => {
      const group = db.groups.find((g) => g.id === groupId);
      if (!group || !group.unread) return;
      group.unread = 0;
      emitGroup(groupId);
    },
    stopGroup: async (groupId) => {
      const group = db.groups.find((g) => g.id === groupId);
      if (!group) throw new ApiError(404, "群不存在。");
      const stopped = group.busy;
      group.busy = [];
      emitGroup(groupId);
      const note: GroupItem = { kind: "note", id: uid("g"), at: new Date().toISOString(), icon: "info", text: "你叫停了群里的发言", speaker: "user" };
      (db.groupItems[groupId] ??= []).push(note);
      emit({ type: "group-item", groupId, item: clone(note) });
      for (const speaker of stopped) emit({ type: "group-activity", groupId, speaker, activity: null });
    },
    patchAssistant: async (assistantId, patch) => {
      if (!assistant(assistantId)) throw new ApiError(404, "助手不存在。");
      if (patch.rule) {
        const rules = (db.rules[assistantId] ??= []);
        const existing = patch.rule.id === undefined ? undefined : rules.find((item) => item.id === patch.rule!.id);
        if (patch.rule.id !== undefined && !existing) throw new ApiError(404, "规则不存在。");
        const text = patch.rule.text === undefined ? existing?.text ?? "" : patch.rule.text.trim();
        if (!text || text.length > 1000) throw new ApiError(400, "规则内容不能为空或超过 1000 字。");
        if (rules.some((item) => item.id !== patch.rule!.id && item.text === text)) throw new ApiError(400, "规则内容已存在。");
        const mode = patch.rule.mode ?? existing?.mode;
        if (mode !== "ask" && mode !== "allow") throw new ApiError(400, "规则模式无效。");
        const rule: Rule = { id: existing?.id ?? uid("r-"), text, mode, changedAt: new Date().toISOString() };
        if (existing) Object.assign(existing, rule);
        else rules.push(rule);
        emit({ type: "profile", assistantId });
        return { rule: clone(rule) };
      }
      setAssistant(assistantId, patch);
    },
    archiveAssistant: async (assistantId) => {
      const target = assistant(assistantId);
      if (!target) throw new ApiError(404, "助手不存在");
      if (target.primary) throw new ApiError(400, "主助手不能归档");
      const live = Object.values(db.jobs).filter(
        (job) => job.assistantId === assistantId && (job.status === "running" || job.status === "queued" || job.status === "waiting"),
      );
      if (live.length) throw new ApiError(409, "请等任务结束后再归档");
      for (const routine of db.routines.filter((r) => r.assistantId === assistantId)) emit({ type: "routine_removed", id: routine.id });
      db.routines = db.routines.filter((r) => r.assistantId !== assistantId);
      db.assistants = db.assistants.filter((a) => a.id !== assistantId);
      emit({ type: "assistant_removed", id: assistantId });
    },
    deleteRule: async (assistantId, ruleId) => {
      db.rules[assistantId] = (db.rules[assistantId] ?? []).filter((r) => r.id !== ruleId);
      emit({ type: "profile", assistantId });
    },
    answerApproval: async (approvalId, answer) => {
      const ap = db.approvals[approvalId];
      if (!ap || ap.status !== "pending") return;
      ap.status = "answered";
      if (ap.questions?.length) {
        ap.answers = answer.answers ?? [];
        if (answer.text?.trim()) ap.answerText = answer.text.trim();
      } else if (answer.key) ap.chosen = answer.key;
      else ap.answerText = (answer.text ?? "").trim();
      ap.answeredAt = new Date().toISOString();
      const option = ap.options.find((o) => o.key === answer.key);
      if (option?.always && ap.ruleText) {
        const rules = (db.rules[ap.assistantId] ??= []);
        rules.push({ id: uid("rule"), text: ap.ruleText, mode: "allow", changedAt: ap.answeredAt });
        pushItem(ap.assistantId, {
          kind: "note",
          id: uid("mock-n"),
          at: ap.answeredAt,
          icon: "rule",
          text: `已记入${assistant(ap.assistantId)?.name ?? ""}的规则 · ${ap.ruleText}无需确认`,
        });
        emit({ type: "profile", assistantId: ap.assistantId });
      }
      emit({ type: "approval", approval: clone(ap) });
      for (const delegation of Object.values(db.delegations)) {
        if (!delegation.reportedAt && ((delegation.approvalIds ?? []).includes(ap.id) || (ap.jobId && delegation.jobIds.includes(ap.jobId)))) {
          delegation.status = "running";
          if (ap.jobId && db.jobs[ap.jobId]?.status === "waiting") {
            db.jobs[ap.jobId].status = "running";
            emit({ type: "job", job: clone(db.jobs[ap.jobId]) });
          }
          emit({ type: "delegation", delegation: clone(delegation) });
        }
      }
    },
    retryDelegation: async (id) => {
      const original = db.delegations[id];
      if (!original || original.status !== "interrupted") throw new ApiError(400, "只有已中断的委派可以重新转交");
      const next: Delegation = { ...original, id: uid("dg-"), status: "running", createdAt: new Date().toISOString(), jobIds: [], approvalIds: [], reportedAt: undefined, endedAt: undefined };
      db.delegations[next.id] = next;
      emit({ type: "delegation", delegation: clone(next) });
      pushItem("hob", { kind: "delegation", id: uid("item-"), at: next.createdAt, delegationId: next.id });
      pushItem(next.to, { kind: "user", id: uid("item-"), at: next.createdAt, text: next.text, from: { assistantId: "hob", name: "Hob", delegationId: next.id } });
    },
    createDraft: async (draftId) => {
      const d = db.drafts[draftId];
      if (!d) return;
      d.status = "created";
      d.createdAssistantId = "bird";
      emit({ type: "draft", draft: clone(d) });
      pushItem(d.assistantId, {
        kind: "note",
        id: uid("mock-n"),
        at: new Date().toISOString(),
        icon: "split",
        text: `专属助手已创建 · ${d.name}`,
      });
    },
    dismissDraft: async (draftId) => {
      const d = db.drafts[draftId];
      if (!d) return;
      d.status = "dismissed";
      emit({ type: "draft", draft: clone(d) });
    },
    createRoutine: async (body) => {
      const r: Routine = {
        ...body,
        assistantId: body.groupId ? db.groups.find((group) => group.id === body.groupId)?.ownerId ?? body.assistantId : body.assistantId,
        id: uid("r"),
        createdAt: new Date().toISOString(),
        runs: [],
      };
      db.routines.push(r);
      emit({ type: "routine", routine: clone(r) });
      return { routine: clone(r) };
    },
    patchRoutine: async (routineId, patch) => {
      const r = db.routines.find((x) => x.id === routineId);
      if (!r) return;
      if (r.groupId && patch.assistantId !== undefined) throw new Error("群的定时由群主处理");
      const { skill, ...rest } = patch;
      Object.assign(r, rest);
      if (skill === null) delete r.skill;
      else if (skill !== undefined) r.skill = skill;
      emit({ type: "routine", routine: clone(r) });
    },
    deleteRoutine: async (routineId) => {
      db.routines = db.routines.filter((r) => r.id !== routineId);
      emit({ type: "routine_removed", id: routineId });
    },
    runRoutine: async (routineId) => {
      const r = db.routines.find((x) => x.id === routineId);
      if (!r) return;
      const time = new Date().toISOString();
      if (r.groupId) {
        const group = db.groups.find((item) => item.id === r.groupId);
        if (!group) throw new Error("群不存在");
        const item: GroupItem = { kind: "note", icon: "routine", id: uid("g-"), at: time, speaker: group.ownerId, text: `定时任务「${r.name}」到点了` };
        (db.groupItems[group.id] ??= []).push(item);
        r.runs = [{ at: time, status: "handed" as const }, ...r.runs].slice(0, 20);
        emit({ type: "group-item", groupId: group.id, item });
        emit({ type: "routine", routine: clone(r) });
        return { outcome: "handed" as const };
      }
      const job: Job = {
        id: uid("t-"),
        assistantId: r.assistantId,
        title: `${r.name}（立即运行）`,
        instruction: r.instruction,
        status: "running",
        createdAt: time,
        startedAt: time,
        stats: { reads: 0, commands: 0, edits: 0 },
        routineId: r.id,
        activity: [{ at: time, verb: "$", text: `立即运行 ${r.name}` }],
      };
      db.jobs[job.id] = job;
      const run: RoutineRun = { jobId: job.id, at: time, status: "running" };
      r.runs = [run, ...r.runs].slice(0, 20);
      pushItem(r.assistantId, { kind: "job", id: uid("mock-j"), at: time, jobId: job.id });
      emit({ type: "job", job: clone(job) });
      emit({ type: "routine", routine: clone(r) });
      touch(r.assistantId, `运行定时任务：${r.name}`);
      return { outcome: "job" as const, job: clone(job) };
    },
    replyJob: async (jobId, text) => {
      const job = db.jobs[jobId];
      if (!job) return;
      job.activity = [...job.activity, { at: new Date().toISOString(), verb: "说", text }];
      emit({ type: "activity", jobId, line: job.activity[job.activity.length - 1], stats: clone(job.stats) });
      // 和真服务器一样：先出「等待读取」，当前这一步做完（这里等 4 秒）再换成正式的一行
      const at = new Date().toISOString();
      emit({ type: "job_step", jobId, step: { id: `q${Date.now()}`, kind: "text", at, from: "user", text, queued: true } });
      setTimeout(() => emit({ type: "job_step", jobId, step: { id: `u${Date.now()}`, kind: "text", at: new Date().toISOString(), from: "user", text } }), 4000);
    },
    transcript: async (jobId) => {
      const job = db.jobs[jobId];
      if (!job) throw new Error(`没有这个任务：${jobId}`);
      return { job: clone(job), steps: stepsOf(job) };
    },
    jobs: async (query = {}) => {
      let list = Object.values(db.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (query.assistantId) list = list.filter((job) => job.assistantId === query.assistantId);
      if (query.groupId) list = list.filter((job) => matchesGroup(job.groupId, query.groupId!));
      if (query.status) list = list.filter((job) => job.status === query.status);
      if (query.before) {
        const index = list.findIndex((job) => job.id === query.before);
        if (index !== -1) list = list.slice(index + 1);
      }
      const limit = query.limit ?? 30;
      const page: JobsPage = { jobs: clone(list.slice(0, limit)), hasMore: list.length > limit };
      return page;
    },
    stopJob: async (jobId) => {
      const job = db.jobs[jobId];
      if (!job) return;
      job.status = "stopped";
      job.endedAt = new Date().toISOString();
      emit({ type: "job", job: clone(job) });
    },
    upload: async (file) => {
      // 和真服务器一样存成 u-xxxxxx-原名；图片在浏览器里直接用本地地址显示
      await new Promise((resolve) => setTimeout(resolve, 1200)); // 像真的上传一样要等一会儿
      const path = `/mock/uploads/u-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}-${file.name}`;
      mockUploads.set(path, URL.createObjectURL(file));
      return path;
    },
    fileUrl: (path, opts) =>
      path === "/mock/readme-page.html" || (scene === "readme-knowledge" && path === "/mock/knowledge/团队资料整理方案.html") ? "/mock/readme-page.html" : mockUploads.get(path) ?? (path === "/srv/example/reports/stats.csv" ? `data:text/plain;charset=utf-8,${encodeURIComponent('项目,大小\n旧日志,2.1GB\n服务,正常')}` : path === "/srv/example/reports/log-cleanup-1031.md" ? `data:text/plain;charset=utf-8,${encodeURIComponent('# 清理报告\n\n已清理旧日志，服务运行正常。')}` : path.startsWith("/mock/assistants/") ? `data:text/plain;charset=utf-8,${encodeURIComponent('# 每日行业简报\n\n整理值得关注的行业动态。')}` : path.startsWith("blob:") ? path : path.startsWith("/mock/knowledge/") ? (path.endsWith(".png") ? `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#d5e3d4"/><circle cx="430" cy="110" r="55" fill="#f5d599"/><path d="M0 380L190 150 340 330 430 220 600 400" fill="#83a392"/></svg>')}` : path.endsWith(".html") ? `data:text/html;charset=utf-8,${encodeURIComponent('<h1>产品设计页面</h1><p>这是模拟模式中的项目资料。</p>')}` : `data:text/plain;charset=utf-8,${encodeURIComponent('模拟模式中的项目资料。')}`) : path.startsWith("/mock/") ? path : `data:text/plain;charset=utf-8,${encodeURIComponent(`mock 模式没有真实文件。\n\n${path}`)}`),
    fileMeta: async (path) => {
      const name = path.split("/").pop() ?? path;
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
      const kind: FileMeta["kind"] =
        [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext) ? "image" : ext === ".md" ? "markdown" : ext === ".csv" ? "csv" : ext === ".html" ? "html" : ext === ".json" ? "json" : "text";
      return {
        path,
        name,
        size: 2048,
        modifiedAt: new Date().toISOString(),
        mime: kind === "image" ? `image/${ext === ".jpg" ? "jpeg" : ext.slice(1)}` : "text/plain; charset=utf-8",
        kind,
        ...(path === "/mock/readme-page.html" ? { page: true } : {}),
        text: kind !== "image",
      };
    },
    jobFiles: async (jobId, path) => {
      const job = db.jobs[jobId];
      if (!job) throw new ApiError(404, "任务不存在");
      const base = "/srv/example/reports";
      const file = (rel: string): JobFilesView["files"][number] => ({ type: "file", path: `${base}/${rel}`, rel, name: rel.split("/").pop()!, size: 2048, modifiedAt: job.createdAt, kind: rel.endsWith(".md") ? "markdown" : rel.endsWith(".csv") ? "csv" : "code" });
      const files: JobFilesView["files"] = jobId !== "t-0927" ? [] : !path ? [
        { type: "directory", path: `${base}/src`, rel: "src", name: "src", count: 2 },
        file("log-cleanup-1031.md"), file("stats.csv"), file("notes.txt"),
      ] : path === "src" ? [
        { type: "directory", path: `${base}/src/checks`, rel: "src/checks", name: "checks", count: 1 }, file("src/main.ts"),
      ] : path === "src/checks" ? [file("src/checks/logs.ts")] : [];
      const directoryCount = files.filter((entry) => entry.type === "directory").length;
      return { files, total: files.length, directoryCount, fileCount: files.length - directoryCount };
    },
    push: async () => pushView(),
    subscribePush: async (subscription: PushSubscriptionJson, label: string) => {
      const rest = devices.filter((device) => device.endpoint !== subscription.endpoint);
      devices.splice(0, devices.length, ...rest, {
        endpoint: subscription.endpoint,
        label: label.trim() || "本机",
        createdAt: new Date().toISOString(),
      });
      return pushView();
    },
    unsubscribePush: async (endpoint: string) => {
      const i = devices.findIndex((device) => device.endpoint === endpoint);
      if (i >= 0) devices.splice(i, 1);
      return pushView();
    },
    testPush: async () => ({ sent: 1, removed: 0 }),
    visibility: async () => {},
    events: (handlers) => {
      listeners.add(handlers.onEvent);
      const timers: ReturnType<typeof setTimeout>[] = [];
      if (scene === "act-demo") {
        timers.push(setTimeout(() => emit({ type: "router-activity", assistantId: "hob", activity: { state: "tool", label: "搜索：最新 AI 动态" } }), 2500));
        timers.push(setTimeout(() => {
          emit({ type: "router-activity", assistantId: "hob", activity: null });
          emit({ type: "item", assistantId: "hob", item: { kind: "assistant", id: "act-answer", at: new Date().toISOString(), text: "正在整理搜索结果…", streaming: true } });
        }, 5500));
        timers.push(setTimeout(() => {
          emit({ type: "item", assistantId: "hob", item: { kind: "assistant", id: "act-answer", at: new Date().toISOString(), text: "已整理好最新动态。" } });
          emit({ type: "assistant", assistant: { ...db.assistants.find((a) => a.id === "hob")!, busy: false, activity: null } });
        }, 7500));
      }
      return () => {
        timers.forEach(clearTimeout);
        listeners.delete(handlers.onEvent);
      };
    },
  };
}
