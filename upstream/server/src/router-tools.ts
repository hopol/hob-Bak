import { t } from "../../shared/i18n.ts";
import { Type } from "@earendil-works/pi-ai";
import { propArtSchema } from "./prop-art-schema.ts";
import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { IMAGE_TYPES } from "../../shared/media.ts";
import { lookupFile, isInPagesDir } from "./files.ts";
import { resolveMovedPath } from "./layout.ts";
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
import { updateAssistant } from "./actions.ts";
import type { Approval, ApprovalQuestion, CustomProp, Job, Routine, RoutineCheck } from "../../shared/types.ts";
import { cronToChinese, timePointText } from "./cron-text.ts";
import { newId } from "./ids.ts";
import { findKnowledgeTool, searchKnowledgeTool } from "./knowledge-tools.ts";
import { generateImage, imageConfigured } from "./image.ts";
import { assistantInGroup, defaultWorkRef, jobModel, noteOf, thinkingLevelsOf, usableRefs } from "./models.ts";
import { overviewTool } from "./overview.ts";
import { pageTool } from "./pages.ts";
import { pushApproval } from "./push.ts";
import { searchTools } from "./search.ts";
import type { HobRuntime } from "./runtime.ts";
import { assistantSkillsDir, groupSkillsDir, listSkills, readAssistantSkillBody, saveSkill, moveSkill } from "./assistant-skills.ts";
import { generalSkillsDir, notEditable, skillDirOf, syncGeneralIndex, visibleSkills } from "./skills.ts";
import { jobView } from "./job-view.ts";
import { HANDOVER_EVENT, requestText } from "./groups.ts";
import { sessionOrigin } from "./origin.ts";
import { deleteSkill } from "./delete-skill.ts";
import { askOptions, cleanRecommended, unnumber } from "./worker-tools.ts";
import { handOffTodos, readTodos, sessionTodosPath, updateTodosTool } from "./todos.ts";

type Tool = ToolDefinition<any, any>;

/** 执行时间的参数说明：cron 表达式和具体时间都收。 */
const SCHEDULES_DESCRIPTION = "一个或多个；可以是 cron 表达式，也可以是具体时间（如 2026-11-08T09:00），到点只跑一次。";

/** once 的参数说明。 */
const ONCE_DESCRIPTION = "可选。为 true 时做成一次就停：没有检查脚本的，跑完一次就停；有检查脚本的，第一次有输出就停。停了的定时任务还在，可以再打开。";

/** 检查脚本参数：create_routine 和 update_routine 共用。 */
const CHECK_DESCRIPTION = "可选。到点先跑的 bash 脚本，填脚本全文：没有输出就这次什么都不做；有输出时，then 为 notify 就把输出作为提醒发到对话，为 job 就带着输出开始任务。脚本在这个定时任务自己的目录里运行，状态文件存在当前目录，记住上次看到哪里；第一次跑还没有状态时只记下现状，不输出。非零退出算检查失败。脚本用到的其他文件也放在这个目录，跟着定时任务走。";

const checkDescription = (group: boolean) => group ? CHECK_DESCRIPTION.replace("then 为 notify 就把输出作为提醒发到对话，为 job 就带着输出开始任务", "then 为 notify 就把输出作为提醒发到群里，为 job 就带着输出交给群主处理") : CHECK_DESCRIPTION;
const checkParam = (group: boolean) => Type.Object({
  script: Type.String({ description: "bash 脚本全文" }),
  then: Type.Union([Type.Literal("notify"), Type.Literal("job")], { description: group ? "有输出时：notify 把输出作为提醒发到群里，job 交给群主处理" : "有输出时：notify 把输出作为提醒发到对话，job 带着输出开始任务" }),
}, { description: checkDescription(group) });

/** edit_skill / save_job_as_skill 的 general 参数：换给谁用 / 新建在哪。 */
const generalParam = (group: boolean) => Type.Optional(Type.Boolean({
  description: group ? "可选，换这份技能给谁用：true 换成通用的，所有助手都能用；false 收回来，归本群。" : "可选，换这份技能给谁用：true 换成通用的，所有助手都能用；false 收回来，归你。",
}));
const intoGeneralParam = (group: boolean) => Type.Optional(Type.Boolean({
  description: group ? "可选，填 true 新建成通用技能，所有助手都能用；不填，新建的归本群。填了 into 就是改那份，不看这一项。" : "可选，填 true 新建成通用技能，所有助手都能用；不填，新建的归你。填了 into 就是改那份，不看这一项。",
}));

/** ask_user 的 questions 参数说明：照抄 .scratch/v2/design-projects.md 第五节，一字不改。 */
const QUESTIONS_DESCRIPTION =
  "可选，一次问几个问题时用，每个写 `title`（问题）、`why`（为什么要定它）、`options`（2 到 3 个选项）、`recommended`（推荐哪个选项）。用户答完，答案一起回来。";


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
      const why = typeof item?.why === "string" ? item.why.trim() : "";
      questions.push({ title, ...(why ? { why } : {}), options, ...(hit ? { recommended: hit.key } : {}) });
    }
    return { ...base, options: [], questions };
  }
  const labels: { label: string }[] = Array.isArray(params.options) ? params.options : [];
  if (labels.length < 2 || labels.length > 3) return { error: "选项要 2 到 3 个。" };
  if (remember && labels.length > 2) return { error: "带 remember 时最多给 2 个选项。" };
  const { options, recommended } = askOptions(labels.map((option) => String(option?.label ?? "")));
  if (remember) options.push({ key: "C", label: `以后「${remember}」直接做`, always: true });
  return { ...base, options, ...(recommended ? { recommended } : {}), ...(remember ? { ruleText: remember } : {}) };
}

