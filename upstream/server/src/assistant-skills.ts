import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadSkillsFromDir, parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
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
  safeTree(path);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
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
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("\n---\n");
  if (!text.startsWith("---\n") || end < 0) throw new Error("技能 frontmatter 无效");
  return text.slice(end + 5).replace(/^\n/, "");
}

export function skillInstruction(titles: string[], instruction: string): string {
  return `按技能${titles.map((title) => `「${title}」`).join("")}做（先读${titles.length === 1 ? "它" : "它们"}的 SKILL.md）。\n${instruction}`;
}

function readSkill(dir: string, name: string, data: Metadata): AssistantSkill {
  validName(name);
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
export function usableSkills(dir: string): AssistantSkill[] {
  try { return listSkills(dir).filter((skill) => skill.enabled); }
  catch (error) { console.error("读取技能失败：", error); return []; }
}
export function groupSkills(home: string, group: Group | undefined): AssistantSkill[] {
  return group ? usableSkills(groupSkillsDir(home, group.parentId ?? group.id)) : [];
}
export function combinedSkills(home: string, assistantId: string, group?: Group, includeDisabledOwn = false): AssistantSkill[] {
  const groupItems = groupSkills(home, group);
  const names = new Set(groupItems.map((item) => item.name));
  const own = includeDisabledOwn ? listAssistantSkills(home, assistantId) : usableAssistantSkills(home, assistantId);
  return [...groupItems, ...own.filter((item) => !names.has(item.name))];
}
export function resolveSkill(home: string, assistantId: string, name: string, group?: Group): AssistantSkill | undefined {
  return combinedSkills(home, assistantId, group, true).find((skill) => skill.name === name);
}
export function loadedSkills(skills: AssistantSkill[]): Skill[] {
  return skills.flatMap((skill) =>
    loadSkillsFromDir({ dir: dirname(skill.path), source: "assistant" }).skills.filter((item) => item.filePath === skill.path));
}
export function saveSkill(dir: string, input: SkillInput, jobId?: string, replaceFiles = false, options?: { overwriteVersion?: boolean }): AssistantSkill {
  validName(input.name);
  if (typeof input.title !== "string" || !input.title.trim() || typeof input.description !== "string" || !input.description.trim() || [...input.description].length > 120 || typeof input.content !== "string") throw new Error("技能内容无效");
  const body = `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\nmetadata:\n  title: ${JSON.stringify(input.title)}\n---\n\n${input.content}`;
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
  mkdirSync(dir, { recursive: true });
  const all = metadata(dir);
  const target = join(dir, input.name);
  safeTree(target);
  const old = all[input.name];
  if (!old && existsSync(target)) throw new Error("技能目录已存在");
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
  validName(name);
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
  validName(name);
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
export function recordSkillUse(dir: string, name: string): void {
  validName(name);
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
  validName(name);
  const all = metadata(dir), target = join(dir, name);
  if (!all[name]) throw new Error("技能不存在");
  safeTree(target);
  const history = join(target, ".history");
  const versions = existsSync(history) ? readdirSync(history).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a) : [];
  if (!versions.length) throw new Error("没有上一版");
  const previous = join(history, String(versions[0]));
  const body = readFileSync(join(previous, "SKILL.md"), "utf8");
  const title = skillHead(body).title ?? all[name].title;
  const files: { path: string; content: string }[] = [];
  function collect(dirPath: string, rel: string): void {
    if (!existsSync(dirPath)) return;
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const path = join(dirPath, entry.name), next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) collect(path, next);
      else if (entry.isFile()) files.push({ path: next, content: readFileSync(path, "utf8") });
    }
  }
  collect(join(previous, "scripts"), "scripts"); collect(join(previous, "references"), "references");
  return saveSkill(dir, { name, title, description: description(join(previous, "SKILL.md")), content: body.slice(body.indexOf("\n---\n") + 5).replace(/^\n/, ""), files }, undefined, true);
}
export function rollbackAssistantSkill(home: string, assistantId: string, name: string): AssistantSkill {
  return rollbackSkill(assistantSkillsDir(home, assistantId), name);
}
