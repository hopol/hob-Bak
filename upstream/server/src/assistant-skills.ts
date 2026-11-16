import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { t } from "../../shared/i18n.ts";
import type { AssistantSkill } from "../../shared/skills.ts";
import type { Group } from "../../shared/types.ts";

type Metadata = Omit<AssistantSkill, "name" | "description" | "path">;
export interface SkillInput { name: string; title: string; description: string; content: string; files?: { path: string; content: string }[] }

/** 这个助手的技能目录（绝对路径）。 */
export function assistantSkillsDir(home: string, assistantId: string): string {
  return checkedDir(home, "assistants", assistantId);
}

export function groupSkillsDir(home: string, groupId: string): string {
  return checkedDir(home, "groups", groupId);
}

function checkedDir(home: string, owner: "assistants" | "groups", assistantId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(assistantId)) throw new Error("助手名称无效");
  const root = resolve(home);
  const dir = join(root, owner, assistantId, "skills");
  let current = root;
  for (const part of [owner, assistantId, "skills"]) {
    current = join(current, part);
    if (isLink(current)) throw new Error("技能路径不能包含符号链接");
  }
  return dir;
}
function validName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(name)) throw new Error("技能名称无效");
}
/** 已经是技能的名字（从别处导入的）：只要求能当目录名、不越出技能目录。 */
export function isSkillName(name: unknown): name is string {
  return typeof name === "string" && !!name && name !== "." && name !== ".." && !name.startsWith(".") && !/[\/\\\0]/.test(name);
}
function pathName(name: string): void {
  if (!isSkillName(name)) throw new Error("技能名称无效");
}

/**
 * 正在沉淀的技能目录（目录 → 正在沉淀的助手或群的名字）。
 * 沉淀从拍底稿到对账或恢复结束独占这个目录：这期间别的入口改了，底稿就对不上了。
 */
const sedimentingDirs = new Map<string, string>();

/** 锁上一个技能目录，owner 是正在沉淀的助手或群的名字（报错时说给用户听）。 */
export function lockSkillsDir(dir: string, owner: string): void {
  sedimentingDirs.set(resolve(dir), owner);
}

export function unlockSkillsDir(dir: string): void {
  sedimentingDirs.delete(resolve(dir));
}

