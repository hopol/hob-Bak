// 事项：群主把一件要分几步、几个人接力的事立成事项，记下原始需求、问答、需求说明、
// 子任务和验收结果。记录同时写一份 md（groups/<gid>/projects/<pid>.md），成员和任务读它。
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { projectRecordPath } from "./config.ts";
import { newId } from "./ids.ts";
import { validateJobCwd } from "./jobs.ts";
import type { HobRuntime } from "./runtime.ts";
import { projectEnded, stageText, subtaskStatus } from "../../shared/project.ts";
import type { Approval, ApprovalAnswer, ApprovalQuestion, Group, Job, Project, ProjectCheck, ProjectQuestion, ProjectStage, Subtask, TopicProject } from "../../shared/types.ts";
import { monthDayClockText } from "./time.ts";

/** 记录里和提示词里的时间写成 MM-DD HH:mm，按用户的时区。 */
export function shortTime(timezone: string, at: string): string {
  return monthDayClockText(timezone, new Date(at));
}

export interface OpenProjectInput {
  group: Group;
  ownerId: string;
  title: string;
  request?: Project["request"];
}

export interface RequirementsInput {
  content: string;
  acceptance: string[];
}

/** 验收任务交来的一条结果（report 的 checks）。 */
export interface CheckInput {
  index: number;
  passed: boolean;
  evidence: string;
  files?: string[];
}

/** 任务结束了的状态：这些状态的任务可以接着做（reply_job）。 */
const ENDED: Job["status"][] = ["done", "stuck", "failed", "stopped"];

/** plan_subtasks 收到的一个子任务：assignee 填群里成员的名字，或者「用户」。 */
export interface PlanSubtaskInput {
  title: string;
  assignee: string;
  brief: string;
  after?: number[];
  check?: boolean;
}

/** 一个问题答了什么：选了选项就写选项文字，自己写的就是那句话。 */
function answerLabel(question: ApprovalQuestion, answer: ApprovalAnswer | undefined): string {
  if (!answer) return "";
  if (answer.key) return question.options.find((option) => option.key === answer.key)?.label ?? answer.key;
  return answer.text ?? "";
}

/** 子任务受阻时事件里的原因：任务没给原因就写它的结束方式。 */
function blockReason(status: Job["status"]): string {
  return status === "stopped" ? "任务被停了" : status === "failed" ? "任务失败" : "没说明原因";
}

export class ProjectManager {
  private starting = new Set<string>();

  constructor(private readonly runtime: HobRuntime) {}

  private get store() {
    return this.runtime.store;
  }

  private get timezone() {
    return this.runtime.settings.settings.general.timezone;
  }

  /** 这个群的事项，新的在前。 */
  list(gid: string): Project[] {
    return this.store.projects(gid);
  }

  get(gid: string, pid: string): Project | undefined {
    return this.store.project(gid, pid);
  }

  /** 进行中的事项（还没结束的）。 */
  active(gid: string): Project[] {
    return this.list(gid).filter((project) => !projectEnded(project));
  }

  /**
   * 话题在左栏和综合话题卡上的进度：话题里有事项才有。
   * done / total 看子任务（用户的看 doneAt，成员的看任务是不是 done）；
   * waitingUser 是有没回答的提问卡，轮到用户、还没点完成的子任务，或者子任务拆好了等用户点开始。
   */
  topicOf(group: Group): TopicProject | undefined {
    if (!group.parentId) return undefined;
    const project = this.list(group.id)[0];
    if (!project) return undefined;
    const done = project.subtasks.filter((subtask) => this.isDone(subtask)).length;
    const waitingUser =
      (project.stage === "plan" && project.subtasks.length > 0) ||
      this.store.approvals().some((approval) => approval.groupId === group.id && approval.status === "pending") ||
      project.subtasks.some((subtask) => subtask.assignee === "user" && Boolean(subtask.notifiedAt) && !subtask.doneAt);
    // 执行时看正在做子任务的成员（任务排队、在跑、在等回复）；其余进行中的阶段是负责人；结束的不填
    const current = projectEnded(project) ? undefined : project.stage === "doing" ? this.runningAssignee(project) : project.ownerId;
    return {
      id: project.id,
      title: project.title,
      stage: project.stage,
      done,
      total: project.subtasks.length,
      waitingUser,
      ...(current ? { current } : {}),
    };
  }

