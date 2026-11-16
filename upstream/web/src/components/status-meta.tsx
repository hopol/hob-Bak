import type { ReactNode } from "react";
import type { Delegation, GroupSummary, Job, JobStatus, SedimentStatus } from "../../../shared/types.ts";
import { t } from "../../../shared/i18n.ts";
import { Icon, type IconName } from "../icons.tsx";
import { todoProgress } from "./Todos.tsx";

export function sedimentText(sediment: SedimentStatus): string {
  if (sediment.status === "running") return t("沉淀技能中…");
  if (sediment.status === "empty") return t("没有要沉淀的");
  if (sediment.status === "failed") return t("沉淀失败");
  return sediment.updated ? t("已更新技能「{title}」· 第 {version} 版", { title: sediment.title, version: sediment.version }) : t("已沉淀技能「{title}」", { title: sediment.title });
}

export type StatusMeta = { text: string; icon: IconName; color: "" | "live" | "ok" | "bad"; spin: boolean };

function dynamicMeta(text: string, icon: IconName, color: StatusMeta["color"], spin: boolean): StatusMeta {
  return { get text() { return t(text); }, icon, color, spin };
}

export const JOB_STATUS: Record<JobStatus, StatusMeta> = {
  queued: dynamicMeta("排队中", "clock", "", false),
  running: dynamicMeta("进行中", "spin", "live", true),
  waiting: dynamicMeta("等助手回复", "pause", "", false),
  done: dynamicMeta("已完成", "check", "ok", false),
  stuck: dynamicMeta("受阻", "close", "bad", false),
  failed: dynamicMeta("失败", "close", "bad", false),
  stopped: dynamicMeta("已停止", "stop", "", false),
};

/** 左栏话题行的小标签：话题有没做完的待办时写 k/n，鼠标悬停写全。 */
export function todoStamp(g: GroupSummary): { text: string; title: string } | null {
  const { done, total } = todoProgress(g.todos);
  if (!total || done >= total) return null;
  return { text: `${done}/${total}`, title: t("待办 {done}/{total}", { done, total }) };
}

export const DELEGATION_STATUS: Record<Delegation["status"], StatusMeta> = {
  running: dynamicMeta("进行中", "spin", "live", true),
  waiting: dynamicMeta("等你确认", "pause", "", false),
  done: dynamicMeta("已完成", "check", "ok", false),
  stuck: dynamicMeta("受阻", "close", "bad", false),
  interrupted: dynamicMeta("已中断", "close", "bad", false),
  returned: dynamicMeta("已退回", "close", "bad", false),
  takenOver: dynamicMeta("已被你接手", "user", "", false),
};

/** 排队里的任务在等前面的任务：写等谁；多个写等几个。 */
export function jobStatusMeta(job: Job, jobs: Record<string, Job>): StatusMeta {
  if (job.status !== "queued" || !job.after?.length) return JOB_STATUS[job.status];
  if (job.after.length > 1) return { ...JOB_STATUS.queued, text: t("等 {n} 个任务", { n: job.after.length }) };
  const title = jobs[job.after[0]!]?.title;
  return { ...JOB_STATUS.queued, text: title ? t("等「{title}」", { title }) : t("等前面的任务") };
}

export function jobStatusIcon(status: JobStatus, size: number, w?: number) {
  const meta = JOB_STATUS[status];
  return <Icon name={meta.icon} size={size} w={w} className={meta.spin ? "spin" : ""} />;
}

export function StatusTag({ meta, card = false, animated = false, swapped = false, children }: {
  meta: StatusMeta; card?: boolean; animated?: boolean; swapped?: boolean; children?: ReactNode;
}) {
  const cls = card ? `st${meta.color === "ok" ? " done" : meta.color === "bad" ? " bad" : ""}` : `jt-st${meta.color ? ` ${meta.color}` : ""}`;
  return <span className={cls}>
    {animated ? <span className="stico">
      <Icon name="spin" size={14} w={2} className={`spin stspin${meta.spin ? "" : " off"}`} />
      {meta.spin ? null : <Icon name={meta.icon} size={14} w={2} className={`stic${meta.color === "ok" ? " pop" : ""}${swapped ? " anim" : ""}`} />}
    </span> : <Icon name={meta.icon} size={card ? 14 : 13} className={meta.spin ? "spin" : ""} />}
    {meta.text}{children}
  </span>;
}
