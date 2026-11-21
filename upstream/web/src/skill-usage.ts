import type { AssistantSkill } from "../../shared/skills.ts";
import { fmtWhen } from "./util.ts";
import { t } from "../../shared/i18n.ts";

export function skillUsage(skill: Pick<AssistantSkill, "uses" | "lastUsedAt" | "version">, now = new Date()): string {
  const used = skill.uses
    ? t("用过 {n} 次{last}", { n: skill.uses, last: skill.lastUsedAt ? t(" · 上次{when}", { when: fmtWhen(skill.lastUsedAt, now) }) : "" })
    : t("尚未使用");
  return t("{used} · 第 {version} 版", { used, version: skill.version });
}
