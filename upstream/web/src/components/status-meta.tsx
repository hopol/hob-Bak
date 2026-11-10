import type { ReactNode } from "react";
import type { Delegation, JobStatus, SedimentStatus } from "../../../shared/types.ts";
import { Icon, type IconName } from "../icons.tsx";

export function sedimentText(sediment: SedimentStatus): string {
  if (sediment.status === "running") return "沉淀技能中…";
  if (sediment.status === "empty") return "没有要沉淀的";
  if (sediment.status === "failed") return "沉淀失败";
  return sediment.updated ? `已更新技能「${sediment.title}」· 第 ${sediment.version} 版` : `已沉淀技能「${sediment.title}」`;
}

type StatusMeta = { text: string; icon: IconName; color: "" | "live" | "ok" | "bad"; spin: boolean };

export const JOB_STATUS: Record<JobStatus, StatusMeta> = {
  queued: { text: "排队中", icon: "clock", color: "", spin: false },
  running: { text: "进行中", icon: "spin", color: "live", spin: true },
  waiting: { text: "等助手回复", icon: "pause", color: "", spin: false },
  done: { text: "已完成", icon: "check", color: "ok", spin: false },
  stuck: { text: "受阻", icon: "close", color: "bad", spin: false },
  failed: { text: "失败", icon: "close", color: "bad", spin: false },
  stopped: { text: "已停止", icon: "stop", color: "", spin: false },
};

export const DELEGATION_STATUS: Record<Delegation["status"], StatusMeta> = {
  running: { text: "进行中", icon: "spin", color: "live", spin: true },
  waiting: { text: "等你确认", icon: "pause", color: "", spin: false },
  done: { text: "已完成", icon: "check", color: "ok", spin: false },
  stuck: { text: "受阻", icon: "close", color: "bad", spin: false },
  interrupted: { text: "已中断", icon: "close", color: "bad", spin: false },
  returned: { text: "已退回", icon: "close", color: "bad", spin: false },
  takenOver: { text: "已被你接手", icon: "user", color: "", spin: false },
};

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
