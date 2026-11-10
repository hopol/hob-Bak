import { homedir } from "node:os";
import { copyFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type, type ImageContent } from "@earendil-works/pi-ai";
import { commandSummary } from "../../shared/command.ts";
import type {
  ActivityLine,
  Approval,
  ApprovalOption,
  Job,
  JobsPage,
  JobRound,
  JobStatus,
  JobStep,
  RoutineRun,
  SedimentStatus,
} from "../../shared/types.ts";
import { IMAGE_TYPES, isImagePath } from "../../shared/media.ts";
import { newId } from "./ids.ts";
import { resolveMovedPath } from "./layout.ts";
import { availableDesktopTools, type DesktopToolSession } from "./desktop-tools.ts";
import { imageConfigured } from "./image.ts";
import { boundKnowledge, findKnowledgeTool, searchKnowledgeTool } from "./knowledge-tools.ts";
import { MCP_SESSION_TOOLS, mcpEnabled, mcpServerDisplay } from "./mcp.ts";
import { jobModel } from "./models.ts";
import { duration, jobProcessLines } from "./job-view.ts";
import { overviewTool } from "./overview.ts";
import { pushJobEnd } from "./push.ts";
import { buildWorkerPrompt, type Abilities, type PromptSettings } from "./prompt.ts";
import { availableSkills } from "./skills.ts";
import { enabledAssistantSkills, listAssistantSkills, readSkillFiles, recordAssistantSkillUse, saveAssistantSkill, usableAssistantSkills } from "./assistant-skills.ts";
import type { HobRuntime } from "./runtime.ts";
import { showPath } from "./text.ts";
import { monthDayTimeText } from "./time.ts";
import { SEDIMENT_PROMPT_HEAD, STEP_EVENT_LIMIT, deriveSteps, textOfContent, toolStep, withOutput } from "./transcript.ts";
import { registerAskTool, registerImageTool, registerReportTool } from "./worker-tools.ts";
import { searchTools } from "./search.ts";

const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ACTIVITY_LIMIT = 200;
const ENDED: JobStatus[] = ["done", "stuck", "failed", "stopped"];

const ALL_ABILITIES: Abilities = { exec: true, write: true, image: true };

/** 助手关掉的能力就不给对应工具（读总是有）。 */
export function workerTools(abilities: Abilities): string[] {
  return WORKER_TOOLS.filter((name) => {
    if (name === "bash") return abilities.exec;
    if (name === "edit" || name === "write") return abilities.write;
    return true;
  });
}

/** 附件里有没有图片（按扩展名判断，不读文件）。 */
export function hasImageFiles(files: string[] | undefined): boolean {
  return (files ?? []).some((file) => isImagePath(file));
}

/** 一张图超过这个大小就不当图片给模型（只留路径），免得把会话撑得太大。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 附件里的图片读成 pi 的图片块（读不出来、太大就跳过，不把整个回合拖死）。任务和对话共用。 */
export function imageContents(files: string[] | undefined): ImageContent[] {
  const out: ImageContent[] = [];
  for (const file of files ?? []) {
    const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
    if (!mimeType) continue;
    try {
      if (statSync(file).size > MAX_IMAGE_BYTES) continue;
      out.push({ type: "image", data: readFileSync(file).toString("base64"), mimeType });
    } catch {
      // 文件没了或读不了：不带图片，靠任务说明的路径自己去读
    }
  }
  return out;
}

export interface StartJobInput {
  title: string;
  instruction: string;
  cwd?: string;
  /** 交给任务的附件（图片会当图片给模型，其他只在说明里列路径） */
  files?: string[];
  model?: string;
  thinking?: string;
  routineId?: string;
  skills?: string[];
  expectMinutes?: number;
  delegationId?: string;
}

interface WorkerState {
  job: Job;
  session?: AgentSession;
  manager?: SessionManager;
  reported?: { outcome: "done" | "stuck" | "need_approval"; result: string; files?: string[] };
  lastText?: string;
  askedFollowUp: boolean;
  lastActivityAt: number;
  pausedMs: number;
  pausedAt?: number;
  nextReminder: number;
  finishTimer?: NodeJS.Timeout;
  ask?: (label: string) => void;
  /** 用户叫停了：收尾期间这个 worker 的 report/追问都不再算数 */
  stopped?: boolean;
  /** 正在跑的工具步骤，按 toolCallId 存：输出更新、跑完都按同一个步骤 id 替换 */
  steps: Map<string, JobStep>;
  readPaths: Map<string, string>;
  /** 你补的话已交给任务、还没被读到（任务做完当前这一步才读）；读到时换成正式的一行 */
  queued: JobStep[];
  /** 任务过程里 MCP 工具的显示名（转义后的服务名 → 配置里的原名） */
  mcpServers: Record<string, string>;
  desktop?: DesktopToolSession;
}

/** 推给助手的任务结果最多带这么多字的报告。 */
const EVENT_SUMMARY_MAX = 3000;

export function jobResultEvent(job: Job, prefix = `任务「${job.title}」`, skillTitles: string[] = [], toolCount = job.stats.reads + job.stats.commands + job.stats.edits, hint?: string): string {
  const status = job.status === "done" ? "已完成" : job.status === "stuck" ? "受阻" : job.status === "stopped" ? "已停止" : "失败";
  const result = job.summary;
  const header = `${prefix}（${job.id}）${status}${job.durationMs !== undefined ? `，用时 ${duration(job.durationMs)}${job.expect ? `，预计 ${job.expect.minutes} 分钟` : ""}` : ""}。\n过程：动手 ${toolCount} 次，${skillTitles.length ? `用了技能${skillTitles.map((title) => `「${title}」`).join("")}` : "没用技能"}。${hint ? `\n${hint}` : ""}`;
  if (!result) return `${header}\n${job.statusReason ?? "没有结果"}`;
  return result.length > EVENT_SUMMARY_MAX
    ? `${header}\n结果（共 ${result.length} 字，以下是前 3,000 字；全文：${job.reportPath}）：\n${result.slice(0, EVENT_SUMMARY_MAX)}`
    : `${header}\n结果：\n${result}`;
}

/** 没带技能的任务做完了，就在结果里提醒助手安排一次沉淀；有从这个任务沉淀出来的技能时，末尾告诉它 into 填哪份。 */
export function sedimentHint(home: string, job: Job, skills = usableAssistantSkills(home, job.assistantId)): string | undefined {
  if (job.status !== "done" || job.skills?.length) return undefined;
  const last = skills.filter((skill) => skill.fromJobId === job.id).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  return `这个任务没带技能。用 save_job_as_skill 让它回顾一遍，把能复用的做法沉淀下来，有没有值得沉淀的由它判断；已经有同类的技能，into 填那份。${last ? `上次从这个任务沉淀出了技能「${last.title}」（${last.name}），into 填它。` : ""}`;
}