  /** 正在做子任务的成员：子任务的任务排队、在跑、在等回复。 */
  private runningAssignee(project: Project): string | undefined {
    const busy: Job["status"][] = ["queued", "running", "waiting"];
    return project.subtasks.find((subtask) => {
      const job = subtask.jobId ? this.store.job(subtask.jobId) : undefined;
      return job ? busy.includes(job.status) : false;
    })?.assignee;
  }

  /** 立事项：原始需求取叫到群主的这条用户消息，时间线加一张事项卡。一个话题只放一件事项。 */
  open(input: OpenProjectInput): Project {
    const now = new Date().toISOString();
    if (input.group.parentId) {
      const existing = this.list(input.group.id)[0];
      if (existing) throw new Error(`这个话题已经有事项「${existing.title}」（${existing.id}）：一个话题只放一件事项。`);
    }
    const request = input.request ?? this.requestOf(input.group, input.ownerId);
    const id = newId("p-");
    // 卡片先落进时间线，事项再记下卡片的条目 id
    const card = this.runtime.groups.appendItem(input.group.id, input.ownerId, { kind: "project", projectId: id });
    const project: Project = {
      id,
      groupId: input.group.id,
      title: input.title.trim(),
      ownerId: input.ownerId,
      stage: "clarify",
      request,
      clarify: [],
      subtasks: [],
      itemId: card.id,
      createdAt: now,
      updatedAt: now,
    };
    this.save(project);
    return project;
  }

  /** 写或改需求说明；还在需求澄清时写完进入任务拆分。 */
  writeRequirements(gid: string, pid: string, input: RequirementsInput): { project: Project; advanced: boolean } {
    const project = this.find(gid, pid);
    const now = new Date().toISOString();
    const advanced = project.stage === "clarify";
    const next: Project = {
      ...project,
      requirements: { content: input.content.trim(), acceptance: input.acceptance.map((item) => item.trim()), updatedAt: now },
      ...(advanced ? { stage: "plan" as ProjectStage } : {}),
      updatedAt: now,
    };
    this.save(next);
    return { project: next, advanced };
  }

  /** 结束事项：做完了（done）或者不做了（dropped），summary 是结论或放弃的原因。事项在话题里，话题跟着关。 */
  close(gid: string, pid: string, outcome: "done" | "dropped", summary: string): Project {
    const project = this.find(gid, pid);
    const now = new Date().toISOString();
    const next: Project = { ...project, stage: outcome, summary: summary.trim(), endedAt: now, updatedAt: now };
    this.save(next);
    const topic = this.store.group(next.groupId);
    if (topic?.parentId) this.runtime.groups.closeByOwner(topic.id, next.summary);
    return next;
  }

  /** 话题被用户关了：里面没结束的事项按放弃处理，原因由关话题的那段写好。 */
  drop(project: Project, summary: string): Project {
    const now = new Date().toISOString();
    const next: Project = { ...project, stage: "dropped", summary, endedAt: now, updatedAt: now };
    this.save(next);
    return next;
  }

