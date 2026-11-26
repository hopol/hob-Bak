import { t } from "../../shared/i18n.ts";
import type { SkillOrigin } from "../../shared/skills.ts";
import type { State } from "./store.ts";

export function skillOriginText(skill: { origin?: SkillOrigin; fromJobId?: string }, state: Pick<State, "jobs" | "assistants" | "groups">): string | undefined {
  const jobId = skill.origin?.kind === "job" ? skill.origin.jobId : skill.origin ? undefined : skill.fromJobId;
  if (jobId) return t("来自任务 {name}", { name: state.jobs[jobId]?.title ?? jobId });
  if (skill.origin?.kind === "assistant") {
    const origin = skill.origin;
    const name = (origin.groupId ? state.groups.find((group) => group.id === origin.groupId)?.name : undefined) ?? state.assistants.find((assistant) => assistant.id === origin.assistantId)?.name ?? origin.groupId ?? origin.assistantId;
    return t("来自和 {name} 的对话", { name });
  }
  return undefined;
}