/** 发给任务所属助手的结果事件。转交结束发给 Hob 的汇总用它不带提醒的那份（delegations.ts）。 */
export function assistantJobResultEvent(home: string, job: Job, options: { prefix?: string; toolCount?: number } = {}): string {
  const skills = usableAssistantSkills(home, job.assistantId);
  const skillTitles = (job.skillsUsed ?? []).map((name) => skills.find((skill) => skill.name === name)?.title ?? name);
  const filesNote = job.files?.length ? `\n任务交来的文件：${job.files.join("、")}。` : "";
  const text = jobResultEvent(job, options.prefix ?? `任务「${job.title}」`, skillTitles, options.toolCount ?? job.stats.reads + job.stats.commands + job.stats.edits, sedimentHint(home, job, skills));
  return `${text}${filesNote}`;
}

function trim(value: string, max = 240): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function activityFor(toolName: string, args: Record<string, unknown>, cwd = ""): ActivityLine | undefined {
  const path = showPath(String(args.path ?? args.file_path ?? args.filePath ?? ""), cwd);
  switch (toolName) {
    case "read":
      return { at: new Date().toISOString(), verb: "读", text: path };
    case "ls":
      return { at: new Date().toISOString(), verb: "读", text: path || "." };
    case "bash":
      return { at: new Date().toISOString(), verb: "跑", text: trim(commandSummary(String(args.command ?? "")), 120) };
    case "edit":
      return { at: new Date().toISOString(), verb: "改", text: path };
    case "write":
      return { at: new Date().toISOString(), verb: "写", text: path };
    case "grep":
      return { at: new Date().toISOString(), verb: "搜", text: trim(String(args.pattern ?? ""), 80) };
    case "find":
      return { at: new Date().toISOString(), verb: "搜", text: trim(String(args.pattern ?? ""), 80) };
    default:
      return undefined;
  }
}

/** 后台任务：一个 Job = 一个隔离的 Worker 会话，结束必须 report。 */
export class JobManager {
  private workers = new Map<string, WorkerState>();
  private queue: string[] = [];
  private followUps = new Map<string, string>();
  private finishing = new Map<string, Promise<void>>();
  private sediments = new Map<string, { cancelled: boolean; session?: AgentSession; task?: Promise<void> }>();
  private watchdog?: NodeJS.Timeout;

  constructor(private readonly runtime: HobRuntime) {}

  private get store() {
    return this.runtime.store;
  }

  private get bus() {
    return this.runtime.bus;
  }

  /** 提示词用的设置：现读 settings.json，所以改完下一个任务就按新时区算。 */
  private promptSettings(): PromptSettings {
    const { timezone, aboutYou } = this.runtime.settings.settings.general;
    return { timezone, aboutYou, memory: this.runtime.settings.memory().provider };
  }

  jobsFor(assistantId: string): Job[] {
    return this.store.jobs().filter((job) => job.assistantId === assistantId);
  }

  /** 任务记录：全部任务，新的在前，可按助手 / 状态筛选，按 before（上一次最后一页的那条）分页。 */
  page(options: { assistantId?: string; status?: JobStatus; before?: string; limit?: number } = {}): JobsPage {
    const limit = Math.max(1, Math.min(options.limit ?? 30, 200));
    let list = this.store.jobs().reverse();
    if (options.assistantId) list = list.filter((job) => job.assistantId === options.assistantId);
    if (options.status) list = list.filter((job) => job.status === options.status);
    if (options.before) {
      const index = list.findIndex((job) => job.id === options.before);
      if (index !== -1) list = list.slice(index + 1);
    }
    return { jobs: list.slice(0, limit), hasMore: list.length > limit };
  }

  /** 详情页要全文时拉它：从任务会话文件重新推导，长输出落到任务目录下。 */
  transcript(jobId: string): JobStep[] {
    const job = this.store.job(jobId);
    if (!job) return [];
    const steps = deriveSteps(this.store.workerFile(jobId), {
      cwd: job.cwd ?? "",
      save: (stepId, text) => this.store.writeStepOutput(jobId, stepId, text),
      mcpServers: mcpServerDisplay(this.runtime.home),
      // 迁移前写进会话的绝对路径：换成新位置后，详情页里还是短文件名
      resolvePath: (path) => resolveMovedPath(this.runtime.home, path),
    });
    return [...steps, ...(this.workers.get(jobId)?.queued ?? [])];
  }

  async start(assistantId: string, input: StartJobInput): Promise<Job> {
    const assistant = this.store.assistant(assistantId);
    if (!assistant) throw new Error(`助手不存在：${assistantId}`);
    if (input.cwd?.trim()) {
      const canonical = (path: string): string => {
        const absolute = resolve(path);
        let parent = absolute;
        while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
        return resolve(realpathSync(parent), relative(parent, absolute));
      };
      const path = relative(canonical(this.runtime.home), canonical(input.cwd));
      if (!path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
        throw new Error("不能在 Hob 的数据目录里干活；不填 cwd 就在任务自己的目录里做。");
      }
    }
    await this.runtime.models.get();
    const requested =
      input.model || input.thinking
        ? { ...(input.model ? { model: input.model } : {}), ...(input.thinking ? { thinking: input.thinking } : {}) }
        : undefined;
    const picked = jobModel({
      settings: this.runtime.settings.settings.models,
      assistant,
      catalog: this.runtime.models,
      ...(requested ? { requested } : {}),
      ...(hasImageFiles(input.files) ? { hasImages: true } : {}),
    });
    const id = this.nextJobId();
    const durations = input.routineId ? (this.store.routine(input.routineId)?.runs ?? [])
      .filter((run) => run.status === "done" && run.durationMs !== undefined && Number.isFinite(run.durationMs) && run.durationMs >= 0)
      .slice(0, 5).map((run) => run.durationMs!).sort((a, b) => a - b) : [];
    const middle = Math.floor(durations.length / 2);
    const median = durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
    const expect: NonNullable<Job["expect"]> = input.routineId && durations.length
      ? { minutes: Math.max(1, Math.ceil(median / 60_000)), source: "routine", runs: durations.length }
      : input.expectMinutes !== undefined ? { minutes: input.expectMinutes, source: "assistant" } : { minutes: 10, source: "default" };
    const job: Job = {
      id,
      assistantId,
      assistantName: assistant.name,
      title: input.title,
      instruction: input.instruction,
      status: "queued",
      expect,
      createdAt: new Date().toISOString(),
      stats: { reads: 0, commands: 0, edits: 0 },
      activity: [],
      cwd: input.cwd?.trim() ? input.cwd : this.store.workDir(id),
      model: picked.model.ref,
      thinking: picked.model.thinking,
      ...(picked.modelReason ? { modelReason: picked.modelReason } : {}),
      ...(input.files?.length ? { inputs: input.files } : {}),
      ...(input.routineId ? { routineId: input.routineId } : {}),
      ...(input.skills?.length ? { skills: input.skills } : {}),
      ...(input.delegationId ? { delegationId: input.delegationId } : {}),
    };
    this.store.saveJob(job);
    if (job.delegationId) this.runtime.delegations.addJob(job.delegationId, job.id);
    await this.runtime.router.addItem(assistantId, { kind: "job", jobId: job.id });
    this.bus.emit({ type: "job", job });
    this.publishBusy(assistantId);
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  /** 任务会改变“忙不忙”（前端用它显示“正在想”），所以状态一变就告诉前端。 */
  private publishBusy(assistantId: string): void {
    const assistant = this.store.assistant(assistantId);
    if (assistant) this.bus.emit({ type: "assistant", assistant: this.runtime.router.summary(assistant) });
  }

  private nextJobId(): string {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = newId("t-", 4);
      if (!this.store.job(candidate)) return candidate;
    }
    return newId("t-", 8);
  }