  /**
   * 把事项拆成子任务（plan_subtasks）。还没开始的整份替换：已经有任务的、用户已经点了完成的
   * 原样保留、序号不变，其余的换成这一次给的。新给的按顺序编号，接在保留下来的后面。
   */
  plan(gid: string, pid: string, given: PlanSubtaskInput[], cwd?: string): Project {
    const project = this.find(gid, pid);
    if (project.stage !== "plan" && project.stage !== "doing") {
      throw new Error(`事项「${project.title}」现在是${stageText(project)}，plan_subtasks 只在任务拆分或执行时用。`);
    }
    if (!given.length) throw new Error("subtasks 不能为空：至少给一个子任务，按做的先后排。");
    const group = this.store.group(gid);
    if (!group) throw new Error(`群不存在：${gid}`);
    const selectedCwd = cwd?.trim();
    if (selectedCwd) {
      validateJobCwd(this.runtime.home, selectedCwd);
      if (!existsSync(selectedCwd) || !statSync(selectedCwd).isDirectory()) throw new Error(`没有这个目录：${selectedCwd}。cwd 填已有的项目目录；不填就各在任务自己的目录里做。`);
    }
    const kept = project.subtasks.filter((subtask) => subtask.jobId || subtask.doneAt);
    const start = kept.reduce((max, subtask) => Math.max(max, subtask.n), 0);
    const people = group.members.map((id) => ({ id, name: this.nameOf(id) }));
    const added = given.map((entry, index) => {
      const position = index + 1;
      const title = String(entry.title ?? "").trim();
      const brief = String(entry.brief ?? "").trim();
      if (!title) throw new Error(`第 ${position} 个子任务的 title 不能为空：写这一份工作叫什么。`);
      const assignee = this.assigneeOf(String(entry.assignee ?? ""), people);
      const after = [...new Set((Array.isArray(entry.after) ? entry.after : []).map(Number))];
      for (const before of after) {
        if (!Number.isInteger(before) || before < 1 || before >= position) {
          throw new Error(`第 ${position} 个子任务的 after 只能填排在前面的序号（1 到 ${position - 1}），收到「${before}」；前置要填它自己前面的子任务，才不会绕成圈。`);
        }
      }
      if (entry.check && assignee === "user") {
        throw new Error(`第 ${position} 个子任务是验收子任务（check），不能交给用户：验收交给没参与做的成员，或者交给你自己。`);
      }
      return {
        n: start + position,
        title,
        assignee,
        brief,
        after: after.map((before) => start + before),
        ...(entry.check ? { check: true } : {}),
      } satisfies Subtask;
    });
    const now = new Date().toISOString();
    const next: Project = {
      ...project,
      ...(selectedCwd ? { cwd: selectedCwd } : {}),
      subtasks: [...kept, ...added].sort((a, b) => a.n - b.n),
      updatedAt: now,
    };
    this.save(next);
    if (next.stage === "doing") this.advance(next);
    return next;
  }

  /** 开始执行（start_subtasks，或者用户点了「开始执行」）：阶段进入 doing，已经能开始的子任务安排下去。 */
  start(gid: string, pid: string): Project {
    const project = this.find(gid, pid);
    if (project.stage !== "plan") {
      throw new Error(`事项「${project.title}」现在是${stageText(project)}，start_subtasks 只在任务拆分时用。`);
    }
    if (!project.subtasks.length) {
      throw new Error(`事项「${project.title}」还没有子任务：先用 plan_subtasks 把它拆成子任务，再开始执行。`);
    }
    const now = new Date().toISOString();
    const next: Project = { ...project, stage: "doing", startedAt: now, updatedAt: now };
    this.save(next);
    this.advance(next);
    return this.store.project(gid, pid) ?? next;
  }

  /** 用户的子任务点了完成：记 doneAt，再看后面的子任务轮没轮到。 */
  done(gid: string, pid: string, n: number): Project {
    const project = this.find(gid, pid);
    const subtask = project.subtasks.find((entry) => entry.n === n);
    if (!subtask) throw new Error(`事项「${project.title}」没有子任务 ${n}。${this.subtaskListText(project)}`);
    if (subtask.assignee !== "user") {
      throw new Error(`子任务 ${n}「${subtask.title}」是${this.nameOf(subtask.assignee)}的任务，由它派任务做；这里只点用户自己的子任务。`);
    }
    if (!project.startedAt) throw new Error(`事项「${project.title}」还没开始执行，用户的子任务还没轮到；先开始执行。`);
    if (subtask.doneAt) return project;
    const waiting = this.waitingOf(project, subtask);
    if (waiting.length) {
      throw new Error(`子任务 ${n}「${subtask.title}」的前置还没完成：${waiting.map((entry) => `子任务 ${entry.n}「${entry.title}」`).join("、")}。等前面的做完再点完成。`);
    }
    const now = new Date().toISOString();
    const next: Project = {
      ...project,
      subtasks: project.subtasks.map((entry) => (entry.n === n ? { ...entry, doneAt: now } : entry)),
      updatedAt: now,
    };
    this.save(next);
    this.advance(next);
    return this.store.project(gid, pid) ?? next;
  }

  /** 子任务开了任务：记下任务 id，任务说明由 taskInstruction 从事项记录生成。 */
  attach(project: Project, n: number, jobId: string): Project {
    const now = new Date().toISOString();
    const next: Project = {
      ...project,
      subtasks: project.subtasks.map((entry) => (entry.n === n ? { ...entry, jobId } : entry)),
      updatedAt: now,
    };
    this.save(next);
    return next;
  }

