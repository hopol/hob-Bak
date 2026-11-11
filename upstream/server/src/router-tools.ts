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
import type { Approval, ApprovalQuestion, CustomProp, Routine, RoutineCheck } from "../../shared/types.ts";
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
import { assistantSkillsDir, combinedSkills, listSkills, resolveSkill, readAssistantSkillBody, saveSkill, skillInstruction } from "./assistant-skills.ts";
import { jobView } from "./job-view.ts";
import { deleteSkill } from "./delete-skill.ts";
import { askOptions, cleanRecommended, unnumber } from "./worker-tools.ts";

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

/** ask_user 的 questions 参数说明：照抄 .scratch/v2/design-projects.md 第五节，一字不改。 */
const QUESTIONS_DESCRIPTION =
  "可选，一次问几个问题时用，每个写 `title`（问题）、`why`（为什么要定它）、`options`（2 到 3 个选项）、`recommended`（推荐哪个选项）。用户答完，答案一起回来；事项在需求澄清时问的，问答会记进事项。";


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
  const note = (icon: "memory" | "rule" | "routine" | "split" | "info", text: string) =>
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
  const sameGroup = (left?: string, right?: string) => !!left && store.groupMatches(left, right);

  const canManageJob = (id: string) => {
    const job = store.job(id);
    return !!job && (groupId ? sameGroup(groupId, job.groupId) : assistant().primary || job.assistantId === assistantId);
  };

  // 检查脚本试跑的结果写成事实交给模型：脚本写错了，现在就能改，不用等到点才失败
  const trialFact = async (routine: Routine): Promise<string> => {
    if (!routine.check) return "";
    const result = await routines.trial(routine);
    if (result.outcome === "failed") return `\n检查脚本试跑失败：${result.reason}。到点也会这样失败。脚本按 bash 执行，用别的语言写的，要在脚本里调用解释器，比如 python3 - <<'EOF' … EOF；要用的文件还没写好的，写好后再用 update_routine 改一次脚本，会再试跑。`;
    if (result.outcome === "hit") return `\n检查脚本试跑有输出（第一次跑应该只记下现状、不输出）：${result.output}`;
    return "\n检查脚本试跑通过，已记下现状。";
  };
  const selectedSkillDir = (id: string, name: string) => {
    const group = groupId ? store.group(groupId) : undefined;
    const skill = resolveSkill(runtime.home, id, name, group);
    return skill ? dirname(dirname(skill.path)) : assistantSkillsDir(runtime.home, id);
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
          return ok(jobView({ ...job, cwd: job.cwd ?? store.workDir(job.id) }, jobs.transcript(job.id), store.approvals(), combinedSkills(runtime.home, job.assistantId, job.groupId ? store.group(job.groupId) : undefined, true), runtime.settings.settings.general.timezone));
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: "edit_skill",
      label: "改技能",
      description: `改一个技能的正文（SKILL.md）：把一段原文换成新的文字，旧版会保留。脚本要改的，交给任务改。${groupId ? "在群里按名字先找本群的技能，再找你自己的。" : ""}`,
      parameters: Type.Object({
        name: Type.String({ description: "技能名" }),
        edits: Type.Array(Type.Object({ old: Type.String(), new: Type.String() }), { description: "一处或几处修改：old 是正文里的原文，要一字不差、只出现一次；new 是换成的文字" }),
        ...(assistant().primary && !groupId ? { assistantId: Type.Optional(Type.String({ description: "可选，改哪个助手的；不填是你自己的" })) } : {}),
      }),
      execute: async (_id, params: { name: string; edits: { old: string; new: string }[]; assistantId?: string }) => {
        const target = targetOf(params.assistantId);
        if ("error" in target) return fail(target.error);
        try {
          const dir = selectedSkillDir(target.id, params.name);
          const skill = listSkills(dir).find((item) => item.name === params.name);
          if (!skill) return fail(`没有这个技能：${params.name}`);
          let body = readAssistantSkillBody(skill.path);
          for (const edit of params.edits) {
            if (!edit.old) return fail("原文不能为空");
            const count = body.split(edit.old).length - 1;
            if (!count) return fail(`正文里找不到这段原文：${[...edit.old].slice(0, 30).join("")}`);
            if (count > 1) return fail(`这段原文出现了 ${count} 次，多带几个字`);
            body = body.replace(edit.old, () => edit.new);
          }
          const saved = saveSkill(dir, { name: skill.name, title: skill.title, description: skill.description, content: body });
          await router.addItem(assistantId, { kind: "note", icon: "skill", text: `已更新技能「${saved.title}」· 第 ${saved.version} 版`, path: saved.path }, groupId);
          bus.emit({ type: "skills", assistantId: target.id });
          return ok(`已更新技能「${saved.title}」，第 ${saved.version} 版。`);
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
          const text = deleteSkill(runtime, target.id, params.name, params.replaced_by || undefined, groupId);
          await router.addItem(assistantId, { kind: "note", icon: "skill", text }, groupId);
          return ok(text);
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: "save_job_as_skill",
      label: "沉淀技能",
      description: `让一个已完成的任务把它的做法写成技能。它在自己的会话里写，能把脚本和命令真跑一遍验证；进度和结果显示在任务卡片上。${groupId ? "群里的任务新沉淀的技能归这个群；into 填哪份就改哪份。" : ""}`,
      parameters: Type.Object({ jobId: Type.String(), into: Type.Optional(Type.String({ description: "可选，在哪个已有技能的基础上改，填技能名；不填就新建。" })), note: Type.Optional(Type.String({ description: "可选，要交代给任务的话，比如用户的反馈和纠正、要一起并进来的技能。" })) }),
      execute: async (_id, params: { jobId: string; into?: string; note?: string }) => {
        const job = store.job(params.jobId);
        if (!job || job.assistantId !== assistantId) return fail("任务不存在");
        try { jobs.startSediment(job.id, { into: params.into || undefined, note: params.note || undefined }); return ok("已开始沉淀，进度显示在任务卡片上。"); }
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
        note: Type.Optional(Type.String({ description: "任务从原话里看不出、又需要知道的背景，最多 200 字。" })),
        cwd: Type.Optional(
          Type.String({
            description:
              "可选，改某个项目时填项目目录；不填就在任务自己的目录里做。",
          }),
        ),
        files: Type.Optional(
          Type.Array(Type.String(), {
            description: "要交给任务的文件路径（用户发来的附件）；图片会直接给模型看",
          }),
        ),
        skills: Type.Optional(Type.Array(Type.String(), { description: "给任务用的技能，填技能名。你的技能，任务只看得到你给的这些。" })),
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
          if ([...note].length > 200) return fail("备注最多 200 字；用户原话和最近的对话会自动带上，备注只写从原话里看不出的背景。");
          // 有的模型会把没用的可选参数填成空串：空串当没填
          const wanted: string[] = Array.isArray(params.skills) ? [...new Set<string>(params.skills.map(String))] : [];
          const skills = combinedSkills(runtime.home, assistantId, groupId ? store.group(groupId) : undefined);
          const missing = wanted.find((name) => !skills.some((item) => item.name === name));
          if (missing) return fail(`没有这个技能：${missing}。能用的有：${skills.map((item) => item.name).join("、") || "无"}`);
          const selected = wanted.map((name) => skills.find((item) => item.name === name)!);
          const original = router.originalWords(assistantId, note, true, Array.isArray(params.files) ? params.files.map(String) : [], groupId);
          const job = await jobs.start(assistantId, {
            title: String(params.title),
            ...(groupId ? { groupId } : {}),
            ...(params.expect_minutes != null ? { expectMinutes: params.expect_minutes } : {}),
            instruction: selected.length ? skillInstruction(selected.map((skill) => skill.title), original.text) : original.text,
            ...(wanted.length ? { skills: wanted } : {}),
            ...(Array.isArray(params.after) && params.after.length ? { after: params.after.map(String) } : {}),
            ...(params.cwd ? { cwd: String(params.cwd) } : {}),
            ...(original.files.length ? { files: original.files } : {}),
            ...(params.model ? { model: String(params.model) } : {}),
            ...(params.thinking ? { thinking: String(params.thinking) } : {}),
            ...(router.currentDelegation(assistantId, groupId) ? { delegationId: router.currentDelegation(assistantId, groupId) } : {}),
          });
          if (job.status === "failed") return fail(`任务启动失败：${job.statusReason ?? "原因不明"}`);
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
          return ok(`已交给任务「${job.title}」（${jobId}），它会接着做。`);
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
          await jobs.stop(jobId, `${assistant().name}叫停了`);
          return ok("已停止。");
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
        await note("rule", `已记入${groupId ? "本群" : nameOf(target.id)}的规则 · ${text}`);
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
        await note("rule", "删除了一条规则");
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
          const routine = routines.create({
            assistantId: target.id,
            ...(groupId ? { groupId } : {}),
            name: String(params.name),
            instruction: String(params.instruction),
            schedules: (params.schedules as string[]) ?? [],
            ...(params.skill ? { skill: String(params.skill) } : {}),
            ...(params.check ? { check: params.check as RoutineCheck } : {}),
            ...(params.once ? { once: true } : {}),
          });
          await note("routine", `新增定时任务 · ${routine.name} · ${routine.schedules.map(cronToChinese).join("、")}`);
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
          if (!found || (groupId ? !sameGroup(groupId, found.groupId) : !!found.groupId || found.assistantId !== target.id)) return fail(`没有这个定时任务：${params.routineId}`);
          const routine = routines.update(String(params.routineId), {
            ...(params.name ? { name: String(params.name) } : {}),
            ...(params.instruction ? { instruction: String(params.instruction) } : {}),
            ...(params.schedules ? { schedules: params.schedules as string[] } : {}),
            ...(typeof params.active === "boolean" ? { active: params.active } : {}),
            ...(typeof params.skill === "string" ? { skill: params.skill } : {}),
            ...(params.check === null || params.check ? { check: params.check as RoutineCheck | null } : {}),
            ...(typeof params.once === "boolean" ? { once: params.once } : {}),
          });
          await note("routine", `修改定时任务 · ${routine.name} · ${routine.schedules.map(cronToChinese).join("、")}`);
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
          if (!found || (groupId ? !sameGroup(groupId, found.groupId) : !!found.groupId || found.assistantId !== target.id)) return fail(`没有这个定时任务：${params.routineId}`);
          routines.remove(String(params.routineId));
          await note("routine", `删除了定时任务「${found.name}」`);
          profileChanged(target.id);
          // 删完还剩哪些写清楚：模型以为有重复、删掉的其实是唯一一条时，看得出来
          const left = store.routines().filter((routine) => groupId ? sameGroup(groupId, routine.groupId) : !routine.groupId && routine.assistantId === target.id);
          return ok(`已删除「${found.name}」。${groupId ? "本群" : target.id === assistantId ? "你" : `「${store.assistant(target.id)?.name ?? target.id}」`}现在${left.length ? `的定时任务：${left.map((routine) => `「${routine.name}」（${routine.id}）`).join("、")}` : "没有定时任务了"}。`);
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
        await note("info", `已换头像 · ${target.name} · ${desc}`);
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
          note: Type.Optional(Type.String({ description: "可选，对方需要知道的背景，最多 200 字。" })),
        }),
        execute: async (_id, params: any) => {
          const targetId = String(params.assistantId);
          const target = store.assistant(targetId);
          if (!target) return fail(`没有这个助手：${targetId}`);
          if (targetId === assistantId) return fail("不能转交给自己。");
          try {
            const note = params.note == null ? "" : String(params.note);
            if ([...note].length > 200) return fail("备注最多 200 字；用户原话和最近的对话会自动带上，备注只写从原话里看不出的背景。");
            const original = router.originalWords(assistantId, note);
            await runtime.delegations.start(targetId, original.text, original.files);
            return endTurn(`已转交给「${target.name}」。`);
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
    });
  }

  // 话题和事项的工具只给群主：不是群主的成员，工具列表里没有它们。
  // open_topic 只在综合里（它要把综合里的原话转进话题）；close_topic 综合和话题里都有；
  // 事项的几个工具只在「软件开发」的群。
  const ownerGroup = groupId ? store.group(groupId) : undefined;
  if (ownerGroup && ownerGroup.ownerId === assistantId) {
    const gid = ownerGroup.id;
    /** 每次都现查：群主在中途换了，旧会话里的调用也要挡住。 */
    const notOwner = (): string | null => {
      const group = store.group(gid);
      if (!group) return "这个话题和事项只在群里用。";
      if (group.ownerId !== assistantId) return "只有群主能开话题、立事项、改需求说明和结束事项。";
      return null;
    };
    /** 事项的几条只给「软件开发」的群：工作方式可能在中途改过。 */
    const notSoftware = (): string | null =>
      store.group(gid)?.workflow === "software" ? null : "这个群的工作方式不是「软件开发」，没有事项：请用户在群里把工作方式改成「软件开发」。";
    /** 这个群进行中的话题，报错时列出来。 */
    const topicList = (): string => {
      const topics = runtime.groups.activeTopics(ownerGroup.parentId ?? gid);
      return topics.length ? topics.map((topic) => `${topic.name}（${topic.id}）`).join("、") : "还没有";
    };
    // 进入新的一步：这一轮结束，代码马上开新的一轮，下一步的做法才进得了系统提示词
    const nextTurn = (text: string) => {
      void runtime.groups.deliverEvent(gid, assistantId, text).catch((error) => console.error("事项的下一步没送到：", error));
    };
    tools.push({
      name: "close_topic",
      label: "关闭话题",
      description: "关闭话题：这件事办完了，或者用户不要了。立了事项的话题用 close_project 结束，话题会跟着关。",
      parameters: Type.Object({
        topic: Type.Optional(Type.String({ description: "话题 id。在话题里关这个话题时不填。" })),
        note: Type.Optional(Type.String({ description: "给用户的结论，或者为什么不做了，会显示在综合的话题卡上。" })),
      }),
      execute: async (_id, params: any) => {
        const problem = notOwner();
        if (problem) return fail(problem);
        const live = store.group(gid);
        const given = typeof params.topic === "string" ? params.topic.trim() : "";
        // 在话题里关这个话题不用填 topic；在综合里要填
        const targetId = given || (live?.parentId ? gid : "");
        if (!targetId) return fail(`topic 不能为空：在综合里关哪个话题就填哪个。这个群进行中的话题：${topicList()}`);
        const topic = store.group(targetId);
        const parentId = live?.parentId ?? gid;
        if (!topic || topic.parentId !== parentId) return fail(`「${targetId}」不是这个群的话题。这个群进行中的话题：${topicList()}`);
        const project = runtime.projects.active(topic.id)[0];
        if (project) {
          return fail(`话题「${topic.name}」里的事项「${project.title}」还没结束：用 close_project 结束事项，话题会跟着关。`);
        }
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
          const noteLine = note ? `\n你留的备注：${note}` : "";
          try {
            if (topicId) {
              const target = store.group(topicId);
              if (!target || target.parentId !== gid) return fail(`「${topicId}」不是这个群的话题。这个群进行中的话题：${topicList()}`);
              // 关了的话题先重新打开，接着在里面办
              const topic = target.closedAt ? runtime.groups.reopen(topicId) : target;
              runtime.groups.forwardUserItem(gid, topicId, user);
              runtime.groups.note(gid, assistantId, `转到了话题「${topic.name}」`, "info");
              void runtime.groups.deliverEvent(topicId, assistantId, `${user.kind === "user" ? "上面是用户在综合里的原话。" : "上面是定时任务到点的记录。"}${noteLine}`).catch((error) => console.error("转到话题的事件没送到：", error));
              return endTurn(`已转到话题「${topic.name}」（${topic.id}），接下来在话题里办。`);
            }
            const topic = runtime.groups.createTopic(gid, title, assistantId);
            runtime.groups.forwardUserItem(gid, topic.id, user);
            void runtime.groups
              .deliverEvent(topic.id, assistantId, `这个话题是你从综合开的，${user.kind === "user" ? "上面是用户在综合里的原话。" : "上面是定时任务到点的记录。"}${noteLine}`)
              .catch((error) => console.error("开话题的事件没送到：", error));
            if (user.kind === "note") return ok(`话题「${topic.name}」（${topic.id}）已开，定时任务到点的记录已转过去。这次定时查到的其他条目，要办的接着各开一个话题；都开完了，在综合里说一句这次开了哪些。`);
            return endTurn(`话题「${topic.name}」（${topic.id}）已开，用户的消息已转过去，接下来在话题里办。`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      });
    }
    // 事项的几个工具只在「软件开发」的群
    const projectTools: Tool[] = [
      {
        name: "open_project",
        label: "立事项",
        description: "把一件事立成事项。触发这一轮的消息（用户原话和附件，或者定时任务到点的那条）会原样记成原始需求。在综合里立，会给它开一个话题，之后的澄清、拆分和执行都在话题里办；在话题里立，事项就挂在这个话题上。",
        parameters: Type.Object({
          title: Type.String({ description: "事项名，写要办成什么，如「给导出加上按月筛选」。" }),
          note: Type.Optional(Type.String({ description: "可选，话题里看不到、你已经知道的背景，比如这次要办的是哪一条。会和触发这一轮的消息一起交给话题里的你。" })),
        }),
        execute: async (_id, params: any) => {
          const problem = notOwner() ?? notSoftware();
          if (problem) return fail(problem);
          const title = String(params.title ?? "").trim();
          if (!title) return fail("title 不能为空：写要办成什么，如「给导出加上按月筛选」。");
          const live = store.group(gid);
          if (!live) return fail("事项只在群里用。");
          try {
            // 在话题里立：事项就挂在这个话题上
            if (live.parentId) {
              const project = runtime.projects.open({ group: live, ownerId: assistantId, title });
              const text = `事项「${project.title}」（${project.id}）已立，现在是需求澄清。记录：${runtime.projects.recordPath(project)}${params.note ? `\n你留的备注：${String(params.note)}` : ""}`;
              nextTurn(text);
              return endTurn(text);
            }
            // 在综合里立：给它开一个话题，之后的澄清、拆分和执行都在话题里办
            const user = runtime.groups.requestItem(gid, assistantId);
            if (!user) return fail("综合里还没有用户的消息，记不成原始需求：请用户说清楚要办什么，再立事项。");
            const topic = runtime.groups.createTopic(gid, title, assistantId);
            const forwarded = runtime.groups.forwardUserItem(gid, topic.id, user);
            const request = { text: user.text, at: forwarded?.at ?? user.at, itemId: forwarded?.id ?? user.id, ...(user.kind === "user" && user.files?.length ? { files: user.files } : {}), ...(user.kind === "user" && user.quote ? { quote: user.quote } : {}) };
            const project = runtime.projects.open({ group: topic, ownerId: assistantId, title, request });
            const record = runtime.projects.recordPath(project);
            const text = `事项「${project.title}」（${project.id}）已立，开了话题「${topic.name}」，现在是需求澄清，接下来在话题里办。记录：${record}`;
            void runtime.groups
              .deliverEvent(topic.id, assistantId, `这个话题是你从综合开的，上面是触发这一轮的消息。${params.note ? `\n你留的备注：${String(params.note)}` : ""}\n事项「${project.title}」（${project.id}）已立，现在是需求澄清。记录：${record}`)
              .catch((error) => console.error("立事项的事件没送到：", error));
            // 定时一次可能查到好几条，各立一个事项：这一轮不结束，接着立下一个
            if (user.kind === "note") return ok(`${text}\n这次定时查到的其他条目，要办的接着各立一个事项；都立完了，在综合里说一句这次立了哪些。`);
            return endTurn(text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      },
      {
        name: "write_requirements",
        label: "写需求说明",
        description: "写或改事项的需求说明和验收标准。改的时候整份替换。",
        parameters: Type.Object({
          project: Type.String({ description: "事项 id。" }),
          content: Type.String({ description: "需求说明正文，Markdown。" }),
          acceptance: Type.Array(Type.String({ description: "一条验收标准" }), { description: "验收标准，一条一句。" }),
        }),
        execute: async (_id, params: any) => {
          const problem = notOwner() ?? notSoftware();
          if (problem) return fail(problem);
          try {
            const project = runtime.projects.find(gid, String(params.project ?? ""));
            const content = String(params.content ?? "").trim();
            if (!content) return fail("content 不能为空：写需求说明正文，写清要解决的问题、做完是什么样、定下来的做法和怎么验证。");
            const acceptance = (Array.isArray(params.acceptance) ? params.acceptance : [])
              .map((item: unknown) => String(item ?? "").trim())
              .filter(Boolean);
            if (!acceptance.length) return fail("acceptance 不能为空：至少写一条验收标准，一条一句，写清怎么算通过，比如「导出的文件能用表格软件打开，每行一条记录」，改好再调用一次。");
            const saved = runtime.projects.writeRequirements(gid, project.id, { content, acceptance });
            if (!saved.advanced) return ok(`需求说明已更新：${acceptance.length} 条验收标准。`);
            const text = `事项「${saved.project.title}」的需求说明已写好，现在是任务拆分。`;
            nextTurn(text);
            return endTurn(text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      },
      {
        name: "plan_subtasks",
        label: "拆子任务",
        description: "把事项拆成子任务，在群里出一张拆分卡片。用户在卡片上点「开始执行」，或者你调用 start_subtasks，子任务才按前置的先后开始。再调用会整份替换还没开始的子任务。",
        parameters: Type.Object({
          project: Type.String({ description: "事项 id。" }),
          cwd: Type.Optional(Type.String({ description: "可选，改某个项目时填项目目录，所有子任务都在这里做；不填就各在任务自己的目录里做。" })),
          subtasks: Type.Array(
            Type.Object({
              title: Type.String({ description: "子任务名。" }),
              assignee: Type.String({ description: "交给哪个成员，填名字；用户自己做的填「用户」。" }),
              brief: Type.String({ description: "子任务说明。" }),
              after: Type.Optional(Type.Array(Type.Number(), { description: "可选，前置子任务的序号。" })),
              check: Type.Optional(Type.Boolean({ description: "可选，为 true 表示这是验收子任务。" })),
            }),
            { description: "子任务列表，按顺序编号，每个写：", minItems: 1 },
          ),
        }),
        execute: async (_id, params: any) => {
          const problem = notOwner() ?? notSoftware();
          if (problem) return fail(problem);
          try {
            const project = runtime.projects.find(gid, String(params.project ?? ""));
            const given = Array.isArray(params.subtasks) ? params.subtasks : [];
            const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined;
            const saved = runtime.projects.plan(gid, project.id, given, cwd);
            const kept = saved.subtasks.filter((subtask) => subtask.jobId || subtask.doneAt).length;
            const rows = saved.subtasks.map((subtask) => `${subtask.n}「${subtask.title}」${subtask.assignee === "user" ? "你" : runtime.store.assistant(subtask.assignee)?.name ?? subtask.assignee}`).join("、");
            return ok(
              `事项「${saved.title}」现在有 ${saved.subtasks.length} 个子任务：${rows}${kept ? `；已经开始的 ${kept} 个原样保留` : ""}。还没开始执行：用户在卡片上点「开始执行」，或者你调用 start_subtasks。${saved.cwd ? `\n工作目录：${saved.cwd}。` : "\n没填工作目录，子任务各在任务自己的目录里做。"}\n记录：${runtime.projects.recordPath(saved)}`,
            );
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      },
      {
        name: "start_subtasks",
        label: "开始执行",
        description: "开始执行事项里拆好的子任务，按前置的先后开始。用户已经在卡片上点了「开始执行」的，不用再调用。",
        parameters: Type.Object({
          project: Type.String({ description: "事项 id。" }),
        }),
        execute: async (_id, params: any) => {
          const problem = notOwner() ?? notSoftware();
          if (problem) return fail(problem);
          try {
            const project = runtime.projects.find(gid, String(params.project ?? ""));
            const started = runtime.projects.start(gid, project.id);
            const text = `事项「${started.title}」开始执行了，现在是执行：轮到的子任务自动以成员的名义开任务，用户的子任务要用户点完成。`;
            nextTurn(text);
            return endTurn(text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      },
      {
        name: "close_project",
        label: "结束事项",
        description: "结束事项。",
        parameters: Type.Object({
          project: Type.String({ description: "事项 id。" }),
          outcome: Type.Union([Type.Literal("done"), Type.Literal("dropped")], { description: "done 做完了；dropped 不做了。" }),
          summary: Type.String({ description: "给用户的结论；不做了的，写明原因。" }),
        }),
        execute: async (_id, params: any) => {
          const problem = notOwner() ?? notSoftware();
          if (problem) return fail(problem);
          const outcome = String(params.outcome ?? "");
          if (outcome !== "done" && outcome !== "dropped") return fail(`outcome 要填 done（做完了）或 dropped（不做了），收到「${outcome}」。`);
          const summary = String(params.summary ?? "").trim();
          if (!summary) return fail("summary 不能为空：做完了写给用户的结论，不做了的写明原因。");
          try {
            const project = runtime.projects.close(gid, String(params.project ?? ""), outcome, summary);
            return ok(`事项「${project.title}」已结束：${outcome === "done" ? "已完成" : "已放弃"}；记录：${runtime.projects.recordPath(project)}`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      },
    ];
    if (ownerGroup.workflow === "software") tools.push(...projectTools);
  }

  tools.push(findKnowledgeTool(runtime), searchKnowledgeTool(runtime, assistantId), ...searchTools(runtime.home, () => runtime.settings.settings.search));
  return tools;
}

export type { Routine };
