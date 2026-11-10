import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Job } from "../../shared/types.ts";
import type { HobRuntime } from "./runtime.ts";

const SUMMARY_CHARS = 100;
const LOG_LIMIT = 10;

const STATUS_TEXT: Record<Job["status"], string> = {
  queued: "排队中",
  running: "进行中",
  waiting: "等你确认",
  done: "已完成",
  stuck: "受阻",
  failed: "失败",
  stopped: "已停止",
};

function whenText(timezone: string, iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isLive(job: Job): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "waiting";
}

/** 各助手最近这段时间的记录：工作日志、结束的任务、进行中的任务、待确认的审批。 */
export function overviewText(runtime: HobRuntime, sinceHours = 24): string {
  const hours = Math.min(Math.max(Math.round(sinceHours), 1), 24 * 7);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const timezone = runtime.settings.settings.general.timezone;
  const jobs = runtime.store.jobs();
  const pending = runtime.store.approvals().filter((approval) => approval.status === "pending" && approval.source !== "job");

  const blocks: string[] = [];
  let endedCount = 0;
  let liveCount = 0;

  for (const assistant of runtime.store.assistants()) {
    const mine = jobs.filter((job) => job.assistantId === assistant.id);
    const ended = mine
      .filter((job) => job.endedAt && job.endedAt >= since)
      .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
    const live = mine.filter(isLive);
    const asks = pending.filter((approval) => approval.assistantId === assistant.id);
    const log = runtime.store
      .worklog(assistant.id, 100)
      .filter((entry) => entry.at >= since)
      .slice(0, LOG_LIMIT);
    if (!ended.length && !live.length && !asks.length && !log.length) continue;
    endedCount += ended.length;
    liveCount += live.length;

    const lines = [`## ${assistant.name}（${assistant.id}）`];
    if (live.length) {
      lines.push("进行中：");
      for (const job of live) {
        const started = job.startedAt ? `，${whenText(timezone, job.startedAt)} 开始` : "";
        lines.push(`- ${job.title} · ${STATUS_TEXT[job.status]}${started}`);
      }
    }
    if (ended.length) {
      lines.push("结束的任务：");
      for (const job of ended) {
        const summary = job.summary ? oneLine(job.summary, SUMMARY_CHARS) : job.statusReason ?? "没有摘要";
        lines.push(`- ${job.title} · ${STATUS_TEXT[job.status]} · ${summary}`);
      }
    }
    if (log.length) {
      lines.push("工作日志：");
      for (const entry of log) lines.push(`- ${whenText(timezone, entry.at)} ${entry.text}`);
    }
    if (asks.length) {
      lines.push("等你确认：");
      for (const approval of asks) lines.push(`- ${approval.title}（${whenText(timezone, approval.createdAt)}）`);
    }
    blocks.push(lines.join("\n"));
  }

  const head = `最近 ${hours} 小时（${whenText(timezone, since)} 之后）：${endedCount} 件结束的任务、${liveCount} 件进行中、${pending.length} 个等你确认。`;
  if (!blocks.length) return `${head}\n\n这段时间没有记录。`;
  return `${head}\n\n${blocks.join("\n\n")}`;
}

/** 只读的 overview 工具：只给主助手（Router）和主助手的任务（Worker）。 */
export function overviewTool(runtime: HobRuntime): ToolDefinition<any, any> {
  return {
    name: "overview",
    label: "查看这段时间的记录",
    description:
      "查各助手一段时间内的工作日志和任务，写早报、日报，或者回答「这段时间做了什么」时用。",
    parameters: Type.Object({
      sinceHours: Type.Optional(Type.Integer({ description: "往回看多少小时，默认 24，最多 168" })),
    }),
    execute: async (_id, params: any) => {
      const hours = Number(params.sinceHours ?? 24);
      return {
        content: [{ type: "text" as const, text: overviewText(runtime, Number.isFinite(hours) ? hours : 24) }],
        details: undefined,
      };
    },
  };
}
