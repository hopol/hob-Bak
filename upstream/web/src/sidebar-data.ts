import { Cron } from "croner";
import type { Approval, AssistantSummary, Delegation, Job, Routine } from "../../shared/types.ts";
import type { KnowledgeEntry } from "../../shared/knowledge.ts";
import type { AssistantSkill } from "../../shared/skills.ts";

export function followingModel(source: "group" | "assistant" | "global", name: string) {
  const label = source === "group" ? "本群" : "助手";
  return { text: `跟随${label} · ${name}`, option: `跟随${label}（${name}）` };
}

export function routineSkills(group: AssistantSkill[], member: AssistantSkill[]) {
  const own = group.filter((skill) => skill.enabled);
  return [...own.map((skill) => ({ skill, group: true })), ...member.filter((skill) => skill.enabled && !own.some((item) => item.name === skill.name)).map((skill) => ({ skill, group: false }))];
}

export function nextRoutine(routines: Routine[], timezone: string, now = new Date()): { routine: Routine; at: Date } | undefined {
  let next: { routine: Routine; at: Date } | undefined;
  for (const routine of routines) if (routine.active) for (const schedule of routine.schedules) {
    try {
      const at = new Cron(schedule, { timezone }).nextRun(now);
      if (at && (!next || at < next.at)) next = { routine, at };
    } catch { /* Invalid schedules have no calculable next run. */ }
  }
  return next;
}

export function assistantStatus(assistant: Pick<AssistantSummary, "id" | "busy">, jobs: Job[], approvals: Approval[], delegations: Delegation[]) {
  const own = jobs.filter((job) => job.assistantId === assistant.id);
  // 只有真等用户答的提问才算「等你确认」；任务提了问在等助手回（waiting），对用户来说还是在办
  if (approvals.some((approval) => approval.status === "pending" && (approval.assistantId === assistant.id || own.some((job) => job.id === approval.jobId)))) return "等你确认";
  // 转交出去的活算在收到转交的那个助手头上：交出去的一方这一轮已经说完了，等结果时是空闲的
  if (assistant.busy || own.some((job) => job.status === "running" || job.status === "waiting") || delegations.some((d) => d.status === "running" && d.to === assistant.id)) return "执行中";
  if (own.some((job) => job.status === "queued")) return "排队中";
  return "空闲";
}

export function sidebarJobs(jobs: Job[], assistantId: string) {
  const own = jobs.filter((job) => job.assistantId === assistantId);
  const last = own.filter((job) => !["running", "queued", "waiting"].includes(job.status) && job.endedAt).sort((a, b) => b.endedAt!.localeCompare(a.endedAt!))[0];
  const running = own.filter((job) => job.status === "running").sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))[0];
  return { running, last };
}

export function formatNext(at: Date, timezone: string, now = new Date()): string {
  const date = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  const day = date(at);
  const [year, month, dayOfMonth] = date(now).split("-").map(Number);
  const tomorrow = new Date(Date.UTC(year!, month! - 1, dayOfMonth! + 1)).toISOString().slice(0, 10);
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  if (day === date(now)) return `今天 ${time}`;
  if (day === tomorrow) return `明天 ${time}`;
  const md = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "numeric", day: "numeric" }).format(at);
  return `${md} ${time}`;
}

export function routineSummary(routines: Routine[], timezone: string, now = new Date()): string {
  if (!routines.length) return "没有";
  const next = nextRoutine(routines, timezone, now);
  if (!next) return `${routines.length} 个 · ${routines.some((r) => r.active) ? "无下次执行时间" : "已暂停"}`;
  return `${routines.length} 个 · ${formatNext(next.at, timezone, now)}`;
}

export function sidebarInfoValues(skillCount: number, knowledgeNames: string[], ruleCount: number) {
  return { skills: skillCount ? `${skillCount} 个` : "没有", knowledge: knowledgeNames.length ? knowledgeNames.join("、") : "未开启", rules: ruleCount ? `${ruleCount} 条` : "没有" };
}

export function groupSidebarFiles(entries: KnowledgeEntry[], now = new Date()) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return { week: entries.filter((entry) => new Date(entry.updatedAt) >= monday), older: entries.filter((entry) => new Date(entry.updatedAt) < monday) };
}