  /** 子任务的任务结束了：告诉负责人，轮到后面的就安排下去，全部做完就进入验收。 */
  jobEnded(job: Job): void {
    const where = job.project;
    if (!where || !job.groupId) return;
    const project = this.store.project(job.groupId, where.id);
    if (!project || projectEnded(project)) return;
    const subtask = project.subtasks.find((entry) => entry.n === where.n);
    if (!subtask) return;
    const now = new Date().toISOString();
    const latest: Project = { ...project, updatedAt: now };
    // 记录里的子任务状态和报告路径跟着刷新
    this.save(latest);
    const text =
      job.status === "done"
        ? `事项「${project.title}」的子任务 ${subtask.n}「${subtask.title}」已完成。`
        : `事项「${project.title}」的子任务 ${subtask.n}「${subtask.title}」受阻：${job.statusReason ?? blockReason(job.status)}。`;
    void this.runtime.groups.deliverEvent(project.groupId, project.ownerId, text).catch((error) => console.error("子任务的结果没送到负责人：", error));
    // 返工做完了：验收任务结束过，请验收子任务的成员再验一次
    if (job.status === "done" && !subtask.check) this.remindChecker(project, subtask, job);
    this.advance(latest);
  }

  /** 结束过的子任务又被接着做（reply_job）：验收这一步回到执行，等它再做一遍。 */
  jobResumed(job: Job): void {
    const where = job.project;
    if (!where || !job.groupId) return;
    const project = this.store.project(job.groupId, where.id);
    if (!project || project.stage !== "review") return;
    this.save({ ...project, stage: "doing", updatedAt: new Date().toISOString() });
  }

  /**
   * 验收任务交来的逐条结果（report 的 checks）：记进事项，同一条以最新的为准。
   * outcome 为 done 时每一条验收标准都要有结果，缺了报错并写明缺第几条。
   */
  recordChecks(jobId: string, outcome: string, given: unknown): void {
    const job = this.store.job(jobId);
    const where = job?.project;
    const project = job && where && job.groupId ? this.store.project(job.groupId, where.id) : undefined;
    const subtask = project && where ? project.subtasks.find((entry) => entry.n === where.n) : undefined;
    if (!job || !project || !subtask?.check) throw new Error("checks 只有验收子任务的任务能填。");
    const acceptance = project.requirements?.acceptance ?? [];
    if (!acceptance.length) throw new Error(`事项「${project.title}」还没有验收标准：先写好需求说明和验收标准再验。`);
    const entries = Array.isArray(given) ? given : [];
    const parsed = entries.map((entry, position) => {
      const raw = (entry ?? {}) as Record<string, unknown>;
      const index = Number(raw.index);
      if (!Number.isInteger(index) || index < 1 || index > acceptance.length) {
        throw new Error(`第 ${position + 1} 条结果的序号要填验收标准的序号（1 到 ${acceptance.length}），收到「${String(raw.index ?? "")}」。`);
      }
      if (typeof raw.passed !== "boolean") throw new Error(`第 ${position + 1} 条结果（验收标准 ${index}）的 passed 要填 true 或 false。`);
      const evidence = String(raw.evidence ?? "").trim();
      if (!evidence) throw new Error(`第 ${position + 1} 条结果（验收标准 ${index}）的 evidence 不能为空：写清命令和输出、截图、文件，或者看到的是什么、应该是什么。`);
      const files = Array.isArray(raw.files) && raw.files.length
        ? { files: (raw.files as unknown[]).map((file) => resolve(job.cwd ?? this.store.workDir(job.id), String(file))) }
        : {};
      return { index, passed: raw.passed, evidence, ...files } satisfies CheckInput;
    });
    if (outcome === "done") {
      const missing = acceptance.map((_, at) => at + 1).filter((index) => !parsed.some((entry) => entry.index === index));
      if (missing.length) {
        throw new Error(`缺第 ${missing.join("、")} 条验收结果：outcome 填 done 时每一条验收标准都要有结果。没法验证的那条记为不通过，evidence 里写清原因。`);
      }
    }
    const now = new Date().toISOString();
    const merged: ProjectCheck[] = [...(project.checks ?? [])];
    for (const entry of parsed) {
      const at = merged.findIndex((check) => check.index === entry.index);
      const check: ProjectCheck = { ...entry, jobId: job.id, at: now };
      if (at >= 0) merged[at] = check;
      else merged.push(check);
    }
    this.save({ ...project, checks: merged.sort((a, b) => a.index - b.index), updatedAt: now });
  }