  /** 并发名额：settings 的 maxJobs（改完立即生效，排队里的会接着启动）。 */
  private runningCount(): number {
    return this.store.jobs().filter((job) => job.status === "running" || job.status === "waiting").length;
  }

  pump(): void {
    const max = this.runtime.settings.settings.work.maxJobs;
    while (this.queue.length && this.runningCount() < max) {
      const id = this.queue.shift()!;
      const job = this.store.job(id);
      if (!job || job.status !== "queued") continue;
      const followUp = this.followUps.get(id);
      this.followUps.delete(id);
      void this.launch(job, followUp).catch((error) => this.failLaunch(job, error));
    }
  }

  private async failLaunch(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.finish(job.id, "failed", undefined, message);
  }

  private async launch(job: Job, followUp?: string): Promise<void> {
    const running: Job = {
      ...job,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.store.saveJob(running);
    this.bus.emit({ type: "job", job: running });

    const assistant = this.store.assistant(running.assistantId);
    // 生图要两头都满足：助手开着，而且设置里真配了图像模型
    const baseAbilities = assistant?.abilities ?? ALL_ABILITIES;
    const abilities: Abilities = {
      ...baseAbilities,
      image: baseAbilities.image && imageConfigured(this.runtime.settings.settings.image),
    };
    const knowledge = await boundKnowledge(this.runtime, running.assistantId);
    const customTools = [registerReportTool(this.runtime, running.id), registerAskTool(this.runtime, running.id), findKnowledgeTool(this.runtime)];
    if (knowledge.length) customTools.push(searchKnowledgeTool(this.runtime, running.assistantId));
    if (abilities.image) customTools.push(registerImageTool(this.runtime, running.id));
    customTools.push(...searchTools(this.runtime.home, () => this.runtime.settings.settings.search));
    const desktop = await availableDesktopTools(this.runtime, running.assistantId, !!this.runtime.models.find(running.model ?? this.runtime.settings.settings.models.work.ref)?.input.includes("image"), running.title, join(this.store.workDir(running.id), "screenshots"));
    if (this.store.job(running.id)?.status !== "running") { await desktop?.dispose(); return; }
    if (desktop) customTools.push(...desktop.tools());
    // 定时跑的就是 Worker：主助手的任务要看得到各助这段时间的动静才能写早报
    if (assistant?.primary) customTools.push(overviewTool(this.runtime));
    // MCP：配置里有启用中的服务才加载（改完配置，之后新开的任务生效）
    const mcp = mcpEnabled(this.runtime.home);
    const allOwnSkills = enabledAssistantSkills(this.runtime.home, running.assistantId);
    const ownSkills = allOwnSkills.filter((skill) => running.skills?.includes(skill.name));
    const ownNames = new Set(ownSkills.map((skill) => skill.name));
    const opened = await this.runtime.pi.open({
      file: this.store.workerFile(running.id),
      cwd: running.cwd ?? homedir(),
      model: running.model ?? this.runtime.settings.settings.models.work.ref,
      thinking: running.thinking ?? this.runtime.settings.settings.models.work.thinking,
      memory: this.runtime.settings.memory().provider,
      skills: [...ownSkills, ...availableSkills(this.runtime.home, undefined, this.runtime.settings.settings.skills?.disabled).filter((skill) => !ownNames.has(skill.name))],
      disabledSkills: this.runtime.settings.settings.skills?.disabled,
      systemPrompt: () =>
        buildWorkerPrompt(this.store, running.id, { ...this.promptSettings(), abilities, desktopEnabled: !!desktop, knowledgeNames: knowledge.map((collection) => collection.name) }),
      tools: [
        ...workerTools(abilities),
        ...customTools.map((tool) => tool.name),
        ...(mcp ? MCP_SESSION_TOOLS : []),
      ],
      customTools,
      mcp,
    });
    if (this.store.job(running.id)?.status !== "running") { opened.session.dispose(); await desktop?.dispose(); return; }
    const mcpServers = mcpServerDisplay(this.runtime.home);

    const worker: WorkerState = {
      job: running,
      session: opened.session,
      manager: opened.manager,
      askedFollowUp: false,
      lastActivityAt: Date.now(),
      pausedMs: 0,
      nextReminder: running.expect?.source === "routine" ? 1.5 : 1,
      steps: new Map(),
      readPaths: new Map(),
      queued: [],
      mcpServers,
      desktop,
    };
    this.workers.set(running.id, worker);
    if (followUp !== undefined) {
      const step: JobStep = { id: `q${Date.now()}-0`, kind: "text", at: new Date().toISOString(), from: "user", text: followUp, queued: true };
      worker.queued.push(step);
      this.emitStep(worker, step);
    }
    const images = followUp === undefined ? imageContents(running.inputs) : [];

    opened.session.subscribe((event) => {
      if (worker.stopped) return;
      if (event.type === "tool_execution_start") {
        if (event.toolName === "read" && typeof event.args?.path === "string") worker.readPaths.set(event.toolCallId, event.args.path);
        this.recordActivity(worker, event.toolName, event.args ?? {});
        const step = toolStep({
          id: event.toolCallId,
          name: event.toolName,
          args: event.args ?? {},
          at: new Date().toISOString(),
          cwd: worker.job.cwd ?? "",
          mcpServers: worker.mcpServers,
          running: true,
        });
        worker.steps.set(event.toolCallId, step);
        this.emitStep(worker, step);
        return;
      }
      if (event.type === "tool_execution_update") {
        const step = worker.steps.get(event.toolCallId);
        if (step) this.emitStep(worker, this.withStepOutput(worker, step, textOfContent(event.partialResult?.content)));
        return;
      }
      if (event.type === "tool_execution_end") {
        if (event.toolName === "read" && !event.isError) {
          const readPath = worker.readPaths.get(event.toolCallId);
          if (readPath) {
            try { this.recordSkillUse(worker, readPath); }
            catch (error) { console.error("记录技能用量失败：", error); }
          }
        }
        worker.readPaths.delete(event.toolCallId);
        const step =
          worker.steps.get(event.toolCallId) ??
          toolStep({ id: event.toolCallId, name: event.toolName, args: {}, cwd: worker.job.cwd ?? "", mcpServers: worker.mcpServers });
        worker.steps.delete(event.toolCallId);
        this.emitStep(
          worker,
          this.withStepOutput(worker, step, textOfContent(event.result?.content), {
            isError: event.isError,
            durationMs: event.durationMs,
          }),
        );
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = textOfContent(event.message.content).trim();
        if (text) worker.lastText = text;
        worker.lastActivityAt = Date.now();
        this.recordSteps(worker, event.message);
        this.addUsage(worker, event.message);
        return;
      }
      if (event.type === "message_start" || event.type === "agent_start") {
        worker.lastActivityAt = Date.now();
        if (event.type === "message_start" && event.message.role === "user") {
          // 补的那句被任务读到了：id 和 transcript 推导出来的一样，前端拿它换掉「等待读取」那行
          const text = textOfContent(event.message.content).trim();
          const index = worker.queued.findIndex((step) => step.text === text);
          if (index >= 0) {
            worker.queued.splice(index, 1);
            this.emitStep(worker, { id: `u${event.message.timestamp}`, kind: "text", at: new Date(event.message.timestamp).toISOString(), from: "user", text });
          }
        }
        return;
      }
      if (event.type === "agent_settled") void this.onSettled(worker);
    });

    void opened.session
      .prompt(followUp ?? running.instruction, images.length ? { images } : undefined)
      .catch(async (error: unknown) => {
        if (!worker.stopped) await this.finish(running.id, "failed", undefined, error instanceof Error ? error.message : String(error));
      });
  }

  private recordSkillUse(worker: WorkerState, path: string): void {
    const job = this.store.job(worker.job.id);
    if (!job) return;
    let absolute: string;
    try { absolute = realpathSync(resolve(job.cwd ?? homedir(), path)); }
    catch { return; }
    const skill = usableAssistantSkills(this.runtime.home, job.assistantId).find((item) => existsSync(item.path) && realpathSync(item.path) === absolute);
    if (!skill || job.skillsUsed?.includes(skill.name)) return;
    recordAssistantSkillUse(this.runtime.home, job.assistantId, skill.name);
    const next = { ...job, skillsUsed: [...(job.skillsUsed ?? []), skill.name] };
    this.store.saveJob(next);
    worker.job = next;
    this.bus.emit({ type: "job", job: next });
    this.bus.emit({ type: "skills", assistantId: job.assistantId });
  }

  private recordActivity(worker: WorkerState, toolName: string, args: Record<string, unknown>): void {
    worker.lastActivityAt = Date.now();
    const line = activityFor(toolName, args);
    if (!line) return;
    const job = this.store.job(worker.job.id);
    if (!job) return;
    const stats = { ...job.stats };
    if (line.verb === "读") stats.reads += 1;
    else if (line.verb === "跑") stats.commands += 1;
    else if (line.verb === "改" || line.verb === "写") stats.edits += 1;
    const activity = [...job.activity, line].slice(-ACTIVITY_LIMIT);
    const next = { ...job, stats, activity };
    this.store.saveJob(next);
    worker.job = next;
    this.bus.emit({ type: "activity", jobId: job.id, line, stats });
  }

  /** 推一步给前端；同一个 id 到了就是替换。 */
  private emitStep(worker: WorkerState, step: JobStep): void {
    this.bus.emit({ type: "job_step", jobId: worker.job.id, step });
  }

  /** 工具结果装进步骤：事件里只给 4KB，全文落盘给路径（详情页要全文时拉 transcript）。 */
  private withStepOutput(
    worker: WorkerState,
    step: JobStep,
    full: string,
    extra: { isError?: boolean; durationMs?: number } = {},
  ): JobStep {
    const jobId = worker.job.id;
    return withOutput(step, full, {
      limit: STEP_EVENT_LIMIT,
      ...extra,
      save: (stepId, text) => this.store.writeStepOutput(jobId, stepId, text),
    });
  }

  /** 助手消息里的说明文字和思考摘要也进时间线（工具步骤已由执行事件推过了）。 */
  private recordSteps(worker: WorkerState, message: { timestamp?: number; content?: unknown }): void {
    const blocks: any[] = Array.isArray(message.content) ? (message.content as any[]) : [];
    const stamp = message.timestamp ?? Date.now();
    const at = new Date(stamp).toISOString();
    blocks.forEach((block, index) => {
      if (block?.type === "text") {
        const text = String(block.text ?? "").trim();
        if (text) this.emitStep(worker, { id: `t${stamp}-${index}`, kind: "text", at, from: "assistant", text });
        return;
      }
      if (block?.type === "thinking") {
        const text = String(block.thinking ?? "").trim();
        if (text && !block.redacted) this.emitStep(worker, { id: `k${stamp}-${index}`, kind: "thinking", at, text });
      }
    });
  }

  /** token 和花费累加到任务上，详情顶部实时看得到。 */
  private addUsage(worker: WorkerState, message: { usage?: { input: number; output: number; cost: { total: number } } }): void {
    const usage = message.usage;
    if (!usage) return;
    const job = this.store.job(worker.job.id);
    if (!job) return;
    const before = job.usage ?? { input: 0, output: 0, cost: 0 };
    const next: Job = {
      ...job,
      usage: {
        input: before.input + usage.input,
        output: before.output + usage.output,
        cost: Number((before.cost + usage.cost.total).toFixed(6)),
      },
    };
    this.store.saveJob(next);
    worker.job = next;
    this.bus.emit({ type: "job", job: next });
  }

  private async onSettled(worker: WorkerState): Promise<void> {
    if (worker.stopped) return;
    const job = this.store.job(worker.job.id);
    if (!job || job.status === "done" || job.status === "stuck" || job.status === "failed" || job.status === "stopped") return;
    if (worker.reported) {
      await this.applyReport(worker.job.id);
      return;
    }
    if (worker.askedFollowUp) {
      await this.finish(worker.job.id, "stuck", undefined, "未提交结果");
      return;
    }
    worker.askedFollowUp = true;
    const session = worker.session;
    if (!session) {
      await this.finish(worker.job.id, "stuck", undefined, "未提交结果");
      return;
    }
    await session.prompt("这一轮结束了，还没有交结果。做完了就调用 report 交结果；没做完，也用 report 说明做到哪、卡在哪。");
  }

  /** report 工具收到结果后由 worker-tools 调用。 */
  async applyReport(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker?.reported || worker.stopped) return;
    const status: JobStatus = worker.reported.outcome === "done" ? "done" : "stuck";
    // 不写原因：outcome 只说明模型自己认为没做完，状态词（受阻、待确认）卡片上已经写过一遍，
    // 当原因存下来就会重复。真正的原因由看门狗和停止操作给。
    await this.finish(workerId, status, worker.reported.result, undefined, worker.reported.files);
  }

