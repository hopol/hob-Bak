import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { commandSummary } from "../../shared/command.ts";
import { t } from "../../shared/i18n.ts";
import type {
  ActivityLine,
  Approval,
  ApprovalOption,
  Group,
  Job,
  JobsPage,
  JobRound,
  JobStatus,
  JobStep,
  RoutineRun,
  SedimentStatus,
  SavedSkill,
} from "../../shared/types.ts";
import { IMAGE_TYPES, isImagePath } from "../../shared/media.ts";
import { newId } from "./ids.ts";
import { resolveMovedPath } from "./layout.ts";
import { availableDesktopTools, browserShellEnv, type DesktopToolSession } from "./desktop-tools.ts";
import { imageConfigured } from "./image.ts";
import { boundKnowledge, findKnowledgeTool, searchKnowledgeTool } from "./knowledge-tools.ts";
import { pluginCommandToolsForAssistant, pluginToolDisplayNames, pluginToolsForAssistant } from "./plugin-host.ts";
import { engineDir } from "./config.ts";
import { jobModel, assistantInGroup } from "./models.ts";
import { duration, jobProcessLines, reviewedSkillsText } from "./job-view.ts";
import { overviewTool } from "./overview.ts";
import { buildWorkerPrompt, type Abilities, type PromptSettings } from "./prompt.ts";
import { loadedVisibleSkills, skillDirOf, visibleSkills } from "./skills.ts";
import { combinedSkills, recordSkillUse, usableAssistantSkills } from "./assistant-skills.ts";
import type { EventDetails } from "./router.ts";
import type { HobRuntime } from "./runtime.ts";
import { briefModelError, showPath } from "./text.ts";
import { monthDayTimeText } from "./time.ts";
import { SEDIMENT_PROMPT_HEAD, STEP_EVENT_LIMIT, JOB_REMINDER_LEAD, browserCommandLabel, deriveSteps, reminderStep, textOfContent, toolStep, withOutput } from "./transcript.ts";
import { registerAskTool, registerFillNewPasswordTool, registerImageTool, registerLoginTool, registerReportTool } from "./worker-tools.ts";
import { scriptToolList } from "./script-tools.ts";
import { proxyEnvironment } from "./network-proxy.ts";
import { searchTools } from "./search.ts";
import { pauseToolTimeoutForUser } from "./tool-timeout.ts";
import { saveSkillTool } from "./save-skill.ts";
import { SKILL_WRITING_GUIDANCE } from "./skill-guidance.ts";
import { CWD_BOUND_LOCKED, isInside, loadWorkspaceAgentsFile, normalizeWorkspaceCwdInput, resolveWorkspaceCwd, validateWorkspaceCwd } from "./workspace.ts";

const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ACTIVITY_LIMIT = 200;
const ENDED: JobStatus[] = ["done", "stuck", "failed", "stopped"];

/** 这一轮没交结果时的提醒：续做、沉淀都用这一句。 */
const NO_RESULT_PROMPT = "这一轮结束了，还没有提交结果。完成后调用 report 提交结果；未完成时，也用 report 说明做到哪、受阻原因、缺什么。";

/** 沉淀消息的前四段（从 SEDIMENT_PROMPT_HEAD 接下去），和以前逐字一致。 */
const SEDIMENT_BODY = `，下次接到同类的事，照着它就能一次做成用户要的样子。\n\n${SKILL_WRITING_GUIDANCE}\n\n`;

/** 沉淀这一轮发给任务的话（第 7.1 节）：改已有技能给它现在的目录，新建给技能目录。 */
export function sedimentMessage(input: { note?: string; assistantName: string }): string {
  const note = input.note ? `\n\n「${input.assistantName}」交代：${input.note}` : "";
  return `${SEDIMENT_PROMPT_HEAD}${SEDIMENT_BODY}改已有的还是新建、新建几份，看着你能用的技能判断：这次的做法属于已有的哪一类，就在那份上改；是另一类事的做法，新建一份，名字和说明按这一类事来起，不按这一次。新建或者大改，在工作目录里写好整个技能文件夹，用 save_skill 的 from 存；只改几句，用 edits。${note}\n\n存好以后调用 report，result 里写这次存了哪些技能、各改了什么。一次性的事、几步就完成的事，或者照常执行就不会走弯路的事，没有值得沉淀的，不用存，调用 report 说一句为什么就好。`;
}

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

/** 校验任务工作目录：必须存在且为目录、在 Hob 数据目录之外。可以是数据目录的上级（比如家目录）：写保护照样挡住对数据目录的改动。 */
export function validateJobCwd(home: string, cwd: string): string {
  return validateWorkspaceCwd(cwd, home, { jobError: true, allowAncestorOfHome: true });
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
  expectMinutes?: number;
  delegationId?: string;
  /** 在群里开的任务：卡片进这个群的时间线，结果回到这个成员在群里的会话 */
  groupId?: string;
  /** 群里派给别的成员时，派给它的那个助手（不填就是执行人自己派的） */
  startedBy?: string;
  /** 这些任务都做完了才开始（start_job 的 after） */
  after?: string[];
}

interface WorkerState {
  job: Job;
  session?: AgentSession;
  manager?: SessionManager;
  reported?: { outcome: "done" | "stuck" | "need_approval"; result: string; files?: string[] };
  lastText?: string;
  /** 这一轮最后一条模型回复是出错（连重试也放弃了）：没交结果时，原因要写它，不写「没交代」 */
  turnError?: string;
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
  scriptRevokes?: Set<() => void>;
  desktop?: DesktopToolSession;
}

/** 一次回顾：任务自己的会话再跑一轮。 */
interface SedimentState {
  jobId: string;
  cancelled: boolean;
  saved: SavedSkill[];
  session?: AgentSession;
  desktop?: DesktopToolSession;
  task?: Promise<void>;
  /** 这一轮交过的报告，避免重复处理。 */
  report?: { ok: boolean; text: string };
  /** 模型调用出错（连接断了、额度用完）：这一轮按失败收尾 */
  error?: string;
  lastText?: string;
}

/** 推给助手的任务结果最多带这么多字的报告。 */
const EVENT_SUMMARY_MAX = 3000;

/** 结果事件的开头：谁做的这件事，助手说给用户听时照这个写，和任务记录对得上。 */
export function jobResultHeader(job: Job): string {
  return `「${job.assistantName ?? job.assistantId}」的任务「${job.title}」`;
}

