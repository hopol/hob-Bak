import { archiveAssistantSkill, listAssistantSkills } from "./assistant-skills.ts";
import type { HobRuntime } from "./runtime.ts";

/** 归档技能前检查任务和定时绑定；助手工具与设置接口共用。 */
export function deleteSkill(runtime: HobRuntime, assistantId: string, name: string, replacedBy?: string): string {
  const skills = listAssistantSkills(runtime.home, assistantId);
  const skill = skills.find((item) => item.name === name);
  if (!skill) throw new Error(`没有这个技能：${name}`);
  const replacement = replacedBy ? skills.find((item) => item.name === replacedBy && item.name !== name) : undefined;
  if (replacedBy && !replacement) throw new Error(`没有这个技能：${replacedBy}`);
  const job = runtime.store.jobs().find((item) => item.assistantId === assistantId && ["queued", "running", "waiting"].includes(item.status) && item.skills?.includes(name));
  if (job) throw new Error(`「${skill.title}」正在被任务 ${job.id} 用，等它做完再删。`);
  const routines = runtime.store.routines().filter((item) => item.assistantId === assistantId && item.skill === name);
  if (routines.length && !replacement) throw new Error(`「${skill.title}」被定时任务「${routines[0].name}」用着：填 replaced_by 指定接替的技能，或者先用 update_routine 改掉。`);
  archiveAssistantSkill(runtime.home, assistantId, name);
  if (replacement) for (const routine of routines) runtime.routines.update(routine.id, { skill: replacement.name });
  runtime.bus.emit({ type: "skills", assistantId });
  return replacement ? `技能「${skill.title}」已并入「${replacement.title}」，原技能移到了归档。` : `已删除技能「${skill.title}」，移到了归档。`;
}