  reportFromTool(jobId: string, data: { outcome: "done" | "stuck" | "need_approval"; result: string; files?: string[] }): void {
    const worker = this.workers.get(jobId);
    if (!worker) return;
    worker.reported = { ...data, ...(data.files ? { files: data.files.map((path) => resolve(worker.job.cwd ?? this.store.workDir(jobId), path)) } : {}) };
    worker.finishTimer ??= setTimeout(() => void this.applyReport(jobId), 200);
  }

  private async finish(
    jobId: string,
    status: JobStatus,
    summary?: string,
    reason?: string,
    files?: string[],
  ): Promise<void> {
    const pending = this.finishing.get(jobId);
    if (pending) return pending;
    const task = this.finishOnce(jobId, status, summary, reason, files);
    this.finishing.set(jobId, task);
    try { await task; } finally { this.finishing.delete(jobId); }
  }

  private async finishOnce(jobId: string, status: JobStatus, summary?: string, reason?: string, files?: string[]): Promise<void> {
    const job = this.store.job(jobId);
    if (!job || ENDED.includes(job.status)) return;
    const worker = this.workers.get(jobId);
    if (worker) worker.stopped = true;
    if (worker?.finishTimer) clearTimeout(worker.finishTimer);
    this.followUps.delete(jobId);
    await worker?.desktop?.dispose();
    await this.settle(job, status, { summary, reason, files, lastText: worker?.lastText });

    if (worker?.session) {
      worker.session.dispose();
    }
    this.workers.delete(jobId);
    this.pump();
  }