/** 工具返回里说的「每 10 分钟」这类：具体时间只说那一刻，有检查脚本的说明有新内容会怎样，开了 once 的说明会停。 */
function routineFact(schedules: string[], check: RoutineCheck | undefined, once: boolean | undefined): string {
  const points = schedules.map((schedule) => timePointText(schedule));
  const labels = schedules.map((schedule, index) => points[index] ?? cronToChinese(schedule));
  const facts: string[] = [];
  if (points.every(Boolean)) facts.push(`${labels.join("、")}跑一次`);
  if (check) facts.push(`${labels.join("、")}检查一次${check.then === "notify" ? "，有新内容就提醒你" : "，有新内容就开任务"}`);
  if (once) facts.push("触发一次就停");
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

/** 开任务、转交时备注的上限。线上被拒的备注九成五在 400 字以内（多是 200 到 400），再长的基本是在重抄原话。 */
const NOTE_LIMIT = 400;

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
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
export function buildRouterTools(runtime: HobRuntime, assistantId: string, groupId?: string): Tool[] {
  const { store, bus, router, jobs, routines } = runtime;
  const assistant = () => {
    const found = store.assistant(assistantId);
    if (!found) throw new Error(`助手不存在：${assistantId}`);
    return found;
  };
  const note = (icon: "memory" | "rule" | "routine" | "split" | "info" | "skill", text: string) =>
    router.addItem(assistantId, { kind: "note", icon, text }, groupId);
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

  // 检查脚本试跑的结果写成事实交给模型：脚本写错了，现在就能改，不用等到点才失败
  const trialFact = async (routine: Routine): Promise<string> => {
    if (!routine.check) return "";
    const result = await routines.trial(routine);
    if (result.outcome === "failed") return `\n检查脚本试跑失败：${result.reason}。到点也会这样失败。脚本按 bash 执行，用别的语言写的，要在脚本里调用解释器，比如 python3 - <<'EOF' … EOF；要用的文件还没写好的，写好后再用 update_routine 改一次脚本，会再试跑。`;
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

  /** 换范围后的提示行：和删技能的提示行同一种样子。 */
  const moveNote = (name: string, title: string, to: "general" | "group" | "assistant", ownerId: string): string => {
    const whose = whoseSkill(to === "general" ? generalSkillsDir(runtime.home) : to === "group" ? groupSkillsDir(runtime.home, groupIdId()) : assistantSkillsDir(runtime.home, ownerId), ownerId);
    if (to === "general") return t("已把{whose}技能「{title}」换成通用的", { whose, title });
    if (to === "group") return t("已把{whose}技能「{title}」收回本群", { whose, title });
    return ownerId !== assistantId ? t("已把{whose}技能「{title}」收回给「{name}」", { whose, title, name: nameOf(ownerId) }) : t("已把{whose}技能「{title}」收回来", { whose, title });
  };
  const groupIdId = () => {
    const group = groupId ? store.group(groupId) : undefined;
    return group ? group.parentId ?? group.id : "";
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
    const found = lookupFile(runtime.home, path, store.jobs().flatMap((job) => job.cwd ? [job.cwd] : []));
    if (!found.ok) throw new Error(found.error);
    return found.info.path;
  };
  const read = createReadToolDefinition(runtime.home, { operations: {
    access: async (path) => { checkFile(path); },
    readFile: async (path) => readFile(checkFile(path)),
    detectImageMimeType: async (path) => IMAGE_TYPES[extname(checkFile(path)).toLowerCase()],
  } }) as unknown as Tool;
  delete (read as { promptSnippet?: unknown }).promptSnippet; // 用了自定义系统提示词，引擎自带的这段不进提示词
  const tools: Tool[] = [
    {
      name: "check_job",
      label: "看任务",
      description: "看一个任务现在的状态和过程：做到哪一步、跑过哪些命令、说过什么、用了哪个技能、在等什么。",
      parameters: Type.Object({ jobId: Type.String({ description: "任务 id" }) }),
      execute: async (_id, params: { jobId: string }) => {
        const job = store.job(params.jobId);
        if (!job || !canManageJob(params.jobId)) return fail(`没有这个任务：${params.jobId}`);
        try {
          return ok(jobView({ ...job, cwd: job.cwd ?? store.workDir(job.id) }, jobs.transcript(job.id), store.approvals(), visibleSkills(runtime, job.assistantId, job.groupId ? store.group(job.groupId) : undefined), runtime.settings.settings.general.timezone, undefined, jobOrigin(job)));
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: "edit_skill",
      label: "改技能",
      description: `改一个技能的正文（SKILL.md）：把一段原文换成新的文字，旧版会保留。脚本要改的，交给任务改。也能换它给谁用。${groupId ? "在群里按名字先找本群的技能，再找你自己的。" : ""}`,
      parameters: Type.Object({
        name: Type.String({ description: "技能名" }),
        edits: Type.Optional(Type.Array(Type.Object({ old: Type.String(), new: Type.String() }), { description: "一处或几处修改：old 是正文里的原文，要一字不差、只出现一次；new 是换成的文字；只换给谁用时不填" })),
        general: generalParam(!!groupId),
        ...(assistant().primary && !groupId ? { assistantId: Type.Optional(Type.String({ description: "可选，改哪个助手的；不填是你自己的" })) } : {}),
      }),
      execute: async (_id, params: { name: string; edits?: { old: string; new: string }[]; general?: boolean; assistantId?: string }) => {
        const target = targetOf(params.assistantId);
        if ("error" in target) return fail(target.error);
        try {
          const found = findSkill(target.id, params.name);
          if (found.problem || !found.skill || !found.dir) return fail(found.problem!);
          const edits = Array.isArray(params.edits) ? params.edits : [];
          if (!edits.length && typeof params.general !== "boolean") return fail("edits 和 general 至少填一样：改正文填 edits，换给谁用填 general。");
          let saved: { name: string; title?: string; version?: number } = found.skill;
          if (edits.length) {
            let body = readAssistantSkillBody(found.skill.path);
            for (const edit of edits) {
              if (!edit.old) return fail("原文不能为空");
              const count = body.split(edit.old).length - 1;
              if (!count) return fail(`正文里找不到这段原文：${[...edit.old].slice(0, 30).join("")}`);
              if (count > 1) return fail(`这段原文出现了 ${count} 次，多带几个字`);
              body = body.replace(edit.old, () => edit.new);
            }
            saved = saveSkill(found.dir, { name: found.skill.name, title: found.skill.title ?? found.skill.name, description: found.skill.description, content: body });
          }
          if (typeof params.general === "boolean") {
            const group = groupId ? store.group(groupId) : undefined;
            const to = params.general ? "general" : group ? "group" : "assistant";
            const toDir = params.general ? generalSkillsDir(runtime.home) : group ? groupSkillsDir(runtime.home, group.parentId ?? group.id) : assistantSkillsDir(runtime.home, target.id);
            if (toDir !== found.dir) {
              // 通用目录里可能有还没登记的技能：先把索引补齐，换范围时不能把它们丢了
              if (params.general) syncGeneralIndex(toDir);
              const conflict = params.general ? t("通用技能里已经有叫 {name} 的技能", { name: found.skill.name }) : group ? t("本群的技能里已经有叫 {name} 的技能", { name: found.skill.name }) : t("你的技能里已经有叫 {name} 的技能", { name: found.skill.name });
              moveSkill(found.dir, toDir, found.skill.name, conflict);
            }
            await note("skill", moveNote(params.name, saved.title ?? found.skill.name, to, target.id));
          }
          bus.emit({ type: "skills", assistantId: target.id });
          return ok(edits.length ? `已更新技能「${saved.title ?? saved.name}」，第 ${saved.version} 版。` : "已换好。");
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: "delete_skill",
      label: "删除技能",
      description: `删除一个技能。技能会移到归档，不会彻底删掉。${groupId ? "在群里按名字先找本群的技能，再找你自己的。" : ""}`,
      parameters: Type.Object({
        name: Type.String({ description: "技能名。" }),
        replaced_by: Type.Optional(Type.String({ description: "可选，被哪个技能接替，填技能名。用到它的定时任务会改用接替的技能。" })),
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
      name: "save_job_as_skill",
      label: "沉淀技能",
      description: `让一个已完成的任务把它的做法写成技能。它在自己的会话里写，能把脚本和命令真跑一遍验证；进度和结果显示在任务卡片上。${groupId ? "群里的任务新沉淀的技能归这个群；into 填哪份就改哪份。" : ""}`,
      parameters: Type.Object({ jobId: Type.String(), into: Type.Optional(Type.String({ description: "可选，在哪个已有技能的基础上改，填技能名；不填就新建。" })), general: intoGeneralParam(!!groupId), note: Type.Optional(Type.String({ description: "可选，要交代给任务的话，比如用户的反馈和纠正、要一起并进来的技能。" })) }),
      execute: async (_id, params: { jobId: string; into?: string; general?: boolean; note?: string }) => {
        const job = store.job(params.jobId);
        // 群里的任务大家可以接手：派给别的成员做的，结果回到派任务的人，沉淀也由它发起
        if (!job || (job.assistantId !== assistantId && !(groupId && canManageJob(params.jobId)))) return fail("任务不存在");
        try { jobs.startSediment(job.id, { into: params.into || undefined, note: params.note || undefined, general: params.general === true }); return ok("已开始沉淀，进度显示在任务卡片上。"); }
        catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      ...read,
      description: "读文件或看图片：用户发来的附件、任务的目录和产出、页面。长文件用 offset 分段读。",
      execute: async (id, args: { path: string; offset?: number; limit?: number }, signal, update, ctx) => {
        try {
          const path = checkFile(resolve(runtime.home, args.path));
          if (IMAGE_TYPES[extname(path).toLowerCase()]) {
            if (ctx?.model && !ctx.model.input.includes("image")) return fail("当前对话模型看不了图片");
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
      description: "把事情交给后台任务去做。用户这次的原话、引用、附件和最近几条对话会自动带给任务，note 只补原话里看不出的背景。",
      parameters: Type.Object({
        title: Type.String({ description: "任务标题，短，如「查磁盘占用」" }),
        note: Type.Optional(Type.String({ description: `任务从原话里看不出、又需要知道的背景，最多 ${NOTE_LIMIT} 字。` })),
        cwd: Type.Optional(
          Type.String({
            description:
              "可选。填了，任务的命令默认就在这个目录里跑，改动直接落在这里，适合直接改一个现成的项目。不填，任务在自己的目录里做；只是读某个项目，或者要另拉一份隔离着做，不用填。",
          }),
        ),
        files: Type.Optional(
          Type.Array(Type.String(), {
            description: "要交给任务的文件路径（用户发来的附件）；图片会直接给模型看",
          }),
        ),
        ...(groupId ? { assistantId: Type.Optional(Type.String({ description: "谁来做：群里一位成员的 id，任务以它的身份跑，用它的技能和记忆。不填就是你自己。" })) } : {}),
        after: Type.Optional(Type.Array(Type.String(), { description: "可选。要等这些任务做完才开始，填任务 id。前置任务没做成（受阻、失败、被停），这个任务就不开始，会告诉你。" })),
        expect_minutes: Type.Optional(Type.Number({ description: "可选，预计多少分钟能交结果。超过了会通知你；不填按 10 分钟。" })),
        model: Type.Optional(Type.String({ description: `可选，不填用默认。聪明、成本、速度 0–100，越高越聪明、越贵、越快：\n${modelText}` })),
        ...(modelSettings.thinkingChoice === "fixed" ? {} : {
          thinking: Type.Optional(Type.String({ description: "可选：思考档以可分派模型列表里每个模型标的为准。不填用模型的默认思考档。" })),
        }),
      }),
      execute: async (_id, params: any) => {
        try {
          if (params.expect_minutes != null && (!Number.isInteger(params.expect_minutes) || params.expect_minutes < 1 || params.expect_minutes > 10080)) return fail("expect_minutes 要在 1 到 10080 之间");
          const note = params.note == null ? "" : String(params.note);
          if ([...note].length > NOTE_LIMIT) return fail(`备注 ${[...note].length} 字，最多 ${NOTE_LIMIT} 字。用户原话和最近的对话会自动带上，备注只写从原话里看不出的背景，改短后再调用一次。`);
          // 群里可以指名成员：任务以它的身份跑（提示词、技能、记忆、默认模型都算它的），结果回到这个会话
          const assignee = assigneeOf(groupId ? params.assistantId : undefined);
          if ("error" in assignee) return fail(assignee.error);
          // 模型可能照着旧对话多填 skills：任务现在带上它能用的全部技能，多填的不报错、不起作用
          const original = router.originalWords(assistantId, note, true, Array.isArray(params.files) ? params.files.map(String) : [], groupId);
          const job = await jobs.start(assignee.id, {
            title: String(params.title),
            ...(groupId ? { groupId } : {}),
            ...(assignee.id === assistantId ? {} : { startedBy: assistantId }),
            ...(params.expect_minutes != null ? { expectMinutes: params.expect_minutes } : {}),
            instruction: original.text,
            ...(Array.isArray(params.after) && params.after.length ? { after: params.after.map(String) } : {}),
            ...(params.cwd ? { cwd: String(params.cwd) } : {}),
            ...(original.files.length ? { files: original.files } : {}),
            ...(params.model ? { model: String(params.model) } : {}),
            ...(params.thinking ? { thinking: String(params.thinking) } : {}),
            ...(router.currentDelegation(assistantId, groupId) ? { delegationId: router.currentDelegation(assistantId, groupId) } : {}),
          });
          if (job.status === "failed") return fail(`任务启动失败：${job.statusReason ?? "原因不明"}`);
          if (assignee.id !== assistantId) return endTurn(`已派给「${nameOf(assignee.id)}」：${job.title}（${job.id}）。结果会回到这里。`);
          if (job.after?.length) {
            const titles = job.after.map((id) => `「${store.job(id)?.title ?? id}」`).join("、");
            return endTurn(`任务「${job.title}」（${job.id}）已排上，等${titles}做完就开始。`);
          }
          return endTurn(
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
      description: "把话交给一个已有的任务：补充、纠正、追问，或者回答它的提问。它带着原来的上下文和目录接着做，已经结束的任务也能接着做。",
      parameters: Type.Object({
        jobId: Type.String({ description: "任务 id" }),
        text: Type.String({ description: "要补充的话" }),
      }),
      execute: async (_id, params: any) => {
        try {
          const jobId = String(params.jobId);
          if (!canManageJob(jobId)) return fail(`没有这个任务：${jobId}`);
          await jobs.reply(jobId, String(params.text), "router");
          const job = store.job(jobId)!;
          const origin = jobOrigin(job);
          return ok(`已交给任务「${job.title}」（${jobId}），它会接着做。${origin ? `这个任务是${origin}开的，结果回到那边。` : ""}`);
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
          await jobs.stop(jobId, origin ? `${assistant().name}在${sessionOrigin(store, groupId, job.groupId)}叫停了` : `${assistant().name}叫停了`);
          return ok(origin ? `已停止。这个任务是${origin}开的。` : "已停止。");
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "ask_user",
      label: "询问用户",
      description: "在对话里出一张选择题卡片（2 到 3 个选项），用户选完，答案会回到对话。",
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
            options: Type.Array(
              Type.Object({ label: Type.String({ description: "选项文字" }) }),
              { description: "2 到 3 个选项", minItems: 2, maxItems: 3 },
            ),
            recommended: Type.Optional(Type.String({ description: "可选，推荐哪个选项，填选项的文字" })),
          }),
          { description: QUESTIONS_DESCRIPTION, minItems: 1, maxItems: 8 },
        )),
        remember: Type.Optional(Type.String({ description: "这类事以后可以不再问时，填这类事的简称（如「清理临时文件」）；卡片上会多一个「以后直接做」的选项。" })),
      }),
      execute: async (_id, params: any) => {
        const approval = approvalFromParams(assistantId, groupId, params);
        if ("error" in approval) return fail(approval.error);
        store.saveApproval(approval);
        // 话题里挂了待答的提问卡：左栏和话题卡上的「等你」跟着变
        if (groupId) runtime.groups.publish(groupId);
        const delegationId = router.currentDelegation(assistantId, groupId);
        if (delegationId) runtime.delegations.addApproval(delegationId, approval.id);
        await router.addItem(assistantId, { kind: "question", approvalId: approval.id }, groupId);
        bus.emit({ type: "approval", approval });
        pushApproval({ push: runtime.push, store }, approval);
        return endTurn("问题卡已显示给用户。");
      },
    },
    {
      name: "set_rule",
      label: "记录规则",
      description: `记下用户对某类事的处理方式：ask 是做之前先问，allow 是直接做。${groupId ? "在群里记的，只在这个群生效。" : ""}`,
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
      description: `新增一个定时任务。执行时间用 cron 表达式，如「0 9 * * *」每天 9 点；只跑一次就填具体时间；多个执行时间就传多个。${groupId ? "在群里建的归这个群，到点交给群主在这里处理。" : ""}`,
      parameters: Type.Object({
        name: Type.String({ description: "定时任务名称，如「每日简报」" }),
        instruction: Type.String({ description: "到点要执行的内容" }),
        schedules: Type.Array(Type.String({ description: "cron 表达式或具体时间" }), { description: SCHEDULES_DESCRIPTION }),
        skill: Type.Optional(Type.String({ description: "可选，按哪个技能做，填技能名。" })),
        check: Type.Optional(checkParam(!!groupId)),
        once: Type.Optional(Type.Boolean({ description: ONCE_DESCRIPTION })),
        ...(assistant().primary && !groupId ? { assistantId: Type.Optional(Type.String({ description: "可选，改哪个助手的；不填是你自己的" })) } : {}),
      }),
      execute: async (_id, params: any) => {
        const target = targetOf(groupId ? undefined : params.assistantId);
        if ("error" in target) return fail(target.error);
        try {
          const words = router.userWords(assistantId, groupId);
          const routine = routines.create({
            assistantId: target.id,
            ...(groupId ? { groupId } : {}),
            name: String(params.name),
            instruction: String(params.instruction),
            instructionBy: assistantId,
            ...(words ? { userWords: [words] } : {}),
            schedules: (params.schedules as string[]) ?? [],
            ...(params.skill ? { skill: String(params.skill) } : {}),
            ...(params.check ? { check: params.check as RoutineCheck } : {}),
            ...(params.once ? { once: true } : {}),
          });
          await note("routine", t("新增{whose}定时任务 · {name} · {schedules}", { whose: whoseRoutine(target.id), name: routine.name, schedules: routine.schedules.map((schedule) => cronToChinese(schedule)).join("、") }));
          profileChanged(target.id);
          return ok(`定时任务「${routine.name}」已创建${routineFact(routine.schedules, routine.check, routine.once)}。它的目录是 ${routines.dir(routine)}，检查脚本在这里运行；脚本要用的其他文件，可以派任务写到这个目录。${await trialFact(routine)}`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "update_routine",
      label: "修改定时任务",
      description: "修改一个定时任务：名称、内容、执行时间（schedules 会整体替换）、按哪个技能做、检查脚本、启用状态。",
      parameters: Type.Object({
        routineId: Type.String(),
        name: Type.Optional(Type.String()),
        instruction: Type.Optional(Type.String()),
        schedules: Type.Optional(Type.Array(Type.String({ description: "cron 表达式或具体时间" }), { description: SCHEDULES_DESCRIPTION })),
        active: Type.Optional(Type.Boolean()),
        skill: Type.Optional(Type.String({ description: "按哪个技能做，填技能名；填空字符串表示不用技能。" })),
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
          const words = router.userWords(assistantId, groupId);
          const instruction = params.instruction ? String(params.instruction) : undefined;
          const routine = routines.update(String(params.routineId), {
            ...(params.name ? { name: String(params.name) } : {}),
            ...(instruction ? { instruction } : {}),
            // 改了内容：这份是当前助手写的，到点时要把原话和它的转述分开给
            ...(instruction && instruction !== found.instruction ? { instructionBy: assistantId } : {}),
            // 只改时间、技能、启停也是用户在交代，这一轮的话照记
            ...(words ? { userWords: [words] } : {}),
            ...(params.schedules ? { schedules: params.schedules as string[] } : {}),
            ...(typeof params.active === "boolean" ? { active: params.active } : {}),
            ...(typeof params.skill === "string" ? { skill: params.skill } : {}),
            ...(params.check === null || params.check ? { check: params.check as RoutineCheck | null } : {}),
            ...(typeof params.once === "boolean" ? { once: params.once } : {}),
          });
          await note("routine", t("修改{whose}定时任务 · {name} · {schedules}", { whose: whoseRoutine(target.id), name: routine.name, schedules: routine.schedules.map((schedule) => cronToChinese(schedule)).join("、") }));
          profileChanged(target.id);
          return ok(`已修改${routineFact(routine.schedules, routine.check, routine.once)}。目录是 ${routines.dir(routine)}。${params.check ? await trialFact(routine) : ""}`);
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
      parameters: Type.Object({ path: Type.String({ description: "文件的绝对路径" }) }),
      execute: async (_id, params: any) => {
        const requested = String(params.path);
        // 迁移后的老路径直接换到新位置（不给模型提示），卡片里存新路径
        const path = existsSync(requested) ? requested : resolveMovedPath(runtime.home, requested);
        if (!existsSync(path)) return fail(`文件不存在：${requested}`);
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
      label: "换头像",
      description: "给自己换头像：换内置道具、换颜色，或用 prop_art 自画一件像素道具。主助手还可以传 assistant 给其他助手换。",
      parameters: Type.Object({
        sprite: Type.String({
          description: `内置道具 id 之一（${PROP_IDS.filter((id) => id !== "hob").join(" ")}），或 custom（自画的，同时填 prop_art；已画过时不填 prop_art 就是换回那件）`,
        }),
        color: Type.Optional(
          Type.String({ description: `可选：火苗颜色，${COLOR_IDS.join(" ")} 之一；不填用道具的默认色` }),
        ),
        prop_art: propArtSchema,
        assistant: Type.Optional(Type.String({ description: "仅主助手：要换头像的助手 id；不填是自己" })),
      }),
      execute: async (_id, params: any) => {
        const target = store.assistant(String(params.assistant ?? assistantId));
        if (!target) return fail(`没有这个助手：${params.assistant}`);
        if (target.id !== assistantId && !assistant().primary) return fail("只有主助手能给其他助手换头像。");
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
        await note("info", t("已换头像 · {assistant} · {description}", { assistant: target.name, description: desc }));
        return ok(`已换头像。`);
      },
    },
  ];

  if (assistant().abilities?.image !== false && imageConfigured(runtime.settings.settings.image)) {
    tools.push({
      name: "generate_image",
      label: "生成图片",
      description: "按文字生成或修改图片，直接显示在对话里：生成时有进度卡片，画好自动显示。返回的路径可以作为之后改图的参考图。",
      parameters: Type.Object({
        prompt: Type.String({ description: "要画什么，越具体越好" }),
        size: Type.Optional(Type.String({ description: "尺寸，如 1024x1024；不填用设置里的默认" })),
        refs: Type.Optional(Type.Array(Type.String(), { description: "参考图的绝对路径（改图、按图生成的时候给）" })),
      }),
      execute: async (_id, params: any) => {
        const config = runtime.settings.settings.image;
        const prompt = String(params.prompt ?? "");
        const size = params.size ? String(params.size) : config.source === "openai" ? config.size : undefined;
        const item = await router.addItem(assistantId, { kind: "image", status: "pending", prompt, ...(size ? { size } : {}), startedAt: new Date().toISOString() }, groupId);
        try {
          const path = await generateImage({ home: runtime.home, dir: join(runtime.home, "assistants", assistantId, "files", "images"), config }, {
            prompt,
            ...(params.size ? { size: String(params.size) } : {}),
            ...(Array.isArray(params.refs) && params.refs.length ? { refs: params.refs.map(String) } : {}),
          });
          await router.updateImage(assistantId, item.id, { status: "done", path }, groupId);
          return ok(`图片已经显示在对话里。路径：${path}，之后改图可以作为参考图。`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await router.updateImage(assistantId, item.id, { status: "failed", error: message }, groupId);
          return fail(message);
        }
      },
    });
  }

  if (runtime.settings.settings.general.showPage !== false) tools.push(pageTool(runtime, assistantId));

  if (assistant().primary) {
    tools.push(
      overviewTool(runtime),
      ...buildAdminTools(runtime, assistantId, groupId),
      {
        name: "message_assistant",
        label: "转交其他助手",
        description: "把一件事转给另一个助手（见「助手」一节），由它负责到底。用户的原话和附件会自动转过去，对方的回复和结果会回到这里。",
        parameters: Type.Object({
          assistantId: Type.String({ description: "目标助手 id" }),
          note: Type.Optional(Type.String({ description: `可选，对方需要知道的背景，最多 ${NOTE_LIMIT} 字。` })),
        }),
        execute: async (_id, params: any) => {
          const targetId = String(params.assistantId);
          const target = store.assistant(targetId);
          if (!target) return fail(`没有这个助手：${targetId}`);
          if (targetId === assistantId) return fail("不能转交给自己。");
          try {
            const note = params.note == null ? "" : String(params.note);
            if ([...note].length > NOTE_LIMIT) return fail(`备注 ${[...note].length} 字，最多 ${NOTE_LIMIT} 字。用户原话和最近的对话会自动带上，备注只写从原话里看不出的背景，改短后再调用一次。`);
            const original = router.originalWords(assistantId, note, true);
            // 手上这份还没做完的项一起交过去：它们写在转交内容里，接手的助手自己决定要不要照这几项列
            const unfinished = readTodos(sessionTodosPath(runtime.home, assistantId, groupId)).filter((item) => item.status !== "done");
            const carried = unfinished.length ? `${original.text}\n\n「${assistant().name}」转交前列过的待办，没做完的：\n${unfinished.map((item) => `· ${item.text}`).join("\n")}` : original.text;
            await runtime.delegations.start(targetId, carried, original.files);
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
        description: "把一件事交给一个群办：在群里开一个话题，把用户的原话、前面几句对话和你的备注转进去，由群主接手。群主关话题时写的结论会回到这里。",
        parameters: Type.Object({
          groupId: Type.String({ description: "群 id（见「群」一节）。" }),
          title: Type.String({ description: "话题名，写这件事，如「相册备份出错」，最多 40 字。" }),
          note: Type.Optional(Type.String({ description: `可选，群里需要知道、原话里看不出的背景，最多 ${NOTE_LIMIT} 字。` })),
        }),
        execute: async (_id, params: any) => {
          const id = String(params.groupId ?? "").trim();
          const group = store.group(id);
          if (!group) {
            const all = store.groups().filter((item) => !item.parentId).map((item) => `${item.name}（${item.id}）`);
            return fail(`没有这个群：${id}。现有的群：${all.length ? all.join("、") : "还没有"}`);
          }
          if (group.parentId) return fail(`${id} 是话题，不是群：groupId 填群 id，会在群里开一个新话题。`);
          if (groupId && sameGroup(groupId, group.id)) return fail(`你就在群「${group.name}」里，不用交给它。`);
          const title = typeof params.title === "string" ? params.title.trim() : "";
          if (!title) return fail("title 不能为空：写这件事，如「相册备份出错」。");
          if ([...title].length > 40) return fail(`title 最多 40 字，现在 ${[...title].length} 字：写成一句话，如「相册备份出错」。`);
          const note = params.note == null ? "" : String(params.note);
          if ([...note].length > NOTE_LIMIT) return fail(`备注 ${[...note].length} 字，最多 ${NOTE_LIMIT} 字。用户原话和最近的对话会自动带上，备注只写从原话里看不出的背景，改短后再调用一次。`);
          try {
            // 原话取这次调用所在会话的（单聊或群），不是要交给的那个群的：主助手是目标群的成员时不能拿那边的综合当原话
            const original = router.originalWords(assistantId, note, true, [], groupId);
            const { topic, item } = runtime.groups.handOver(group.id, title, assistantId, original);
            // 这次说话所在的对话里落一张话题卡：进度、等你回答、结论都在卡上
            await router.addItem(assistantId, { kind: "topic", topicId: topic.id }, groupId);
            void runtime.groups.deliverEvent(topic.id, topic.ownerId, HANDOVER_EVENT, item.id).catch((error) => console.error("交给群的事件没送到：", error));
            return endTurn(`已交给群「${group.name}」：开了话题「${topic.name}」（${topic.id}），群主「${nameOf(topic.ownerId)}」接手。有了结论会回到这里。`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  } else {
    tools.push({
      name: "hand_back_to_hob",
      label: "交回 Hob",
      description: "把不归你管的事交回 Hob，由它转给合适的助手。",
      parameters: Type.Object({ text: Type.String({ description: "用户要什么" }), reason: Type.String({ description: "为什么不归你，一句话" }) }),
      execute: async (_id, params: any) => {
        const text = String(params.text ?? "").trim();
        const reason = String(params.reason ?? "").trim();
        if (!text || !reason) return fail("请写清用户要求和交回原因。");
        try {
          const delegationId = router.currentDelegation(assistantId, groupId);
          if (delegationId) {
            runtime.delegations.returnToHob(delegationId, text, reason);
          } else {
            await router.ensure("hob");
            const handbackId = newId("hb-");
            await router.addItem(assistantId, { kind: "note", icon: "info", text: `已交回 Hob：${reason}`, handbackId });
            await router.addForwarded("hob", text, handbackId, assistantId);
            await router.event("hob", `转自「${assistant().name}」：${text}\n交回原因：${reason}`);
          }
          return endTurn("已交回 Hob。");
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    /**
     * 自己的补充说明自己改：用户当面纠正了一条记在里面的事，不用去找主助手。
     * 群主还多一项：改本群的（话题里改的是所属群的）。
     */
    {
      name: "edit_notes",
      label: "改补充说明",
      description: "改你自己的补充说明：把一段原文换成新的文字。补充说明记的是一直成立、你做事要知道的事实：它每轮都在你的提示词里，你派出去的任务也带着它，写进来的会一直被拿去用。",
      parameters: Type.Object({
        edits: Type.Array(
          Type.Object({ old: Type.String(), new: Type.String() }),
          { description: "一处或几处修改：old 是补充说明里的原文，要一字不差、只出现一次；new 是换成的文字；old 填空字符串表示把 new 接在最后" },
        ),
        ...(groupId && store.group(groupId)?.ownerId === assistantId
          ? { group: Type.Optional(Type.Boolean({ description: "填 true 改本群的补充说明，不填改你自己的。" })) }
          : {}),
      }),
      execute: async (_id, params: { edits?: { old?: string; new?: string }[]; group?: boolean }) => {
        const edits = Array.isArray(params.edits) ? params.edits : [];
        if (!edits.length) return fail("edits 不能为空：要改哪一段，就填它的原文和换成的文字。");
        // 群和话题只在群里能改，改的是所属的那个群（话题没有自己的补充说明）
        const live = groupId ? store.group(groupId) : undefined;
        const toGroup = params.group === true;
        if (toGroup && !live) return fail("group 只在群里用：要改自己的补充说明，不填这一项。");
        if (toGroup && live!.ownerId !== assistantId) return fail("只有群主能改本群的补充说明。");
        const gid = live ? live.parentId ?? live.id : "";
        const current = toGroup ? store.group(gid)?.instructions ?? "" : assistant().instructions;
        let text = current;
        for (const edit of edits) {
          const old = typeof edit?.old === "string" ? edit.old : "";
          const next = typeof edit?.new === "string" ? edit.new : "";
          if (!old) {
            text = text.trim() ? `${text.trimEnd()}\n${next}` : next;
            continue;
          }
          const count = text.split(old).length - 1;
          if (!count) return fail(`原文没找到：${old}。现在的补充说明是：${text.trim() || "（空）"}`);
          if (count > 1) return fail(`这段原文出现了 ${count} 次，多带几个字让它只出现一次。`);
          text = text.replace(old, () => next);
        }
        try {
          if (toGroup) {
            runtime.groups.update(gid, { instructions: text });
          } else {
            // 和界面上改档案走同一套：校验、推送、档案页实时更新都在里面
            const result = await updateAssistant(runtime, assistantId, { instructions: text });
            if (result.status !== 200) return fail((result.body as { error?: string }).error ?? "没有改成补充说明。");
          }
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
        await note("info", toGroup ? t("修改了本群的补充说明") : t("修改了自己的补充说明"));
        // 改完的全文给回去：追加时把原文又抄了一遍这类错，模型看得出来
        return ok(`已改好补充说明。现在是：\n${text.trim() || "（空）"}`);
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
      if (group.ownerId !== assistantId) return "只有群主能开话题和关闭话题。";
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
      description: "关闭话题：这件事办完了，或者用户不要了。",
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
          return ok(`话题「${closed.name}」已关闭。`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    });
    if (!ownerGroup.parentId) {
      tools.push({
        name: "open_topic",
        label: "开话题",
        description: "开一个话题，把触发这一轮的消息（用户的话，或者定时任务到点的那条）转进去，到话题里接着办。topic 填已有话题的 id，就转到那个话题（关了的会重新打开）。",
        parameters: Type.Object({
          title: Type.Optional(Type.String({ description: "新话题的名字，写这件事，如「相册备份出错」。转到已有话题时不填。" })),
          topic: Type.Optional(Type.String({ description: "已有话题的 id。开新话题时不填。" })),
          note: Type.Optional(Type.String({ description: "话题里看不到、你已经知道的背景，比如前面查到的情况。会和用户的原话一起交给话题里的你。" })),
        }),
        execute: async (_id, params: any) => {
          const problem = notOwner();
          if (problem) return fail(problem);
          const title = typeof params.title === "string" ? params.title.trim() : "";
          const topicId = typeof params.topic === "string" ? params.topic.trim() : "";
          const note = typeof params.note === "string" ? params.note.trim() : "";
          if (!title && !topicId) return fail("title 和 topic 要填一个：开新话题填 title，转到已有话题填 topic。");
          if (title && topicId) return fail("title 和 topic 只能填一个：开新话题填 title，转到已有话题填 topic。");
          if (title && [...title].length > 40) return fail(`title 最多 40 字，现在 ${[...title].length} 字：写成一句话，如「相册备份出错」。`);
          const user = runtime.groups.requestItem(gid, assistantId);
          if (!user) return fail("综合里还没有用户的消息，没有可以转过去的话：直接在这里办，或者等用户说话以后再开话题。");
          // 来由和综合里前面几句对话：取法和派任务带的一样（定时来由不带前面几句）
          const original = router.originalWords(assistantId, note || undefined, true, [], gid);
          const routine = user.kind === "note";
          const reason = routine ? "上面是定时任务到点的记录。" : "上面是用户在综合里的原话。";
          const event = `这个话题是你从综合开的，${reason}\n\n${original.text}`;
          try {
            if (topicId) {
              const target = store.group(topicId);
              if (!target || target.parentId !== gid) return fail(`「${topicId}」不是这个群的话题。这个群进行中的话题：${topicList()}`);
              // 关了的话题先重新打开，接着在里面办
              const topic = target.closedAt ? runtime.groups.reopen(topicId) : target;
              runtime.groups.forwardUserItem(gid, topicId, user);
              runtime.groups.note(gid, assistantId, `转到了话题「${topic.name}」`, "info");
              void runtime.groups.deliverEvent(topicId, assistantId, `${reason}\n\n${original.text}`).catch((error) => console.error("转到话题的事件没送到：", error));
              return endTurn(`已转到话题「${topic.name}」（${topic.id}），接下来在话题里办。`);
            }
            const topic = runtime.groups.createTopic(gid, title, assistantId);
            runtime.groups.forwardUserItem(gid, topic.id, user);
            void runtime.groups
              .deliverEvent(topic.id, assistantId, event)
              .catch((error) => console.error("开话题的事件没送到：", error));
            if (routine) return ok(`话题「${topic.name}」（${topic.id}）已开，定时任务到点的记录已转过去，话题里的你已经接手，这一件在综合里不用再管。这次定时查到的其他条目，接着按分量办；都安排完了，在综合里说一句这次各是怎么安排的。`);
            return endTurn(`话题「${topic.name}」（${topic.id}）已开，用户的消息已转过去，接下来在话题里办。`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      });
    }
  }

  tools.push(updateTodosTool(runtime, { assistantId, ...(groupId ? { groupId } : {}) }), findKnowledgeTool(runtime), searchKnowledgeTool(runtime, assistantId), ...searchTools(runtime.home, () => runtime.settings.settings.search));
  return tools;
}

export type { Routine };