  /** 验收结果：通过、没通过、未验证各几条。 */
  checkCounts(project: Project): { passed: number; failed: number; unchecked: number } {
    const acceptance = project.requirements?.acceptance ?? [];
    let passed = 0;
    let failed = 0;
    for (let index = 1; index <= acceptance.length; index += 1) {
      const check = this.checkOf(project, index);
      if (!check) continue;
      if (check.passed) passed += 1;
      else failed += 1;
    }
    return { passed, failed, unchecked: acceptance.length - passed - failed };
  }

  /** 返工做完了：给验收子任务的成员发事件，请它回到原来那个验收任务再验一次。 */
  private remindChecker(project: Project, subtask: Subtask, job: Job): void {
    // 只算「又被接着做」的：续做过至少一轮
    if (!job.rounds?.length) return;
    for (const checker of project.subtasks.filter((entry) => entry.check && entry.jobId)) {
      const checkJob = this.store.job(checker.jobId!);
      if (!checkJob || !ENDED.includes(checkJob.status)) continue;
      const text = `事项「${project.title}」的子任务 ${subtask.n}「${subtask.title}」改过了，验收任务「${checkJob.title}」（${checkJob.id}）可以再验一次。`;
      void this.runtime.groups.deliverEvent(project.groupId, checker.assignee, text).catch((error) => console.error("再验一次的事件没送到：", error));
    }
  }