  /** 写 report.md、工作日志、推事件。 */
  private async settle(
    job: Job,
    status: JobStatus,
    options: { summary?: string; reason?: string; files?: string[]; lastText?: string },
  ): Promise<void> {
    const endedAt = new Date().toISOString();
    // 报告原样保留（不压成一行、不截断）：任务详情和 report.md 要完整的；只有推给助手的事件太长时才截
    const cleanSummary = options.summary?.trim() ? options.summary : undefined;
    const statusText = status === "done" ? "已完成" : status === "stuck" ? "受阻" : status === "stopped" ? "已停止" : "失败";
    const reportPath = this.store.writeReport(
      job.id,
      [
        `# ${job.title}`,
        "",
        `状态：${statusText}${options.reason ? `（${options.reason}）` : ""}`,
        `结束时间：${monthDayTimeText(this.runtime.settings.settings.general.timezone)}`,
        "",
        "## 结果",
        "",
        cleanSummary ?? options.lastText ?? "（没有回复）",
        "",
        "## 任务说明",
        "",
        job.instruction,
      ].join("\n"),
    );
    const next: Job = {
      ...job,
      status,
      endedAt,
      reportPath,
      ...(job.startedAt ? { durationMs: Date.parse(endedAt) - Date.parse(job.startedAt) } : {}),
      ...(options.summary !== undefined ? { summary: cleanSummary } : {}),
      ...(options.reason ? { statusReason: options.reason } : {}),
      ...(options.summary !== undefined ? { files: options.files ?? [] } : {}),
    };
    this.store.saveJob(next);
    for (const path of options.files ?? []) void this.runtime.knowledge.collect({ origin: "output", path, description: job.title, assistantId: job.assistantId, jobId: job.id }).catch((error) => console.error("知识库收集失败：", error));
    // 转交里的任务：先把转交重新打开，结果由目标助手接着处理完才回流 Hob（见 DelegationManager.resume）
    const delegationId = !job.routineId && job.delegationId && this.runtime.delegations.resume(job.delegationId) ? job.delegationId : undefined;
    this.bus.emit({ type: "job", job: next });
    pushJobEnd({ push: this.runtime.push, store: this.store }, next);
    this.publishBusy(job.assistantId);
    const assistant = this.store.assistant(job.assistantId);
    this.store.addWorklog(job.assistantId, {
      at: endedAt,
      text: `任务${statusText}：${job.title}`,
      jobId: job.id,
    });
    this.bus.emit({ type: "profile", assistantId: job.assistantId });
    const toolCount = this.transcript(job.id).filter((step) => step.kind === "tool" && (!next.startedAt || step.at >= next.startedAt)).length;

    if (job.routineId) {
      const routine = this.store.routine(job.routineId);
      if (routine) {
        const run: RoutineRun = {
          jobId: job.id, at: endedAt, status,
          ...(next.durationMs !== undefined ? { durationMs: next.durationMs } : {}),
          tools: next.stats.reads + next.stats.commands + next.stats.edits,
          ...(next.usage ? { tokens: next.usage.input + next.usage.output } : {}),
        };
        const runs = [run, ...routine.runs.filter((item) => item.jobId !== job.id)].slice(0, 20);
        const updated = { ...routine, runs };
        this.store.saveRoutine(updated);
        this.bus.emit({ type: "routine", routine: updated });
        await this.runtime.router
          .event(job.assistantId, assistantJobResultEvent(this.runtime.home, next, { prefix: `定时任务「${routine.name}」`, toolCount }), {
            routine: { id: routine.id, name: routine.name, jobId: job.id },
          })
          .catch(() => undefined);
      }
    } else if (assistant) {
      const text = assistantJobResultEvent(this.runtime.home, next, { toolCount });
      if (delegationId) void this.runtime.router.relay(job.assistantId, text, delegationId).catch(() => this.runtime.delegations.turnEnded(delegationId, "目标助手处理失败", true));
      else await this.runtime.router.event(job.assistantId, text).catch(() => undefined);
    }
  }

