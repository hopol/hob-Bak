import type { Approval, Job, JobStatus, JobStep } from "../../shared/types.ts";
import type { AssistantSkill } from "../../shared/skills.ts";

const statusText: Record<JobStatus, string> = { queued: "排队中", running: "进行中", waiting: "等你回复", done: "已完成", stuck: "受阻", failed: "失败", stopped: "已停止" };

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** 任务过程按时间倒序，供任务查看和超时通知共用。 */
export function jobProcessLines(steps: JobStep[], timezone: string, now = new Date()): string[] {
  const visible = steps.filter((step) => step.kind === "tool" || (step.kind === "text" && (step.from === "assistant" || step.from === "user")));
  const format = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const today = format.format(now).slice(0, 10);
  return visible.reverse().map((step) => {
    const time = format.format(new Date(step.at));
    const clock = time.slice(0, 10) === today ? time.slice(11) : time.slice(5);
    const detail = step.kind === "tool"
      ? `${step.title ?? step.name ?? "工具"}${step.running ? ` · 还在跑，${Math.max(0, Math.floor((now.getTime() - Date.parse(step.at)) / 60000))} 分钟` : ""}${step.isError ? " · 出错" : ""}`
      : `${step.from === "user" ? "收到" : "说"}：${step.text ?? ""}`;
    const line = `${clock} ${detail}`.replace(/\s+/g, " ").trim();
    const chars = [...line];
    return chars.length > 160 ? `${chars.slice(0, 159).join("")}…` : line;
  });
}

export function jobView(job: Job, steps: JobStep[], approvals: Approval[], skills: AssistantSkill[], timezone: string, now = new Date()): string {
  const ended = !["queued", "running", "waiting"].includes(job.status);
  const elapsed = Math.max(0, now.getTime() - Date.parse(job.startedAt ?? job.createdAt));
  const state = job.status === "queued" ? "排队中" : ended
    ? `${statusText[job.status]}，用时 ${duration(job.durationMs ?? (job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt ?? job.createdAt) : 0))}`
    : `${statusText[job.status]}，已运行 ${elapsed < 60000 ? "不到 1 分钟" : `${Math.floor(elapsed / 60000)} 分钟`}`;
  const lines = [`任务「${job.title}」（${job.id}）：${state}${job.rounds?.length ? `（第 ${job.rounds.length + 1} 轮）` : ""}`];
  if (job.statusReason) lines.push(`原因：${job.statusReason}`);
  for (const approval of approvals.filter((item) => item.jobId === job.id && item.status === "pending")) lines.push(`在等你回复：${approval.title}`);
  if (job.skillsUsed?.length) lines.push(`用到的技能：${job.skillsUsed.map((name) => { const skill = skills.find((item) => item.name === name); return skill ? `${skill.title}（第 ${skill.version} 版）` : name; }).join("、")}`);
  if (ended) {
    if (job.summary) {
      const chars = [...job.summary];
      lines.push(chars.length > 1000 ? `结果（共 ${chars.length} 字，全文：${job.reportPath ?? "无"}）：${chars.slice(0, 1000).join("")}` : `结果：${job.summary}`);
    }
    if (job.reportPath) lines.push(`报告：${job.reportPath}`);
  }
  if (job.rounds?.length) lines.push(`之前的轮次：${job.rounds.map((round, i) => `第 ${i + 1} 轮 ${statusText[round.status]}，用时 ${duration(round.durationMs ?? (round.startedAt && round.endedAt ? Date.parse(round.endedAt) - Date.parse(round.startedAt) : 0))}`).join("；")}`);
  lines.push(`工作目录：${job.cwd ?? "未指定"}`);
  const process = jobProcessLines(steps, timezone, now);
  lines.push(`过程（新的在前，共 ${process.length} 步）：`, ...process);
  return lines.join("\n");
}