export function jobResultEvent(job: Job, prefix = jobResultHeader(job), skillTitles: string[] = [], toolCount = job.stats.reads + job.stats.commands + job.stats.edits, hint?: string): string {
  const status = job.status === "done" ? "已完成" : job.status === "stuck" ? "受阻" : job.status === "stopped" ? "已停止" : "失败";
  const result = job.summary;
  const header = `${prefix}（${job.id}）${status}${job.durationMs !== undefined ? `，用时 ${duration(job.durationMs)}${job.expect ? `，预计 ${job.expect.minutes} 分钟` : ""}` : ""}。\n过程：工具操作 ${toolCount} 次，${skillTitles.length ? `用了技能${skillTitles.map((title) => `「${title}」`).join("")}` : "没用技能"}。${hint ? `\n${hint}` : ""}`;
  if (!result) return `${header}\n${job.statusReason ?? "没有结果"}`;
  return result.length > EVENT_SUMMARY_MAX
    ? `${header}\n结果（共 ${result.length} 字，以下是前 3,000 字；全文：${job.reportPath}）：\n${result.slice(0, EVENT_SUMMARY_MAX)}`
    : `${header}\n结果：\n${result}`;
}

/** 提示行和结果里要的那几项：哪份技能、叫什么、是不是从这个任务沉淀出来的。 */
export type SkillName = { name: string; title?: string; fromJobId?: string; updatedAt?: string };

/**
 * 任务做完就提醒回顾：用到了技能不代表没东西可沉淀，一个任务可能用好几份技能，也可能发现技能里没写到的做法。
 */
export function sedimentHint(home: string, job: Job, skills: SkillName[] = usableAssistantSkills(home, job.assistantId)): string | undefined {
  if (job.status !== "done") return undefined;
  const used = (job.skillsUsed ?? []).map((name) => skills.find((skill) => skill.name === name)?.title ?? name);
  return used.length
    ? `这个任务用了技能${used.map((title) => `「${title}」`).join("")}。可以用 review_job 让它回顾一遍，有没有值得沉淀的由它判断：技能里没写到的做法、写错的地方，它会补进对应的那份；是另一类事的做法，它会新建一份。`
    : "这个任务没用到技能。可以用 review_job 让它回顾一遍，把能复用的做法沉淀下来，有没有值得沉淀的由它判断。";
}

/** 发给任务所属助手的结果事件。转交结束发给 Hob 的汇总用它不带提醒的那份（delegations.ts）。 */
export function assistantJobResultEvent(home: string, job: Job, options: { prefix?: string; toolCount?: number; group?: Group; skills?: SkillName[] } = {}): string {
  const skills = options.skills ?? combinedSkills(home, job.assistantId, options.group);
  const skillTitles = (job.skillsUsed ?? []).map((name) => skills.find((skill) => skill.name === name)?.title ?? name);
  const filesNote = job.files?.length ? `\n任务交来的文件：${job.files.join("、")}。` : "";
  const text = jobResultEvent(job, options.prefix ?? jobResultHeader(job), skillTitles, options.toolCount ?? job.stats.reads + job.stats.commands + job.stats.edits, sedimentHint(home, job, skills));
  return `${text}${filesNote}`;
}

