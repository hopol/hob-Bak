import { archiveSkill, listSkills } from "./assistant-skills.ts";
import type { HobRuntime } from "./runtime.ts";
import { notEditable, skillDirOf, visibleSkills } from "./skills.ts";

/** 归档技能前检查正在使用的任务；助手工具与设置接口共用。只读的两类不归 Hob 管，不能删。 */
export function deleteSkill(runtime: HobRuntime, assistantId: string, name: string, replacedBy?: string, groupId?: string, explicitGroup = false): string {
  const group = groupId ? runtime.store.group(groupId) : undefined;
  const all = visibleSkills(runtime, assistantId, group);
  const skill = all.find((item) => item.name === name);
  if (!skill || !skill.editable) throw new Error(notEditable(name, all));
  const dir = skillDirOf(runtime, skill, assistantId, group);
  const groupDir = group ? skillDirOf(runtime, { ...skill, scope: "group" }, assistantId, group) : undefined;
  // 群的技能接口只删本群的：按名字先找到的是别处的同名技能就不是这个群的那份
  if (explicitGroup && dir !== groupDir) throw new Error(`本群里没有叫 ${name} 的技能`);
  const skills = listSkills(dir);
  const replacement = replacedBy ? skills.find((item) => item.name === replacedBy && item.name !== name) : undefined;
  if (replacedBy && !replacement) throw new Error(`没有这个技能：${replacedBy}`);
  const usesSkill = (owner: string, gid?: string) => {
    const target = gid ? runtime.store.group(gid) : undefined;
    const found = visibleSkills(runtime, owner, target).find((item) => item.name === name);
    return !!found && skillDirOf(runtime, found, owner, target) === dir;
  };
  const job = runtime.store.jobs().find((item) => usesSkill(item.assistantId, item.groupId) && ["queued", "running", "waiting"].includes(item.status) && item.skillsUsed?.includes(name));
  if (job) throw new Error(`「${skill.title ?? skill.name}」正在被任务 ${job.id} 用，等它做完再删。`);
  archiveSkill(dir, name);
  runtime.bus.emit({ type: "skills", assistantId });
  const title = skill.title ?? skill.name;
  return replacement ? `技能「${title}」已并入「${replacement.title}」，原技能移到了归档。` : `已删除技能「${title}」，移到了归档。`;
}