  /** 子任务的任务说明：原始需求、需求说明、验收标准、这个子任务、前置结果、备注和记录路径，不取群里最后一句话。 */
  taskInstruction(project: Project, subtask: Subtask, note?: string): string {
    const lines: string[] = [`## 原始需求（${shortTime(this.timezone, project.request.at)}）`, "", project.request.text || "（没有记下原话）"];
    if (project.request.files?.length) lines.push("", `附件：${project.request.files.join("、")}`);
    if (project.request.quote) lines.push("", `引用：「${project.request.quote.text}」`);
    if (project.requirements) {
      lines.push("", "## 需求说明", "", project.requirements.content);
      lines.push("", "## 验收标准", "");
      project.requirements.acceptance.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
    lines.push("", "## 你的子任务", "", `子任务 ${subtask.n}「${subtask.title}」`, "", subtask.brief);
    const before = subtask.after.flatMap((n) => {
      const entry = project.subtasks.find((item) => item.n === n);
      return entry ? [entry] : [];
    });
    if (before.length) {
      lines.push("", "## 前置子任务的结果");
      for (const entry of before) {
        lines.push("", this.subtaskResultLine(project, entry));
      }
    }
    // 验收子任务：所有做出来的子任务交了什么，不只是直接前置的
    if (subtask.check) {
      const results = project.subtasks.filter((entry) => !entry.check);
      if (results.length) {
        lines.push("", "## 各子任务交来的结果");
        for (const entry of results) lines.push("", this.subtaskResultLine(project, entry));
      }
    }
    if (note?.trim()) lines.push("", `## 「${this.nameOf(subtask.assignee)}」的备注`, "", note.trim());
    lines.push("", "## 事项记录", "", this.recordPath(project));
    return lines.join("\n");
  }

  /** 子任务交来的结果：一行标题、谁做的、状态、报告，下面一行交来的文件。 */
  private subtaskResultLine(project: Project, entry: Subtask): string {
    const job = entry.jobId ? this.store.job(entry.jobId) : undefined;
    const status = subtaskStatus(project, entry, job, (other) => this.jobOf(other));
    const line = `- 子任务 ${entry.n}「${entry.title}」· ${this.who(entry.assignee)} · ${status} · 报告：${job?.reportPath ?? "没有报告文件"}`;
    return job?.files?.length ? `${line}\n  交来的文件：${job.files.join("、")}` : line;
  }

  /**
   * 用户答了问题卡：提问的成员在这个群里负责一件在需求澄清的事项，就把问答追加到最近更新的那件
   * （问题、为什么、选项、推荐、回答）。
   */
  recordAnswers(approval: Approval): void {
    if (!approval.groupId || approval.status !== "answered") return;
    const project = this.active(approval.groupId)
      .filter((entry) => entry.stage === "clarify" && entry.ownerId === approval.assistantId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!project) return;
    const at = approval.createdAt;
    const answeredAt = approval.answeredAt ?? new Date().toISOString();
    const asked: ProjectQuestion[] = approval.questions?.length
      ? approval.questions.map((question, index) => ({
          title: question.title,
          ...(question.why ? { why: question.why } : {}),
          options: question.options.map((option) => option.label),
          ...(question.recommended ? { recommended: question.options.find((option) => option.key === question.recommended)?.label ?? "" } : {}),
          answer: answerLabel(question, approval.answers?.[index]),
          askedBy: approval.assistantId,
          at,
          answeredAt,
        }))
      : [
          {
            title: approval.title,
            ...(approval.detail ? { why: approval.detail } : {}),
            options: approval.options.map((option) => option.label),
            answer: approval.chosen ? (approval.options.find((option) => option.key === approval.chosen)?.label ?? approval.chosen) : approval.answerText ?? "",
            askedBy: approval.assistantId,
            at,
            answeredAt,
          },
        ];
    this.save({ ...project, clarify: [...project.clarify, ...asked], updatedAt: answeredAt });
  }

  /** 进程启动后，继续安排事项里已经轮到但还没开出任务的子任务。 */
  recover(): void {
    for (const project of this.store.groups().flatMap((group) => this.list(group.id)).filter((entry) => entry.stage === "doing")) this.advance(project);
  }

  /** 做完的、轮到后面的、全部做完进验收，都由这里往下走。 */
  private advance(project: Project): void {
    if (project.stage !== "doing") return;
    if (project.subtasks.length && project.subtasks.every((subtask) => this.isDone(subtask))) {
      const now = new Date().toISOString();
      this.save({ ...project, stage: "review", updatedAt: now });
      const { passed, failed, unchecked } = this.checkCounts(project);
      void this.runtime.groups
        .deliverEvent(project.groupId, project.ownerId, `事项「${project.title}」的子任务都做完了，现在是验收。\n验收结果：通过 ${passed} 条，没通过 ${failed} 条，未验证 ${unchecked} 条。`)
        .catch((error) => console.error("事项进入验收的事件没送到：", error));
      return;
    }
    void this.pump(project);
  }

  /** 轮到的子任务：前置都完成了；成员的直接开任务，用户的发推送。 */
  private async pump(project: Project): Promise<void> {
    if (project.stage !== "doing") return;
    const ready = project.subtasks.filter((subtask) => {
      if (this.isDone(subtask) || this.waitingOf(project, subtask).length || subtask.startError) return false;
      if (subtask.assignee === "user") return !subtask.jobId && !subtask.notifiedAt;
      return !subtask.jobId && !this.starting.has(this.startKey(project, subtask));
    });
    if (!ready.length) return;
    const now = new Date().toISOString();
    const marked: Project = {
      ...project,
      subtasks: project.subtasks.map((subtask) => (ready.some((item) => item.n === subtask.n) ? { ...subtask, notifiedAt: subtask.notifiedAt ?? now } : subtask)),
      updatedAt: now,
    };
    this.save(marked);
    for (const subtask of ready) {
      if (subtask.assignee === "user") {
        void this.runtime.push.send({
          title: `待你执行：${subtask.title}`,
          body: `事项「${project.title}」· 子任务 ${subtask.n}`,
          url: `/#/group/${encodeURIComponent(project.groupId)}`,
        }).catch(() => undefined);
        continue;
      }
      void this.startMemberSubtask(marked, subtask);
    }
  }

  private async startMemberSubtask(project: Project, subtask: Subtask): Promise<void> {
    const key = this.startKey(project, subtask);
    if (this.starting.has(key)) return;
    this.starting.add(key);
    try {
      const existing = this.store.jobs().find((job) => job.groupId === project.groupId && job.assistantId === subtask.assignee && job.project?.id === project.id && job.project.n === subtask.n);
      if (existing) {
        this.attach(this.store.project(project.groupId, project.id) ?? project, subtask.n, existing.id);
        await this.rememberStartedSubtask(project, subtask, existing.id);
        return;
      }
      const job = await this.runtime.jobs.start(subtask.assignee, {
        title: subtask.title,
        groupId: project.groupId,
        instruction: this.taskInstruction(project, subtask),
        ...(project.request.files?.length ? { files: project.request.files } : {}),
        ...(project.cwd ? { cwd: project.cwd } : {}),
        project: { id: project.id, n: subtask.n },
      });
      this.attach(this.store.project(project.groupId, project.id) ?? project, subtask.n, job.id);
      await this.rememberStartedSubtask(project, subtask, job.id);
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/。+$/, "");
      const current = this.store.project(project.groupId, project.id);
      if (current) {
        this.save({
          ...current,
          subtasks: current.subtasks.map((entry) => (entry.n === subtask.n ? { ...entry, startError: reason } : entry)),
          updatedAt: new Date().toISOString(),
        });
      }
      void this.runtime.groups
        .deliverEvent(project.groupId, project.ownerId, `事项「${project.title}」的子任务 ${subtask.n}「${subtask.title}」受阻：任务没开起来，${reason}。`)
        .catch((deliveryError) => console.error("子任务启动失败的事件没送到负责人：", deliveryError));
    } finally {
      this.starting.delete(key);
    }
  }