  async reply(jobId: string, text: string, source: "user" | "router" = "user"): Promise<void> {
    await this.finishing.get(jobId);
    const sediment = this.sediments.get(jobId);
    if (sediment) {
      sediment.cancelled = true;
      await sediment.session?.abort().catch(() => undefined);
      await sediment.task;
    }
    const job = this.store.job(jobId);
    if (!job) throw new Error("没有这个任务。");
    if (ENDED.includes(job.status)) {
      const { endedAt, statusReason, durationMs, summary, files, reportPath, sediment, ...rest } = job;
      const previous = job.rounds ?? [];
      // 这一轮的报告另存一份：下一轮写报告会覆盖原文件。原文件不在了就不存，不让续做因此失败
      const savedReport = reportPath && existsSync(reportPath) ? join(dirname(reportPath), `report.round-${previous.length + 1}.md`) : undefined;
      if (reportPath && savedReport) copyFileSync(reportPath, savedReport);
      const used = previous.reduce((sum, round) => ({ input: sum.input + (round.usage?.input ?? 0), output: sum.output + (round.usage?.output ?? 0), cost: sum.cost + (round.usage?.cost ?? 0) }), { input: 0, output: 0, cost: 0 });
      const usage = job.usage && previous.every((round) => round.usage) ? { input: job.usage.input - used.input, output: job.usage.output - used.output, cost: Number((job.usage.cost - used.cost).toFixed(6)) } : undefined;
      const ended: JobRound = { status: job.status, statusReason, startedAt: job.startedAt, endedAt, durationMs, summary, files, usage, reportPath: savedReport, followUp: text };
      const rounds = [...previous, ended];
      const queued: Job = { ...rest, rounds, status: "queued", expect: { minutes: 10, source: "default" }, startedAt: undefined };
      this.store.saveJob(queued);
      try {
        await this.runtime.router.addItem(job.assistantId, { kind: "job", jobId, round: rounds.length });
      } catch (error) {
        this.store.saveJob(job);
        throw error;
      }
      this.followUps.set(jobId, `${source === "router" ? `「${this.store.assistant(job.assistantId)?.name ?? job.assistantId}」` : "用户"}接着说（${monthDayTimeText(this.runtime.settings.settings.general.timezone)}）：${text}`);
      this.bus.emit({ type: "job", job: queued });
      this.publishBusy(job.assistantId);
      this.queue.push(jobId);
      this.pump();
      return;
    }
    const worker = this.workers.get(jobId);
    if (!worker?.session) throw new Error("这个任务当前未在运行。");
    // 任务卡在 ask_user 等答复：用户在对话里回的话就是答复，不然插话要等提问返回才读得到，任务永远等下去
    const asking = worker.ask ? this.store.approvals().find((item) => item.jobId === jobId && item.status === "pending") : undefined;
    if (asking) {
      const answered: Approval = source === "user"
        ? { ...asking, status: "answered", answerText: text, answeredAt: new Date().toISOString() }
        : { ...asking, status: "expired" };
      this.store.saveApproval(answered);
      this.bus.emit({ type: "approval", approval: answered });
      this.resolveAsk(answered, source === "user" ? `用户没有选给出的选项，而是在对话里回复：${text}` : `「${this.store.assistant(job.assistantId)?.name ?? job.assistantId}」回复：${text}`);
      return;
    }
    // 先显示出来：任务在跑命令时要等这一步做完才读到，界面上标着「等待读取」
    const step: JobStep = { id: `q${Date.now()}-${worker.queued.length}`, kind: "text", at: new Date().toISOString(), from: "user", text, queued: true };
    worker.queued.push(step);
    this.emitStep(worker, step);
    try {
      if (worker.session.isStreaming) await worker.session.steer(text);
      else void worker.session.prompt(text).catch(() => { worker.queued = worker.queued.filter((item) => item !== step); });
    } catch (error) {
      worker.queued = worker.queued.filter((item) => item !== step);
      throw error;
    }
  }

  private setSediment(jobId: string, sediment: SedimentStatus): void {
    const job = this.store.job(jobId);
    if (!job) return;
    const next = { ...job, sediment };
    this.store.saveJob(next);
    this.bus.emit({ type: "job", job: next });
  }

