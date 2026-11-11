import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { commandSummary } from "../../shared/command.ts";
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
} from "../../shared/types.ts";
import { IMAGE_TYPES, isImagePath } from "../../shared/media.ts";
import { newId } from "./ids.ts";
import { resolveMovedPath } from "./layout.ts";
import { availableDesktopTools, type DesktopToolSession } from "./desktop-tools.ts";
import { imageConfigured } from "./image.ts";
import { boundKnowledge, findKnowledgeTool, searchKnowledgeTool } from "./knowledge-tools.ts";
import { MCP_SESSION_TOOLS, mcpEnabled, mcpServerDisplay } from "./mcp.ts";
import { jobModel, assistantInGroup } from "./models.ts";
import { duration, jobProcessLines } from "./job-view.ts";
import { overviewTool } from "./overview.ts";
import { pushJobEnd } from "./push.ts";
import { buildWorkerPrompt, type Abilities, type PromptSettings } from "./prompt.ts";
import { availableSkills } from "./skills.ts";
import { assistantSkillsDir, combinedSkills, groupSkillsDir, loadedSkills, recordSkillUse, usableAssistantSkills, usableSkills } from "./assistant-skills.ts";
import type { AssistantSkill } from "../../shared/skills.ts";
import { reconcileSkills, restoreSkills, snapshotSkills, type SkillSaved } from "./sediment.ts";
import type { HobRuntime } from "./runtime.ts";
import { showPath } from "./text.ts";
import { monthDayTimeText } from "./time.ts";
import { SEDIMENT_PROMPT_HEAD, STEP_EVENT_LIMIT, deriveSteps, textOfContent, toolStep, withOutput } from "./transcript.ts";
import { registerAskTool, registerImageTool, registerReportTool } from "./worker-tools.ts";
import { searchTools } from "./search.ts";

const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ACTIVITY_LIMIT = 200;
const ENDED: JobStatus[] = ["done", "stuck", "failed", "stopped"];

/** 这一轮没交结果时的提醒：续做、沉淀都用这一句。 */
const NO_RESULT_PROMPT = "这一轮结束了，还没有交结果。做完了就调用 report 交结果；没做完，也用 report 说明做到哪、卡在哪。";

/** 沉淀消息的前四段（从 SEDIMENT_PROMPT_HEAD 接下去），和以前逐字一致。 */
const SEDIMENT_BODY = `，下次接到同类的事，照着它就能一次做成用户要的样子。

下一次的情况会和这次不一样，所以技能写这一类事怎么做，不写这一次的经过和数据。按做事的顺序写步骤，带上要用的命令、查询和判断点，怎么判断结果对不对，写在对应的那一步里。用户在过程中纠正过的做法、对结果提过的要求，最能帮下次少走弯路，要写进去。踩过的坑写成一条规则加一句原因，放在它影响的那一步；会变的情况写怎么查，不写死。每条经验只写一次，修补时直接改掉写错的那句。

技能要照着能跑通。写进去的只读命令和查询，存之前再跑一遍，确认照着写的就能用；能写成脚本的步骤，写成只读脚本放在 scripts/，一次输出要看的全部结果，跑一遍、输出对得上再保存。会改东西的步骤只写在正文里，留给以后的任务确认后再执行。偶尔才用得上的细节放 references/，按主题起文件名。

有几类东西留在技能外面：临时故障和网络错误，环境没装好、没配好导致的失败只写怎么装好、配好；「某个工具不能用」这类结论，环境修好以后它还会一直挡路；这次没走通的尝试。助手的规则和工具说明里已经有的，也不用重复。

`;