  private async rememberStartedSubtask(project: Project, subtask: Subtask, jobId: string): Promise<void> {
    try {
      await this.runtime.router.remember(subtask.assignee, `事项「${project.title}」的子任务 ${subtask.n}「${subtask.title}」轮到你了，已经以你的名义开了任务 ${jobId}。`, project.groupId);
    } catch (error) {
      console.error("记进成员会话失败：", error);
    }
  }

  private startKey(project: Project, subtask: Subtask): string {
    return `${project.groupId}:${project.id}:${subtask.n}`;
  }

  private isDone(subtask: Subtask): boolean {
    if (subtask.assignee === "user") return Boolean(subtask.doneAt);
    return subtask.jobId ? this.store.job(subtask.jobId)?.status === "done" : false;
  }

  /** 前置里还没做完的。 */
  private waitingOf(project: Project, subtask: Subtask): Subtask[] {
    return subtask.after.flatMap((n) => {
      const before = project.subtasks.find((entry) => entry.n === n);
      return before && !this.isDone(before) ? [before] : [];
    });
  }

  private assigneeOf(value: string, people: { id: string; name: string }[]): string {
    const text = value.trim();
    if (text === "用户") return "user";
    // 名字优先；名字对不上也认成员 id，填错了格式也能对得上人
    const hit = people.find((person) => person.name === text) ?? people.find((person) => person.id === text);
    if (hit) return hit.id;
    throw new Error(`assignee 要填群里成员的名字，或者「用户」；「${text}」对不上。群里有：${people.map((person) => person.name).join("、")}。`);
  }

  private subtaskListText(project: Project): string {
    return project.subtasks.length ? `这个事项的子任务：${project.subtasks.map((entry) => `${entry.n}「${entry.title}」`).join("、")}。` : "这个事项还没有子任务。";
  }

  /** 事项 id 不对、或者不是这个群的：说清楚，并列出这个群里进行中的事项。 */
  find(gid: string, pid: string): Project {
    const project = this.store.project(gid, pid?.trim() ?? "");
    if (!project) throw new Error(`没有这个事项：${pid}。这个群进行中的事项：${this.activeText(gid)}`);
    if (projectEnded(project)) throw new Error(`事项「${project.title}」（${project.id}）已经结束了，不能再改。这个群进行中的事项：${this.activeText(gid)}`);
    return project;
  }

  private activeText(gid: string): string {
    const active = this.active(gid);
    return active.length ? active.map((project) => `${project.title}（${project.id}）`).join("、") : "还没有";
  }

  /** 记录文件的路径：提示词和工具返回都写它。 */
  recordPath(project: Project): string {
    return projectRecordPath(this.runtime.home, project.groupId, project.id);
  }

  /** 每次变化都写一份 json 和一份 md，并推给前端；左栏和综合的话题卡跟着变。 */
  private save(project: Project): void {
    this.store.saveProject(project);
    this.store.saveProjectRecord(project.groupId, project.id, this.record(project));
    this.runtime.bus.emit({ type: "project", project });
    this.runtime.groups.publish(project.groupId);
  }

