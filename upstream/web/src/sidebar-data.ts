import { currentLocale, t } from "../../shared/i18n.ts";
import { Cron } from "croner";
import type { Approval, AssistantSummary, Delegation, Job, Routine } from "../../shared/types.ts";
import type { KnowledgeEntry } from "../../shared/knowledge.ts";

export function followingModel(source: "group" | "assistant" | "global", name: string) {
  const label = source === "group" ? t("本群") : t("助手");
  return { text: t("跟随{label} · {name}", { label, name }), option: t("跟随{label}（{name}）", { label, name }) };
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
  // 群和话题里出的问题卡挂在那个群的行上，不再算到助手自己头上（不然首页同一件事出现两行）
  if (approvals.some((approval) => approval.status === "pending" && !approval.groupId && approval.assistantId === assistant.id && approval.source !== "job")) return "等你确认";
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
  const locale = currentLocale() === "en" ? "en-US" : "zh-CN";
  const time = new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  if (day === date(now)) return t("今天 {time}", { time });
  if (day === tomorrow) return t("明天 {time}", { time });
  const md = new Intl.DateTimeFormat(locale, { timeZone: timezone, month: "short", day: "numeric" }).format(at);
  return `${md} ${time}`;
}

export function routineSummary(routines: Routine[], timezone: string, now = new Date()): string {
  if (!routines.length) return t("没有");
  const next = nextRoutine(routines, timezone, now);
  if (!next) return `${routines.length} ${t("个")} · ${routines.some((r) => r.active) ? t("无下次执行时间") : t("已暂停")}`;
  return `${routines.length} ${t("个")} · ${formatNext(next.at, timezone, now)}`;
}

export function sidebarInfoValues(skillCount: number, knowledgeNames: string[], ruleCount: number) {
  return { skills: skillCount ? `${skillCount} ${t("个")}` : t("没有"), knowledge: knowledgeNames.length ? knowledgeNames.join(t("、")) : t("未开启"), rules: ruleCount ? `${ruleCount} ${t("条")}` : t("没有") };
}

export function groupSidebarFiles(entries: KnowledgeEntry[], now = new Date()) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return { week: entries.filter((entry) => new Date(entry.updatedAt) >= monday), older: entries.filter((entry) => new Date(entry.updatedAt) < monday) };
}
