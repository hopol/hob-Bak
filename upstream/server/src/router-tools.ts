import { Type } from "@earendil-works/pi-ai";
import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { IMAGE_TYPES } from "../../shared/media.ts";
import { lookupFile, isInPagesDir } from "./files.ts";
import { resolveMovedPath } from "./layout.ts";
import {
  COLORS,
  COLOR_IDS,
  customSprite,
  distinctSprite,
  parseSprite,
  PROP_IDS,
  PROPS,
  spriteId,
  validateCustomProp,
} from "../../shared/sprites.ts";
import type { ColorId } from "../../shared/sprites.ts";
import type { Approval, ApprovalOption, CustomProp, Draft, Routine, RoutineCheck } from "../../shared/types.ts";
import { cronToChinese, timePointText } from "./cron-text.ts";
import { newId } from "./ids.ts";
import { findKnowledgeTool, searchKnowledgeTool } from "./knowledge-tools.ts";
import { generateImage, imageConfigured } from "./image.ts";
import { defaultWorkRef, jobModel, noteOf, thinkingLevelsOf, usableRefs } from "./models.ts";
import { overviewTool } from "./overview.ts";
import { pageTool } from "./pages.ts";
import { pushApproval } from "./push.ts";
import { searchTools } from "./search.ts";
import type { HobRuntime } from "./runtime.ts";
import { clampDuty } from "./text.ts";
import { listAssistantSkills, readAssistantSkillBody, saveAssistantSkill, skillInstruction, usableAssistantSkills } from "./assistant-skills.ts";
import { jobView } from "./job-view.ts";
import { deleteSkill } from "./delete-skill.ts";

type Tool = ToolDefinition<any, any>;

/** 执行时间的参数说明：cron 表达式和具体时间都收。 */
const SCHEDULES_DESCRIPTION = "一个或多个；可以是 cron 表达式，也可以是具体时间（如 2026-11-08T09:00），到点只跑一次。";

/** once 的参数说明。 */
const ONCE_DESCRIPTION = "可选。为 true 时做成一次就停：没有检查脚本的，跑完一次就停；有检查脚本的，第一次有输出就停。停了的定时任务还在，可以再打开。";

/** 检查脚本参数：create_routine 和 update_routine 共用。 */
const CHECK_DESCRIPTION = "可选。到点先跑的 bash 脚本，填脚本全文：没有输出就这次什么都不做；有输出时，then 为 notify 就把输出作为提醒发到对话，为 job 就带着输出开始任务。脚本在这个定时任务自己的目录里运行，状态文件存在当前目录，记住上次看到哪里；第一次跑还没有状态时只记下现状，不输出。非零退出算检查失败。脚本用到的其他文件也放在这个目录，跟着定时任务走。";