  startSediment(jobId: string, options: { into?: string; note?: string } = {}): void {
    const job = this.store.job(jobId);
    if (!job) throw new Error("任务不存在");
    if (job.status !== "done" || this.finishing.has(jobId) || this.workers.has(jobId)) throw new Error("只有已完成的任务可以沉淀");
    if (this.sediments.has(jobId)) throw new Error("任务正在沉淀技能");
    const skills = usableAssistantSkills(this.runtime.home, job.assistantId);
    const into = options.into ? skills.find((skill) => skill.name === options.into) : undefined;
    if (options.into && !into) throw new Error(`没有这个技能：${options.into}。现有的：${skills.map((skill) => skill.name).join("、") || "无"}`);
    const state: { cancelled: boolean; session?: AgentSession; task?: Promise<void> } = { cancelled: false };
    this.sediments.set(jobId, state);
    this.setSediment(jobId, { status: "running" });
    state.task = this.sedimentRound(job, state, into, options.note).catch(async (error) => {
      if (state.cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error("沉淀技能失败：", error);
      this.setSediment(jobId, { status: "failed", reason: message });
      await this.runtime.router.addItem(job.assistantId, { kind: "note", icon: "info", text: `技能沉淀失败：${message}` }).catch((noteError) => console.error("写入沉淀失败提示失败：", noteError));
    }).finally(async () => {
      try {
        const sediment = this.store.job(jobId)?.sediment;
        if (!sediment || sediment.status === "running") return;
        const result = sediment.status === "saved" ? (sediment.updated ? `已更新技能「${sediment.title}」（${sediment.name}）· 第 ${sediment.version} 版` : `已沉淀技能「${sediment.title}」（${sediment.name}）`) : sediment.status === "empty" ? `没有沉淀，${sediment.reason}` : `沉淀失败，${sediment.reason}`;
        await this.runtime.router.event(job.assistantId, `任务「${job.title}」（${job.id}）沉淀完了：${result}。`).catch((error) => console.error("发送沉淀结果失败：", error));
      } finally { this.sediments.delete(jobId); }
    });
  }

  private async sedimentRound(job: Job, state: { cancelled: boolean; session?: AgentSession }, into: ReturnType<typeof usableAssistantSkills>[number] | undefined, note?: string): Promise<void> {
    let saved: Extract<SedimentStatus, { status: "saved" }> | undefined;
    const savedSkills = new Set<string>();
    let lastText = "";
    const skillTool = {
      name: "save_skill", label: "保存技能",
      description: "保存技能。content 是 SKILL.md 的正文，开头的 name 和 description 由 Hob 写。files 放脚本和参考资料，路径以 scripts/ 或 references/ 开头：给 from（工作目录里已有文件的路径，直接复制），或者给 content。",
      parameters: Type.Object({
        ...(!into ? { name: Type.String({ description: "技能的目录名，只用小写字母、数字和连字符，如 weekly-report。" }) } : {}),
        title: Type.String({ description: "中文名，如「每周周报」。" }),
        description: Type.String({ description: "什么时候用，一句话，120 字以内。" }),
        content: Type.String({ description: "SKILL.md 正文。" }),
        files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.Optional(Type.String()), from: Type.Optional(Type.String()) }), { description: "可选，脚本和参考资料：path 加 content，或 path 加 from（工作目录里已有文件的路径，直接复制）。" })),
      }),
      execute: async (_id: string, params: any) => {
        if (state.cancelled || this.store.job(job.id)?.status !== "done") throw new Error("任务已继续，取消沉淀");
        const name = into?.name ?? params.name;
        const overwriteVersion = savedSkills.has(name);
        if (!into && !overwriteVersion && listAssistantSkills(this.runtime.home, job.assistantId).some((skill) => skill.name === name)) {
          return { content: [{ type: "text" as const, text: `「${name}」已经有了，新技能换个名字。` }], details: undefined, isError: true };
        }
        const files = readSkillFiles(job.cwd ?? this.store.workDir(job.id), params.files);
        const skill = saveAssistantSkill(this.runtime.home, job.assistantId, { ...params, name, files }, job.id, false, { overwriteVersion });
        savedSkills.add(skill.name);
        saved = { status: "saved", name: skill.name, title: skill.title, version: skill.version, updated: !!into };
        if (!overwriteVersion) {
          let text = skill.version === 1 ? `已沉淀技能「${skill.title}」` : `已更新技能「${skill.title}」· 第 ${skill.version} 版`;
          const routine = job.routineId && this.store.routine(job.routineId);
          if (routine && !routine.skill) {
            this.runtime.routines.update(routine.id, { skill: skill.name });
            text = `已沉淀技能「${skill.title}」，以后定时执行按它做`;
          }
          await this.runtime.router.addItem(job.assistantId, { kind: "note", icon: "skill", text, path: skill.path });
        }
        this.bus.emit({ type: "skills", assistantId: job.assistantId });
        return { content: [{ type: "text" as const, text: "技能已保存。" }], details: undefined };
      },
    };
    const message = `${SEDIMENT_PROMPT_HEAD}，下次接到同类的事，照着它就能一次做成用户要的样子。

下一次的情况会和这次不一样，所以技能写这一类事怎么做，不写这一次的经过和数据。按做事的顺序写步骤，带上要用的命令、查询和判断点，怎么判断结果对不对，写在对应的那一步里。用户在过程中纠正过的做法、对结果提过的要求，最能帮下次少走弯路，要写进去。踩过的坑写成一条规则加一句原因，放在它影响的那一步；会变的情况写怎么查，不写死。每条经验只写一次，修补时直接改掉写错的那句。

技能要照着能跑通。写进去的只读命令和查询，存之前再跑一遍，确认照着写的就能用；能写成脚本的步骤，写成只读脚本放在 scripts/，一次输出要看的全部结果，跑一遍、输出对得上再保存。会改东西的步骤只写在正文里，留给以后的任务确认后再执行。偶尔才用得上的细节放 references/，按主题起文件名。

有几类东西留在技能外面：临时故障和网络错误，环境没装好、没配好导致的失败只写怎么装好、配好；「某个工具不能用」这类结论，环境修好以后它还会一直挡路；这次没走通的尝试。助手的规则和工具说明里已经有的，也不用重复。

${into ? `这次在技能「${into.title}」（${into.name}，第 ${into.version} 版）的基础上改，先读它现在的内容。` : "这次新建一个技能，名字和说明按这一类事来起，不按这一次。"}${note ? `\n「${this.store.assistant(job.assistantId)?.name ?? job.assistantId}」交代：${note}` : ""}
一次性的事、几步就做完的事，或者照常做就不会走弯路的事，没有值得沉淀的，回复「没有需要沉淀的」就好。`;
    if (state.cancelled) return;
    // 沉淀时只补上助手明确指定的目标技能，以及交代中点名的技能。
    const mentioned = usableAssistantSkills(this.runtime.home, job.assistantId).filter((skill) => job.skills?.includes(skill.name) || skill.name === into?.name || (!!note && (note.includes(skill.name) || note.includes(skill.title))));
    const own = enabledAssistantSkills(this.runtime.home, job.assistantId).filter((skill) => mentioned.some((item) => item.name === skill.name));
    const ownNames = new Set(own.map((skill) => skill.name));
    const common = availableSkills(this.runtime.home, undefined, this.runtime.settings.settings.skills?.disabled).filter((skill) => !ownNames.has(skill.name));
    const opened = await this.runtime.pi.open({
      file: this.store.workerFile(job.id), cwd: job.cwd ?? homedir(),
      model: job.model ?? this.runtime.settings.settings.models.work.ref,
      thinking: job.thinking ?? this.runtime.settings.settings.models.work.thinking,
      memory: "off", systemPrompt: () => buildWorkerPrompt(this.store, job.id, this.promptSettings()),
      tools: ["read", "ls", "grep", "find", "bash", "save_skill"], customTools: [skillTool],
      skills: [...common, ...own],
    });
    state.session = opened.session;
    const steps = new Map<string, JobStep>();
    opened.session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "user") {
        this.bus.emit({ type: "job_step", jobId: job.id, step: { id: `u${event.message.timestamp}`, kind: "text", at: new Date(event.message.timestamp).toISOString(), from: "user", text: "沉淀技能" } });
      } else if (event.type === "tool_execution_start") {
        const step = toolStep({ id: event.toolCallId, name: event.toolName, args: event.args ?? {}, at: new Date().toISOString(), cwd: job.cwd ?? "", running: true });
        steps.set(event.toolCallId, step);
        this.bus.emit({ type: "job_step", jobId: job.id, step });
      } else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        const step = steps.get(event.toolCallId);
        if (step) {
          const text = textOfContent(event.type === "tool_execution_update" ? event.partialResult?.content : event.result?.content);
          const next = withOutput(step, text, { limit: STEP_EVENT_LIMIT, ...(event.type === "tool_execution_end" ? { isError: event.isError, durationMs: event.durationMs } : {}), save: (id, value) => this.store.writeStepOutput(job.id, id, value) });
          this.bus.emit({ type: "job_step", jobId: job.id, step: next });
          if (event.type === "tool_execution_end") steps.delete(event.toolCallId);
        }
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        lastText = textOfContent(event.message.content).trim();
        const worker = { job } as WorkerState;
        this.recordSteps(worker, event.message);
      }
    });
    try {
      if (!state.cancelled) await opened.session.prompt(message);
      if (!state.cancelled) this.setSediment(job.id, saved ?? { status: "empty", reason: lastText || "没有需要沉淀的" });
    } finally { opened.session.dispose(); }
  }

  async stop(jobId: string, reason = "你叫停了"): Promise<void> {
    const job = this.store.job(jobId);
    if (!job) throw new Error("没有这个任务。");
    const worker = this.workers.get(jobId);
    if (worker) {
      // 先标记再 abort：终止命令的过程中模型可能接着把 report 跑完，那不能把 stopped 改成完成
      worker.stopped = true;
      worker.ask?.("（任务被停了）");
      worker.ask = undefined;
      // abort 会把正在执行的工具（bash 子进程）一起终止
      await worker.session?.abort().catch(() => undefined);
    }
    await this.finish(jobId, "stopped", undefined, reason);
  }

  /** Worker 的 ask_user：出审批卡、把任务标成待确认，阻塞到用户答复。 */
  async askQuestion(
    jobId: string,
    input: { title: string; detail?: string; options: ApprovalOption[]; ruleText?: string },
  ): Promise<string> {
    const job = this.store.job(jobId);
    if (!job) throw new Error(`任务不存在：${jobId}`);
    const worker = this.workers.get(jobId);
    const approval: Approval = {
      id: newId("q-"),
      assistantId: job.assistantId,
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      options: input.options,
      status: "pending",
      source: "job",
      jobId,
      ...(input.ruleText ? { ruleText: input.ruleText } : {}),
      createdAt: new Date().toISOString(),
    };
    this.store.saveApproval(approval);
    if (!worker) { this.store.saveApproval({ ...approval, status: "expired" }); return "（任务未在运行）"; }
    const answer = new Promise<string>((resolve) => { worker.ask = resolve; });
    const delegationId = !job.routineId && job.delegationId && this.runtime.delegations.resume(job.delegationId) ? job.delegationId : undefined;
    const waiting: Job = { ...job, status: "waiting" };
    this.store.saveJob(waiting);
    worker.job = waiting;
    worker.pausedAt = Date.now();
    this.bus.emit({ type: "job", job: waiting });
    const sentence = (value: string) => /[。！？.!?]\s*$/.test(value) ? value : `${value}。`;
    const text = `任务「${job.title}」（${job.id}）在等你回复：${sentence(input.title)}${input.detail ? sentence(input.detail) : ""}选项：${input.options.map((option) => `${option.key} ${option.label}`).join("、")}。`;
    if (delegationId) void this.runtime.router.relay(job.assistantId, text, delegationId).catch(() => this.runtime.delegations.turnEnded(delegationId, "目标助手处理失败", true));
    else void this.runtime.router.event(job.assistantId, text).catch((error) => console.error("任务提问投递失败：", error));
    return await answer;
  }

  /** Worker 的 ask_user 等答案时，审批被答复（answer 是回给模型的那句）。 */
  resolveAsk(approval: Approval, answer: string): void {
    const worker = approval.jobId ? this.workers.get(approval.jobId) : undefined;
    const job = approval.jobId ? this.store.job(approval.jobId) : undefined;
    if (job && job.status === "waiting") {
      const next: Job = { ...job, status: "running" };
      this.store.saveJob(next);
      this.bus.emit({ type: "job", job: next });
      if (worker) worker.job = next;
    }
    worker?.ask?.(answer);
    if (worker) {
      worker.ask = undefined;
      if (worker.pausedAt !== undefined) worker.pausedMs += Date.now() - worker.pausedAt;
      worker.pausedAt = undefined;
      worker.lastActivityAt = Date.now();
    }
  }

  startWatchdog(): void {
    this.watchdog ??= setInterval(() => {
      this.checkStalls();
      // 并发小了以后（设置里改的），排队的任务还在等，这里补一次泵
      this.pump();
    }, 30_000);
    this.watchdog.unref?.();
  }

  checkStalls(now = Date.now()): void {
    const idleMs = this.runtime.settings.settings.work.jobStallMinutes * 60_000;
    for (const [jobId, worker] of this.workers) {
      const job = this.store.job(jobId);
      if (job?.status === "running" && job.startedAt && job.expect && worker.pausedAt === undefined) {
        const elapsed = Math.max(0, now - Date.parse(job.startedAt) - worker.pausedMs);
        if (elapsed >= job.expect.minutes * 60_000 * worker.nextReminder) {
          while (elapsed >= job.expect.minutes * 60_000 * worker.nextReminder) worker.nextReminder *= 2;
          const source = job.expect.source === "assistant" ? "派活时估的" : job.expect.source === "routine" ? `这个定时任务以前 ${job.expect.runs} 次的中位数` : "默认 10 分钟";
          const routine = job.routineId && this.store.routine(job.routineId);
          const prefix = routine ? `定时任务「${routine.name}」` : `任务「${job.title}」`;
          const steps = this.transcript(jobId);
          for (const step of worker.steps.values()) {
            const index = steps.findIndex((item) => item.id === step.id);
            if (index >= 0) steps[index] = step; else steps.push(step);
          }
          const lines = jobProcessLines(steps, this.runtime.settings.settings.general.timezone, new Date(now)).slice(0, 10);
          const text = `${prefix}（${job.id}）已运行 ${Math.floor(elapsed / 60_000)} 分钟，超过预计的 ${job.expect.minutes} 分钟（${source}）。\n最近的过程（新的在前）：${lines.length ? `\n${lines.join("\n")}` : ""}`;
          void this.runtime.router.event(job.assistantId, text).catch((error) => console.error("任务超时通知失败：", error));
        }
      }
      // 在等用户答提问不算没响应：等多久都是用户的事
      if (!worker.ask && now - worker.lastActivityAt > idleMs) {
        void this.finish(jobId, "stuck", undefined, `${Math.round(idleMs / 60_000)} 分钟无响应`);
      }
    }
  }

  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  /** 进程重启：没跑完的任务标失败。 */
  recover(): void {
    const now = new Date().toISOString();
    for (const job of this.store.jobs()) {
      if (job.status === "running" || job.status === "queued" || job.status === "waiting") {
        const next: Job = { ...job, status: "failed", endedAt: now, statusReason: "Hob 重启，任务中断" };
        this.store.saveJob(next);
        this.bus.emit({ type: "job", job: next });
      } else if (job.sediment?.status === "running") {
        this.setSediment(job.id, { status: "failed", reason: "Hob 重启，沉淀中断" });
      }
    }
    for (const approval of this.store.approvals()) {
      if (approval.status === "pending" && approval.source === "job") {
        this.store.saveApproval({ ...approval, status: "expired" });
      }
    }
    this.queue = [];
    this.followUps.clear();
  }

  disposeAll(): void {
    this.stopWatchdog();
    for (const state of this.sediments.values()) { state.cancelled = true; void state.session?.abort(); }
    for (const worker of this.workers.values()) { worker.session?.dispose(); void worker.desktop?.dispose(); }
    this.workers.clear();
  }

  /** 测试用：等所有任务结束。 */
  async waitIdle(timeoutMs = 15_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const active = this.store
        .jobs()
        .filter((job) => job.status === "running" || job.status === "queued" || job.status === "waiting");
      if (!active.length && !this.finishing.size && !this.sediments.size) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
