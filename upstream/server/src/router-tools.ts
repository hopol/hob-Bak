import { t } from "../../shared/i18n.ts";
import { Type } from "typebox";
import { propArtSchema } from "./prop-art-schema.ts";
import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { IMAGE_TYPES } from "../../shared/media.ts";
import { checkSensitivePath, lookupFile, isInPagesDir, OUTSIDE_HOB } from "./files.ts";
import { resolveMovedPath } from "./layout.ts";
import { assistantFilesDir, assistantWorkDir } from "./config.ts";
import {
  COLORS,
  COLOR_IDS,
  customSprite,
  parseSprite,
  PROP_IDS,
  PROPS,
  spriteId,
  validateCustomProp,
} from "../../shared/sprites.ts";
import type { ColorId } from "../../shared/sprites.ts";
import { buildAdminTools } from "./admin-tools.ts";
import type { Approval, ApprovalQuestion, ApprovalQuestionInput, CardRecord, CustomProp, Job, Routine, RoutineCheck } from "../../shared/types.ts";
import { loginCard, prepareLogin } from "./login.ts";
import { prepareFillNewPassword } from "./new-password.ts";
import { cronToChinese, timePointText } from "./cron-text.ts";
import { newId } from "./ids.ts";
import { findKnowledgeTool, searchKnowledgeTool } from "./knowledge-tools.ts";
import { generateImage, imageConfigured } from "./image.ts";
import { assistantInGroup, defaultWorkRef, jobModel, noteOf, thinkingLevelsOf, usableRefs } from "./models.ts";
import { overviewTool } from "./overview.ts";
import { pageTool } from "./pages.ts";
import { pushApproval } from "./push.ts";
import { searchTools } from "./search.ts";
import { searchPluginsTool } from "./search-plugins.ts";
import type { HobRuntime } from "./runtime.ts";
import { assistantSkillsDir, groupSkillsDir, listSkills } from "./assistant-skills.ts";
import { bundledPlaywrightSkillDir, generalSkillsDir, notEditable, skillDirOf, visibleSkills } from "./skills.ts";
import { jobView, reviewedSkillsText } from "./job-view.ts";
import { HANDOVER_EVENT } from "./groups.ts";
import { sessionOrigin } from "./origin.ts";
import { deleteSkill } from "./delete-skill.ts";
import { askOptions, cleanRecommended, unnumber } from "./worker-tools.ts";
import { handOffTodos, readTodos, sessionTodosPath, updateTodosTool } from "./todos.ts";
import { searchHistory } from "./history.ts";
import { saveSkillTool } from "./save-skill.ts";
import { validateCard } from "./cards.ts";
import { markdownToCard } from "./card-markdown.ts";
import { CWD_IMMUTABLE, normalizeWorkspaceCwdInput, resolveWorkspaceCwd } from "./workspace.ts";

type Tool = ToolDefinition<any, any>;

/** 执行时间的参数说明：cron 表达式和具体时间都收。 */
const SCHEDULES_DESCRIPTION = "一个或多个；可以是 cron 表达式，也可以是具体时间（如 2026-11-08T09:00），到执行时间只运行一次。";

/** once 的参数说明。 */
const ONCE_DESCRIPTION = "可选。为 true 时设置为仅运行一次：没有检查脚本的，运行一次后停止；有检查脚本的，第一次有输出后停止。已停止的定时任务还在，可以重新启用。";

/** 检查脚本参数：create_routine 和 update_routine 共用。 */
const CHECK_DESCRIPTION = "可选。到执行时间先运行的 bash 脚本，填脚本全文：没有输出就这次什么都不做；有输出时，then 为 notify 就把输出作为提醒发到对话，为 job 就把输出和任务内容一起交给你处理。每次有输出都会这样处理一次，不看上一次的处理完没有：同一件事连着输出几次，就会处理几次；只该处理一次的，在状态文件里记下已经输出过的，下次跳过。脚本里要调用你的工具（包括插件），用 node 运行 JS，全局对象 tools 就是你能用的工具。脚本在这个定时任务自己的目录里运行，状态文件存在当前目录，记住上次看到哪里；第一次运行还没有状态时只记下现状，不输出。非零退出算检查失败。脚本用到的其他文件也放在这个目录，跟着定时任务走。";

const checkDescription = (group: boolean) => group ? CHECK_DESCRIPTION.replace("then 为 notify 就把输出作为提醒发到对话，为 job 就把输出和任务内容一起交给你处理", "then 为 notify 就把输出作为提醒发到群里，为 job 就把输出和任务内容一起交给群主处理") : CHECK_DESCRIPTION;
const checkParam = (group: boolean) => Type.Object({
  script: Type.String({ description: "bash 脚本全文" }),
  then: Type.Union([Type.Literal("notify"), Type.Literal("job")], { description: group ? "有输出时怎么办。notify：把输出原样发到群里提醒用户，不叫醒群主，任务内容不会执行；job：把输出和任务内容一起交给群主，由群主处理。要看了输出再判断、再动手的，填 job。" : "有输出时怎么办。notify：把输出原样发到对话提醒用户，不叫醒你，任务内容不会执行；job：把输出和任务内容一起交给你，由你处理。要看了输出再判断、再动手的，填 job。" }),
}, { description: checkDescription(group) });

const QUESTION_INPUTS: readonly ApprovalQuestionInput[] = ["text", "multiline", "number", "date", "time"];

/** ask_user 的 questions 参数说明。 */
const QUESTIONS_DESCRIPTION =
  "可选，一次问几个问题时用。每个问题写 `title`（问题）、`why`（为什么要问它）；选择题写 `options`（2 到 3 个选项）和 `recommended`（推荐哪个选项），填空题不写 `options`，写 `input`（`text` 一行字、`multiline` 一段话、`number` 数字、`date` 日期、`time` 时间）和可选的 `placeholder`。用户答完，答案一起回来。";


/** 单问题卡的选项列表。 */
/**
 * 把 ask_user 的参数变成审批卡：有 questions 就是一张问几个问题的卡，没有就是原来那张单问题卡。
 * 参数不合规时给一句写清怎么改的话。
 */
function approvalFromParams(assistantId: string, groupId: string | undefined, params: any): Approval | { error: string } {
  const base = {
    id: newId("q-"),
    assistantId,
    title: String(params.title),
    ...(params.detail ? { detail: String(params.detail) } : {}),
    status: "pending" as const,
    source: "router" as const,
    ...(groupId ? { groupId } : {}),
    createdAt: new Date().toISOString(),
  };
  const remember = typeof params.remember === "string" ? params.remember.trim() : "";
  const asked: any[] = Array.isArray(params.questions) ? params.questions : [];
  if (asked.length) {
    if (remember) return { error: "带 questions 时不能带 remember：要记规则就用 set_rule，或者另出一张不带 questions 的卡问。" };
    if (asked.length > 8) return { error: `一张卡最多问 8 个问题，现在有 ${asked.length} 个：拆成几张卡，一轮问眼下能定的。` };
    const questions: ApprovalQuestion[] = [];
    const titles = unnumber(asked.map((item) => (typeof item?.title === "string" ? item.title : "")));
    for (const [index, item] of asked.entries()) {
      const n = index + 1;
      const title = titles[index];
      if (!title) return { error: `第 ${n} 个问题缺 title：每个问题都要写清问什么。` };
      const hasOptions = item?.options !== undefined && item?.options !== null;
      const hasInput = item?.input !== undefined && item?.input !== null;
      if (hasOptions && hasInput) {
        return { error: `第 ${n} 个问题不能同时带 options 和 input：选择题只写 options，填空题只写 input。` };
      }
      if (!hasOptions && !hasInput) {
        return { error: `第 ${n} 个问题缺 options 或 input：选择题写 options（2 到 3 个选项），填空题写 input（text、multiline、number、date 或 time）。` };
      }
      const why = typeof item?.why === "string" ? item.why.trim() : "";
      if (hasInput) {
        const input = typeof item.input === "string" ? item.input.trim() : "";
        if (!QUESTION_INPUTS.includes(input as ApprovalQuestionInput)) {
          return { error: `第 ${n} 个问题的 input 只能是 text、multiline、number、date 或 time，现在填的是「${String(item.input)}」：改成这五种之一。` };
        }
        if (item?.recommended !== undefined && item?.recommended !== null && String(item.recommended).trim() !== "") {
          return { error: `第 ${n} 个问题是填空题，不能带 recommended：去掉 recommended。` };
        }
        const placeholder = typeof item?.placeholder === "string" ? item.placeholder.trim() : "";
        questions.push({
          title,
          ...(why ? { why } : {}),
          options: [],
          input: input as ApprovalQuestionInput,
          ...(placeholder ? { placeholder } : {}),
        });
        continue;
      }
      const labels = Array.isArray(item?.options) ? item.options.map((option: any) => String(option?.label ?? "").trim()) : [];
      if (labels.length < 2 || labels.length > 3) {
        return { error: `第 ${n} 个问题的选项要 2 到 3 个，现在有 ${labels.length} 个：合并相近的选项，或者把它拆成两个问题。` };
      }
      const { options, recommended: marked } = askOptions(labels);
      const recommended = typeof item?.recommended === "string" ? cleanRecommended(item.recommended) : "";
      const hit = recommended ? options.find((option) => option.label === recommended) : options.find((option) => option.key === marked);
      if (recommended && !hit) {
        return { error: `第 ${n} 个问题的 recommended 要和其中一个选项的文字一字不差，现在填的是「${recommended}」：填${options.map((option) => `「${option.label}」`).join("或")}。` };
      }
      questions.push({ title, ...(why ? { why } : {}), options, ...(hit ? { recommended: hit.key } : {}) });
    }
    return { ...base, options: [], questions };
  }
  const labels: { label: string }[] = Array.isArray(params.options) ? params.options : [];
  if (labels.length < 2 || labels.length > 3) return { error: "选项要 2 到 3 个。" };
  if (remember && labels.length > 2) return { error: "带 remember 时最多给 2 个选项。" };
  const { options, recommended } = askOptions(labels.map((option) => String(option?.label ?? "")));
  if (remember) options.push({ key: "C", label: t("以后「{remember}」直接执行", { remember }), always: true });
  return { ...base, options, ...(recommended ? { recommended } : {}), ...(remember ? { ruleText: remember } : {}) };
}

