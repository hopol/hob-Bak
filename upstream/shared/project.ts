// 事项的推导：子任务状态不存，由事项、子任务和它对应的任务推出来（界面和服务端共用）。
import type { Job, Project, ProjectStage, Subtask } from "./types.ts";

/** 子任务的状态。 */
export type SubtaskStatus = "未开始" | "等待前置任务" | "待开始" | "进行中" | "已完成" | "受阻" | "待你执行";

/** 阶段在提示词和状态行里的写法。 */
export const STAGE_TEXT: Record<ProjectStage, string> = {
  clarify: "需求澄清",
  plan: "任务拆分",
  doing: "执行中",
  review: "验收中",
  done: "已完成",
  dropped: "已放弃",
};

/** 阶段条上的五步（g7）：需求说明单独一步，执行带完成数。 */
export const STAGE_STEPS = ["需求澄清", "需求说明", "任务拆分", "执行", "验收"] as const;

/** 让这一阶段走的第几步（0 起）；已结束的停在最后。 */
export function stageIndex(stage: ProjectStage): number {
  return stage === "clarify" ? 0 : stage === "plan" ? 2 : stage === "doing" ? 3 : 4;
}

/** 状态行里的一句话：「执行中」，放弃的带上原因。 */
export function stageText(project: Project): string {
  if (project.stage !== "dropped") return STAGE_TEXT[project.stage];
  const reason = project.summary?.trim();
  return reason ? `已放弃：${reason}` : "已放弃";
}

/** 事项结束了没有（结束以后不再接受改需求说明、结束这类变化）。 */
export function projectEnded(project: Project): boolean {
  return project.stage === "done" || project.stage === "dropped";
}

/**
 * 一个子任务现在是什么状态。
 * job 是这个子任务对应的任务；jobOf 用来查别的子任务（前置）的任务，不传就只看自己的。
 */
export function subtaskStatus(
  project: Project,
  subtask: Subtask,
  job?: Job | null,
  jobOf?: (subtask: Subtask) => Job | null | undefined,
): SubtaskStatus {
  const jobFor = (other: Subtask) => (other === subtask ? job : jobOf?.(other));
  const done = (other: Subtask) => (other.assignee === "user" ? Boolean(other.doneAt) : jobFor(other)?.status === "done");
  // 做完的就说做完：事项还在执行时，已经交了的子任务不该因为别的事显示回「未开始」
  if (done(subtask)) return "已完成";
  if (subtask.startError) return "受阻";
  if (!project.startedAt) return "未开始";
  if (subtask.after.some((n) => {
    const before = project.subtasks.find((entry) => entry.n === n);
    return before ? !done(before) : false;
  })) return "等待前置任务";
  if (subtask.assignee === "user") return "待你执行";
  if (!job) return "待开始";
  if (job.status === "queued" || job.status === "running" || job.status === "waiting") return "进行中";
  return "受阻";
}

/** 执行到哪儿了：做完的子任务数和总数。 */
export function projectProgress(project: Project, jobOf?: (subtask: Subtask) => Job | null | undefined): { done: number; total: number } {
  const done = project.subtasks.filter((subtask) => subtaskStatus(project, subtask, jobOf?.(subtask), jobOf) === "已完成").length;
  return { done, total: project.subtasks.length };
}