/** 沉淀这一轮发给任务的话（第 7.1 节）：改已有技能给它现在的目录，新建给技能目录。 */
export function sedimentMessage(input: { into?: AssistantSkill; skillsDir: string; note?: string; assistantName: string }): string {
  const fifth = input.into
    ? `这次在技能「${input.into.title}」（${input.into.name}，第 ${input.into.version} 版）的基础上改：它在 ${dirname(input.into.path)}，先读它现在的内容，再直接改这个目录里的文件。`
    : `这次新建一个技能，名字和说明按这一类事来起，不按这一次。建在 ${input.skillsDir}/<名字>/，名字只用小写字母、数字和连字符，如 weekly-report。SKILL.md 开头这样写：\n\`\`\`\n---\nname: <名字>\ndescription: <什么时候用，一句话，120 字以内>\nmetadata:\n  title: <中文名，如「每周周报」>\n---\n\`\`\``;
  const note = input.note ? `\n「${input.assistantName}」交代：${input.note}` : "";
  return `${SEDIMENT_PROMPT_HEAD}${SEDIMENT_BODY}${fifth}${note}\n\n写好以后调用 report，result 里写这次新建或改了哪些地方。一次性的事、几步就做完的事，或者照常做就不会走弯路的事，没有值得沉淀的，不用动技能，调用 report 说一句为什么就好。`;
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

/** 校验任务工作目录：必须在 Hob 数据目录之外；调用方另行校验目录是否存在。 */
export function validateJobCwd(home: string, cwd: string): void {
  const canonical = (path: string): string => {
    const absolute = resolve(path);
    let parent = absolute;
    while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
    return resolve(realpathSync(parent), relative(parent, absolute));
  };
  const path = relative(canonical(home), canonical(cwd));
  if (!path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
    throw new Error("不能在 Hob 的数据目录里干活；不填 cwd 就在任务自己的目录里做。");
  }
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
  /** 在群里开的任务：卡片进这个群的时间线，结果回到这个成员在群里的会话 */
  groupId?: string;
  /** 前置任务 id：这些都做完了才开始 */
  after?: string[];
  /** 事项里的子任务：任务结束后由它告诉负责人、安排后面的子任务 */
  project?: { id: string; n: number };
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

/** 一次沉淀：任务自己的会话再跑一轮，报告时拿技能目录和底稿对账。 */
interface SedimentState {
  jobId: string;
  cancelled: boolean;
  /** 改哪份技能（名字）；没有就是新建 */
  into?: string;
  session?: AgentSession;
  desktop?: DesktopToolSession;
  task?: Promise<void>;
  /** 这一轮交过的报告：交过就不再对账一次 */
  report?: { ok: boolean; text: string };
  /** 轮到它、拍过底稿了（排队时被停下的没有底稿，不用恢复） */
  started?: boolean;
  /** 模型调用出错（连接断了、额度用完）：这一轮按失败收尾 */
  error?: string;
  lastText?: string;
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
  if (job.project && (job.skillsUsed ?? []).some((name) => skills.some((skill) => skill.name === name))) return undefined;
  const last = skills.filter((skill) => skill.fromJobId === job.id).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  return `这个任务没带技能。用 save_job_as_skill 让它回顾一遍，把能复用的做法沉淀下来，有没有值得沉淀的由它判断；已经有同类的技能，into 填那份。${last ? `上次从这个任务沉淀出了技能「${last.title}」（${last.name}），into 填它。` : ""}`;
}

/** 发给任务所属助手的结果事件。转交结束发给 Hob 的汇总用它不带提醒的那份（delegations.ts）。 */
export function assistantJobResultEvent(home: string, job: Job, options: { prefix?: string; toolCount?: number; group?: Group } = {}): string {
  const skills = combinedSkills(home, job.assistantId, options.group);
  const skillTitles = (job.skillsUsed ?? []).map((name) => skills.find((skill) => skill.name === name)?.title ?? name);
  const filesNote = job.files?.length ? `\n任务交来的文件：${job.files.join("、")}。` : "";
  const text = jobResultEvent(job, options.prefix ?? `任务「${job.title}」`, skillTitles, options.toolCount ?? job.stats.reads + job.stats.commands + job.stats.edits, sedimentHint(home, job, skills));
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
  private sediments = new Map<string, SedimentState>();
  /** 每个助手最后一次沉淀的收尾：同一个助手的沉淀排队一个个来 */
  private sedimentQueue = new Map<string, Promise<void>>();
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
      mcpServers: mcpServerDisplay(this.runtime.home),
      // 迁移前写进会话的绝对路径：换成新位置后，详情页里还是短文件名
      resolvePath: (path) => resolveMovedPath(this.runtime.home, path),
    });
  }

  async start(assistantId: string, input: StartJobInput): Promise<Job> {
    const assistant = this.store.assistant(assistantId);
    if (!assistant) throw new Error(`助手不存在：${assistantId}`);
    const after = [...new Set((input.after ?? []).map((id) => id.trim()).filter(Boolean))];
    for (const id of after) {
      const before = this.store.job(id);
      if (!before) throw new Error(`没有这个任务：${id}`);
      if (before.status === "stuck" || before.status === "failed" || before.status === "stopped") {
        throw new Error(`前置任务「${before.title}」（${id}）${endWord(before.status)}，等不到它做完了。`);
      }
    }
    if (input.cwd?.trim()) {
      validateJobCwd(this.runtime.home, input.cwd);
    }
    await this.runtime.models.get();
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
      cwd: input.cwd?.trim() ? input.cwd : this.store.workDir(id, assistantId),
      model: picked.model.ref,
      thinking: picked.model.thinking,
      ...(picked.modelReason ? { modelReason: picked.modelReason } : {}),
      ...(input.files?.length ? { inputs: input.files } : {}),
      ...(input.routineId ? { routineId: input.routineId } : {}),
      ...(input.skills?.length ? { skills: input.skills } : {}),
      ...(after.length ? { after } : {}),
      ...(input.delegationId ? { delegationId: input.delegationId } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.project ? { project: input.project } : {}),
    };
    this.store.saveJob(job);
    if (job.delegationId) this.runtime.delegations.addJob(job.delegationId, job.id);
    await this.runtime.router.addItem(assistantId, { kind: "job", jobId: job.id }, job.groupId);
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

  /** 事件送到派它的助手的会话：群里的任务回它的群会话，其余回单聊。 */
  private notifyAssistant(job: Job, text: string): Promise<void> {
    return job.groupId
      ? this.runtime.router.event(job.assistantId, text, undefined, job.groupId)
      : this.runtime.router.event(job.assistantId, text);
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
      await this.finish(dependent.id, "stuck", undefined, `前置任务「${job.title}」没做成`);
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
  private async openWorkerSession(job: Job, sediment = false): Promise<{ session: AgentSession; manager: SessionManager; mcpServers: Record<string, string>; desktop?: DesktopToolSession }> {
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
    const customTools = [registerReportTool(this.runtime, job.id, sediment), registerAskTool(this.runtime, job.id, sediment), findKnowledgeTool(this.runtime)];
    if (knowledge.length) customTools.push(searchKnowledgeTool(this.runtime, job.assistantId));
    if (abilities.image) customTools.push(registerImageTool(this.runtime, job.id));
    customTools.push(...searchTools(this.runtime.home, () => this.runtime.settings.settings.search));
    const desktop = await availableDesktopTools(this.runtime, job.assistantId, !!this.runtime.models.find(job.model ?? this.runtime.settings.settings.models.work.ref)?.input.includes("image"), job.title, join(this.store.workDir(job.id), "screenshots"));
    if (desktop) customTools.push(...desktop.tools());
    // 定时跑的就是 Worker：主助手的任务要看得到各助这段时间的动静才能写早报
    if (assistant?.primary) customTools.push(overviewTool(this.runtime));
    // MCP：配置里有启用中的服务才加载（改完配置，之后新开的任务生效）
    const mcp = mcpEnabled(this.runtime.home);
    const group = job.groupId ? this.store.group(job.groupId) : undefined;
    const ownSkillInfo = combinedSkills(this.runtime.home, job.assistantId, group);
    const ownSkills = loadedSkills(ownSkillInfo);
    const selectedSkills = job.project ? ownSkills : ownSkills.filter((skill) => job.skills?.includes(skill.name));
    const selectedSkillInfo = ownSkillInfo.filter((skill) => selectedSkills.some((item) => item.name === skill.name));
    const ownNames = new Set(selectedSkills.map((skill) => skill.name));
    const opened = await this.runtime.pi.open({
      file: this.store.workerFile(job.id),
      cwd: job.cwd ?? homedir(),
      model: job.model ?? this.runtime.settings.settings.models.work.ref,
      thinking: job.thinking ?? this.runtime.settings.settings.models.work.thinking,
      memory: this.runtime.settings.memory().provider,
      skills: [...selectedSkills, ...availableSkills(this.runtime.home, undefined, this.runtime.settings.settings.skills?.disabled).filter((skill) => !ownNames.has(skill.name))],
      disabledSkills: this.runtime.settings.settings.skills?.disabled,
      systemPrompt: () =>
        buildWorkerPrompt(this.store, job.id, { ...this.promptSettings(), ...(job.project && selectedSkillInfo.length ? { assistantSkills: selectedSkillInfo } : {}), abilities: promptAbilities, desktopEnabled: !!desktop, knowledgeNames: knowledge.map((collection) => collection.name) }),
      tools: [
        ...new Set([
          ...workerTools(abilities),
          ...(sediment ? ["write", "edit"] : []),
          ...customTools.map((tool) => tool.name),
          ...(mcp ? MCP_SESSION_TOOLS : []),
        ]),
      ],
      customTools,
      mcp,
    });
    return { session: opened.session, manager: opened.manager, mcpServers: mcpServerDisplay(this.runtime.home), ...(desktop ? { desktop } : {}) };
  }

  private async launch(job: Job, followUp?: string): Promise<void> {
    const running: Job = {
      ...job,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.store.saveJob(running);
    this.bus.emit({ type: "job", job: running });

    const { session, manager, mcpServers, desktop } = await this.openWorkerSession(running);
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
        const step = worker.steps.get(event.toolCallId);
        if (step) this.emitStep(running.id, this.withStepOutput(running.id, step, textOfContent(event.partialResult?.content)));
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

    const instruction = followUp ?? [running.instruction, this.afterBrief(running)].filter(Boolean).join("\n\n");
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

  private recordSkillUse(worker: WorkerState, path: string): void {
    const job = this.store.job(worker.job.id);
    if (!job) return;
    let absolute: string;
    try { absolute = realpathSync(resolve(job.cwd ?? homedir(), path)); }
    catch { return; }
    const skill = combinedSkills(this.runtime.home, job.assistantId, job.groupId ? this.store.group(job.groupId) : undefined).find((item) => existsSync(item.path) && realpathSync(item.path) === absolute);
    if (!skill || job.skillsUsed?.includes(skill.name)) return;
    recordSkillUse(dirname(dirname(skill.path)), skill.name);
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
    await worker?.desktop?.dispose();
    await this.settle(job, status, { summary, reason, files, lastText: worker?.lastText });
    const ended = this.store.job(jobId);
    if (ended) this.runtime.projects.jobEnded(ended);

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
    pushJobEnd({ push: this.runtime.push, store: this.store }, next);
    this.publishBusy(next);
    const assistant = this.store.assistant(job.assistantId);
    this.store.addWorklog(job.assistantId, {
      at: endedAt,
      text: `任务${statusText}：${job.title}`,
      jobId: job.id,
    });
    this.bus.emit({ type: "profile", assistantId: job.assistantId });
    const toolCount = this.workerSteps(job.id).filter((step) => step.kind === "tool" && (!next.startedAt || step.at >= next.startedAt)).length;

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
          .event(job.assistantId, assistantJobResultEvent(this.runtime.home, next, { prefix: `定时任务「${routine.name}」`, toolCount, group: next.groupId ? this.store.group(next.groupId) : undefined }), {
            routine: { id: routine.id, name: routine.name, jobId: job.id },
          }, next.groupId)
          .catch(() => undefined);
      }
    } else if (assistant) {
      const text = assistantJobResultEvent(this.runtime.home, next, { toolCount, group: next.groupId ? this.store.group(next.groupId) : undefined });
      if (delegationId) void this.runtime.router.relay(job.assistantId, text, delegationId).catch(() => this.runtime.delegations.turnEnded(delegationId, "目标助手处理失败", true));
      else await this.notifyAssistant(next, text).catch(() => undefined);
    }
  }

  async reply(jobId: string, text: string, source: "user" | "router" = "user"): Promise<void> {
    await this.finishing.get(jobId);
    const target = this.store.job(jobId);
    if (!target) throw new Error("没有这个任务。");
    // 用户绕过助手直接对任务说的话，助手也要知道：任务之后来问、交结果时它才对得上
    if (source === "user") void this.runtime.router.remember(target.assistantId, `用户给任务「${target.title}」（${target.id}）追加了回复：${text}`, target.groupId).catch((error) => console.error("记进助手会话失败：", error));
    // 沉淀中有人接着说：先停掉沉淀、照底稿把技能改回去，再照常开新一轮
    if (this.sediments.has(jobId)) await this.stopSediment(jobId);
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
      this.followUps.set(jobId, `${source === "router" ? `「${this.store.assistant(job.assistantId)?.name ?? job.assistantId}」` : "用户"}接着说（${monthDayTimeText(this.runtime.settings.settings.general.timezone)}）：${text}`);
      // 验收过的事项又去改：阶段回到执行，改完再验一次
      this.runtime.projects.jobResumed(queued);
      this.bus.emit({ type: "job", job: queued });
      this.publishBusy(queued);
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

  /** 沉淀的底稿目录：开始前拍的技能目录，收尾和恢复都用它。 */
  private sedimentBase(jobId: string): string {
    return join(this.store.jobDir(jobId), "sediment-base");
  }

  private sedimentDir(job: Job): string {
    const file = join(this.sedimentBase(job.id), ".target.json");
    if (!existsSync(file)) return assistantSkillsDir(this.runtime.home, job.assistantId);
    const owner = JSON.parse(readFileSync(file, "utf8")) as { kind: "group" | "assistant"; id: string };
    if (owner.kind === "group") return groupSkillsDir(this.runtime.home, owner.id);
    if (owner.kind === "assistant") return assistantSkillsDir(this.runtime.home, owner.id);
    throw new Error("沉淀目标无效");
  }

  startSediment(jobId: string, options: { into?: string; note?: string; manual?: boolean } = {}): void {
    const job = this.store.job(jobId);
    if (!job) throw new Error("任务不存在");
    if (job.status !== "done" || this.finishing.has(jobId) || this.workers.has(jobId)) throw new Error("只有已完成的任务可以沉淀");
    if (this.sediments.has(jobId)) throw new Error("任务正在沉淀技能");
    const group = job.groupId ? this.store.group(job.groupId) : undefined;
    const skills = combinedSkills(this.runtime.home, job.assistantId, group);
    // 任务详情上手动点的不带 into：默认改这个任务沉淀出来的、还在用的那份（和结果里的提醒一样）
    const last = skills.filter((skill) => skill.fromJobId === job.id).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    const wanted = options.into ?? (options.manual ? last?.name : undefined);
    const into = wanted ? skills.find((skill) => skill.name === wanted) : undefined;
    if (wanted && !into) throw new Error(`没有这个技能：${wanted}。现有的：${skills.map((skill) => skill.name).join("、") || "无"}`);
    const groupId = group ? group.parentId ?? group.id : undefined;
    const groupDir = groupId ? groupSkillsDir(this.runtime.home, groupId) : undefined;
    const owner = groupDir && (!into || dirname(dirname(into.path)) === groupDir)
      ? { kind: "group", id: groupId! } : { kind: "assistant", id: job.assistantId };
    const base = this.sedimentBase(jobId);
    rmSync(base, { recursive: true, force: true });
    mkdirSync(base, { recursive: true });
    const file = join(base, ".target.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(owner));
    renameSync(`${file}.tmp`, file);
    const dir = this.sedimentDir(job);
    const state: SedimentState = { jobId, cancelled: false, ...(into ? { into: into.name } : {}) };
    this.sediments.set(jobId, state);
    this.setSediment(jobId, { status: "running" });
    // 一个助手一次只沉淀一个任务：技能目录是共用的，拍底稿到对账这段时间要独占；后来的排在后面
    const previous = this.sedimentQueue.get(dir) ?? Promise.resolve();
    state.task = previous.then(() => this.runSediment(job, state, into, options.note));
    const tail = state.task.catch(() => undefined);
    this.sedimentQueue.set(dir, tail);
    void tail.then(() => { if (this.sedimentQueue.get(dir) === tail) this.sedimentQueue.delete(dir); });
  }

  /** 轮到这一次沉淀：拍底稿、跑这一轮；出错照底稿恢复、记失败；收尾删底稿，失败才通知助手。 */
  private async runSediment(job: Job, state: SedimentState, into: AssistantSkill | undefined, note?: string): Promise<void> {
    const skillsDir = this.sedimentDir(job);
    const base = this.sedimentBase(job.id);
    try {
      // 排队时就被接着说停下了：收尾已经由 stopSediment 做完
      if (state.cancelled) return;
      // 开始前拍底稿：收尾、被停下、进程重启都拿它恢复
      snapshotSkills(skillsDir, base);
      state.started = true;
      // 排队这段时间里前一次沉淀可能改过这份：重新取一次，消息里的版本号才对
      const current = into ? usableSkills(skillsDir).find((skill) => skill.name === into.name) ?? into : undefined;
      await this.sedimentRound(job, state, current, note);
    } catch (error) {
      if (!state.cancelled) {
        console.error("沉淀技能失败：", error);
        try { if (existsSync(join(base, ".snapshot-ready"))) restoreSkills(skillsDir, base); }
        catch (restoreError) { console.error("恢复技能失败：", restoreError); }
        this.setSediment(job.id, { status: "failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      // 被停下的由 stopSediment 恢复、删底稿、清状态
      if (state.cancelled) return;
      rmSync(base, { recursive: true, force: true });
      const sediment = this.store.job(job.id)?.sediment;
      // 只有失败才通知助手：沉淀出来什么了，任务卡片和对话里已经写着
      if (sediment?.status === "failed") {
        await this.notifyAssistant(job, `任务「${job.title}」（${job.id}）沉淀完了：沉淀失败，${sediment.reason}。`).catch((error) => console.error("发送沉淀结果失败：", error));
      }
    } finally {
      if (this.sediments.get(job.id) === state) this.sediments.delete(job.id);
    }
  }

  /** 停下沉淀：在跑的中断会话、照底稿恢复、删底稿；排队的直接取消，不等前面那个。都不留记录。 */
  private async stopSediment(jobId: string): Promise<void> {
    const state = this.sediments.get(jobId);
    if (!state) return;
    state.cancelled = true;
    this.sediments.delete(jobId);
    if (state.started) {
      await state.session?.abort().catch(() => undefined);
      await state.task?.catch(() => undefined);
    }
    const job = this.store.job(jobId);
    if (!job) return;
    if (state.started) {
      // 已经对账存好了（状态不是 running）就不恢复
      if (job.sediment?.status === "running") {
        try { restoreSkills(this.sedimentDir(job), this.sedimentBase(jobId)); }
        catch (error) { console.error("恢复技能失败：", error); }
      }
      rmSync(this.sedimentBase(jobId), { recursive: true, force: true });
    }
    if (!state.started) rmSync(this.sedimentBase(jobId), { recursive: true, force: true });
    if (job.sediment?.status === "running") this.setSediment(jobId);
  }

  /** 沉淀这一轮调 report：拿技能目录和底稿对账，返回给模型看的话。 */
  async reportSediment(jobId: string, result: string): Promise<{ ok: boolean; text: string }> {
    const state = this.sediments.get(jobId);
    const job = this.store.job(jobId);
    if (!state || !job) return { ok: true, text: "结果已记录。" };
    if (state.report) return state.report;
    const outcome = await this.reconcileSediment(job, result);
    if (!outcome.ok) return { ok: false, text: `技能还没存上：${outcome.reasons.join("；")}。改好以后再调用 report。` };
    state.report = { ok: true, text: outcome.text };
    return state.report;
  }

  /** 报告时的对账：技能目录和底稿比，按结果登记版本、写提示行，记任务上的沉淀状态。 */
  private async reconcileSediment(job: Job, result: string): Promise<{ ok: true; text: string } | { ok: false; reasons: string[] }> {
    let outcome: ReturnType<typeof reconcileSkills>;
    try { outcome = reconcileSkills(this.sedimentDir(job), this.sedimentBase(job.id), job.id); }
    catch (error) { return { ok: false, reasons: [error instanceof Error ? error.message : String(error)] }; }
    if (!outcome.ok) return outcome;
    if (!outcome.saved.length) {
      this.setSediment(job.id, { status: "empty", reason: result.trim() || "没有需要沉淀的" });
      return { ok: true, text: "结果已记录。" };
    }
    // 先记状态再写提示行：这之后被接着说停下，也不会把已经登记的技能改回去
    const chosen = outcome.saved.find((item) => item.name === this.sediments.get(job.id)?.into) ?? outcome.saved[0]!;
    this.setSediment(job.id, { status: "saved", name: chosen.name, title: chosen.title, version: chosen.version, updated: chosen.updated });
    this.bus.emit({ type: "skills", assistantId: job.assistantId });
    for (const saved of outcome.saved) await this.noteSavedSkill(job, saved);
    return { ok: true, text: "技能已保存。" };
  }

  /** 每份改动的技能在对话里落一行；定时任务还没绑技能的，绑上新建的那份。 */
  private async noteSavedSkill(job: Job, saved: SkillSaved): Promise<void> {
    let text = saved.updated ? `已更新技能「${saved.title}」· 第 ${saved.version} 版` : `已沉淀技能「${saved.title}」`;
    const routine = job.routineId ? this.store.routine(job.routineId) : undefined;
    if (routine && !routine.skill) {
      this.runtime.routines.update(routine.id, { skill: saved.name });
      text = `已沉淀技能「${saved.title}」，以后定时执行按它做`;
    }
    const path = join(this.sedimentDir(job), saved.name, "SKILL.md");
    await this.runtime.router.addItem(job.assistantId, { kind: "note", icon: "skill", text, path }, job.groupId).catch((error) => console.error("写入技能提示失败：", error));
  }

  /** 沉淀就是任务的又一轮：同一个会话、同一套工具，直接改技能目录，收尾时对账。 */
  private async sedimentRound(job: Job, state: SedimentState, into: AssistantSkill | undefined, note?: string): Promise<void> {
    const skillsDir = this.sedimentDir(job);
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
    const message = sedimentMessage({ ...(into ? { into } : {}), skillsDir, ...(note ? { note } : {}), assistantName: this.store.assistant(job.assistantId)?.name ?? job.assistantId });
    try {
      await opened.session.prompt(message);
      if (state.cancelled || state.report) return;
      // 模型出错停下的不提醒、不对账：改了一半的照底稿恢复（runSediment 收尾）
      if (state.error) throw new Error(state.error);
      // 没交 report：照常提醒一次
      await opened.session.prompt(NO_RESULT_PROMPT);
      if (state.cancelled || state.report) return;
      if (state.error) throw new Error(state.error);
      // 还不交：按交了处理，result 用最后一段话；校验还不过就把技能恢复原样，记失败
      const outcome = await this.reconcileSediment(job, state.lastText ?? "");
      if (!outcome.ok) {
        try { restoreSkills(skillsDir, this.sedimentBase(job.id)); }
        catch (error) { console.error("恢复技能失败：", error); }
        this.setSediment(job.id, { status: "failed", reason: `技能没改好，已恢复原样：${outcome.reasons.join("；")}` });
      }
    } finally {
      opened.session.dispose();
      await opened.desktop?.dispose();
    }
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
    input: { title: string; detail?: string; options: ApprovalOption[]; recommended?: ApprovalOption["key"]; ruleText?: string },
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
    const text = `任务「${job.title}」（${job.id}）在等你回复：${sentence(input.title)}${input.detail ? sentence(input.detail) : ""}选项：${input.options.map((option) => `${option.key} ${option.label}${option.key === input.recommended ? "（推荐）" : ""}`).join("、")}。`;
    if (delegationId) void this.runtime.router.relay(job.assistantId, text, delegationId).catch(() => this.runtime.delegations.turnEnded(delegationId, "目标助手处理失败", true));
    else void this.notifyAssistant(job, text).catch((error) => console.error("任务提问投递失败：", error));
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
          const steps = [...this.workerSteps(jobId), ...worker.queued];
          for (const step of worker.steps.values()) {
            const index = steps.findIndex((item) => item.id === step.id);
            if (index >= 0) steps[index] = step; else steps.push(step);
          }
          const lines = jobProcessLines(steps, this.runtime.settings.settings.general.timezone, new Date(now)).slice(0, 10);
          const text = `${prefix}（${job.id}）已运行 ${Math.floor(elapsed / 60_000)} 分钟，超过预计的 ${job.expect.minutes} 分钟（${source}）。\n最近的过程（新的在前）：${lines.length ? `\n${lines.join("\n")}` : ""}`;
          void this.notifyAssistant(job, text).catch((error) => console.error("任务超时通知失败：", error));
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
    const interrupted: Job[] = [];
    for (const job of this.store.jobs()) {
      if (job.status === "running" || job.status === "queued" || job.status === "waiting") {
        const next: Job = { ...job, status: "failed", endedAt: now, statusReason: "Hob 重启，任务中断" };
        this.store.saveJob(next);
        this.bus.emit({ type: "job", job: next });
        interrupted.push(next);
      } else if (job.sediment?.status === "running") {
        // 沉淀改到一半：技能目录照底稿恢复，任务上记失败。没有底稿的是还在排队、没动过技能的
        const base = this.sedimentBase(job.id);
        if (existsSync(base)) {
          try {
            if (!existsSync(join(base, ".target.json")) || existsSync(join(base, ".snapshot-ready"))) restoreSkills(this.sedimentDir(job), base);
          }
          catch (error) { console.error("恢复技能失败：", error); }
          rmSync(base, { recursive: true, force: true });
        }
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
    for (const job of interrupted) this.runtime.projects.jobEnded(job);
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