/** 工具返回里说的「每 10 分钟」这类：具体时间只说那一刻，有检查脚本的说明有新内容会怎样，开了 once 的说明会停。 */
function routineFact(schedules: string[], check: RoutineCheck | undefined, once: boolean | undefined, group = false): string {
  const points = schedules.map((schedule) => timePointText(schedule));
  const labels = schedules.map((schedule, index) => points[index] ?? cronToChinese(schedule));
  const facts: string[] = [];
  if (points.every(Boolean)) facts.push(`${labels.join("、")}运行一次`);
  if (check) facts.push(`${labels.join("、")}检查一次${check.then === "notify" ? `，有输出时原样发到${group ? "群里" : "对话"}，任务内容不会执行` : `，有输出时连同任务内容交给${group ? "群主" : "你"}处理`}`);
  if (once) facts.push(t("运行一次后停止"));
  return facts.length ? `，${facts.join("；")}` : "";
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/**
 * 出了卡片就结束本轮：pi 的 terminate 让这一批工具结果之后不再请求模型，
 * 用户不会再看到卡片后面补的一句废话。
 */
function endTurn(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, terminate: true };
}

/** 四个交接入口共用的说明格式。 */
export const HANDOFF_NOTE_DESCRIPTION = `交接说明。接手的一方只看到这段说明和 files 里的文件，看不到你和用户的对话，所以它要知道的都写在这里。按这几项写，用不上的项省掉：
要办成什么：交什么结果，做到什么程度算完。
背景：这件事是怎么来的，已经知道的情况（路径、名字、查过的结论、前几次做到哪一步）。
用户的要求：用户明确说过的要求和在意的事，照用户的原话引用；用户没提的要求不加。
执行前确认：哪些事要先回来确认。`;

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

/** 是否正好是一个表情符号（用 Intl.Segmenter 数字素）。 */
export function isSingleEmoji(raw: string): boolean {
  const emoji = raw.trim();
  if (!emoji) return false;
  const graphemes = [...GRAPHEME_SEGMENTER.segment(emoji)];
  if (graphemes.length !== 1) return false;
  return /\p{Extended_Pictographic}/u.test(emoji)
    || /^\p{Regional_Indicator}{2}$/u.test(emoji)
    || /^[#*0-9]\uFE0F?\u20E3$/u.test(emoji);
}

function fileMeta(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    if (!/\.(md|txt)$/i.test(path)) return undefined;
    const text = readFileSync(path, "utf8");
    const chars = text.replace(/\s/g, "").length;
    const images = path.toLowerCase().endsWith(".md") ? (text.match(/!\[[^\]]*\]\([^)]*\)/g)?.length ?? 0) : 0;
    return `${chars} 字${images ? ` · ${images} 张图` : ""}`;
  } catch {
    return undefined;
  }
}