const CHECK_PARAM = Type.Object({
  script: Type.String({ description: "bash 脚本全文" }),
  then: Type.Union([Type.Literal("notify"), Type.Literal("job")], { description: "有输出时：notify 把输出作为提醒发到对话，job 带着输出开始任务" }),
}, { description: CHECK_DESCRIPTION });

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
export function buildRouterTools(runtime: HobRuntime, assistantId: string): Tool[] {
  const { store, bus, router, jobs, routines } = runtime;
  const assistant = () => {
    const found = store.assistant(assistantId);
    if (!found) throw new Error(`助手不存在：${assistantId}`);
    return found;
  };
  const note = (icon: "memory" | "rule" | "routine" | "split" | "info", text: string) =>
    router.addItem(assistantId, { kind: "note", icon, text });
  const profileChanged = () => bus.emit({ type: "profile", assistantId });

  // 能派的模型：写进 start_job 的参数说明，助手知道有哪些可选、哪个是默认
  const modelSettings = runtime.settings.settings.models;
  const usable = usableRefs(modelSettings, assistant(), runtime.models);
  const defaultModel = defaultWorkRef(modelSettings, assistant(), runtime.models);
  const modelList = usable.map((ref) => {
    const entry = modelSettings.roster.find((item) => item.ref === ref);
    const note = entry ? noteOf(entry, runtime.models) : "";
    const levels = modelSettings.thinkingChoice === "fixed"
      ? jobModel({ settings: modelSettings, assistant: assistant(), catalog: runtime.models, requested: { model: ref } }).model.thinking
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
        if (!job || (!assistant().primary && job.assistantId !== assistantId)) return fail(`没有这个任务：${params.jobId}`);
        try {
          return ok(jobView({ ...job, cwd: job.cwd ?? store.workDir(job.id) }, jobs.transcript(job.id), store.approvals(), listAssistantSkills(runtime.home, job.assistantId), runtime.settings.settings.general.timezone));
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: "edit_skill",
      label: "改技能",
      description: "改一个技能的正文（SKILL.md）：把一段原文换成新的文字，旧版会保留。脚本要改的，交给任务改。",
      parameters: Type.Object({
        name: Type.String({ description: "技能名" }),
        edits: Type.Array(Type.Object({ old: Type.String(), new: Type.String() }), { description: "一处或几处修改：old 是正文里的原文，要一字不差、只出现一次；new 是换成的文字" }),
      }),
      execute: async (_id, params: { name: string; edits: { old: string; new: string }[] }) => {
        try {
          const skill = listAssistantSkills(runtime.home, assistantId).find((item) => item.name === params.name);
          if (!skill) return fail(`没有这个技能：${params.name}`);
          let body = readAssistantSkillBody(skill.path);
          for (const edit of params.edits) {
            if (!edit.old) return fail("原文不能为空");
            const count = body.split(edit.old).length - 1;
            if (!count) return fail(`正文里找不到这段原文：${[...edit.old].slice(0, 30).join("")}`);
            if (count > 1) return fail(`这段原文出现了 ${count} 次，多带几个字`);
            body = body.replace(edit.old, () => edit.new);
          }
          const saved = saveAssistantSkill(runtime.home, assistantId, { name: skill.name, title: skill.title, description: skill.description, content: body });
          await router.addItem(assistantId, { kind: "note", icon: "skill", text: `已更新技能「${saved.title}」· 第 ${saved.version} 版`, path: saved.path });
          bus.emit({ type: "skills", assistantId });
          return ok(`已更新技能「${saved.title}」，第 ${saved.version} 版。`);
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: "delete_skill",
      label: "删除技能",
      description: "删除一个技能。技能会移到归档，不会彻底删掉。",
      parameters: Type.Object({ name: Type.String({ description: "技能名。" }), replaced_by: Type.Optional(Type.String({ description: "可选，被哪个技能接替，填技能名。用到它的定时任务会改用接替的技能。" })) }),
      execute: async (_id, params: { name: string; replaced_by?: string }) => {
        try {
          const text = deleteSkill(runtime, assistantId, params.name, params.replaced_by || undefined);
          await router.addItem(assistantId, { kind: "note", icon: "skill", text });
          return ok(text);
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: "save_job_as_skill",
      label: "沉淀技能",
      description: "让一个已完成的任务把它的做法写成技能。它在自己的会话里写，能把脚本和命令真跑一遍验证；进度显示在任务卡片上，写好以后结果会回到这里。",
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
        expect_minutes: Type.Optional(Type.Number({ description: "可选，预计多少分钟能交结果。超过了会通知你；不填按 10 分钟。" })),
        model: Type.Optional(Type.String({ description: `可选，不填用默认。聪明、成本、速度 0–100，越高越聪明、越贵、越快：\n${modelText}` })),
        thinking: Type.Optional(
          Type.String({ description: modelSettings.thinkingChoice === "fixed" ? "当前设置为固定思考档，此参数会被忽略，不要填。" : "可选：思考档以可分派模型列表里每个模型标的为准。不填用模型的默认思考档。" }),
        ),
      }),
      execute: async (_id, params: any) => {
        try {
          if (params.expect_minutes != null && (!Number.isInteger(params.expect_minutes) || params.expect_minutes < 1 || params.expect_minutes > 10080)) return fail("expect_minutes 要在 1 到 10080 之间");
          const note = params.note == null ? "" : String(params.note);
          if ([...note].length > 200) return fail("备注最多 200 字；用户原话和最近的对话会自动带上，备注只写从原话里看不出的背景。");
          // 有的模型会把没用的可选参数填成空串：空串当没填
          const wanted: string[] = Array.isArray(params.skills) ? [...new Set<string>(params.skills.map(String))] : [];
          const skills = usableAssistantSkills(runtime.home, assistantId);
          const missing = wanted.find((name) => !skills.some((item) => item.name === name));
          if (missing) return fail(`没有这个技能：${missing}。能用的有：${skills.map((item) => item.name).join("、") || "无"}`);
          const selected = wanted.map((name) => skills.find((item) => item.name === name)!);
          const original = router.originalWords(assistantId, note, true, Array.isArray(params.files) ? params.files.map(String) : []);
          const job = await jobs.start(assistantId, {
            title: String(params.title),
            ...(params.expect_minutes != null ? { expectMinutes: params.expect_minutes } : {}),
            instruction: selected.length ? skillInstruction(selected.map((skill) => skill.title), original.text) : original.text,
            ...(wanted.length ? { skills: wanted } : {}),
            ...(params.cwd ? { cwd: String(params.cwd) } : {}),
            ...(original.files.length ? { files: original.files } : {}),
            ...(params.model ? { model: String(params.model) } : {}),
            ...(params.thinking ? { thinking: String(params.thinking) } : {}),
            ...(router.currentDelegation(assistantId) ? { delegationId: router.currentDelegation(assistantId) } : {}),
          });
          if (job.status === "failed") return fail(`任务启动失败：${job.statusReason ?? "原因不明"}`);
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
          await jobs.stop(String(params.jobId), `${assistant().name}叫停了`);
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
        options: Type.Array(
          Type.Object({
            label: Type.String({ description: "选项文字，如「暂不发布」" }),
          }),
          { description: "2 到 3 个选项", minItems: 2, maxItems: 3 },
        ),
        remember: Type.Optional(Type.String({ description: "这类事以后可以不再问时，填这类事的简称（如「清理临时文件」）；卡片上会多一个「以后直接做」的选项。" })),
      }),
      execute: async (_id, params: any) => {
        const labels: { label: string }[] = Array.isArray(params.options) ? params.options : [];
        if (labels.length < 2 || labels.length > 3) return fail("选项要 2 到 3 个。");
        const remember = typeof params.remember === "string" ? params.remember.trim() : "";
        if (remember && labels.length > 2) return fail("带 remember 时最多给 2 个选项。");
        const options: ApprovalOption[] = labels.map((option, index) => ({
          key: (["A", "B", "C"] as const)[index],
          label: String(option.label),
        }));
        if (remember) options.push({ key: "C", label: `以后「${remember}」直接做`, always: true });
        const approval: Approval = {
          id: newId("q-"),
          assistantId,
          title: String(params.title),
          ...(params.detail ? { detail: String(params.detail) } : {}),
          options,
          status: "pending",
          source: "router",
          ...(remember ? { ruleText: remember } : {}),
          createdAt: new Date().toISOString(),
        };
        store.saveApproval(approval);
        const delegationId = router.currentDelegation(assistantId);
        if (delegationId) runtime.delegations.addApproval(delegationId, approval.id);
        await router.addItem(assistantId, { kind: "question", approvalId: approval.id });
        bus.emit({ type: "approval", approval });
        pushApproval({ push: runtime.push, store }, approval);
        return endTurn("问题卡已显示给用户。");
      },
    },
    {
      name: "set_rule",
      label: "记录规则",
      description: "记下用户对某类事的处理方式：ask 是做之前先问，allow 是直接做。",
      parameters: Type.Object({
        text: Type.String({ description: "规则内容，如「发布公众号」" }),
        mode: Type.Unsafe<"ask" | "allow">(Type.String({ description: "ask 或 allow" })),
      }),
      execute: async (_id, params: any) => {
        const text = String(params.text).trim();
        if (!text) return fail("规则内容为空。");
        const mode = params.mode === "allow" ? "allow" : "ask";
        const rules = store.rules(assistantId);
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
        store.saveRules(assistantId, rules);
        await note("rule", `已记入${assistant().name}的规则 · ${text}`);
        profileChanged();
        return ok("已记录规则。");
      },
    },
    {
      name: "remove_rule",
      label: "删除规则",
      description: "删除一条规则。",
      parameters: Type.Object({ ruleId: Type.String({ description: "规则 id" }) }),
      execute: async (_id, params: any) => {
        const rules = store.rules(assistantId);
        const kept = rules.filter((rule) => rule.id !== params.ruleId);
        if (kept.length === rules.length) return fail("没有这条规则。");
        store.saveRules(assistantId, kept);
        await note("rule", "删除了一条规则");
        profileChanged();
        return ok("已删除。");
      },
    },
    {
      name: "create_routine",
      label: "新增定时任务",
      description: "新增一个定时任务。执行时间用 cron 表达式，如「0 9 * * *」每天 9 点；只跑一次就填具体时间；多个执行时间就传多个。",
      parameters: Type.Object({
        name: Type.String({ description: "定时任务名称，如「每日简报」" }),
        instruction: Type.String({ description: "到点要执行的内容" }),
        schedules: Type.Array(Type.String({ description: "cron 表达式或具体时间" }), { description: SCHEDULES_DESCRIPTION }),
        skill: Type.Optional(Type.String({ description: "可选，按哪个技能做，填技能名。" })),
        check: Type.Optional(CHECK_PARAM),
        once: Type.Optional(Type.Boolean({ description: ONCE_DESCRIPTION })),
      }),
      execute: async (_id, params: any) => {
        try {
          const routine = routines.create({
            assistantId,
            name: String(params.name),
            instruction: String(params.instruction),
            schedules: (params.schedules as string[]) ?? [],
            ...(params.skill ? { skill: String(params.skill) } : {}),
            ...(params.check ? { check: params.check as RoutineCheck } : {}),
            ...(params.once ? { once: true } : {}),
          });
          await note("routine", `新增定时任务 · ${routine.name} · ${routine.schedules.map(cronToChinese).join("、")}`);
          profileChanged();
          return ok(`定时任务「${routine.name}」已创建${routineFact(routine.schedules, routine.check, routine.once)}。它的目录是 ${routines.dir(routine)}，检查脚本在这里运行；脚本要用的其他文件，可以派任务写到这个目录。`);
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
        check: Type.Optional(Type.Union([CHECK_PARAM, Type.Null()], { description: `${CHECK_DESCRIPTION}传 null 去掉检查。` })),
        once: Type.Optional(Type.Boolean({ description: ONCE_DESCRIPTION })),
      }),
      execute: async (_id, params: any) => {
        try {
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
          profileChanged();
          return ok(`已修改${routineFact(routine.schedules, routine.check, routine.once)}。目录是 ${routines.dir(routine)}。`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "delete_routine",
      label: "删除定时任务",
      description: "删除一个定时任务。",
      parameters: Type.Object({ routineId: Type.String() }),
      execute: async (_id, params: any) => {
        try {
          routines.remove(String(params.routineId));
          await note("routine", "删除了一条定时任务");
          profileChanged();
          return ok("已删除。");
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
        await router.addItem(assistantId, { kind: "file", path, name, ...(meta ? { meta } : {}) });
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
        prop_art: Type.Optional(
          Type.Object({
            art: Type.Array(Type.String(), {
              description: "最多 16 行，每行恰好 16 个字符；从第 0 行起逐行盖在火苗上，. 表示不动，k 是描边色，其它字符查 pal；不能盖住火苗的两只眼睛",
            }),
            pal: Type.Record(Type.String(), Type.String(), {
              description: "单个小写字母 → #rrggbb；不能用 o y e（火苗自己的色）和 k（描边固定），最多 6 种",
            }),
            dx: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)], {
              description: "火苗的横向位置：头顶的道具用 2，手边的用 0 或 1",
            }),
          }, {
            description:
              'sprite 为 custom 时要画的那件。例：{ "art": ["....kkkk........", "...khhhhk.......", "....kkkk........"], "pal": { "h": "#ffc21a" }, "dx": 2 }',
          }),
        ),
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
        const item = await router.addItem(assistantId, { kind: "image", status: "pending", prompt, ...(size ? { size } : {}), startedAt: new Date().toISOString() });
        try {
          const path = await generateImage({ home: runtime.home, dir: join(runtime.home, "assistants", assistantId, "files", "images"), config }, {
            prompt,
            ...(params.size ? { size: String(params.size) } : {}),
            ...(Array.isArray(params.refs) && params.refs.length ? { refs: params.refs.map(String) } : {}),
          });
          await router.updateImage(assistantId, item.id, { status: "done", path });
          return ok(`图片已经显示在对话里。路径：${path}，之后改图可以作为参考图。`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await router.updateImage(assistantId, item.id, { status: "failed", error: message });
          return fail(message);
        }
      },
    });
  }

  if (runtime.settings.settings.general.showPage !== false) tools.push(pageTool(runtime, assistantId));

  if (assistant().primary) {
    tools.push(
      overviewTool(runtime),
      {
        name: "propose_assistant",
        label: "提议创建专属助手",
        description: "提议新建一个专属助手：对话里出一张草稿卡，用户点「创建」才会建。做事的方法由所有助手共用的模板和全局规则决定，草稿里只写这个助手特有的东西。",
        parameters: Type.Object({
          name: Type.String({ description: "助手名字，职责加一个亲切的昵称，四五个字，如「写稿搭子」「记账管家」。" }),
          duty: Type.String({ description: "左栏头像下面那行小字，最多 8 个字，如「周报和文章」「账单和预算」。" }),
          dutyLong: Type.String({ description: "草稿卡里的职责说明，两三句话，写完整一些" }),
          sprite: Type.String({
            description: `内置道具：${PROP_IDS.filter((id) => id !== "hob").map((id) => `${id} ${PROPS[id].label}`).join("，")}；或 custom（同时填 prop_art，自己画一件）`,
          }),
          prop_art: Type.Optional(
            Type.Object(
              {
                art: Type.Array(Type.String(), {
                  description: "最多 16 行，每行恰好 16 个字符；从第 0 行起逐行盖在火苗上，. 表示不动，k 是描边色，其它字符查 pal；不能盖住火苗的两只眼睛",
                }),
                pal: Type.Record(Type.String(), Type.String(), {
                  description: "单个小写字母 → #rrggbb；不能用 o y e（火苗自己的色）和 k（描边固定），最多 6 种",
                }),
                dx: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)], {
                  description: "火苗的横向位置：头顶的道具用 2，手边的用 0 或 1",
                }),
              },
              {
                description:
                  'sprite 为 custom 时要画的那件。例：{ "art": ["....kkkk........", "...khhhhk.......", "....kkkk........"], "pal": { "h": "#ffc21a" }, "dx": 2 }',
              },
            ),
          ),
          routines: Type.Optional(
            Type.Array(
              Type.Object({ name: Type.String(), instruction: Type.String(), schedule: Type.String() }),
              { description: "可选。这个助手要定期做的事，不是每个助手都需要；拿不准就先问用户，问清楚再加。" },
            ),
          ),
          askFirst: Type.Optional(Type.Array(Type.String(), { description: "这个领域特有、做之前要先问用户的事，每项一条；全局规则已经列的不重复。" })),
          // 必填：可选时模型第一次总是漏掉，被打回再补，白走一轮（评测 G5 三次都这样）
          facts: Type.Array(Type.String(), { description: "这个助手特有的事实，每项一行：管什么、不管什么（归谁管）、东西在哪（目录、服务）。只写事实，不写做法和规矩。例：「博客源码在 ~/sites/blog，用 Hugo 构建」「报销归「财务」助手管，这里不碰」" }),
          conversations: Type.Optional(Type.Integer({ description: "需要迁移的对话段数，默认 0" })),
        }),
        execute: async (_id, params: any) => {
          const checked = params.prop_art !== undefined ? validateCustomProp(params.prop_art) : undefined;
          if (checked && !checked.ok) return fail(`prop_art 画得不对：${checked.error}；照着原因改好，再调用一次。`);
          const given = parseSprite(String(params.sprite ?? ""));
          if (given?.prop === "hob") return fail("hob 火苗是主助手专用的。");
          if (checked?.ok && given && given.prop !== "custom") {
            return fail("sprite 填了内置道具就不要传 prop_art；要自画一件就把 sprite 填 custom。");
          }
          if (given?.prop === "custom" && !checked?.ok) {
            return fail("sprite 是 custom 时要同时给 prop_art（art、pal、dx）画一件。");
          }
          const facts = Array.isArray(params.facts) ? params.facts.filter((fact: unknown): fact is string => typeof fact === "string").map((fact: string) => fact.trim()).filter(Boolean) : [];
          if (!facts.length) return fail("facts 至少写一条：这个助手管什么、不管什么。");
          const routinesInput: { name: string; instruction: string; schedule: string }[] =
            params.routines ?? [];
          const taken = store.assistants().map((a) => a.sprite);
          // 自画的存画法（sprite 记成 custom）；内置道具的照旧，和已有助手撞了就换个颜色
          const sprite = checked?.ok ? distinctSprite("custom", taken) : given ? distinctSprite(String(params.sprite), taken) : "page";
          const prop = checked?.ok ? checked.prop : undefined;
          const draft: Draft = {
            id: newId("d-"),
            assistantId,
            status: "pending",
            name: String(params.name),
            sprite,
            ...(prop ? { prop } : {}),
            duty: clampDuty(String(params.duty ?? "")),
            dutyLong: String(params.dutyLong),
            routines: routinesInput,
            routinesText: routinesInput.map((item) => `${item.name} · ${cronToChinese(item.schedule)}`).join("、"),
            askFirst: (params.askFirst as string[]) ?? [],
            instructions: facts,
            carry: { conversations: Number(params.conversations ?? 0) },
            createdAt: new Date().toISOString(),
          };
          store.saveDraft(draft);
          await router.addItem(assistantId, { kind: "draft", draftId: draft.id });
          bus.emit({ type: "draft", draft });
          return endTurn(
            "草稿卡已显示给用户。",
          );
        },
      },
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
          const delegationId = router.currentDelegation(assistantId);
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

  tools.push(findKnowledgeTool(runtime), searchKnowledgeTool(runtime, assistantId), ...searchTools(runtime.home, () => runtime.settings.settings.search));
  return tools;
}

export type { Routine };