/** 结束状态的中文说法（事件、原因和提示里都用这几个词）。 */
function endWord(status: JobStatus): string {
  return status === "done" ? "已完成" : status === "stuck" ? "受阻" : status === "stopped" ? "已停止" : status === "failed" ? "失败" : "没结束";
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
    case "bash": {
      const command = String(args.command ?? "");
      return { at: new Date().toISOString(), verb: "跑", text: browserCommandLabel(command) ?? trim(commandSummary(command), 120) };
    }
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
  private sediments = new Map<string, SedimentState>();

  private watchdog?: NodeJS.Timeout;
  /** 测试中将模型和工具的时限调到毫秒级。 */
  stallOverrideMs?: number;

  constructor(private readonly runtime: HobRuntime) {}

  private get store() {
    return this.runtime.store;
  }

  private get bus() {
    return this.runtime.bus;
  }

  /** 提示词用的设置：现读 settings.json，所以改完下一个任务就按新时区和语言算。 */
  private promptSettings(): PromptSettings {
    const { timezone, aboutYou, locale } = this.runtime.settings.settings.general;
    return { timezone, aboutYou, locale, memory: this.runtime.settings.memory().provider };
  }

  jobsFor(assistantId: string): Job[] {
    return this.store.jobs().filter((job) => job.assistantId === assistantId);
  }

  /** 任务记录：全部任务，新的在前，可按助手 / 状态筛选，按 before（上一次最后一页的那条）分页。 */
  page(options: { assistantId?: string; groupId?: string; status?: JobStatus; before?: string; limit?: number } = {}): JobsPage {
    const limit = Math.max(1, Math.min(options.limit ?? 30, 200));
    // 新的在前，按这一轮开始的时间：续做的任务排回上面
    let list = this.store.jobs().sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
    if (options.assistantId) list = list.filter((job) => job.assistantId === options.assistantId);
    if (options.groupId) list = list.filter((job) => this.store.groupMatches(options.groupId!, job.groupId));
    if (options.status) list = list.filter((job) => job.status === options.status);
    if (options.before) {
      const index = list.findIndex((job) => job.id === options.before);
      if (index !== -1) list = list.slice(index + 1);
    }
    return { jobs: list.slice(0, limit), hasMore: list.length > limit };
  }

  /** 详情页要全文时拉它：从任务会话文件重新推导，长输出落到任务目录下。 */
  transcript(jobId: string): JobStep[] {
    const steps = this.workerSteps(jobId);
    // 沉淀在自己的会话文件里，开头抄的是任务会话：只取开始以后的，按时间插回去
    const dir = join(this.store.jobDir(jobId), "sediment");
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort((a, b) => parseInt(a) - parseInt(b)) : [];
    for (const name of files) {
      const since = new Date(parseInt(name)).toISOString();
      const block = this.deriveJobSteps(jobId, join(dir, name), since);
      const at = steps.findIndex((step) => step.at > since);
      steps.splice(at < 0 ? steps.length : at, 0, ...block);
    }
    return [...steps, ...(this.workers.get(jobId)?.queued ?? [])];
  }

  private workerSteps(jobId: string): JobStep[] {
    return this.deriveJobSteps(jobId, this.store.workerFile(jobId));
  }

  private deriveJobSteps(jobId: string, file: string, since?: string): JobStep[] {
    const job = this.store.job(jobId);
    if (!job) return [];
    return deriveSteps(file, {
      since,
      cwd: job.cwd ?? "",
      save: (stepId, text) => this.store.writeStepOutput(jobId, stepId, text),
      mcpServers: pluginToolDisplayNames(this.runtime.plugins),
      // 迁移前写进会话的绝对路径：换成新位置后，详情页里还是短文件名
      resolvePath: (path) => resolveMovedPath(this.runtime.home, path),
    });
  }

  async start(assistantId: string, input: StartJobInput, signal?: AbortSignal): Promise<Job> {
    const assistant = this.store.assistant(assistantId);
    if (!assistant) throw new Error(`助手不存在：${assistantId}`);
    const after = [...new Set((input.after ?? []).map((id) => id.trim()).filter(Boolean))];
    for (const id of after) {
      const before = this.store.job(id);
      if (!before) throw new Error(`没有这个任务：${id}`);
      if (before.status === "stuck" || before.status === "failed" || before.status === "stopped") {
        throw new Error(`前置任务「${before.title}」（${id}）${endWord(before.status)}，无法等待它完成。`);
      }
    }
    const explicitCwd = normalizeWorkspaceCwdInput(input.cwd);
    const boundCwd = resolveWorkspaceCwd(this.store, this.runtime.home, assistantId, input.groupId).bound;
    let validatedCwd: string | undefined;
    if (boundCwd) {
      validatedCwd = validateJobCwd(this.runtime.home, boundCwd);
      if (explicitCwd) {
        // 绑定目录里面的子目录可以（比如并行任务各用一份 worktree），出了绑定目录不行
        const validatedExplicit = validateJobCwd(this.runtime.home, explicitCwd);
        const [root, target] = [realpathSync(validatedCwd), realpathSync(validatedExplicit)];
        if (!isInside(root, target)) throw new Error(CWD_BOUND_LOCKED);
        if (target !== root) validatedCwd = validatedExplicit;
      }
    } else if (explicitCwd) {
      validatedCwd = validateJobCwd(this.runtime.home, explicitCwd);
    }
    await this.runtime.models.get();
    signal?.throwIfAborted();
    const requested =
      input.model || input.thinking
        ? { ...(input.model ? { model: input.model } : {}), ...(input.thinking ? { thinking: input.thinking } : {}) }
        : undefined;
    const picked = jobModel({
      settings: this.runtime.settings.settings.models,
      assistant: assistantInGroup(assistant, input.groupId ? this.store.group(input.groupId) : undefined, this.runtime.models, this.runtime.settings.settings.models),
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
    // 任务自己的目录总是建好：指定了 cwd 的任务也用它放临时文件和隔离着的副本
    const ownDir = this.store.workDir(id, assistantId);
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
      cwd: validatedCwd ?? ownDir,
      model: picked.model.ref,
      thinking: picked.model.thinking,
      ...(picked.modelReason ? { modelReason: picked.modelReason } : {}),
      ...(input.files?.length ? { inputs: input.files } : {}),
      ...(input.routineId ? { routineId: input.routineId } : {}),
      ...(after.length ? { after } : {}),
      ...(input.delegationId ? { delegationId: input.delegationId } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.startedBy ? { startedBy: input.startedBy } : {}),
    };
    this.store.saveJob(job);
    if (job.delegationId) this.runtime.delegations.addJob(job.delegationId, job.id);
    await this.runtime.router.addItem(assistantId, { kind: "job", jobId: job.id }, job.groupId);
    if (signal?.aborted) {
      await this.finish(job.id, "stopped", undefined, t("创建任务调用已中止"));
      signal.throwIfAborted();
    }
    this.bus.emit({ type: "job", job });
    this.publishBusy(job);
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  /** 任务会改变“忙不忙”（前端用它显示“正在想”），所以状态一变就告诉前端；群里的任务还要让群的摘要跟上。 */
  private publishBusy(job: Job): void {
    const assistant = this.store.assistant(job.assistantId);
    if (assistant) this.bus.emit({ type: "assistant", assistant: this.runtime.router.summary(assistant) });
    if (job.groupId) this.runtime.groups.publish(job.groupId);
  }

  /** 事件送到哪个助手的会话：群里的任务回它的群会话，其余回单聊。派给别的成员做的，回派任务的助手。 */
  private notifyAssistant(job: Job, text: string, details?: EventDetails): Promise<boolean> {
    const speaker = job.startedBy ?? job.assistantId;
    if (job.groupId) return this.runtime.router.event(speaker, text, details, job.groupId);
    return details ? this.runtime.router.event(speaker, text, details) : this.runtime.router.event(speaker, text);
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
    const held: string[] = [];
    while (this.queue.length && this.runningCount() < max) {
      const id = this.queue.shift()!;
      const job = this.store.job(id);
      if (!job || job.status !== "queued") continue;
      // 前置没做完：留在队里等，不占并发名额
      if (!this.afterDone(job)) {
        held.push(id);
        continue;
      }
      const followUp = this.followUps.get(id);
      this.followUps.delete(id);
      void this.launch(job, followUp).catch((error) => this.failLaunch(job, error));
    }
    if (held.length) this.queue = [...held, ...this.queue];
  }

  /** 前置任务都做完了吗。 */
  private afterDone(job: Job): boolean {
    return (job.after ?? []).every((id) => this.store.job(id)?.status === "done");
  }

  /** 前置没做成：等它的任务结束为受阻，链上后面的一层一层跟着停，每层都按结果事件通知派它的助手。 */
  private async blockDependents(job: Job): Promise<void> {
    if (job.status === "done") return;
    for (const dependent of this.store.jobs().filter((item) => item.status === "queued" && item.after?.includes(job.id))) {
      await this.finish(dependent.id, "stuck", undefined, `前置任务「${job.title}」未完成`);
    }
  }

  private async failLaunch(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.finish(job.id, "failed", undefined, message);
  }

  /**
   * 开会话：任务这一轮和沉淀那一轮共用这一段，模型、提示词、技能、工具、自定义工具都一样。
   * 沉淀另要 write、edit（助手没开「改文件」也要有）；report、ask_user 开会话时就定好按沉淀处理，
   * 停下沉淀的那一刻还在跑的调用也不会落到任务上。
   */
  private async openWorkerSession(job: Job, sediment = false): Promise<{ session: AgentSession; manager: SessionManager; mcpServers: Record<string, string>; scriptRevokes: Set<() => void>; desktop?: DesktopToolSession }> {
    const assistant = this.store.assistant(job.assistantId);
    // 生图要两头都满足：助手开着，而且设置里真配了图像模型
    const baseAbilities = assistant?.abilities ?? ALL_ABILITIES;
    const abilities: Abilities = {
      ...baseAbilities,
      image: baseAbilities.image && imageConfigured(this.runtime.settings.settings.image),
    };
    // 提示词里的「不能做」跟着这一轮实际给的工具走：沉淀一定要有 write、edit
    const promptAbilities: Abilities = sediment ? { ...abilities, write: true } : abilities;
    const knowledge = await boundKnowledge(this.runtime, job.assistantId);
    const ownDir = this.store.workDir(job.id, job.assistantId);
    const workerCwd = job.cwd ?? ownDir;
    const agentsFiles = job.cwd && job.cwd !== ownDir ? loadWorkspaceAgentsFile(job.cwd) : [];
    const customTools = [
      registerReportTool(this.runtime, job.id, sediment),
      registerAskTool(this.runtime, job.id, sediment),
      findKnowledgeTool(this.runtime),
      saveSkillTool(this.runtime, job.assistantId, job.groupId, workerCwd, job.id, [workerCwd, ownDir]),
    ];
    if (knowledge.length) customTools.push(searchKnowledgeTool(this.runtime, job.assistantId));
    if (abilities.image) customTools.push(registerImageTool(this.runtime, job.id));
    customTools.push(...searchTools(this.runtime.home, () => this.runtime.settings.settings.search, () => this.runtime.settings.settings.providers));
    const desktop = await availableDesktopTools(this.runtime, job.assistantId, !!this.runtime.models.find(job.model ?? this.runtime.settings.settings.models.work.ref)?.input.includes("image"), job.title, join(this.store.workDir(job.id), "screenshots"));
    const credentialsEnabled = !!desktop && this.runtime.plugins.hasCredentialProvider(job.assistantId);
    customTools.push(registerLoginTool(this.runtime, job.id, sediment, credentialsEnabled));
    if (desktop && this.runtime.plugins.hasPasswordGenerator(job.assistantId)) customTools.push(registerFillNewPasswordTool(this.runtime, job.id, sediment));
    if (desktop) customTools.push(...desktop.tools());
    const cliEnvironment = desktop ? await desktop.preparePlaywrightCli() : undefined;
    // 定时跑的就是 Worker：主助手的任务要看得到各助这段时间的动静才能写早报
    if (assistant?.primary) customTools.push(overviewTool(this.runtime));
    const existingNames = new Set([...workerTools(abilities), ...customTools.map(tool => tool.name), "tool_search"]);
    const pluginTools = pluginToolsForAssistant(this.runtime.plugins, job.assistantId, existingNames);
    customTools.push(...pluginTools);
    const toolSearch = pluginTools.some(tool => tool.exposure === "deferred");
    const group = job.groupId ? this.store.group(job.groupId) : undefined;
    // 任务带上它看得到的全部技能（本群、自己的、通用的），自己挑对得上的那份
    const taskSkillInfo = visibleSkills(this.runtime, job.assistantId, group);
    const taskSkills = taskSkillInfo.some((skill) => skill.enabled !== false);
    await this.runtime.scriptTools.start();
    const scriptRevokes = new Set<() => void>();
    const opened = await this.runtime.pi.open({
      file: this.store.workerFile(job.id),
      cwd: job.cwd ?? homedir(),
      agentsFiles,
      writeGuard: { home: this.runtime.home, roots: () => [...new Set([ownDir, ...(job.cwd ? [job.cwd] : [])])] },
      model: job.model ?? this.runtime.settings.settings.models.work.ref,
      thinking: job.thinking ?? this.runtime.settings.settings.models.work.thinking,
      memory: this.runtime.settings.memory().provider,
      skills: loadedVisibleSkills(taskSkillInfo),
      disabledSkills: this.runtime.settings.settings.skills?.disabled,
      systemPrompt: () =>
        buildWorkerPrompt(this.store, job.id, { ...this.promptSettings(), abilities: promptAbilities, desktopEnabled: !!desktop, credentialsEnabled, knowledgeNames: knowledge.map((collection) => collection.name), ...(taskSkills ? { taskSkills } : {}) }),
      tools: [
        ...new Set([
          ...workerTools(abilities),
          ...(sediment ? ["write", "edit"] : []),
          ...customTools.map((tool) => tool.name),
          ...(toolSearch ? ["tool_search"] : []),
        ]),
      ],
      customTools,
      stall: {
        milliseconds: () => this.stallOverrideMs ?? this.runtime.settings.settings.work.jobStallMinutes * 60_000,
        onRetry: () => {
          const worker = this.workers.get(job.id);
          const current = this.store.job(job.id);
          if (!worker || !current) return;
          worker.lastActivityAt = Date.now();
          const line: ActivityLine = { at: new Date().toISOString(), verb: "说", text: t("模型没有响应，正在重试") };
          this.store.saveJob({ ...current, activity: [...current.activity, line].slice(-ACTIVITY_LIMIT) });
          this.bus.emit({ type: "activity", jobId: job.id, line, stats: current.stats });
        },
      },
      bashSpawnHook: ({ command, cwd, env }) => {
        const credential = this.runtime.scriptTools.issue({
          tools: async () => {
            const reserved = new Set(existingNames);
            const livePlugins = pluginToolsForAssistant(this.runtime.plugins, job.assistantId, reserved);
            for (const tool of livePlugins) reserved.add(tool.name);
            const commandTools = pluginCommandToolsForAssistant(this.runtime.plugins, job.assistantId, reserved);
            return scriptToolList(customTools, !!(await boundKnowledge(this.runtime, job.assistantId)).length, livePlugins, commandTools);
          },
          onCall: (tool) => {
            const current = this.store.job(job.id);
            if (!current) return;
            const line: ActivityLine = { at: new Date().toISOString(), verb: "跑", text: tool.label };
            this.store.saveJob({ ...current, activity: [...current.activity, line].slice(-ACTIVITY_LIMIT) });
            this.bus.emit({ type: "activity", jobId: job.id, line, stats: current.stats });
          },
        });
        scriptRevokes.add(credential.revoke);
        const binDirs = [join(engineDir(this.runtime.home), "bin"), ...this.runtime.plugins.binDirsForAssistant(job.assistantId)];
        return { command, cwd, env: this.runtime.scriptTools.environment(proxyEnvironment(browserShellEnv(env, cliEnvironment), this.runtime.settings.settings.general), credential.token, binDirs) };
      },
      toolSearch,
    });
    return { session: opened.session, manager: opened.manager, mcpServers: pluginToolDisplayNames(this.runtime.plugins), scriptRevokes, ...(desktop ? { desktop } : {}) };
  }

  private async launch(job: Job, followUp?: string): Promise<void> {
    const running: Job = {
      ...job,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.store.saveJob(running);
    this.bus.emit({ type: "job", job: running });

    const { session, manager, mcpServers, desktop, scriptRevokes } = await this.openWorkerSession(running);
    if (this.store.job(running.id)?.status !== "running") { session.dispose(); await desktop?.dispose(); return; }

    // 开会话的这段时间里沉淀可能做完了：带上存着的沉淀状态
    const latest = this.store.job(running.id)?.sediment;
    const worker: WorkerState = {
      job: latest ? { ...running, sediment: latest } : running,
      session,
      manager,
      askedFollowUp: false,
      lastActivityAt: Date.now(),
      pausedMs: 0,
      nextReminder: 1,
      steps: new Map(),
      readPaths: new Map(),
      queued: [],
      mcpServers,
      scriptRevokes,
      desktop,
    };
    this.workers.set(running.id, worker);
    if (followUp !== undefined) {
      const step: JobStep = { id: `q${Date.now()}-0`, kind: "text", at: new Date().toISOString(), from: "user", text: followUp, queued: true };
      worker.queued.push(step);
      this.emitStep(running.id, step);
    }
    const images = followUp === undefined ? imageContents(running.inputs) : [];

    session.subscribe((event) => {
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
        this.emitStep(running.id, step);
        return;
      }
      if (event.type === "tool_execution_update") {
        worker.lastActivityAt = Date.now();
        const step = worker.steps.get(event.toolCallId);
        if (step) this.emitStep(running.id, this.withStepOutput(running.id, step, textOfContent(event.partialResult?.content)));
        return;
      }
      if (event.type === "tool_execution_end") {
        if (event.toolName === "bash") { scriptRevokes.forEach((revoke) => revoke()); scriptRevokes.clear(); }
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
          running.id,
          this.withStepOutput(running.id, step, textOfContent(event.result?.content), {
            isError: event.isError,
            durationMs: event.durationMs,
          }),
        );
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = textOfContent(event.message.content).trim();
        if (text) worker.lastText = text;
        // 调模型失败（重试成功的话下一条会把它清掉）：没交结果时代码要说这个原因，不说「没交代」
        worker.turnError = event.message.stopReason === "error" || (event.message.stopReason === "aborted" && !!event.message.errorMessage)
          ? event.message.errorMessage ?? "模型服务出错"
          : undefined;
        worker.lastActivityAt = Date.now();
        this.recordSteps(running.id, event.message);
        this.addUsage(running.id, event.message);
        worker.job = this.store.job(running.id) ?? worker.job;
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
            this.emitStep(running.id, { id: `u${event.message.timestamp}`, kind: "text", at: new Date(event.message.timestamp).toISOString(), from: "user", text });
          }
        }
        return;
      }
      if (event.type === "agent_settled") void this.onSettled(worker);
    });

    const inputFiles = running.inputs?.length ? `附带文件：\n${running.inputs.map((file) => `- ${file}`).join("\n")}` : "";
    const instruction = followUp ?? [running.instruction, inputFiles, this.afterBrief(running)].filter(Boolean).join("\n\n");
    void session
      .prompt(instruction, images.length ? { images } : undefined)
      .catch(async (error: unknown) => {
        if (!worker.stopped) await this.finish(running.id, "failed", undefined, error instanceof Error ? error.message : String(error));
      });
  }

  /** 等在前面的任务做完了：标题、状态、报告路径一行一个写在说明后面，它照着去读前面的结果。 */
  private afterBrief(job: Job): string | undefined {
    const lines = (job.after ?? []).flatMap((id) => {
      const before = this.store.job(id);
      if (!before) return [];
      const status = before.status === "done" ? "已完成" : endWord(before.status);
      return [`「${before.title}」（${id}）${status}，报告：${before.reportPath ?? "没有报告文件"}`];
    });
    return lines.length ? `等在前面的任务：\n${lines.join("\n")}` : undefined;
  }

  /** 任务读了技能：能改的那几档记一次用量，读到的任一档都记进 skillsUsed。 */
  private recordSkillUse(worker: WorkerState, path: string): void {
    const job = this.store.job(worker.job.id);
    if (!job) return;
    let absolute: string;
    try { absolute = realpathSync(resolve(job.cwd ?? homedir(), path)); }
    catch { return; }
    const skills = visibleSkills(this.runtime, job.assistantId, job.groupId ? this.store.group(job.groupId) : undefined);
    const skill = skills.find((item) => existsSync(item.path) && realpathSync(item.path) === absolute);
    if (!skill || job.skillsUsed?.includes(skill.name)) return;
    if (skill.editable) recordSkillUse(skillDirOf(this.runtime, skill, job.assistantId, job.groupId ? this.store.group(job.groupId) : undefined), skill.name);
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
  private emitStep(jobId: string, step: JobStep): void {
    this.bus.emit({ type: "job_step", jobId, step });
  }

  /** 工具结果装进步骤：事件里只给 4KB，全文落盘给路径（详情页要全文时拉 transcript）。 */
  private withStepOutput(
    jobId: string,
    step: JobStep,
    full: string,
    extra: { isError?: boolean; durationMs?: number } = {},
  ): JobStep {
    return withOutput(step, full, {
      limit: STEP_EVENT_LIMIT,
      ...extra,
      save: (stepId, text) => this.store.writeStepOutput(jobId, stepId, text),
    });
  }

  /** 助手消息里的说明文字和思考摘要也进时间线（工具步骤已由执行事件推过了）。 */
  private recordSteps(jobId: string, message: { timestamp?: number; content?: unknown }): void {
    const blocks: any[] = Array.isArray(message.content) ? (message.content as any[]) : [];
    const stamp = message.timestamp ?? Date.now();
    const at = new Date(stamp).toISOString();
    blocks.forEach((block, index) => {
      if (block?.type === "text") {
        const text = String(block.text ?? "").trim();
        if (text) this.emitStep(jobId, { id: `t${stamp}-${index}`, kind: "text", at, from: "assistant", text });
        return;
      }
      if (block?.type === "thinking") {
        const text = String(block.thinking ?? "").trim();
        if (text && !block.redacted) this.emitStep(jobId, { id: `k${stamp}-${index}`, kind: "thinking", at, text });
      }
    });
  }

  /** token 和花费累加到任务上，详情顶部实时看得到（沉淀那一轮也算这个任务的用量）。 */
  private addUsage(jobId: string, message: { usage?: { input: number; output: number; cost: { total: number } } }): void {
    const usage = message.usage;
    if (!usage) return;
    const job = this.store.job(jobId);
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
    this.bus.emit({ type: "job", job: next });
  }

  private async onSettled(worker: WorkerState): Promise<void> {
    if (worker.stopped) return;
    const job = this.store.job(worker.job.id);
    if (!job || job.status === "done" || job.status === "stuck" || job.status === "failed" || job.status === "stopped") return;
    if (worker.turnError === "模型没有响应") {
      await this.finish(worker.job.id, "stuck", undefined, t("模型没有响应"));
      return;
    }
    if (worker.reported) {
      await this.applyReport(worker.job.id);
      return;
    }
    if (worker.askedFollowUp) {
      await this.finish(worker.job.id, worker.turnError ? "failed" : "stuck", undefined, worker.turnError ? t("调用模型失败（{error}）", { error: briefModelError(worker.turnError) }) : "未提交结果");
      return;
    }
    worker.askedFollowUp = true;
    const session = worker.session;
    if (!session) {
      await this.finish(worker.job.id, "stuck", undefined, "未提交结果");
      return;
    }
    await session.prompt(NO_RESULT_PROMPT);
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
    worker?.scriptRevokes?.forEach((revoke) => revoke());
    await worker?.desktop?.dispose();
    await this.settle(job, status, { summary, reason, files, lastText: worker?.lastText });

    if (worker?.session) {
      worker.session.dispose();
    }
    this.workers.delete(jobId);
    await this.blockDependents(this.store.job(jobId) ?? job);
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
    this.publishBusy(next);
    const assistant = this.store.assistant(job.assistantId);
    this.store.addWorklog(job.assistantId, {
      at: endedAt,
      text: `任务${statusText}：${job.title}`,
      jobId: job.id,
    });
    this.bus.emit({ type: "profile", assistantId: job.assistantId });
    const toolCount = this.workerSteps(job.id).filter((step) => step.kind === "tool" && (!next.startedAt || step.at >= next.startedAt)).length;
    // 结果里的「用了技能「X」」和沉淀提醒都要标题：任一档都算，只读的那几份没有 fromJobId，不会被当成沉淀目标
    const resultSkills = visibleSkills(this.runtime, job.assistantId, next.groupId ? this.store.group(next.groupId) : undefined);
    const resultDetails: EventDetails = { job: { id: job.id, round: next.rounds?.length ?? 0, kind: "result" }, workDone: true };

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
        void this.runtime.router
          .event(job.assistantId, assistantJobResultEvent(this.runtime.home, next, { prefix: `定时任务「${routine.name}」`, toolCount, group: next.groupId ? this.store.group(next.groupId) : undefined, skills: resultSkills }), {
            routine: { id: routine.id, name: routine.name, jobId: job.id },
            ...resultDetails,
          }, next.groupId)
          .catch((error) => console.error("发送定时任务结果失败：", error));
      }
    } else if (assistant) {
      const text = assistantJobResultEvent(this.runtime.home, next, { toolCount, group: next.groupId ? this.store.group(next.groupId) : undefined, skills: resultSkills });
      if (delegationId) {
        void this.runtime.router.relay(job.assistantId, text, delegationId, resultDetails).catch((error: unknown) => {
          this.runtime.delegations.turnEnded(delegationId, error instanceof Error ? error.message : String(error), true);
        });
      } else {
        void this.notifyAssistant(next, text, resultDetails).catch((error) => console.error("发送任务结果失败：", error));
      }
    }
  }

  async reply(jobId: string, text: string, source: "user" | "router" = "user"): Promise<SavedSkill[] | undefined> {
    await this.finishing.get(jobId);
    const target = this.store.job(jobId);
    if (!target) throw new Error("没有这个任务。");
    // 用户绕过助手直接对任务说的话，助手也要知道：任务之后来问、交结果时它才对得上
    if (source === "user") void this.runtime.router.remember(target.assistantId, `用户给任务「${target.title}」（${target.id}）追加了回复：${text}`, target.groupId).catch((error) => console.error("记进助手会话失败：", error));
    const interrupted = this.sediments.has(jobId) ? await this.stopSediment(jobId) : undefined;
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
      // 沉淀结果跟着这一轮走：过去的卡片各写各的
      const ended: JobRound = { status: job.status, statusReason, startedAt: job.startedAt, endedAt, durationMs, summary, files, usage, reportPath: savedReport, followUp: text, ...(sediment && sediment.status !== "running" ? { sediment } : {}) };
      const rounds = [...previous, ended];
      const queued: Job = { ...rest, rounds, status: "queued", expect: { minutes: 10, source: "default" }, startedAt: undefined };
      this.store.saveJob(queued);
      try {
        await this.runtime.router.addItem(job.assistantId, { kind: "job", jobId, round: rounds.length }, job.groupId);
      } catch (error) {
        this.store.saveJob(job);
        throw error;
      }
      this.followUps.set(jobId, `${interrupted ? `上一轮回顾停了，${reviewedSkillsText(interrupted)}\n` : ""}${source === "router" ? `「${this.store.assistant(job.assistantId)?.name ?? job.assistantId}」` : "用户"}接着说（${monthDayTimeText(this.runtime.settings.settings.general.timezone)}）：${text}`);
      this.bus.emit({ type: "job", job: queued });
      this.publishBusy(queued);
      this.queue.push(jobId);
      this.pump();
      return interrupted;
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
    this.emitStep(jobId, step);
    try {
      if (worker.session.isStreaming) await worker.session.steer(text);
      else void worker.session.prompt(text).catch(() => { worker.queued = worker.queued.filter((item) => item !== step); });
    } catch (error) {
      worker.queued = worker.queued.filter((item) => item !== step);
      throw error;
    }
  }

  private setSediment(jobId: string, sediment?: SedimentStatus): void {
    const job = this.store.job(jobId);
    if (!job) return;
    const { sediment: _previous, ...rest } = job;
    const next: Job = sediment ? { ...rest, sediment } : rest;
    this.store.saveJob(next);
    // 续做的那一轮在跑：它手里那份也改掉，不然它下次存任务会把沉淀状态写回去
    const worker = this.workers.get(jobId);
    if (worker) worker.job = { ...worker.job, ...(sediment ? { sediment } : { sediment: undefined }) };
    this.bus.emit({ type: "job", job: next });
  }

  startSediment(jobId: string, options: { note?: string } = {}): void {
    const job = this.store.job(jobId);
    if (!job) throw new Error("任务不存在");
    if (!ENDED.includes(job.status) || this.finishing.has(jobId) || this.workers.has(jobId)) throw new Error("任务还没结束，做完以后再让它回顾。");
    if (this.sediments.has(jobId)) throw new Error("任务正在回顾。");
    const state: SedimentState = { jobId, cancelled: false, saved: [] };
    this.sediments.set(jobId, state);
    this.setSediment(jobId, { status: "running" });
    state.task = this.runSediment(job, state, options.note);
  }

  private async runSediment(job: Job, state: SedimentState, note?: string): Promise<void> {
    try { await this.sedimentRound(job, state, note); }
    catch (error) {
      if (!state.cancelled) this.setSediment(job.id, { status: "failed", reason: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!state.cancelled) {
        const sediment = this.store.job(job.id)?.sediment;
        if (sediment?.status === "failed") void this.notifyAssistant(job, `任务「${job.title}」（${job.id}）沉淀完了：沉淀失败，${sediment.reason}。`).catch((error) => console.error("发送沉淀结果失败：", error));
      }
      if (this.sediments.get(job.id) === state) this.sediments.delete(job.id);
    }
  }

  private async stopSediment(jobId: string): Promise<SavedSkill[]> {
    const state = this.sediments.get(jobId);
    if (!state) return [];
    state.cancelled = true;
    await state.session?.abort().catch(() => undefined);
    await state.task?.catch(() => undefined);
    if (this.sediments.get(jobId) === state) this.sediments.delete(jobId);
    if (this.store.job(jobId)?.sediment?.status === "running") this.setSediment(jobId);
    return [...state.saved];
  }

  recordSavedSkill(jobId: string, saved: SavedSkill): void {
    const state = this.sediments.get(jobId);
    if (!state || state.cancelled) return;
    state.saved.push(saved);
    this.setSediment(jobId, { status: "running", saved: [...state.saved] });
  }

  async reportSediment(jobId: string, result: string): Promise<{ ok: boolean; text: string }> {
    const state = this.sediments.get(jobId);
    if (!state || state.cancelled) return { ok: true, text: "结果已记录。" };
    if (state.report) return state.report;
    const saved = state.saved[0];
    this.setSediment(jobId, saved ? { status: "saved", ...saved } : { status: "empty", reason: result.trim() || "没有需要沉淀的" });
    state.report = { ok: true, text: "结果已记录。" };
    return state.report;
  }

  /** 回顾在原任务会话里继续，已提交的技能不随中断撤回。 */
  private async sedimentRound(job: Job, state: SedimentState, note?: string): Promise<void> {
    const opened = await this.openWorkerSession(job, true);
    state.session = opened.session;
    state.desktop = opened.desktop;
    if (state.cancelled) {
      opened.session.dispose();
      await opened.desktop?.dispose();
      return;
    }
    const steps = new Map<string, JobStep>();
    opened.session.subscribe((event) => {
      if (state.cancelled) return;
      if (event.type === "tool_execution_start") {
        const step = toolStep({ id: event.toolCallId, name: event.toolName, args: event.args ?? {}, at: new Date().toISOString(), cwd: job.cwd ?? "", mcpServers: opened.mcpServers, running: true });
        steps.set(event.toolCallId, step);
        this.emitStep(job.id, step);
        return;
      }
      if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        if (event.type === "tool_execution_end" && event.toolName === "bash") { opened.scriptRevokes.forEach((revoke) => revoke()); opened.scriptRevokes.clear(); }
        const step = steps.get(event.toolCallId);
        if (!step) return;
        const text = textOfContent(event.type === "tool_execution_update" ? event.partialResult?.content : event.result?.content);
        const next = withOutput(step, text, {
          limit: STEP_EVENT_LIMIT,
          ...(event.type === "tool_execution_end" ? { isError: event.isError, durationMs: event.durationMs } : {}),
          save: (id, value) => this.store.writeStepOutput(job.id, id, value),
        });
        this.emitStep(job.id, next);
        if (event.type === "tool_execution_end") steps.delete(event.toolCallId);
        return;
      }
      if (event.type === "message_start" && event.message.role === "user") {
        // 沉淀消息显示成「沉淀技能」；中途那句「还没有交结果」的提醒不显示
        const text = textOfContent(event.message.content).trim();
        if (!text.startsWith(SEDIMENT_PROMPT_HEAD)) return;
        this.emitStep(job.id, { id: `u${event.message.timestamp}`, kind: "text", at: new Date(event.message.timestamp).toISOString(), from: "user", text: "沉淀技能" });
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        state.lastText = textOfContent(event.message.content).trim() || state.lastText;
        // 出错后自动重试成功的，以最后一条为准
        state.error = event.message.stopReason === "error" ? event.message.errorMessage || "模型调用出错" : undefined;
        this.recordSteps(job.id, event.message);
        this.addUsage(job.id, event.message);
      }
    });
    const message = sedimentMessage({ ...(note ? { note } : {}), assistantName: this.store.assistant(job.assistantId)?.name ?? job.assistantId });
    try {
      await opened.session.prompt(message);
      if (state.cancelled || state.report) return;
      // 模型出错就停止回顾，已提交的技能保留。
      if (state.error) throw new Error(state.error);
      // 没交 report：照常提醒一次
      await opened.session.prompt(NO_RESULT_PROMPT);
      if (state.cancelled || state.report) return;
      if (state.error) throw new Error(state.error);
      await this.reportSediment(job.id, state.lastText ?? "");
    } finally {
      opened.scriptRevokes.forEach((revoke) => revoke());
      opened.session.dispose();
      await opened.desktop?.dispose();
    }
  }

  async stop(jobId: string, reason = "你停止了"): Promise<void> {
    const job = this.store.job(jobId);
    if (!job) throw new Error("没有这个任务。");
    const worker = this.workers.get(jobId);
    if (worker) {
      // 先标记再 abort：终止命令的过程中模型可能接着把 report 跑完，那不能把 stopped 改成完成
      worker.stopped = true;
      worker.ask?.("（任务已停止）");
      worker.ask = undefined;
      // abort 会把正在执行的工具（bash 子进程）一起终止
      await worker.session?.abort().catch(() => undefined);
    }
    await this.finish(jobId, "stopped", undefined, reason);
  }

  /** Worker 的 ask_user：只交给助手（用户只和助手打交道，不推送、不给用户出卡），把任务标成待确认，阻塞到助手或用户答复。 */
  async askQuestion(
    jobId: string,
    input: { title: string; detail?: string; options: ApprovalOption[]; recommended?: ApprovalOption["key"]; ruleText?: string; login?: Approval["login"] },
    signal?: AbortSignal,
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
      ...(input.recommended ? { recommended: input.recommended } : {}),
      status: "pending",
      source: "job",
      jobId,
      ...(job.groupId ? { groupId: job.groupId } : {}),
      ...(input.ruleText ? { ruleText: input.ruleText } : {}),
      ...(input.login ? { login: input.login } : {}),
      createdAt: new Date().toISOString(),
    };
    this.store.saveApproval(approval);
    if (!worker) { this.store.saveApproval({ ...approval, status: "expired" }); return "（任务未在运行）"; }
    const resumeTimeout = pauseToolTimeoutForUser(signal);
    let resolveAnswer!: (answer: string) => void;
    const answer = new Promise<string>((resolve) => {
      resolveAnswer = (value) => { resumeTimeout(); resolve(value); };
      worker.ask = resolveAnswer;
    });
    const delegationId = !job.routineId && job.delegationId && this.runtime.delegations.resume(job.delegationId) ? job.delegationId : undefined;
    const waiting: Job = { ...job, status: "waiting" };
    this.store.saveJob(waiting);
    worker.job = waiting;
    worker.pausedAt = Date.now();
    this.bus.emit({ type: "job", job: waiting });
    const cancel = () => {
      if (worker.ask !== resolveAnswer) return;
      worker.ask = undefined;
      const pending = this.store.approval(approval.id);
      if (pending?.status === "pending") {
        const expired = { ...pending, status: "expired" as const };
        this.store.saveApproval(expired);
        this.bus.emit({ type: "approval", approval: expired });
      }
      this.deliveredQuestions.delete(approval.id);
      const current = this.store.job(jobId);
      if (current?.status === "waiting") {
        worker.job = { ...current, status: "running" };
        this.store.saveJob(worker.job);
        this.bus.emit({ type: "job", job: worker.job });
      }
      if (worker.pausedAt !== undefined) worker.pausedMs += Date.now() - worker.pausedAt;
      worker.pausedAt = undefined;
      worker.lastActivityAt = Date.now();
      resolveAnswer("（提问已中止）");
    };
    if (signal?.aborted) { cancel(); return answer; }
    signal?.addEventListener("abort", cancel, { once: true });
    const sentence = (value: string) => /[。！？.!?]\s*$/.test(value) ? value : `${value}。`;
    const text = `任务「${job.title}」（${job.id}）在等你回复：${sentence(input.title)}${input.detail ? sentence(input.detail) : ""}选项：${input.options.map((option) => `${option.key} ${option.label}${option.key === input.recommended ? "（推荐）" : ""}`).join("、")}。`;
    const questionDetails: EventDetails = { job: { id: job.id, round: job.rounds?.length ?? 0, kind: "question" } };
    let delivered = false;
    if (delegationId) {
      delivered = await this.runtime.router.relay(job.assistantId, text, delegationId, questionDetails).catch((error) => {
        this.runtime.delegations.turnEnded(delegationId, error instanceof Error ? error.message : String(error), true);
        return false;
      });
    } else {
      delivered = await this.notifyAssistant(job, text, questionDetails).catch((error) => {
        console.error("任务提问投递失败：", error);
        return false;
      });
    }
    if (!signal?.aborted && delivered === false) {
      await this.finishUnsentQuestion(jobId, approval, "没有送到助手");
      cancel();
    }
    try { return await answer; } finally { signal?.removeEventListener("abort", cancel); resumeTimeout(); }
  }

  /** 提问真正送进了助手会话的那张提问卡（id）。还排在队里没送到的不算，那一轮结束时不能当作没人接。 */
  private deliveredQuestions = new Set<string>();

  questionDelivered(jobId: string): void {
    const approval = this.store.approvals().find((item) => item.jobId === jobId && item.status === "pending");
    if (approval) this.deliveredQuestions.add(approval.id);
  }

  /** 同一回合结束时，任务的提问没有被助手接住就结束它，避免永久占着等待名额。 */
  async finishUnansweredQuestions(assistantId: string, groupId?: string): Promise<void> {
    const hasUserCard = this.store.approvals().some((approval) => approval.status === "pending" && approval.source === "router" && approval.assistantId === assistantId && (groupId ? approval.groupId === groupId : !approval.groupId));
    if (hasUserCard) return;
    const waiting = this.store.jobs().filter((job) => {
      if (job.status !== "waiting") return false;
      if (groupId !== undefined) return job.groupId === groupId && (job.startedBy ?? job.assistantId) === assistantId;
      return !job.groupId && job.assistantId === assistantId;
    });
    for (const job of waiting) {
      const approval = this.store.approvals().find((item) => item.jobId === job.id && item.status === "pending");
      if (!approval || !this.deliveredQuestions.delete(approval.id)) continue;
      const question = approval.title;
      const expired = { ...approval, status: "expired" as const };
      this.store.saveApproval(expired);
      this.bus.emit({ type: "approval", approval: expired });
      await this.finish(job.id, "stuck", undefined, `提问没有得到答复：${question}`);
    }
  }

  /** 任务提问投递失败时立即收尾，原因写进任务报告和结果事件。 */
  private async finishUnsentQuestion(jobId: string, approval: Approval, detail?: string): Promise<void> {
    const current = this.store.approval(approval.id);
    if (current?.status === "pending") {
      const expired = { ...current, status: "expired" as const };
      this.store.saveApproval(expired);
      this.bus.emit({ type: "approval", approval: expired });
    }
    await this.finish(jobId, "stuck", undefined, `提问没有得到答复：${approval.title}${detail ? `（${detail}）` : ""}`);
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

  /** 把一次提醒送进任务会话，并在任务过程里记成不属于用户或助手的系统提醒。 */
  private remindWorker(worker: WorkerState, text: string): void {
    const step = reminderStep(`r${Date.now()}`, new Date().toISOString(), text);
    this.emitStep(worker.job.id, step);
    worker.lastActivityAt = Date.now();
    const session = worker.session;
    if (!session) return;
    const send = session.isStreaming ? session.steer(text) : session.prompt(text);
    void send.catch((error) => console.error("任务停滞提醒投递失败：", error));
  }

  checkStalls(now = Date.now()): void {
    const idleMs = this.runtime.settings.settings.work.jobStallMinutes * 60_000;
    for (const [jobId, worker] of this.workers) {
      const job = this.store.job(jobId);
      if (job?.status === "running" && job.startedAt && job.expect && worker.pausedAt === undefined) {
        const elapsed = Math.max(0, now - Date.parse(job.startedAt) - worker.pausedMs);
        if (elapsed >= job.expect.minutes * 60_000 * worker.nextReminder) {
          const reminder = worker.nextReminder === 1;
          while (elapsed >= job.expect.minutes * 60_000 * worker.nextReminder) worker.nextReminder *= 2;
          const source = job.expect.source === "assistant" ? "分派任务时估计的" : job.expect.source === "routine" ? `这个定时任务以前 ${job.expect.runs} 次的中位数` : "默认 10 分钟";
          const routine = job.routineId && this.store.routine(job.routineId);
          const prefix = routine ? `定时任务「${routine.name}」` : `任务「${job.title}」`;
          if (reminder) {
            this.remindWorker(worker, `${JOB_REMINDER_LEAD}${Math.floor(elapsed / 60_000)} 分钟，超过派活时预计的 ${job.expect.minutes} 分钟。已经做成、可以交的，现在整理好用 report 交结果；还没做完，就接着做。`);
          } else {
            const steps = [...this.workerSteps(jobId), ...worker.queued];
            for (const step of worker.steps.values()) {
              const index = steps.findIndex((item) => item.id === step.id);
              if (index >= 0) steps[index] = step; else steps.push(step);
            }
            const lines = jobProcessLines(steps, this.runtime.settings.settings.general.timezone, new Date(now)).slice(0, 10);
            const text = `${prefix}（${job.id}）已运行 ${Math.floor(elapsed / 60_000)} 分钟，超过预计的 ${job.expect.minutes} 分钟（${source}）。\n最近的过程（新的在前）：${lines.length ? `\n${lines.join("\n")}` : ""}`;
            void this.notifyAssistant(job, text, { job: { id: job.id, round: job.rounds?.length ?? 0, kind: "timeout" } }).catch((error) => console.error("任务超时通知失败：", error));
          }
        }
      }
      // 在等用户答提问不算没响应：等多久都是用户的事
      if (!worker.ask && !worker.session?.isStreaming && now - worker.lastActivityAt > idleMs) {
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
    const interrupted: Job[] = [];
    for (const job of this.store.jobs()) {
      if (job.status === "running" || job.status === "queued" || job.status === "waiting") {
        const next: Job = { ...job, status: "failed", endedAt: now, statusReason: "Hob 重启，任务中断" };
        this.store.saveJob(next);
        this.bus.emit({ type: "job", job: next });
        interrupted.push(next);
      } else if (job.sediment?.status === "running") {
        this.setSediment(job.id);
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
    for (const worker of this.workers.values()) { worker.scriptRevokes?.forEach((revoke) => revoke()); worker.session?.dispose(); void worker.desktop?.dispose(); }
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
