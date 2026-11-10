import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { AssistantSkill } from "../../shared/skills.ts";

type Metadata = Omit<AssistantSkill, "name" | "description" | "path">;
export interface SkillInput { name: string; title: string; description: string; content: string; files?: { path: string; content: string }[] }

function checkedDir(home: string, assistantId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(assistantId)) throw new Error("助手名称无效");
  const root = resolve(home);
  const dir = join(root, "assistants", assistantId, "skills");
  let current = root;
  for (const part of ["assistants", assistantId, "skills"]) {
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
function description(file: string): string {
  const line = readFileSync(file, "utf8").split("\n").find((item) => item.startsWith("description: "));
  if (!line) throw new Error("技能说明缺失");
  return JSON.parse(line.slice("description: ".length));
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

export function listAssistantSkills(home: string, assistantId: string): AssistantSkill[] {
  const dir = checkedDir(home, assistantId);
  return Object.entries(metadata(dir)).map(([name, data]) => {
    validName(name);
    const skillDir = join(dir, name);
    safeTree(skillDir);
    const path = join(skillDir, "SKILL.md");
    return { name, ...data, description: description(path), path };
  });
}
/** 给对话、任务和定时用的已启用技能：读不了就当没有并记日志，一个坏掉的技能不能让整个助手开不了会话。 */
export function usableAssistantSkills(home: string, assistantId: string): AssistantSkill[] {
  try { return listAssistantSkills(home, assistantId).filter((skill) => skill.enabled); }
  catch (error) { console.error(`读取「${assistantId}」的技能失败：`, error); return []; }
}
export function enabledAssistantSkills(home: string, assistantId: string): Skill[] {
  return usableAssistantSkills(home, assistantId).flatMap((skill) =>
    loadSkillsFromDir({ dir: dirname(skill.path), source: "assistant" }).skills.filter((item) => item.filePath === skill.path));
}
/** save_skill 的附件可以不抄全文，只给工作目录里的文件（from），这里读出来；不能跳出工作目录。 */
export function readSkillFiles(cwd: string, files: unknown): SkillInput["files"] {
  if (files === undefined) return undefined;
  if (!Array.isArray(files)) throw new Error("技能附件无效");
  let root: string | undefined;
  return files.map((file) => {
    const { path, content, from } = (file ?? {}) as { path?: unknown; content?: unknown; from?: unknown };
    // 有的模型会把每个字段都填上，没用的那个给空串：空串当没给
    const hasFrom = from !== undefined && from !== "";
    const hasContent = content !== undefined && !(hasFrom && content === "");
    if (hasContent === hasFrom) throw new Error("附件要给 content 或 from，只给一个");
    if (!hasFrom) return { path, content } as { path: string; content: string };
    if (typeof from !== "string" || !from.trim()) throw new Error("附件的 from 无效");
    let real: string;
    try { root ??= realpathSync(cwd); real = realpathSync(resolve(root, from)); }
    catch { throw new Error(`找不到 from 指向的文件：${from}`); }
    const rel = relative(root, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("from 只能是工作目录里的文件");
    const stat = statSync(real);
    if (!stat.isFile()) throw new Error(`from 不是文件：${from}`);
    if (stat.size > 200 * 1024) throw new Error("技能附件超过 200 KB");
    return { path, content: readFileSync(real, "utf8") } as { path: string; content: string };
  });
}
export function saveAssistantSkill(home: string, assistantId: string, input: SkillInput, jobId?: string, replaceFiles = false, options?: { overwriteVersion?: boolean }): AssistantSkill {
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
  const dir = checkedDir(home, assistantId);
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
  return listAssistantSkills(home, assistantId).find((skill) => skill.name === input.name)!;
}
export function setAssistantSkillEnabled(home: string, assistantId: string, name: string, enabled: boolean): AssistantSkill {
  validName(name);
  const dir = checkedDir(home, assistantId), all = metadata(dir);
  if (!all[name]) throw new Error("技能不存在");
  safeTree(join(dir, name));
  all[name].enabled = enabled;
  saveMetadata(dir, all);
  return listAssistantSkills(home, assistantId).find((skill) => skill.name === name)!;
}
export function archiveAssistantSkill(home: string, assistantId: string, name: string): void {
  validName(name);
  const dir = checkedDir(home, assistantId), all = metadata(dir), target = join(dir, name);
  if (!all[name]) throw new Error("技能不存在");
  safeTree(target);
  const archive = join(dir, ".archive");
  safeTree(archive);
  mkdirSync(archive, { recursive: true });
  renameSync(target, join(archive, `${name}-${Date.now()}`));
  delete all[name];
  saveMetadata(dir, all);
}
export function recordAssistantSkillUse(home: string, assistantId: string, name: string): void {
  validName(name);
  const dir = checkedDir(home, assistantId), all = metadata(dir);
  if (!all[name]) throw new Error("技能不存在");
  all[name].uses++;
  all[name].lastUsedAt = new Date().toISOString();
  saveMetadata(dir, all);
}
export function rollbackAssistantSkill(home: string, assistantId: string, name: string): AssistantSkill {
  validName(name);
  const dir = checkedDir(home, assistantId), all = metadata(dir), target = join(dir, name);
  if (!all[name]) throw new Error("技能不存在");
  safeTree(target);
  const history = join(target, ".history");
  const versions = existsSync(history) ? readdirSync(history).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a) : [];
  if (!versions.length) throw new Error("没有上一版");
  const previous = join(history, String(versions[0]));
  const body = readFileSync(join(previous, "SKILL.md"), "utf8");
  const titleLine = body.split("\n").find((line) => line.startsWith("  title: "));
  const title = titleLine ? JSON.parse(titleLine.slice("  title: ".length)) : all[name].title;
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
  return saveAssistantSkill(home, assistantId, { name, title, description: description(join(previous, "SKILL.md")), content: body.slice(body.indexOf("\n---\n") + 5).replace(/^\n/, ""), files }, undefined, true);
}