/** 改、删、回滚、导入之前先问一句：这个目录正在沉淀就先别动。 */
export function assertSkillsDirFree(dir: string): void {
  const owner = sedimentingDirs.get(resolve(dir));
  if (owner) throw new Error(t("「{owner}」正在沉淀技能，等这一轮结束再改。", { owner }));
}
function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function safeTree(path: string): void {
  if (isLink(path)) throw new Error("技能目录不能包含符号链接");
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("技能目录不能包含符号链接");
  if (stat.isDirectory()) for (const entry of readdirSync(path)) safeTree(join(path, entry));
}
function metadata(dir: string): Record<string, Metadata> {
  const path = join(dir, "skills.json");
  if (!existsSync(path)) return {};
  safeTree(path);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  // 导入的技能目录里，skills.json 可能是别的工具留下的（对象形状不对就当没有，别把整个助手的技能拖没）
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Metadata>) : {};
}
/** 技能索引：给通用技能目录对账和测试用。 */
export function skillIndex(dir: string): Record<string, Metadata> {
  return metadata(dir);
}
function saveMetadata(dir: string, data: Record<string, Metadata>): void {
  const temp = join(dir, `.${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temp, JSON.stringify(data, null, 2));
  renameSync(temp, join(dir, "skills.json"));
}
/** 写 skills.json（沉淀对账时用）。 */
export function saveAssistantSkillsIndex(dir: string, data: Record<string, Metadata>): void {
  saveMetadata(dir, data);
}

/** SKILL.md 开头的几项：name、description、metadata.title。照 pi 读技能的办法解析（带不带引号都认），开头写错时抛 yaml 的原话。 */
export interface SkillHead { name?: string; description?: string; title?: string }

export function skillHead(text: string): SkillHead {
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(text);
  const value = (raw: unknown) => (typeof raw === "string" && raw.trim() ? raw.trim() : undefined);
  const metadata = frontmatter.metadata && typeof frontmatter.metadata === "object" ? (frontmatter.metadata as Record<string, unknown>) : {};
  return { name: value(frontmatter.name), description: value(frontmatter.description), title: value(metadata.title) };
}

function description(file: string): string {
  let value: string | undefined;
  try { value = skillHead(readFileSync(file, "utf8")).description; }
  catch { throw new Error("技能说明缺失"); }
  if (!value) throw new Error("技能说明缺失");
  return value;
}
export function readAssistantSkillBody(path: string): string {
  return bodyOf(readFileSync(path, "utf8"));
}

/** SKILL.md 的正文（frontmatter 之后的部分）。 */
function bodyOf(text: string): string {
  const end = text.indexOf("\n---\n");
  if (!text.startsWith("---\n") || end < 0) throw new Error("技能 frontmatter 无效");
  return text.slice(end + 5).replace(/^\n/, "");
}

/** SKILL.md 的正文换掉，frontmatter 原样留着。 */
function withBody(text: string, body: string): string {
  const end = text.indexOf("\n---\n");
  if (!text.startsWith("---\n") || end < 0) throw new Error("技能 frontmatter 无效");
  return `${text.slice(0, end + 5)}\n${body}`;
}

export function skillInstruction(titles: string[], instruction: string): string {
  return `按技能${titles.map((title) => `「${title}」`).join("")}做（先读${titles.length === 1 ? "它" : "它们"}的 SKILL.md）。\n${instruction}`;
}

function readSkill(dir: string, name: string, data: Metadata): AssistantSkill {
  pathName(name);
  const skillDir = join(dir, name);
  safeTree(skillDir);
  const path = join(skillDir, "SKILL.md");
  return { name, ...data, description: description(path), path };
}

/**
 * 助手的技能：一份读不了就只跳过那一份并记日志。
 * 沉淀直接改技能文件，改到一半时别处要列技能，不能因此把整个助手的技能都当成没有。
 */
export function listSkills(dir: string): AssistantSkill[] {
  return Object.entries(metadata(dir)).flatMap(([name, data]) => {
    try { return [readSkill(dir, name, data)]; }
    catch (error) { console.error(`跳过读不了的技能「${name}」：`, error); return []; }
  });
}
export function listAssistantSkills(home: string, assistantId: string): AssistantSkill[] {
  return listSkills(assistantSkillsDir(home, assistantId));
}

/** 给对话、任务和定时用的已启用技能。 */
export function usableAssistantSkills(home: string, assistantId: string): AssistantSkill[] {
  try { return listAssistantSkills(home, assistantId).filter((skill) => skill.enabled); }
  catch (error) { console.error(`读取「${assistantId}」的技能失败：`, error); return []; }
}
export function groupSkills(home: string, group: Group | undefined): AssistantSkill[] {
  if (!group) return [];
  try { return listSkills(groupSkillsDir(home, group.parentId ?? group.id)).filter((skill) => skill.enabled); }
  catch (error) { console.error("读取技能失败：", error); return []; }
}
export function combinedSkills(home: string, assistantId: string, group?: Group, includeDisabledOwn = false): AssistantSkill[] {
  const groupItems = groupSkills(home, group);
  const names = new Set(groupItems.map((item) => item.name));
  const own = includeDisabledOwn ? listAssistantSkills(home, assistantId) : usableAssistantSkills(home, assistantId);
  return [...groupItems, ...own.filter((item) => !names.has(item.name))];
}
export function saveSkill(dir: string, input: SkillInput, jobId?: string, replaceFiles = false, options?: { overwriteVersion?: boolean }): AssistantSkill {
  assertSkillsDirFree(dir);
  mkdirSync(dir, { recursive: true });
  const all = metadata(dir);
  const old = all[input.name];
  // Hob 的命名约定只管新建的；导入的技能叫什么就还叫什么
  if (old) pathName(input.name);
  else validName(input.name);
  if (typeof input.title !== "string" || !input.title.trim() || typeof input.description !== "string" || !input.description.trim() || typeof input.content !== "string") throw new Error("技能内容无效");
  if (!old && [...input.description].length > 120) throw new Error("技能内容无效");
  const target = join(dir, input.name);
  safeTree(target);
  if (!old && existsSync(target)) throw new Error("技能目录已存在");
  // 改已有的：frontmatter 原样保留（Hob 不认识的字段、别的工具写的格式都不动），只换正文
  const kept = old && existsSync(join(target, "SKILL.md")) ? withBody(readFileSync(join(target, "SKILL.md"), "utf8"), input.content) : undefined;
  const body = kept ?? `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\nmetadata:\n  title: ${JSON.stringify(input.title)}\n---\n\n${input.content}`;
  if ([...body].length > 20000) throw new Error("SKILL.md 超过 20000 字");
  if (input.files !== undefined && !Array.isArray(input.files)) throw new Error("技能附件无效");
  const files = input.files ?? [];
  if (files.length > 20) throw new Error("技能附件超过 20 个");
  const names = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string" || !/^(scripts|references)\/(?!.*(?:^|\/)\.\.?($|\/))[^\\\0]+$/.test(file.path) || file.path.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("附件路径无效");
    if (Buffer.byteLength(file.content) > 200 * 1024) throw new Error("技能附件超过 200 KB");
    if (names.has(file.path)) throw new Error("附件路径重复");
    names.add(file.path);
  }
  const existingFiles = new Set<string>();
  const collectFiles = (dirPath: string, prefix: string): void => {
    if (!existsSync(dirPath)) return;
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) collectFiles(join(dirPath, entry.name), path);
      else if (entry.isFile()) existingFiles.add(path);
    }
  };
  collectFiles(join(target, "scripts"), "scripts");
  collectFiles(join(target, "references"), "references");
  const combined = new Set([...(replaceFiles ? [] : existingFiles), ...names]);
  if (combined.size > 20) throw new Error("技能附件超过 20 个");
  for (const path of combined) {
    const parts = path.split("/");
    for (let i = 2; i < parts.length; i++) if (combined.has(parts.slice(0, i).join("/"))) throw new Error("附件路径冲突");
  }
  if (old && !options?.overwriteVersion) {
    const history = join(target, ".history");
    mkdirSync(history, { recursive: true });
    const snapshot = join(history, String(old.version));
    mkdirSync(snapshot);
    for (const entry of readdirSync(target)) if (entry !== ".history") cpSync(join(target, entry), join(snapshot, entry), { recursive: true });
    const versions = readdirSync(history).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a);
    for (const version of versions.slice(5)) rmSync(join(history, String(version)), { recursive: true, force: true });
  } else if (!old) mkdirSync(target);
  if (replaceFiles) for (const folder of ["scripts", "references"]) rmSync(join(target, folder), { recursive: true, force: true });
  writeFileSync(join(target, "SKILL.md"), body);
  for (const file of files) {
    const dest = join(target, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content);
  }
  const now = new Date().toISOString();
  all[input.name] = { title: input.title, version: old && options?.overwriteVersion ? old.version : (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now, ...(jobId ? { fromJobId: jobId } : old?.fromJobId ? { fromJobId: old.fromJobId } : {}), uses: old?.uses ?? 0, ...(old?.lastUsedAt ? { lastUsedAt: old.lastUsedAt } : {}), enabled: old?.enabled ?? true };
  saveMetadata(dir, all);
  return listSkills(dir).find((skill) => skill.name === input.name)!;
}
export function saveAssistantSkill(home: string, assistantId: string, input: SkillInput, jobId?: string, replaceFiles = false, options?: { overwriteVersion?: boolean }): AssistantSkill {
  return saveSkill(assistantSkillsDir(home, assistantId), input, jobId, replaceFiles, options);
}
export function setSkillEnabled(dir: string, name: string, enabled: boolean): AssistantSkill {
  pathName(name);
  const all = metadata(dir);
  if (!all[name]) throw new Error("技能不存在");
  safeTree(join(dir, name));
  all[name].enabled = enabled;
  saveMetadata(dir, all);
  return listSkills(dir).find((skill) => skill.name === name)!;
}
export function setAssistantSkillEnabled(home: string, assistantId: string, name: string, enabled: boolean): AssistantSkill {
  return setSkillEnabled(assistantSkillsDir(home, assistantId), name, enabled);
}
export function archiveSkill(dir: string, name: string): void {
  pathName(name);
  assertSkillsDirFree(dir);
  const all = metadata(dir), target = join(dir, name);
  if (!all[name]) throw new Error("技能不存在");
  safeTree(target);
  const archive = join(dir, ".archive");
  safeTree(archive);
  mkdirSync(archive, { recursive: true });
  renameSync(target, join(archive, `${name}-${Date.now()}`));
  delete all[name];
  saveMetadata(dir, all);
}
export function archiveAssistantSkill(home: string, assistantId: string, name: string): void {
  archiveSkill(assistantSkillsDir(home, assistantId), name);
}
/** 换范围：连同版本历史一起搬过去，索引跟着搬；目标那档已经有同名的就报错。 */
export function moveSkill(fromDir: string, toDir: string, name: string, conflict: string): void {
  pathName(name);
  if (resolve(fromDir) === resolve(toDir)) return;
  assertSkillsDirFree(fromDir);
  assertSkillsDirFree(toDir);
  const from = metadata(fromDir), to = metadata(toDir);
  const data = from[name];
  if (!data) throw new Error("技能不存在");
  if (to[name]) throw new Error(conflict);
  safeTree(join(fromDir, name));
  safeTree(join(toDir, name));
  mkdirSync(toDir, { recursive: true });
  renameSync(join(fromDir, name), join(toDir, name));
  to[name] = data;
  delete from[name];
  saveMetadata(toDir, to);
  saveMetadata(fromDir, from);
}
export function recordSkillUse(dir: string, name: string): void {
  pathName(name);
  const all = metadata(dir);
  if (!all[name]) throw new Error("技能不存在");
  all[name].uses++;
  all[name].lastUsedAt = new Date().toISOString();
  saveMetadata(dir, all);
}
export function recordAssistantSkillUse(home: string, assistantId: string, name: string): void {
  recordSkillUse(assistantSkillsDir(home, assistantId), name);
}
export function rollbackSkill(dir: string, name: string): AssistantSkill {
  pathName(name);
  assertSkillsDirFree(dir);
  const all = metadata(dir), target = join(dir, name);
  if (!all[name]) throw new Error("技能不存在");
  safeTree(target);
  const history = join(target, ".history");
  const versions = existsSync(history) ? readdirSync(history).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a) : [];
  if (!versions.length) throw new Error("没有上一版");
  const previous = join(history, String(versions[0]));
  // 现在的这一版先进历史，再把上一版整份放回来：附件、目录结构和 frontmatter 都不动
  const snapshot = join(history, String(all[name].version));
  if (!existsSync(snapshot)) {
    mkdirSync(snapshot, { recursive: true });
    for (const entry of readdirSync(target)) if (entry !== ".history") cpSync(join(target, entry), join(snapshot, entry), { recursive: true });
  }
  const kept = readdirSync(history).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a);
  for (const version of kept.slice(5)) rmSync(join(history, String(version)), { recursive: true, force: true });
  for (const entry of readdirSync(target)) if (entry !== ".history") rmSync(join(target, entry), { recursive: true, force: true });
  for (const entry of readdirSync(previous)) cpSync(join(previous, entry), join(target, entry), { recursive: true });
  const head = skillHead(readFileSync(join(target, "SKILL.md"), "utf8"));
  all[name] = { ...all[name], ...(head.title ? { title: head.title } : {}), version: all[name].version + 1, updatedAt: new Date().toISOString() };
  saveMetadata(dir, all);
  return listSkills(dir).find((skill) => skill.name === name)!;
}
export function rollbackAssistantSkill(home: string, assistantId: string, name: string): AssistantSkill {
  return rollbackSkill(assistantSkillsDir(home, assistantId), name);
}
