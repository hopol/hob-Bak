import type { HobRuntime } from "./runtime.ts";
import { nowText } from "./time.ts";

/** 每条 Router 消息附带的当前状态，不显示在对话里。 */
export function nowBlock(runtime: HobRuntime, assistantId: string): string {
  const now = new Date();
  const timezone = runtime.settings.settings.general.timezone;
  const clock = (value: string) => new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
  const short = (value: string) => Array.from(value).length > 20 ? `${Array.from(value).slice(0, 20).join("")}…` : value;
  const jobs = runtime.store.jobs().filter((job) => job.assistantId === assistantId);
  const lines = [`【现在】${nowText(timezone, now)}`];
  const active = jobs.filter((job) => ["running", "queued", "waiting"].includes(job.status)).map((job) => {
    const minutes = job.startedAt ? Math.floor((now.getTime() - new Date(job.startedAt).getTime()) / 60_000) : 0;
    const status = job.status === "queued" ? "排队中" : job.status === "waiting" ? "等你回复" : minutes < 1 ? "刚开始" : `运行 ${minutes} 分钟`;
    return `${job.id}「${short(job.title)}」，${status}`;
  });
  if (active.length) lines.push(`进行中：${active.join("；")}`);
  if (assistantId === "hob") {
    const delegations = runtime.store.delegations().filter((item) => item.from === assistantId && (item.status === "running" || item.status === "waiting"))
      .map((item) => `${runtime.store.assistant(item.to)?.name ?? item.to}「${short(item.text)}」，${clock(item.createdAt)} 起`);
    if (delegations.length) lines.push(`转交中：${delegations.join("；")}`);
  }
  const approvals = runtime.store.approvals().filter((item) => item.assistantId === assistantId && item.status === "pending" && item.source !== "job").map((item) => item.title);
  if (approvals.length) lines.push(`等用户选：${approvals.join("；")}`);
  const names = { done: "已完成", stuck: "受阻", failed: "失败", stopped: "已停止" } as const;
  const recent = jobs.filter((job) => job.endedAt && !job.routineId && job.status in names && new Date(job.endedAt).getTime() >= now.getTime() - 86_400_000 && new Date(job.endedAt).getTime() <= now.getTime())
    .sort((a, b) => b.endedAt!.localeCompare(a.endedAt!)).slice(0, 5)
    .map((job) => `${job.id}「${short(job.title)}」${clock(job.endedAt!)} ${names[job.status as keyof typeof names]}`);
  if (recent.length) lines.push(`最近结束：${recent.join("；")}`);
  return lines.join("\n");
}
