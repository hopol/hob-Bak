import type { AssistantSkill } from "../../shared/skills.ts";
import { fmtWhen } from "./util.ts";

export function skillUsage(skill: Pick<AssistantSkill, "uses" | "lastUsedAt" | "version">, now = new Date()): string {
  const used = skill.uses ? `用过 ${skill.uses} 次${skill.lastUsedAt ? ` · 上次${fmtWhen(skill.lastUsedAt, now)}` : ""}` : "还没用过";
  return `${used} · 第 ${skill.version} 版`;
}