/** 一个助手的 Router 能用的全部工具。改状态的工具都写卡片 + 发事件。 */
export function buildRouterTools(
  runtime: HobRuntime,
  assistantId: string,
  groupId?: string,
  cwd = runtime.home,
  ownWorkDir = assistantWorkDir(runtime.home, assistantId),
): Tool[] {
  const { store, bus, router, jobs, routines } = runtime;
  const resolvedWorkspace = resolveWorkspaceCwd(store, runtime.home, assistantId, groupId);
  const boundSession = Boolean(resolvedWorkspace.bound);
  const currentGroup = groupId ? store.group(groupId) : undefined;
  const parentGroup = currentGroup?.parentId ? store.group(currentGroup.parentId) : currentGroup;
  const groupHasBoundCwd = Boolean(parentGroup?.cwd);
  const assistant = () => {
    const found = store.assistant(assistantId);
    if (!found) throw new Error(`助手不存在：${assistantId}`);
    return found;
  };
  const note = (icon: "memory" | "rule" | "routine" | "split" | "info" | "skill", text: string) =>
    router.addItem(assistantId, { kind: "note", icon, text }, groupId);
  const presentApproval = async (approval: Approval, signal?: AbortSignal) => {
    const cancel = () => {
      const current = store.approval(approval.id);
      if (!current || current.status !== "pending") return;
      const expired: Approval = { ...current, status: "expired" };
      store.saveApproval(expired);
      bus.emit({ type: "approval", approval: expired });
      if (groupId) runtime.groups.publish(groupId);
    };
    if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      await router.addItem(assistantId, { kind: "question", approvalId: approval.id }, groupId);
      signal?.throwIfAborted();
      bus.emit({ type: "approval", approval });
      pushApproval({ push: runtime.push, store }, approval);
    } finally { signal?.removeEventListener("abort", cancel); }
  };
  const profileChanged = (target = assistantId) => bus.emit({ type: "profile", assistantId: target });
  /**
   * 主助手的规则、定时和技能工具多一个 assistantId：填了就操作那个助手的，
   * 规则、定时和技能都按那个助手存。
   */
  const targetOf = (given: unknown): { id: string } | { error: string } => {
    const id = typeof given === "string" ? given.trim() : "";
    if (!id) return { id: assistantId };
    const found = store.assistant(id);
    return found ? { id: found.id } : { error: `没有这个助手：${id}` };
  };
  const nameOf = (id: string) => store.assistant(id)?.name ?? id;
  /**
   * start_job 在群里可以指名成员：填的是这个群里的成员就按它开任务，不填或填自己就还是自己。
   */
  const assigneeOf = (given: unknown): { id: string } | { error: string } => {
    const id = typeof given === "string" ? given.trim() : "";
    if (!id || id === assistantId) return { id: assistantId };
    const group = groupId ? store.group(groupId) : undefined;
    if (group && store.assistant(id) && group.members.includes(id)) return { id };
    return { error: `${id} 不在这个群里。群里的成员：${(group?.members ?? []).map((member) => `${nameOf(member)}（${member}）`).join("、")}` };
  };
  const sameGroup = (left?: string, right?: string) => !!left && store.groupMatches(left, right);

  const canManageJob = (id: string) => {
    const job = store.job(id);
    return !!job && (groupId ? sameGroup(groupId, job.groupId) : assistant().primary || job.assistantId === assistantId);
  };
  /** 任务不是这个会话开的：它在哪（给模型看的出处）；是的话 undefined。 */
  const jobOrigin = (job: Job) => (job.groupId ?? undefined) === (groupId ?? undefined) ? undefined : sessionOrigin(store, job.groupId, groupId);

  // 检查脚本试运行的结果写成事实交给模型：脚本写错了，现在就能改，不用等到执行时间才失败
  const trialFact = async (routine: Routine): Promise<string> => {
    if (!routine.check) return "";
    const result = await routines.trial(routine);
    if (result.outcome === "failed") return `\n检查脚本试跑失败：${result.reason}。到执行时间也会这样失败。脚本按 bash 执行，用别的语言写的，要在脚本里调用解释器，比如 python3 - <<'EOF' … EOF；要用的文件还没写好的，写好后再用 update_routine 改一次脚本，会再试跑。`;
    if (result.outcome === "hit") return `\n检查脚本试跑有输出（第一次跑应该只记下现状、不输出）：${result.output}`;
    return "\n检查脚本试跑通过，已记下现状。";
  };
  /** 技能名对应的那份（看得到的里面找）；只读的、没有的都返回一句说清的话。 */
  const findSkill = (id: string, name: string) => {
    const group = groupId ? store.group(groupId) : undefined;
    const all = visibleSkills(runtime, id, group);
    const skill = all.find((item) => item.name === name);
    return { skill, all, dir: skill && skill.editable ? skillDirOf(runtime, skill, id, group) : undefined, problem: !skill || !skill.editable ? notEditable(name, all) : undefined };
  };

  /**
   * 提示行里说的是谁的技能：本群的、另一个助手的，写清是哪个；自己在单聊里操作自己的，不用说。
   * 群里写的一行看不出是谁做的，所以群里连自己的技能也写上名字。
   */
  const whoseSkill = (dir: string, ownerId: string): string => {
    const group = groupId ? store.group(groupId) : undefined;
    const groupDir = group ? groupSkillsDir(runtime.home, group.parentId ?? group.id) : undefined;
    if (groupDir && dir === groupDir) return t("本群的");
    return ownerId !== assistantId || groupDir ? t("「{name}」的", { name: nameOf(ownerId) }) : "";
  };

  /** 定时任务归属：本群的、另一个助手的写清楚；自己在单聊里建的不用说。 */
  const whoseRoutine = (ownerId: string): string => groupId ? t("本群的") : ownerId === assistantId ? "" : t("「{name}」的", { name: nameOf(ownerId) });
  /** 现在有哪些定时任务（带 id）：删完、或者 id 填错了，模型看得出该填哪个。 */
  const routinesLeft = (ownerId: string): string => {
    const left = store.routines().filter((routine) => groupId ? sameGroup(groupId, routine.groupId) : !routine.groupId && routine.assistantId === ownerId);
    return `${groupId ? "本群" : ownerId === assistantId ? "你" : `「${store.assistant(ownerId)?.name ?? ownerId}」`}现在${left.length ? `的定时任务：${left.map((routine) => `「${routine.name}」（${routine.id}）`).join("、")}` : "没有定时任务"}。`;
  };

  // 能派的模型：写进 start_job 的参数说明，助手知道有哪些可选、哪个是默认
  const modelSettings = runtime.settings.settings.models;
  const modelAssistant = assistantInGroup(assistant(), groupId ? store.group(groupId) : undefined, runtime.models, modelSettings);
  const usable = usableRefs(modelSettings, modelAssistant, runtime.models);
  const defaultModel = defaultWorkRef(modelSettings, modelAssistant, runtime.models);
  const modelList = usable.map((ref) => {
    const entry = modelSettings.roster.find((item) => item.ref === ref);
    const note = entry ? noteOf(entry, runtime.models) : "";
    const levels = modelSettings.thinkingChoice === "fixed"
      ? jobModel({ settings: modelSettings, assistant: modelAssistant, catalog: runtime.models, requested: { model: ref } }).model.thinking
      : thinkingLevelsOf(runtime.models.find(ref)).join("、");
    return `${ref}${ref === defaultModel ? "（默认）" : ""}${note ? ` · ${note}` : ""} · 思考档 ${levels}`;
  });
  const modelText = modelList.length ? modelList.join("\n") : "（现在没有可用的模型）";

  const checkFile = (path: string) => {
    try {
      const root = realpathSync(bundledPlaywrightSkillDir());
      const file = realpathSync(path);
      if (file.startsWith(`${root}${sep}`) && statSync(file).isFile()) return file;
    } catch { /* 交给普通文件规则报告错误 */ }
    const found = lookupFile(runtime.home, path, [...store.jobs().flatMap((job) => job.cwd ? [job.cwd] : []), cwd]);
    if (found.ok) return found.info.path;
    // 技能清单里列出来的文件都能读：Lore 的在 system/ 里，本机和自带的在数据目录外，普通文件规则会拒掉
    try {
      const file = realpathSync(path);
      if (statSync(file).isFile() && visibleSkills(runtime, assistantId, currentGroup).some((skill) => file.startsWith(`${realpathSync(skill.dir)}${sep}`))) return file;
    } catch { /* 按普通文件规则的原因报 */ }
    throw new Error(found.error);
  };
  const read = createReadToolDefinition(cwd, { operations: {
    access: async (path) => { checkFile(path); },
    readFile: async (path) => readFile(checkFile(path)),
    detectImageMimeType: async (path) => IMAGE_TYPES[extname(checkFile(path)).toLowerCase()],
  } }) as unknown as Tool;
  delete (read as { promptSnippet?: unknown }).promptSnippet; // 用了自定义系统提示词，引擎自带的这段不进提示词
  const credentialsAvailable = (() => {
    const desktop = runtime.desktop.view();
    return desktop.enabled && Boolean(desktop.url && desktop.tokenConfigured) && runtime.plugins.hasCredentialProvider(assistantId);
  })();
  const fillNewPasswordAvailable = (() => {
    const desktop = runtime.desktop.view();
    return desktop.enabled && Boolean(desktop.url && desktop.tokenConfigured) && runtime.plugins.hasPasswordGenerator(assistantId);
  })();
  const tools: Tool[] = [
    {
      name: "react",
      label: "表情回应",
      description: "给用户最新的一条消息加一个表情回应，显示在那条消息的右下角，像聊天软件里的点赞。再调一次会换成新的表情。",
      parameters: Type.Object({
        emoji: Type.String({ description: "一个 emoji，比如 👍 ✅ ❤️ 😂" }),
      }),
      execute: async (_id, params: { emoji: string }) => {
        const emoji = typeof params.emoji === "string" ? params.emoji.trim() : "";
        if (!isSingleEmoji(emoji)) return fail("emoji 要正好一个表情，比如 👍");
        const result = groupId ? runtime.groups.react(groupId, assistantId, emoji) : router.react(assistantId, emoji);
        if (!result.ok) return fail(result.error);
        return ok(`已给用户的消息点了 ${emoji}。`);
      },
    },
    {
      name: "search_history",
      label: "搜索聊天记录",
      description: "在所有单聊、群和话题的聊天记录里按文字找消息，也能只看用户收藏过的消息。按时间从新到旧返回，每条带对话名、说话人、时间和命中处前后的一段原文。",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "要找的文字，空格隔开的几个词都要出现，不分大小写；只看收藏时可以不填。" })),
        starred: Type.Optional(Type.Boolean({ description: "填 true 只找用户收藏过的消息。" })),
      }),
      execute: async (_id, params: { query?: string; starred?: boolean }) => {
        const query = params.query?.trim() ?? "";
        if (!query && !params.starred) return fail("query 和 starred 至少填一个");
        try {
          const { results, total } = await searchHistory(store, { query, starred: params.starred, limit: 20, context: 80 });
          if (!total) return ok(params.starred && !store.stars().length ? "用户还没有收藏过消息" : `没找到包含「${query}」的消息`);
          const lines = results.map((item) => `${item.starred ? "★" : ""}[${item.at}] ${item.conversationName} · ${item.speakerName}：${item.snippet}`);
          if (total > results.length) lines.push(`还有 ${total - results.length} 条没列出，换更具体的词再找`);
          return ok(lines.join("\n"));
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    saveSkillTool(runtime, assistantId, groupId, cwd, undefined, [cwd, ownWorkDir]),
    searchPluginsTool(runtime.plugins, assistantId),
    {
      name: "check_job",
      label: "查看任务",
      description: "查看一个任务现在的状态和过程：做到哪一步、运行过哪些命令、说过什么、用了哪个技能、在等什么。",
      parameters: Type.Object({ jobId: Type.String({ description: "任务 id" }) }),
      execute: async (_id, params: { jobId: string }) => {
        const job = store.job(params.jobId);
        if (!job || !canManageJob(params.jobId)) return fail(`没有这个任务：${params.jobId}`);
        try {
          const transcript = jobs.transcript(params.jobId);
          if (router.checkJobUnchanged(assistantId, groupId, params.jobId, job, transcript)) {
            return ok("和你上次查看时一样，没有新的步骤。任务结束或提问时会通知你。");
          }
          return ok(jobView({ ...job, cwd: job.cwd ?? store.workDir(job.id) }, transcript, store.approvals(), visibleSkills(runtime, job.assistantId, job.groupId ? store.group(job.groupId) : undefined), runtime.settings.settings.general.timezone, undefined, jobOrigin(job)));
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: "delete_skill",
      label: "删除技能",
      description: `删除一个技能。技能会移到归档，不会彻底删掉。${groupId ? "在群里按名字先找本群的技能，再找你自己的。" : ""}`,
      parameters: Type.Object({
        name: Type.String({ description: "技能名。" }),
        replaced_by: Type.Optional(Type.String({ description: "可选，被哪个技能接替，填技能名。" })),
        ...(assistant().primary && !groupId ? { assistantId: Type.Optional(Type.String({ description: "可选，改哪个助手的；不填是你自己的" })) } : {}),
      }),
      execute: async (_id, params: { name: string; replaced_by?: string; assistantId?: string }) => {
        const target = targetOf(params.assistantId);
        if ("error" in target) return fail(target.error);
        try {
          const found = findSkill(target.id, params.name);
          if (found.problem || !found.dir) return fail(found.problem!);
          const title = found.skill?.title ?? params.name;
          const text = deleteSkill(runtime, target.id, params.name, params.replaced_by || undefined, groupId);
          await router.addItem(assistantId, { kind: "note", icon: "skill", text: t("已删除{whose}技能「{title}」", { whose: whoseSkill(found.dir, target.id), title }) }, groupId);
          return ok(text);
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: "review_job",
      label: "沉淀技能",
      description: "让一个已经结束的任务（做完、受阻、失败或停下的都行）回顾这次的做法，值得留的它自己存成技能。它在自己的会话里写，能把脚本和命令真跑一遍验证；进度和结果显示在任务卡片上。",
      parameters: Type.Object({ jobId: Type.String({ description: "任务 id。" }), note: Type.Optional(Type.String({ description: "可选，要交代给任务的话，比如用户的反馈和纠正、要一起并进来的技能。" })) }),
      execute: async (_id, params: { jobId: string; note?: string }) => {
        const job = store.job(params.jobId);
        if (!job || (job.assistantId !== assistantId && !(groupId && canManageJob(params.jobId)))) return fail("任务不存在");
        try { jobs.startSediment(job.id, { note: params.note || undefined }); return ok("已开始回顾，进度显示在任务卡片上。"); }
        catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      ...read,
      description: "读取文件或查看图片：用户发来的附件、任务的目录和产出、页面。长文件用 offset 分段读取。",
      execute: async (id, args: { path: string; offset?: number; limit?: number }, signal, update, ctx) => {
        try {
          const path = checkFile(resolve(cwd, args.path));
          if (IMAGE_TYPES[extname(path).toLowerCase()]) {
            if (ctx?.model && !ctx.model.input.includes("image")) return fail("当前对话模型无法查看图片");
            return await read.execute(id, { ...args, path }, signal, update, ctx);
          }
          const lines = (await readFile(checkFile(path), "utf8")).split("\n");
          const start = Math.max(0, Math.floor(args.offset ?? 1) - 1);
          if (start >= lines.length) return fail(`Offset ${args.offset} is beyond end of file (${lines.length} lines total)`);
          const end = Math.min(lines.length, start + Math.max(0, Math.floor(args.limit ?? lines.length)));
          let count = start;
          let size = 0;
          while (count < end && size + lines[count].length + (count > start ? 1 : 0) <= 3900) {
            size += lines[count].length + (count > start ? 1 : 0);
            count++;
          }
          if (count === start && start < end) {
            const next = start + 2 <= lines.length ? `；接着读用 offset=${start + 2}` : "";
            const text = `${lines[start].slice(0, 3900)}\n（第 ${start + 1} 行共 ${lines[start].length} 字，这里只有前 3,900 字${next}）`;
            return { ...ok(text), structuredContent: text };
          }
          const content = lines.slice(start, count).join("\n");
          const text = count < lines.length ? `${content}\n（共 ${lines.length} 行，这里到第 ${count} 行；接着读用 offset=${count + 1}）` : content;
          return { ...ok(text), structuredContent: text };
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: "start_job",
      label: "创建任务",
      description: "把事情交给后台任务执行。任务只看得到你写的 note 和 files 里的文件。",
      parameters: Type.Object({
        title: Type.String({ description: "任务标题，短，如「查磁盘占用」" }),
        note: Type.String({ description: HANDOFF_NOTE_DESCRIPTION }),
        cwd: Type.Optional(
          Type.String({
            description: boundSession
              ? `可选。不填，任务就在 ${resolvedWorkspace.bound} 里运行；填它里面的一个子目录，任务就在那里运行，比如几个任务要并行改同一个项目，各给一份 worktree。相对路径以 ${resolvedWorkspace.bound} 为准。`
              : "可选。填了，任务的命令默认就在这个目录里运行，改动直接落在这里，适合直接修改一个现成的项目。不填，任务在自己的目录里执行；只是读取某个项目，或者要另拉一份隔离着执行，不用填。相对路径以你的工作目录为准。",
          }),
        ),
        files: Type.Optional(
          Type.Array(Type.String(), {
            description: "要交给任务的文件路径；相对路径以你的工作目录为准，图片会直接给模型查看",
          }),
        ),
        ...(groupId ? { assistantId: Type.Optional(Type.String({ description: "谁来做：群里一位成员的 id，任务以它的身份运行，用它的技能和记忆。不填就是你自己。" })) } : {}),
        after: Type.Optional(Type.Array(Type.String(), { description: "可选。要等这些任务完成才开始，填任务 id。前置任务未完成（受阻、失败、已停止），这个任务就不开始，会告诉你。" })),
        expect_minutes: Type.Optional(Type.Number({ description: "可选，预计多少分钟能交结果。超过了会通知你；不填按 10 分钟。" })),
        model: Type.Optional(Type.String({ description: `可选，不填用默认。智能、成本、速度 0–100，越高越智能、越贵、越快：\n${modelText}` })),
        ...(modelSettings.thinkingChoice === "fixed" ? {} : {
          thinking: Type.Optional(Type.String({ description: "可选：思考档以可分派模型列表里每个模型标的为准。不填用模型的默认思考档。" })),
        }),
      }),
      execute: async (_id, params: any, signal) => {
        try {
          if (params.expect_minutes != null && (!Number.isInteger(params.expect_minutes) || params.expect_minutes < 1 || params.expect_minutes > 10080)) return fail("expect_minutes 要在 1 到 10080 之间");
          const note = String(params.note ?? "").trim();
          if (!note) return fail("note 不能为空：写清交接说明后再调用一次。");
          const files = Array.isArray(params.files) ? params.files.map((file: unknown) => resolve(cwd, String(file))) : [];
          // 群里可以指名成员：任务以它的身份跑（提示词、技能、记忆、默认模型都算它的），结果回到这个会话
          const assignee = assigneeOf(groupId ? params.assistantId : undefined);
          if ("error" in assignee) return fail(assignee.error);
          const rawCwd = normalizeWorkspaceCwdInput(params.cwd);
          const explicitCwd = rawCwd ? resolve(cwd, rawCwd) : undefined;
          const job = await jobs.start(assignee.id, {
            title: String(params.title),
            ...(groupId ? { groupId } : {}),
            ...(assignee.id === assistantId ? {} : { startedBy: assistantId }),
            ...(params.expect_minutes != null ? { expectMinutes: params.expect_minutes } : {}),
            instruction: note,
            ...(Array.isArray(params.after) && params.after.length ? { after: params.after.map(String) } : {}),
            ...(explicitCwd ? { cwd: explicitCwd } : {}),
            ...(files.length ? { files } : {}),
            ...(params.model ? { model: String(params.model) } : {}),
            ...(params.thinking ? { thinking: String(params.thinking) } : {}),
            ...(router.currentDelegation(assistantId, groupId) ? { delegationId: router.currentDelegation(assistantId, groupId) } : {}),
            ...(router.currentRoutineId(assistantId, groupId) ? { routineId: router.currentRoutineId(assistantId, groupId) } : {}),
          }, signal);
          if (job.status === "failed") return fail(`任务启动失败：${job.statusReason ?? "原因不明"}`);
          if (assignee.id !== assistantId) return ok(`已派给「${nameOf(assignee.id)}」：${job.title}（${job.id}）。结果会回到这里。`);
          if (job.after?.length) {
            const titles = job.after.map((id) => `「${store.job(id)?.title ?? id}」`).join("、");
            return ok(`任务「${job.title}」（${job.id}）已排上，等${titles}做完就开始。`);
          }
          return ok(
            `任务「${job.title}」（${job.id}）已开始，预计 ${job.expect?.minutes ?? 10} 分钟${params.expect_minutes == null ? "（默认）" : ""}。`,
          );
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "reply_job",
      label: "补充任务说明",
      description: "把话交给一个已有的任务：补充、纠正、追问，或者回答它的提问。它带着原来的上下文和目录继续执行，已经结束的任务也能接着执行。",
      parameters: Type.Object({
        jobId: Type.String({ description: "任务 id" }),
        text: Type.String({ description: "要补充的话" }),
      }),
      execute: async (_id, params: any) => {
        try {
          const jobId = String(params.jobId);
          if (!canManageJob(jobId)) return fail(`没有这个任务：${jobId}`);
          const job = store.job(jobId)!;
          const interrupted = await jobs.reply(jobId, String(params.text), "router");
          const origin = jobOrigin(job);
          const text = origin
            ? `已交给任务「${job.title}」（${jobId}），它会接着做。这个任务是${origin}创建的，结果回到那边。`
            : `已交给任务「${job.title}」（${jobId}），它会接着做，结果会回到这里。`;
          return ok(`${text}${interrupted ? `它的回顾停了，${reviewedSkillsText(interrupted)}` : ""}`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "stop_job",
      label: "停止任务",
      description: "停止一个正在运行的任务。",
      parameters: Type.Object({ jobId: Type.String({ description: "任务 id" }) }),
      execute: async (_id, params: any) => {
        try {
          const jobId = String(params.jobId);
          if (!canManageJob(jobId)) return fail(`没有这个任务：${jobId}`);
          const job = store.job(jobId)!;
          const origin = jobOrigin(job);
          // 停止原因里写清在哪停的，这句话界面上也会显示
          await jobs.stop(jobId, origin ? `${assistant().name}在${sessionOrigin(store, groupId, job.groupId)}停止了` : `${assistant().name}停止了`);
          return ok(origin ? `已停止。这个任务是${origin}创建的。` : "已停止。");
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "send_card",
      label: "发送卡片",
      description: `**说明**：在对话里发一张卡片。卡片有自己的标题、分栏、表格和折叠的段落，用来放文档式排版的内容；也可以让用户填表、选择、点按钮。卡片里有能操作的东西时，这一轮在这里结束，用户操作完，结果会作为系统消息回到对话；只有展示内容的卡片不结束这一轮。你发的卡片不能有密码框：密码、密钥这类值要用插件的卡片收，不经过你。

**参数**
- \`markdown\`：卡片内容。普通的 Markdown 照常写（小标题、列表、表格、代码块、链接），另外有这些写法：
  - 卡片标题：第一行写 \`# 标题\`；紧跟着的一行普通文字是副标题，可以不写。
  - 单独一行 \`---\` 是分割线；单独一行 \`![说明](https://…)\` 是图片。
  - 分栏：单独一行 \`::: columns\` 开始，单独一行 \`:::\` 结束，栏和栏之间单独一行 \`+++\`。手机上会竖着排。各栏宽度不一样时写 \`::: columns{weights="2 1"}\`。
  - 折叠：\`<details><summary>标题</summary>\` 开始，\`</details>\` 结束，中间是默认收起的内容；写成 \`<details open>\` 默认展开。
  - 能操作的组件一行一个，写成 \`::组件[文字]{属性}\`，属性之间用空格隔开，带空格的值加引号：
    - \`::input[标签]{name=… placeholder="…" default="…" required}\`：输入框，一行字。加 \`type=multiline\` 是一段话，\`type=number\` 是数字，可以加 \`min=\`、\`max=\`。
    - \`::select[标签]{name=… options="选项1|选项2|选项3" default="选项1" required}\`：单选。\`::multiselect\` 是多选，\`default\` 里几个默认选中的也用 \`|\` 隔开。
    - \`::date[标签]{name=… required}\`、\`::time[标签]{…}\`、\`::datetime[标签]{…}\`：日期、时间、日期和时间。
    - \`::checkbox[文字]{name=… checked}\`：开关，写 \`checked\` 默认打开。
    - \`::button[文字]{primary}\`：按钮，\`primary\` 是主按钮，\`danger\` 是危险操作。写 \`url=https://…\` 是打开网址；在表单里写 \`submit\` 是提交表单；其余的点了就算一次操作。
  - 表单：单独一行 \`:::form{name=…}\` 开始，单独一行 \`:::\` 结束，里面的输入在点 \`submit\` 按钮时一起交回。表单里的每个输入都要有不重复的 \`name\`。`,
      parameters: Type.Object({
        markdown: Type.String({ description: "卡片内容，Markdown" }),
      }),
      execute: async (_id, params: { markdown?: unknown }) => {
        if (typeof params.markdown !== "string" || !params.markdown.trim()) {
          return fail("卡片内容不能为空。");
        }
        const { card, warnings, errors } = markdownToCard(params.markdown);
        if (errors.length) return fail(`卡片格式不对：${errors.join("；")}`);
        const result = validateCard(card);
        if (!result.ok) {
          const error = result.error.error.startsWith("卡片不能有")
            ? `你发的${result.error.error}`
            : `卡片格式不对：${result.error.error}`;
          return fail(error);
        }
        const record: CardRecord = {
          id: newId("c-"),
          owner: { type: "assistant", assistantId },
          ...(groupId ? { groupId } : {}),
          card: result.value.card,
          status: "open",
          createdAt: new Date().toISOString(),
        };
        await router.addCard(assistantId, record, groupId);
        const shown = result.value.interactive
          ? "卡片已显示给用户，用户操作完结果会回到对话。"
          : "卡片已显示给用户。";
        const reply = warnings.length ? `${shown}注意：${warnings.join("；")}。` : shown;
        return result.value.interactive ? endTurn(reply) : ok(reply);
      },
    },
    {
      name: "login",
      label: "登录",
      description: credentialsAvailable
        ? "登录云桌面浏览器里当前打开的网站，先打开网站的登录页再调用。用户的密码管理器里存了这个网站的账号时，Hob 核对网址、请用户批准后，把账号和密码直接填进页面；没存的，请用户在卡片上填一次，存进密码管理器再填；页面要扫码、第三方账号或验证码这类只能用户本人完成的，请用户在云桌面里自己登录。密码不经过你。填好以后由你点登录按钮；分两步的登录页（先填用户名、点下一步才出密码框），点完下一步再调一次。site 写网站网址或名称，比如 forum.example.net 或「Example 论坛」；同一个网站存了几个账号时，account 写要用的用户名或邮箱，不确定就不填，用户在卡上选；reason 一句话写为什么要登录，显示在卡上；self 填 true 时不填账号，直接请用户在云桌面里自己登录。"
        : "请用户在云桌面里登录一个网站：会出一张卡，用户登录完会告诉你；登录信息所有助手共用，登一次就行。site 写哪个网站，reason 一句话写为什么要登录。",
      parameters: Type.Object({
        site: Type.String({ description: "网站网址或名称" }),
        reason: Type.String({ description: "为什么要登录，一句话" }),
        ...(credentialsAvailable ? { account: Type.Optional(Type.String({ description: "用户名或邮箱，不确定就不填" })), self: Type.Optional(Type.Boolean({ description: "用户要自己登录时填 true" })) } : {}),
      }),
      execute: async (_id: string, params: any, signal?: AbortSignal) => {
        const site = String(params.site ?? "").trim();
        const reason = String(params.reason ?? "").trim();
        const account = typeof params.account === "string" ? params.account.trim() : undefined;
        if (!site || !reason) return fail("site 和 reason 都要填写清楚。");
        try {
          const prepared = await prepareLogin(runtime, assistantId, site, account, params.self === true);
          if (prepared.kind === "message") return ok(prepared.text);
          if (prepared.kind === "failed") return fail(prepared.text);
          if (prepared.kind === "mismatch") {
            const approval: Approval = {
              id: newId("q-"), assistantId, title: "没有填写密码", detail: prepared.text, options: [], status: "answered", source: "router",
              ...(groupId ? { groupId } : {}), login: { site, reason, fillLogin: prepared.approval }, createdAt: new Date().toISOString(), answeredAt: new Date().toISOString(),
            };
            store.saveApproval(approval);
            await router.addItem(assistantId, { kind: "question", approvalId: approval.id }, groupId);
            bus.emit({ type: "approval", approval });
            return ok(prepared.text);
          }
          const card = loginCard(prepared, site, reason);
          const approval: Approval = {
            id: newId("q-"), assistantId, title: card.title, ...(card.detail ? { detail: card.detail } : {}),
            options: card.options, status: "pending", source: "router", ...(groupId ? { groupId } : {}), login: card.login, createdAt: new Date().toISOString(),
          };
          store.saveApproval(approval);
          const delegationId = router.currentDelegation(assistantId, groupId);
          if (delegationId) runtime.delegations.addApproval(delegationId, approval.id);
          await presentApproval(approval, signal);
          return endTurn(card.endTurn);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    ...(fillNewPasswordAvailable ? [{
      name: "fill_new_password",
      label: "生成并填写新密码",
      description: "注册新账号或修改密码时用：让用户的密码管理器按网站的要求生成一个新密码，Hob 先把它存进密码管理器，再填进云桌面浏览器当前页面的密码框（新密码和确认密码都填），密码不经过你。会先请用户批准。username 写注册或登录用的用户名或邮箱；length 和 characters 照页面上写的密码要求填，页面没写就不填（默认 20 位，含小写、大写、数字和符号）；name 是存进密码管理器时的名称，默认用网站名。",
      parameters: Type.Object({
        username: Type.String({ description: "注册或登录用的用户名或邮箱" }),
        length: Type.Optional(Type.Integer({ minimum: 4, maximum: 128, description: "页面要求的密码长度；不填默认 20 位" })),
        characters: Type.Optional(Type.Array(Type.Union([Type.Literal("lowercase"), Type.Literal("uppercase"), Type.Literal("numbers"), Type.Literal("symbols")]), { minItems: 1, maxItems: 4, description: "页面允许的字符种类；不填默认含小写、大写、数字和符号" })),
        name: Type.Optional(Type.String({ description: "存进密码管理器时的名称；不填用网站名" })),
      }),
      execute: async (_id: string, params: any, signal?: AbortSignal) => {
        const username = String(params.username ?? "").trim();
        if (!username) return fail("username 要填写注册或登录用的用户名或邮箱。");
        const characters = Array.isArray(params.characters) ? params.characters as ("lowercase" | "uppercase" | "numbers" | "symbols")[] : undefined;
        try {
          const prepared = await prepareFillNewPassword(runtime, assistantId, username, params.length === undefined ? undefined : Number(params.length), characters, typeof params.name === "string" ? params.name : undefined);
          if (prepared.kind === "message") return ok(prepared.text);
          const approval: Approval = {
            id: newId("q-"), assistantId, title: prepared.title, detail: prepared.detail,
            options: [{ key: "A", label: "不允许" }, { key: "B", label: "生成并填写" }],
            status: "pending", source: "router", ...(groupId ? { groupId } : {}),
            login: { site: prepared.approval.host, reason: prepared.detail, fillNewPassword: prepared.approval },
            createdAt: new Date().toISOString(),
          };
          store.saveApproval(approval);
          const delegationId = router.currentDelegation(assistantId, groupId);
          if (delegationId) runtime.delegations.addApproval(delegationId, approval.id);
          await presentApproval(approval, signal);
          return endTurn(`已请用户批准在 ${prepared.approval.host} ${prepared.approval.mode === "register" ? "注册新账号" : "修改密码"}，这一轮先到这里；用户批准后 Hob 会生成、保存并填好。`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    }] : []),
    {
      name: "ask_user",
      label: "询问用户",
      description: "在对话里出一张提问卡，用户答完，答案会回到对话。问题可以是选择题（2 到 3 个选项），也可以是填空题（一行字、一段话、数字、日期、时间）。",
      parameters: Type.Object({
        title: Type.String({ description: "问题，一句话" }),
        detail: Type.Optional(Type.String({ description: "补充说明，写清后果。" })),
        options: Type.Optional(Type.Array(
          Type.Object({
            label: Type.String({ description: "选项文字，如「暂不发布」" }),
          }),
          { description: "2 到 3 个选项", minItems: 2, maxItems: 3 },
        )),
        questions: Type.Optional(Type.Array(
          Type.Object({
            title: Type.String({ description: "问题" }),
            why: Type.Optional(Type.String({ description: "可选，写清为什么要定它" })),
            options: Type.Optional(Type.Array(
              Type.Object({ label: Type.String({ description: "选项文字" }) }),
              { description: "2 到 3 个选项", minItems: 2, maxItems: 3 },
            )),
            recommended: Type.Optional(Type.String({ description: "可选，推荐哪个选项，填选项的文字" })),
            input: Type.Optional(Type.Union([
              Type.Literal("text"),
              Type.Literal("multiline"),
              Type.Literal("number"),
              Type.Literal("date"),
              Type.Literal("time"),
            ], { description: "填空题的类型：text 一行字、multiline 一段话、number 数字、date 日期、time 时间。不写 options 时必填。" })),
            placeholder: Type.Optional(Type.String({ description: "可选，输入框里的提示文字。" })),
          }),
          { description: QUESTIONS_DESCRIPTION, minItems: 1, maxItems: 8 },
        )),
        remember: Type.Optional(Type.String({ description: "这类事以后可以不再问时，填这类事的简称（如「清理临时文件」）；卡片上会多一个「以后直接执行」的选项。" })),
      }),
      execute: async (_id, params: any, signal) => {
        const approval = approvalFromParams(assistantId, groupId, params);
        if ("error" in approval) return fail(approval.error);
        store.saveApproval(approval);
        // 话题里挂了待答的提问卡：左栏和话题卡上的「等你」跟着变
        if (groupId) runtime.groups.publish(groupId);
        const delegationId = router.currentDelegation(assistantId, groupId);
        if (delegationId) runtime.delegations.addApproval(delegationId, approval.id);
        await presentApproval(approval, signal);
        return endTurn("问题卡已显示给用户。");
      },
    },
    {
      name: "set_rule",
      label: "记录规则",
      description: `记下用户对某类事的处理方式：ask 是执行前确认，allow 是直接执行。${groupId ? "在群里记的，只在这个群生效。" : ""}`,
      parameters: Type.Object({
        text: Type.String({ description: "规则内容，如「发布公众号」" }),
        mode: Type.Unsafe<"ask" | "allow">(Type.String({ description: "ask 或 allow" })),
        ...(assistant().primary && !groupId ? { assistantId: Type.Optional(Type.String({ description: "可选，改哪个助手的；不填是你自己的" })) } : {}),
      }),
      execute: async (_id, params: any) => {
        const target = targetOf(params.assistantId);
        if ("error" in target) return fail(target.error);
        const text = String(params.text).trim();
        if (!text) return fail("规则内容为空。");
        const mode = params.mode === "allow" ? "allow" : "ask";
        const rules = groupId ? store.groupRules(groupId) : store.rules(target.id);
        const existing = rules.find((rule) => rule.text === text);
        // 答 always 审批时规则已经写好了（Actions 那行提示也已经出过），这里没改动就不重复出：
        // 模型看到答案之后常会把同一句再记一遍，重复的提示行对用户没有信息量。
        if (existing?.mode === mode) return ok("这条规则已经记着了，没有改动。");
        if (existing) {
          existing.mode = mode;
          existing.changedAt = new Date().toISOString();
        } else {
          rules.push({ id: newId("r-"), text, mode, changedAt: new Date().toISOString() });
        }
        if (groupId) store.saveGroupRules(groupId, rules);
        else store.saveRules(target.id, rules);
        await note("rule", t("已记入{owner}的规则 · {rule}", { owner: groupId ? t("本群") : nameOf(target.id), rule: text }));
        profileChanged(target.id);
        return ok("已记录规则。");
      },
    },
    {
      name: "remove_rule",
      label: "删除规则",
      description: "删除一条规则。",
      parameters: Type.Object({
        ruleId: Type.String({ description: "规则 id" }),
        ...(assistant().primary && !groupId ? { assistantId: Type.Optional(Type.String({ description: "可选，改哪个助手的；不填是你自己的" })) } : {}),
      }),
      execute: async (_id, params: any) => {
        const target = targetOf(params.assistantId);
        if ("error" in target) return fail(target.error);
        const rules = groupId ? store.groupRules(groupId) : store.rules(target.id);
        const kept = rules.filter((rule) => rule.id !== params.ruleId);
        if (kept.length === rules.length) return fail("没有这条规则。");
        if (groupId) store.saveGroupRules(groupId, kept);
        else store.saveRules(target.id, kept);
        await note("rule", t("删除了{owner}的一条规则", { owner: groupId ? t("本群") : nameOf(target.id) }));
        profileChanged(target.id);
        return ok("已删除。");
      },
    },
    {
      name: "create_routine",
      label: "新增定时任务",
      description: `新增一个定时任务。执行时间用 cron 表达式，如「0 9 * * *」每天 9 点；只运行一次就填具体时间；多个执行时间就传多个。${groupId ? "在群里创建的归这个群，到执行时间交给群主在这里处理。" : ""}`,
      parameters: Type.Object({
        name: Type.String({ description: "定时任务名称，如「每日简报」" }),
        instruction: Type.String({ description: "到执行时间要执行的内容" }),
        schedules: Type.Array(Type.String({ description: "cron 表达式或具体时间" }), { description: SCHEDULES_DESCRIPTION }),
        check: Type.Optional(checkParam(!!groupId)),
        once: Type.Optional(Type.Boolean({ description: ONCE_DESCRIPTION })),
        ...(assistant().primary && !groupId ? { assistantId: Type.Optional(Type.String({ description: "可选，改哪个助手的；不填是你自己的" })) } : {}),
      }),
      execute: async (_id, params: any) => {
        const target = targetOf(groupId ? undefined : params.assistantId);
        if ("error" in target) return fail(target.error);
        try {
          const routine = routines.create({
            assistantId: target.id,
            ...(groupId ? { groupId } : {}),
            name: String(params.name),
            instruction: String(params.instruction),
            instructionBy: assistantId,
            schedules: (params.schedules as string[]) ?? [],
            ...(params.check ? { check: params.check as RoutineCheck } : {}),
            ...(params.once ? { once: true } : {}),
          });
          await note("routine", t("新增{whose}定时任务 · {name} · {schedules}", { whose: whoseRoutine(target.id), name: routine.name, schedules: routine.schedules.map((schedule) => cronToChinese(schedule)).join("、") }));
          profileChanged(target.id);
          return ok(`定时任务「${routine.name}」已创建${routineFact(routine.schedules, routine.check, routine.once, !!groupId)}。它的目录是 ${routines.dir(routine)}，检查脚本在这里运行；脚本要用的其他文件，可以分派任务写到这个目录。${await trialFact(routine)}`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "update_routine",
      label: "修改定时任务",
      description: "修改一个定时任务：名称、内容、执行时间（schedules 会整体替换）、检查脚本、启用状态。",
      parameters: Type.Object({
        routineId: Type.String(),
        name: Type.Optional(Type.String()),
        instruction: Type.Optional(Type.String()),
        schedules: Type.Optional(Type.Array(Type.String({ description: "cron 表达式或具体时间" }), { description: SCHEDULES_DESCRIPTION })),
        active: Type.Optional(Type.Boolean()),
        check: Type.Optional(Type.Union([checkParam(!!groupId), Type.Null()], { description: `${checkDescription(!!groupId)}传 null 去掉检查。` })),
        once: Type.Optional(Type.Boolean({ description: ONCE_DESCRIPTION })),
        ...(assistant().primary && !groupId ? { assistantId: Type.Optional(Type.String({ description: "可选，改哪个助手的；不填是你自己的" })) } : {}),
      }),
      execute: async (_id, params: any) => {
        const target = targetOf(params.assistantId);
        if ("error" in target) return fail(target.error);
        try {
          const found = store.routine(String(params.routineId));
          if (!found || (groupId ? !sameGroup(groupId, found.groupId) : !!found.groupId || found.assistantId !== target.id)) return fail(`没有这个定时任务：${params.routineId}。${routinesLeft(target.id)}`);
          const instruction = params.instruction ? String(params.instruction) : undefined;
          const routine = routines.update(String(params.routineId), {
            ...(params.name ? { name: String(params.name) } : {}),
            ...(instruction ? { instruction } : {}),
            // 修改了内容：这份是当前助手填写的，到执行时间时写明是谁填写的
            ...(instruction && instruction !== found.instruction ? { instructionBy: assistantId } : {}),
            ...(params.schedules ? { schedules: params.schedules as string[] } : {}),
            ...(typeof params.active === "boolean" ? { active: params.active } : {}),
            ...(params.check === null || params.check ? { check: params.check as RoutineCheck | null } : {}),
            ...(typeof params.once === "boolean" ? { once: params.once } : {}),
          });
          await note("routine", t("修改{whose}定时任务 · {name} · {schedules}", { whose: whoseRoutine(target.id), name: routine.name, schedules: routine.schedules.map((schedule) => cronToChinese(schedule)).join("、") }));
          profileChanged(target.id);
          return ok(`已修改${routineFact(routine.schedules, routine.check, routine.once, !!groupId)}。目录是 ${routines.dir(routine)}。${params.check ? await trialFact(routine) : ""}`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "delete_routine",
      label: "删除定时任务",
      description: "删除一个定时任务。",
      parameters: Type.Object({
        routineId: Type.String(),
        ...(assistant().primary && !groupId ? { assistantId: Type.Optional(Type.String({ description: "可选，改哪个助手的；不填是你自己的" })) } : {}),
      }),
      execute: async (_id, params: any) => {
        const target = targetOf(params.assistantId);
        if ("error" in target) return fail(target.error);
        try {
          const found = store.routine(String(params.routineId));
          if (!found || (groupId ? !sameGroup(groupId, found.groupId) : !!found.groupId || found.assistantId !== target.id)) return fail(`没有这个定时任务：${params.routineId}。${routinesLeft(target.id)}`);
          routines.remove(String(params.routineId));
          await note("routine", t("删除了{whose}定时任务「{name}」", { whose: whoseRoutine(target.id), name: found.name }));
          profileChanged(target.id);
          // 删完还剩哪些写清楚：模型以为有重复、删掉的其实是唯一一条时，看得出来
          return ok(`已删除「${found.name}」。${routinesLeft(target.id)}`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "send_file",
      label: "发送文件",
      description: "把一个文件（任务交来的文件、截图、任务生成的图）作为卡片发到对话里，图片直接显示。",
      parameters: Type.Object({ path: Type.String({ description: "文件路径；相对路径以你的工作目录为准" }) }),
      execute: async (_id, params: any) => {
        const requested = resolve(cwd, String(params.path));
        // 迁移后的老路径直接换到新位置（不给模型提示），卡片里存新路径
        let path = existsSync(requested) ? requested : resolveMovedPath(runtime.home, requested);
        if (!existsSync(path)) return fail(`文件不存在：${requested}`);
        const sensitive = checkSensitivePath(path, runtime.home);
        if (sensitive) return fail(`${sensitive}：${path}`);
        // 页面只读得到 Hob 自己的目录和任务工作目录：外部目录（含绑定的项目目录）文件复制一份进 files/sent/ 再发，同时拦截敏感文件
        const homeScope = lookupFile(runtime.home, path, []);
        if (!homeScope.ok && homeScope.error !== OUTSIDE_HOB) return fail(`${homeScope.error}：${path}`);
        if (!homeScope.ok) {
          const workScope = lookupFile(runtime.home, path, [...store.jobs().flatMap((job) => job.cwd ? [job.cwd] : []), cwd]);
          if (!workScope.ok && workScope.error !== OUTSIDE_HOB) return fail(`${workScope.error}：${path}`);
          if (!statSync(path).isFile()) return fail(`这是目录，不是文件：${path}`);
          const copy = join(assistantFilesDir(runtime.home, assistantId, "sent"), randomUUID().slice(0, 8), basename(path));
          mkdirSync(dirname(copy), { recursive: true });
          copyFileSync(path, copy);
          path = copy;
        }
        let name = basename(path);
        let meta = fileMeta(path);
        if (isInPagesDir(relative(runtime.home, resolve(path))) && extname(path).toLowerCase() === ".html") {
          const html = await readFile(path, "utf8");
          const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1];
          const summary = html.match(/<header class="hd"><h1>[\s\S]*?<\/h1><p>([\s\S]*?)<\/p><\/header>/)?.[1];
          const unescape = (value: string) => value.replace(/&(amp|lt|gt|quot);/g, (_, key: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[key]!);
          if (title !== undefined && summary !== undefined) { name = unescape(title); meta = unescape(summary); }
        }
        await router.addItem(assistantId, { kind: "file", path, name, ...(meta ? { meta } : {}) }, groupId);
        return ok("已发送。");
      },
    },
    {
      name: "set_avatar",
      label: "更换头像",
      description: "给自己更换头像：更换内置道具、更换颜色，或用 prop_art 自画一件像素道具。主助手还可以传 assistant 给其他助手更换。",
      parameters: Type.Object({
        sprite: Type.String({
          description: `内置道具 id 之一（${PROP_IDS.filter((id) => id !== "hob").join(" ")}），或 custom（自画的，同时填 prop_art；已画过时不填 prop_art 就是换回那件）`,
        }),
        color: Type.Optional(
          Type.String({ description: `可选：火苗颜色，${COLOR_IDS.join(" ")} 之一；不填用道具的默认色` }),
        ),
        prop_art: propArtSchema,
        assistant: Type.Optional(Type.String({ description: "仅主助手：要更换头像的助手 id；不填是自己" })),
      }),
      execute: async (_id, params: any) => {
        const target = store.assistant(String(params.assistant ?? assistantId));
        if (!target) return fail(`没有这个助手：${params.assistant}`);
        if (target.id !== assistantId && !assistant().primary) return fail("只有主助手能给其他助手更换头像。");
        const parsed = parseSprite(String(params.sprite ?? ""));
        if (!parsed) {
          return fail(
            `sprite 要是内置道具 id 之一（${PROP_IDS.filter((id) => id !== "hob").join(" ")}）或 custom，收到「${params.sprite}」。`,
          );
        }
        const color = typeof params.color === "string" ? params.color : undefined;
        if (color !== undefined && !Object.hasOwn(COLORS, color)) {
          return fail(`color 要是 ${COLOR_IDS.join(" ")} 之一，收到「${color}」。`);
        }
        let sprite: string;
        let prop: CustomProp | undefined;
        if (parsed.prop === "custom") {
          if (params.prop_art !== undefined) {
            const checked = validateCustomProp(params.prop_art);
            if (!checked.ok) return fail(`prop_art 画得不对：${checked.error}；照着原因改好，再调用一次。`);
            prop = checked.prop;
          } else if (!target.prop) {
            return fail("sprite 是 custom 但还没有画过的道具：要给 prop_art（art、pal、dx）画一件。");
          }
          sprite = customSprite((color ?? parsed.color) as ColorId);
        } else {
          if (params.prop_art !== undefined) return fail("sprite 是内置道具时不要传 prop_art；要自画一件就把 sprite 填 custom。");
          sprite = spriteId(parsed.prop, (color ?? parsed.color) as ColorId);
        }
        const next = { ...target, sprite, ...(prop ? { prop } : {}) };
        store.saveAssistant(next);
        bus.emit({ type: "assistant", assistant: runtime.router.summary(next) });
        const desc =
          parsed.prop === "custom"
            ? `自画道具 · ${COLORS[(color ?? parsed.color) as ColorId].name}`
            : `${PROPS[parsed.prop].label} · ${COLORS[(color ?? parsed.color) as ColorId].name}`;
        await note("info", t("已更换头像 · {assistant} · {description}", { assistant: target.name, description: desc }));
        return ok(t("已更换头像。"));
      },
    },
  ];

  if (assistant().abilities?.image !== false && imageConfigured(runtime.settings.settings.image)) {
    tools.push({
      name: "generate_image",
      label: "生成图片",
      description: "按文字生成或修改图片，直接显示在对话里：生成时有进度卡片，生成后自动显示。返回的路径可以作为之后修改图片的参考图。",
      parameters: Type.Object({
        prompt: Type.String({ description: "要画什么，越具体越好" }),
        size: Type.Optional(Type.String({ description: "尺寸，如 1024x1024；不填用设置里的默认" })),
        refs: Type.Optional(Type.Array(Type.String(), { description: "参考图的绝对路径（改图、按图生成的时候给）" })),
      }),
      execute: async (_id, params: any, signal) => {
        const config = runtime.settings.settings.image;
        const prompt = String(params.prompt ?? "");
        const size = params.size ? String(params.size) : config.source === "openai" ? config.size : undefined;
        const item = await router.addItem(assistantId, { kind: "image", status: "pending", prompt, ...(size ? { size } : {}), startedAt: new Date().toISOString() }, groupId);
        try {
          const path = await generateImage({ home: runtime.home, dir: join(runtime.home, "assistants", assistantId, "files", "images"), config, signal }, {
            prompt,
            ...(params.size ? { size: String(params.size) } : {}),
            ...(Array.isArray(params.refs) && params.refs.length ? { refs: params.refs.map(String) } : {}),
          });
          await router.updateImage(assistantId, item.id, { status: "done", path }, groupId);
          return ok(`图片已经显示在对话里。路径：${path}，之后修改图片可以作为参考图。`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await router.updateImage(assistantId, item.id, { status: "failed", error: message }, groupId);
          return fail(message);
        }
      },
    });
  }

  if (runtime.settings.settings.general.showPage !== false) tools.push(pageTool(runtime, assistantId));

  {
    tools.push(
      overviewTool(runtime),
      ...buildAdminTools(runtime, assistantId, groupId, { primary: assistant().primary }),
      {
        name: "message_assistant",
        label: "转交其他助手",
        description: "把一件事转给另一个助手（见「助手」一节），由它负责到底。对方只看得到你写的 note 和 files 里的文件；它的回复和结果会回到这里。",
        parameters: Type.Object({
          assistantId: Type.String({ description: "目标助手 id" }),
          note: Type.String({ description: HANDOFF_NOTE_DESCRIPTION }),
          files: Type.Optional(Type.Array(Type.String({ description: "要交给对方的文件路径" }))),
        }),
        execute: async (_id, params: any, signal) => {
          const targetId = String(params.assistantId);
          const target = store.assistant(targetId);
          if (!target) return fail(`没有这个助手：${targetId}`);
          if (targetId === assistantId) return fail("不能转交给自己。");
          const currentDelegationId = router.currentDelegation(assistantId, groupId);
          if (currentDelegationId) {
            const current = store.delegation(currentDelegationId);
            const sourceName = current ? nameOf(current.from) : "发起委派的助手";
            return fail(`你在处理「${sourceName}」转来的事：不归你管就用 hand_back 交回它，由它再转。`);
          }
          // 转给主助手的事它没法再往下转（转交中不能再转交，它也没有 hand_back），交回才能由它接着转
          if (target.primary && !assistant().primary) return fail(`要交给「${target.name}」，用 hand_back：它会接过去，转给合适的助手。`);
          try {
            const note = String(params.note ?? "").trim();
            if (!note) return fail("note 不能为空：写清交接说明后再调用一次。");
            const files = Array.isArray(params.files) ? params.files.map((file: unknown) => resolve(cwd, String(file))) : [];
            const unfinished = readTodos(sessionTodosPath(runtime.home, assistantId, groupId)).filter((item) => item.status !== "done");
            const carried = unfinished.length
              ? `${note}\n\n「${assistant().name}」转交前列过的待办，没做完的：\n${unfinished.map((item) => `· ${item.text}`).join("\n")}`
              : note;
            await runtime.delegations.start(assistantId, targetId, carried, files, signal);
            signal?.throwIfAborted();
            if (!unfinished.length) return endTurn(`已转交给「${target.name}」。`);
            await handOffTodos(runtime, assistantId, groupId);
            return endTurn(`已转交给「${target.name}」。你手上那份待办（没做完 ${unfinished.length} 项）一起交过去了，已经清掉。`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      },
      {
        name: "message_group",
        label: "交给群",
        description: "把一件事交给一个群处理：在群里创建一个话题，你写的 note 是话题的第一条，由群主接手。群主关闭话题时写的结论会回到这里。",
        parameters: Type.Object({
          groupId: Type.String({ description: "群 id（见「群」一节）。" }),
          title: Type.String({ description: "话题名，写这件事，如「相册备份出错」，最多 40 字。" }),
          note: Type.String({ description: HANDOFF_NOTE_DESCRIPTION }),
          files: Type.Optional(Type.Array(Type.String({ description: "要交给群的文件路径" }))),
          cwd: Type.Optional(Type.String({ description: "可选，仅目标群未绑定工作目录时可用，为新话题指定工作目录（绝对路径，创建后不可修改）。" })),
        }),
        execute: async (_id, params: any, signal) => {
          const id = String(params.groupId ?? "").trim();
          const group = store.group(id);
          if (!group) {
            const all = store.groups().filter((item) => !item.parentId).map((item) => `${item.name}（${item.id}）`);
            return fail(`没有这个群：${id}。现有的群：${all.length ? all.join("、") : "还没有"}`);
          }
          if (group.parentId) return fail(`${id} 是话题，不是群：groupId 填群 id，会在群里创建一个新话题。`);
          if (groupId && sameGroup(groupId, group.id)) return fail(`你就在群「${group.name}」里，不用交给它。`);
          const title = typeof params.title === "string" ? params.title.trim() : "";
          if (!title) return fail("title 不能为空：写这件事，如「相册备份出错」。");
          if ([...title].length > 40) return fail(`title 最多 40 字，现在 ${[...title].length} 字：写成一句话，如「相册备份出错」。`);
          const note = String(params.note ?? "").trim();
          if (!note) return fail("note 不能为空：写清交接说明后再调用一次。");
          const files = Array.isArray(params.files) ? params.files.map((file: unknown) => resolve(cwd, String(file))) : [];
          try {
            signal?.throwIfAborted();
            const { topic, item } = runtime.groups.handOver(group.id, title, assistantId, {
              text: note,
              files,
              ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
            });
            const cancel = () => {
              const current = store.group(topic.id);
              if (current && !current.closedAt && !runtime.groups.summary(topic.id).busy?.length) {
                runtime.groups.closeByOwner(topic.id, t("交接调用已中止"));
              }
            };
            signal?.addEventListener("abort", cancel, { once: true });
            try {
              // 这次说话所在的对话里落一张话题卡：进度、等你回答、结论都在卡上
              await router.addItem(assistantId, { kind: "topic", topicId: topic.id }, groupId);
              signal?.throwIfAborted();
            } finally {
              signal?.removeEventListener("abort", cancel);
            }
            void runtime.groups.deliverEvent(topic.id, topic.ownerId, HANDOVER_EVENT, item.id).catch((error) => console.error("交给群的事件没送到：", error));
            return endTurn(`已交给群「${group.name}」：创建了话题「${topic.name}」（${topic.id}），群主「${nameOf(topic.ownerId)}」接手。有了结论会回到这里。`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }
  if (!assistant().primary) {
    tools.push({
      name: "hand_back",
      label: "交回",
      description: "把不归你管的事交回：别人转给你的，交回转来的那位；用户直接找你的，交回 Hob，由它转给合适的助手。",
      parameters: Type.Object({ text: Type.String({ description: "用户要什么" }), reason: Type.String({ description: "为什么不归你，一句话" }) }),
      execute: async (_id, params: any, signal) => {
        const text = String(params.text ?? "").trim();
        const reason = String(params.reason ?? "").trim();
        if (!text || !reason) return fail("请写清用户要求和交回原因。");
        try {
          const delegationId = router.currentDelegation(assistantId, groupId);
          if (delegationId) {
            const delegation = store.delegation(delegationId);
            const destinationName = delegation ? nameOf(delegation.from) : "发起委派的助手";
            runtime.delegations.returnTo(delegationId, text, reason);
            return endTurn(`已交回「${destinationName}」。`);
          }
          const destination = store.assistant("hob");
          if (!destination) return fail("主助手不存在，暂时无法交回。");
          await router.ensure(destination.id);
          signal?.throwIfAborted();
          const handbackId = newId("hb-");
          await router.addItem(assistantId, { kind: "note", icon: "info", text: `已交回「${destination.name}」：${reason}`, handbackId });
          signal?.throwIfAborted();
          await router.addForwarded(destination.id, text, handbackId, assistantId);
          signal?.throwIfAborted();
          await router.event(destination.id, `转自「${assistant().name}」：${text}\n交回原因：${reason}`);
          return endTurn(`已交回「${destination.name}」。`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    });
  }

  // 群主在群里管理话题；不是群主的成员没有这些工具。
  // open_topic 只在综合里；close_topic 综合和话题里都有。
  const ownerGroup = groupId ? store.group(groupId) : undefined;
  if (ownerGroup && ownerGroup.ownerId === assistantId) {
    const gid = ownerGroup.id;
    /** 每次都现查：群主在中途换了，旧会话里的调用也要挡住。 */
    const notOwner = (): string | null => {
      const group = store.group(gid);
      if (!group) return "这个群和话题只在群里用。";
      if (group.ownerId !== assistantId) return "只有群主能创建话题和关闭话题。";
      return null;
    };
    /** 这个群进行中的话题，报错时列出来。 */
    const topicList = (): string => {
      const topics = runtime.groups.activeTopics(ownerGroup.parentId ?? gid);
      return topics.length ? topics.map((topic) => `${topic.name}（${topic.id}）`).join("、") : "还没有";
    };
    tools.push({
      name: "close_topic",
      label: "关闭话题",
      description: "关闭话题：这件事完成了，或者用户不要了。",
      parameters: Type.Object({
        topic: Type.Optional(Type.String({ description: "话题 id。在话题里关这个话题时不填。" })),
        note: Type.Optional(Type.String({ description: "给用户的结论，或者为什么不做了，会显示在综合的话题卡上。" })),
      }),
      execute: async (_id, params: any) => {
        const problem = notOwner();
        if (problem) return fail(problem);
        const live = store.group(gid);
        const given = typeof params.topic === "string" ? params.topic.trim() : "";
        const targetId = given || (live?.parentId ? gid : "");
        if (!targetId) return fail(`topic 不能为空：在综合里关哪个话题就填哪个。这个群进行中的话题：${topicList()}`);
        const topic = store.group(targetId);
        const parentId = live?.parentId ?? gid;
        if (!topic || topic.parentId !== parentId) return fail(`「${targetId}」不是这个群的话题。这个群进行中的话题：${topicList()}`);
        try {
          const closed = runtime.groups.closeByOwner(topic.id, params.note);
          // 关的是自己所在的话题：这里的事办完了，本轮到此为止（和转交、交回一样），不再多请求一轮模型
          return targetId === gid ? endTurn(`话题「${closed.name}」已关闭。`) : ok(`话题「${closed.name}」已关闭。`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    });
    if (!ownerGroup.parentId) {
      tools.push({
        name: "open_topic",
        label: "创建话题",
        description: "创建一个话题，把你的交接说明放进话题，由群主接手。topic 填已有话题的 id，就转到那个话题（已关闭的会重新打开）。",
        parameters: Type.Object({
          title: Type.Optional(Type.String({ description: "新话题的名字，写这件事，如「相册备份出错」。转到已有话题时不填。" })),
          topic: Type.Optional(Type.String({ description: "已有话题的 id。创建新话题时不填。" })),
          note: Type.String({ description: HANDOFF_NOTE_DESCRIPTION }),
          files: Type.Optional(Type.Array(Type.String({ description: "要交给话题的文件路径" }))),
          ...(groupHasBoundCwd ? {} : {
            cwd: Type.Optional(Type.String({ description: "仅创建新话题（填 title）时可选，话题的工作目录（绝对路径，创建后不可修改）。" })),
          }),
        }),
        execute: async (_id, params: any) => {
          const problem = notOwner();
          if (problem) return fail(problem);
          const title = typeof params.title === "string" ? params.title.trim() : "";
          const topicId = typeof params.topic === "string" ? params.topic.trim() : "";
          if (!title && !topicId) return fail("title 和 topic 要填一个：创建新话题填 title，转到已有话题填 topic。");
          if (title && topicId) return fail("title 和 topic 只能填一个：创建新话题填 title，转到已有话题填 topic。");
          if (title && [...title].length > 40) return fail(`title 最多 40 字，现在 ${[...title].length} 字：写成一句话，如「相册备份出错」。`);
          const note = typeof params.note === "string" ? params.note.trim() : "";
          if (!note) return fail("note 不能为空：写清交接说明后再调用一次。");
          const files = Array.isArray(params.files) ? params.files.map((file: unknown) => resolve(cwd, String(file))) : [];
          const event = `这个话题是你从综合创建的，上面是交接说明。\n\n${note}`;

          try {
            if (topicId) {
              if (!groupHasBoundCwd && params.cwd !== undefined) return fail(CWD_IMMUTABLE);
              const target = store.group(topicId);
              if (!target || target.parentId !== gid) return fail(`「${topicId}」不是这个群的话题。这个群进行中的话题：${topicList()}`);
              // 已关闭的话题先重新打开，接着在里面处理
              const topic = target.closedAt ? runtime.groups.reopen(topicId) : target;
              runtime.groups.appendItem(topicId, "user", { kind: "user", text: note, ...(files.length ? { files } : {}), forwardedFrom: { assistantId } });
              runtime.groups.note(gid, assistantId, `转到了话题「${topic.name}」`, "info", undefined, topicId);
              void runtime.groups.deliverEvent(topicId, assistantId, event).catch((error) => console.error("转到话题的事件没送到：", error));
              return endTurn(`已转到话题「${topic.name}」（${topic.id}），接下来在话题里处理。`);
            }
            const topic = runtime.groups.createTopic(gid, title, assistantId, !groupHasBoundCwd && params.cwd !== undefined ? { cwd: params.cwd } : undefined);
            runtime.groups.appendItem(topic.id, "user", { kind: "user", text: note, ...(files.length ? { files } : {}), forwardedFrom: { assistantId } });
            void runtime.groups
              .deliverEvent(topic.id, assistantId, event)
              .catch((error) => console.error("创建话题的事件没送到：", error));
            return endTurn(t("话题「{name}」（{id}）已创建，交接说明已转过去，接下来在话题里处理。", { name: topic.name, id: topic.id }));
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      });
    }
  }

  tools.push(updateTodosTool(runtime, { assistantId, ...(groupId ? { groupId } : {}) }), findKnowledgeTool(runtime), searchKnowledgeTool(runtime, assistantId), ...searchTools(runtime.home, () => runtime.settings.settings.search, () => runtime.settings.settings.providers));
  return tools;
}

export type { Routine };
