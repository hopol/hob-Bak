import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Group } from "../../shared/types.ts";
import type { SkillOrigin } from "../../shared/skills.ts";
import { t } from "../../shared/i18n.ts";
import { assistantSkillsDir, groupSkillsDir, isSkillName, saveAssistantSkillsIndex, skillHead, skillIndex } from "./assistant-skills.ts";
import { generalSkillsDir, skillDirOf, visibleSkills } from "./skills.ts";
import { inspectSkill } from "./sediment.ts";
import type { HobRuntime } from "./runtime.ts";
import { userReadsEnglish } from "./prompt.ts";

interface SaveInput { name: string; from?: string; edits?: { file?: string; old: string; new: string }[]; general?: boolean; assistantId?: string }
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

function noLinks(path: string, name: string, prefix = ""): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`没存上：「${name}」里不能有符号链接：${prefix}。改好以后再存。`);
  if (stat.isDirectory()) for (const entry of readdirSync(path)) noLinks(join(path, entry), name, prefix ? `${prefix}/${entry}` : entry);
}

/** 不异步让出事件循环：查找、校验和提交一份技能按调用顺序执行。 */
export function saveSkillDirectory(runtime: HobRuntime, assistantId: string, group: Group | undefined, cwd: string, input: SaveInput, origin: SkillOrigin, allowedFromDirs?: string[]) {
  const { name, general } = input;
  const from = input.from === "" ? undefined : input.from;
  const edits = input.edits?.length ? input.edits : undefined;
  if (!isSkillName(name)) throw new Error("技能名称无效");
  if (from === undefined && edits === undefined && general === undefined) throw new Error("from、edits、general 至少填一样：整份存填 from，改几处填 edits，换给谁用填 general。");
  if (from !== undefined && edits !== undefined) throw new Error("from 和 edits 只填一样：整份存填 from，改几处填 edits。");
  const found = visibleSkills(runtime, assistantId, group).find((skill) => skill.name === name);
  if (found && !found.editable) throw new Error(`${name} 是只读的技能，不能改；换个名字另存一份。`);
  if (!found && from === undefined) throw new Error(`还没有叫 ${name} 的技能。新建要填 from，指向写好的技能文件夹。`);
  const own = group ? groupSkillsDir(runtime.home, group.parentId ?? group.id) : assistantSkillsDir(runtime.home, assistantId);
  const original = found ? skillDirOf(runtime, found, assistantId, group) : (general ? generalSkillsDir(runtime.home) : own);
  const destination = general === undefined ? original : general ? generalSkillsDir(runtime.home) : own;
  const oldIndex = skillIndex(original);
  const old = oldIndex[name];
  if (!old && existsSync(join(original, name))) throw new Error(`技能目录已存在：${name}`);
  if (destination !== original && (skillIndex(destination)[name] || existsSync(join(destination, name)))) throw new Error(`目标范围里已经有叫 ${name} 的技能`);
  mkdirSync(destination, { recursive: true });
  const stage = mkdtempSync(join(destination, ".save-"));
  const staged = join(stage, name);
  const target = join(destination, name);
  const previous = join(original, name);
  const backup = join(stage, ".previous");
  try {
    if (from !== undefined) {
      const roots = [...new Set([cwd, ...(allowedFromDirs ?? [])])];
      const source = realpathSync(resolve(cwd, from));
      const allowed = roots.some((root) => {
        try { return inside(realpathSync(root), source); } catch { return false; }
      });
      if (!allowed) throw new Error("from 要指向工作目录里的技能文件夹。");
      noLinks(source, name);
      cpSync(source, staged, { recursive: true, filter: (path) => path !== join(source, ".history") });
    } else {
      noLinks(previous, name);
      cpSync(previous, staged, { recursive: true, filter: (path) => path !== join(previous, ".history") });
      for (const edit of edits ?? []) {
        const file = edit.file || "SKILL.md", path = resolve(staged, file);
        if (!inside(staged, path) || file.split(/[\\/]/).includes(".history") || !existsSync(path) || !lstatSync(path).isFile()) throw new Error(`技能里没有 ${file}。要加新文件，在工作目录里写好整个技能文件夹，用 from 存。`);
        const text = readFileSync(path, "utf8");
        if (!edit.old) throw new Error("原文不能为空");
        const count = text.split(edit.old).length - 1;
        if (!count) throw new Error(`${file} 里找不到这段原文：${[...edit.old].slice(0, 30).join("")}`);
        if (count > 1) throw new Error(`这段原文在 ${file} 里出现了 ${count} 次，多带几个字。`);
        writeFileSync(path, text.replace(edit.old, () => edit.new));
      }
    }
    const skillFile = join(staged, "SKILL.md");
    if (existsSync(skillFile)) {
      let actual: string | undefined;
      try { actual = skillHead(readFileSync(skillFile, "utf8")).name; } catch { /* 校验会给出 YAML 错误 */ }
      if (actual && actual !== name) throw new Error(`SKILL.md 里的 name 是 ${actual}，和 name（${name}）不一样，改成一样再存。`);
    }
    const check = inspectSkill(stage, name, { existing: !!old });
    if (!check.ok) throw new Error(`没存上：${check.reasons.join("；")}。改好以后再存。`);
    const now = new Date().toISOString();
    if (old) {
      const history = join(staged, ".history"), oldHistory = join(previous, ".history");
      if (existsSync(oldHistory)) cpSync(oldHistory, history, { recursive: true });
      mkdirSync(history, { recursive: true });
      const snapshot = join(history, String(old.version));
      if (!existsSync(snapshot)) cpSync(previous, snapshot, { recursive: true, filter: (path) => path !== oldHistory });
      const versions = readdirSync(history).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a);
      for (const version of versions.slice(5)) rmSync(join(history, String(version)), { recursive: true, force: true });
      renameSync(previous, backup);
    }
    const { fromJobId: _oldOrigin, ...oldMetadata } = old ?? { title: check.title, version: 0, createdAt: now, updatedAt: now, uses: 0, enabled: true };
    const data = { ...oldMetadata, title: check.title, version: (old?.version ?? 0) + 1, updatedAt: now, origin };
    const destIndex = original === destination ? oldIndex : skillIndex(destination);
    let installed = false;
    try {
      renameSync(staged, target);
      installed = true;
      destIndex[name] = data;
      saveAssistantSkillsIndex(destination, destIndex);
      if (destination !== original && old) { delete oldIndex[name]; saveAssistantSkillsIndex(original, oldIndex); }
    } catch (error) {
      if (installed) rmSync(target, { recursive: true, force: true });
      if (old) renameSync(backup, previous);
      if (destination === original) { if (old) oldIndex[name] = old; else delete oldIndex[name]; saveAssistantSkillsIndex(original, oldIndex); }
      else { delete destIndex[name]; saveAssistantSkillsIndex(destination, destIndex); if (old) { oldIndex[name] = old; saveAssistantSkillsIndex(original, oldIndex); } }
      throw error;
    }
    const scope = destination === generalSkillsDir(runtime.home) ? "通用的" : group && destination === own ? "本群的" : "你的";
    return { name, title: check.title, version: data.version, updated: !!old, scope, movedOnly: from === undefined && edits === undefined };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function saveSkillTool(runtime: HobRuntime, assistantId: string, groupId: string | undefined, cwd: string, jobId?: string, allowedFromDirs?: string[]): ToolDefinition<any, any> {
  const group = groupId ? runtime.store.group(groupId) : undefined;
  const english = userReadsEnglish(runtime.settings.settings.general);
  return {
    name: "save_skill", label: "存技能",
    description: `存一份技能：新建、修改，或者换给谁用。名字已经有的是改那一份，没有就是新建。每存一次是一个新版本，旧版会保留。${group ? "在群里按名字先找本群的技能，再找你自己的，再找通用的。" : ""}`,
    parameters: Type.Object({
      name: Type.String({ description: "技能名，只用小写字母、数字和连字符，如 weekly-report。" }),
      from: Type.Optional(Type.String({ description: `可选，写好的技能文件夹，整份存进来；新建时要填。文件夹里要有 SKILL.md，开头这样写：\n\`\`\`\n---\nname: <和 name 一样>\ndescription: <什么时候用，一句话，120 字以内>\nmetadata:\n  title: <${english ? "英文名，如「Weekly report」" : "中文名，如「每周周报」"}>\n---\n\`\`\`\n脚本放 scripts/，偶尔用得上的细节放 references/。` })),
      edits: Type.Optional(Type.Array(Type.Object({ file: Type.Optional(Type.String()), old: Type.String(), new: Type.String() }), { description: "可选，改已有技能的一处或几处：file 是技能里的文件，不填是 SKILL.md；old 是原文，要一字不差、只出现一次；new 是换成的文字。和 from 只填一样。" })),
      general: Type.Optional(Type.Boolean({ description: `可选，给谁用：true 是通用的，所有助手都能用；false 归${group ? "本群" : "你"}。新建时不填归${group ? "本群" : "你"}；改已有的不填就不变。只换给谁用，填 name 和这一项就行。` })),
      ...(!jobId && !group && runtime.store.assistant(assistantId)?.primary ? { assistantId: Type.Optional(Type.String({ description: "可选，改哪个助手的；不填是你自己的" })) } : {}),
    }),
    execute: async (_id, params: SaveInput) => {
      try {
        const target = !jobId && !group && runtime.store.assistant(assistantId)?.primary ? params.assistantId || assistantId : assistantId;
        if (!runtime.store.assistant(target)) throw new Error(`没有这个助手：${target}`);
        const origin: SkillOrigin = jobId ? { kind: "job", jobId } : { kind: "assistant", assistantId, ...(groupId ? { groupId } : {}) };
        const saved = saveSkillDirectory(runtime, target, group, cwd, params, origin, allowedFromDirs);
        if (jobId) runtime.jobs.recordSavedSkill(jobId, { name: saved.name, title: saved.title, version: saved.version, updated: saved.updated });
        runtime.bus.emit({ type: "skills", assistantId: target });
        await runtime.router.addItem(assistantId, { kind: "note", icon: "skill", text: t("已存技能「{title}」第 {version} 版", { title: saved.title, version: saved.version }) }, groupId);
        const text = saved.movedOnly ? `已把「${saved.title}」换成${saved.scope}。` : `已存技能「${saved.title}」（${saved.name}），第 ${saved.version} 版，是${saved.scope}。`;
        return { content: [{ type: "text" as const, text }], details: undefined };
      } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true }; }
    },
  };
}