  private nameOf(assistantId: string): string {
    return this.store.assistant(assistantId)?.name ?? assistantId;
  }

  private who(assignee: string): string {
    return assignee === "user" ? "你" : this.nameOf(assignee);
  }

  /** 叫到群主的那条用户消息；这一轮不是用户叫的，就取群里最后一条用户消息。 */
  private requestOf(group: Group, ownerId: string): Project["request"] {
    const user = this.runtime.groups.requestItem(group.id, ownerId);
    if (!user || (user.kind !== "user" && (user.kind !== "note" || user.icon !== "routine"))) return { text: "", at: new Date().toISOString() };
    return {
      text: user.text,
      ...(user.kind === "user" && user.files?.length ? { files: user.files } : {}),
      ...(user.kind === "user" && user.quote ? { quote: user.quote } : {}),
      itemId: user.id,
      at: user.at,
    };
  }

  /** 事项记录（md）：标题和状态、原始需求、问答、需求说明、验收标准、子任务、结论。 */
  record(project: Project): string {
    const lines: string[] = [`# ${project.title}`, "", `状态：${stageText(project)}`, `负责：${this.nameOf(project.ownerId)}`, `立事项：${shortTime(this.timezone, project.createdAt)}`];
    if (project.cwd) lines.push(`工作目录：${project.cwd}`);
    if (project.endedAt) lines.push(`结束：${shortTime(this.timezone, project.endedAt)}`);

    lines.push("", "## 原始需求", "", project.request.text || "（没有记下原话）");
    if (project.request.files?.length) lines.push("", `附件：${project.request.files.join("、")}`);
    if (project.request.quote) lines.push("", `引用：「${project.request.quote.text}」`);

    if (project.clarify.length) {
      lines.push("", "## 需求澄清", "");
      for (const question of project.clarify) {
        lines.push(`**${this.nameOf(question.askedBy)}**：${question.title}`);
        if (question.why) lines.push(`  为什么要定：${question.why}`);
        if (question.options?.length) lines.push(`  选项：${question.options.join(" / ")}`);
        if (question.recommended) lines.push(`  推荐：${question.recommended}`);
        lines.push(`**你**：${question.answer ?? "（还没回答）"}`, "");
      }
      if (lines.at(-1) === "") lines.pop();
    }

    if (project.requirements) {
      lines.push("", "## 需求说明", "", project.requirements.content, "", "## 验收标准", "");
      project.requirements.acceptance.forEach((item, index) => {
        const check = this.checkOf(project, index + 1);
        lines.push(`${index + 1}. ${checkLabel(check)} ${item}`);
        if (check) {
          lines.push(`   - 证据：${check.evidence}`);
          if (check.files?.length) lines.push(`   - 文件：${check.files.join("、")}`);
        }
      });
    }

    if (project.subtasks.length) {
      lines.push("", "## 子任务", "");
      for (const subtask of project.subtasks) {
        const job = subtask.jobId ? this.store.job(subtask.jobId) : undefined;
        const parts = [
          `${subtask.n}. ${subtask.title}`,
          this.who(subtask.assignee),
          subtask.after.length ? `前置：子任务 ${subtask.after.join("、")}` : "前置：无",
          subtaskStatus(project, subtask, job, (other) => this.jobOf(other)),
        ];
        if (subtask.jobId) parts.push(`任务 ${subtask.jobId}`);
        if (subtask.startError) parts.push(`原因：${subtask.startError}`);
        if (job?.reportPath) parts.push(`报告：${job.reportPath}`);
        lines.push(parts.join(" · "));
      }
    }

    if (project.summary?.trim()) lines.push("", project.stage === "dropped" ? "## 放弃原因" : "## 结论", "", project.summary.trim());
    return `${lines.join("\n")}\n`;
  }

  private checkOf(project: Project, index: number): ProjectCheck | undefined {
    return project.checks?.find((check) => check.index === index);
  }

  private jobOf(subtask: Subtask) {
    return subtask.jobId ? this.store.job(subtask.jobId) : undefined;
  }
}

/** 验收标准前面的方框：做完的打勾或打叉，还没验的留着。 */
function checkLabel(check: ProjectCheck | undefined): string {
  if (!check) return "[ ]";
  return check.passed ? "[x]" : "[!]";
}
