// 沉淀的底稿和对账：开始前把技能目录拍一份，收尾时拿它和现在的目录比，改动通过校验才登记版本。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveAssistantSkillsIndex, isSkillName, skillHead, type SkillHead } from "./assistant-skills.ts";

/** 技能的目录名：小写字母、数字和连字符，2 到 48 个字。 */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,47}$/;
const ATTACHMENT_LIMIT = 200 * 1024;
const ATTACHMENT_COUNT = 20;
const SKILL_TEXT_LIMIT = 20000;
const DESCRIPTION_LIMIT = 120;
const HISTORY_KEEP = 5;
const TOP_LEVEL = new Set(["SKILL.md", "scripts", "references", ".history"]);

type Metadata = { title: string; version: number; createdAt: string; updatedAt: string; fromJobId?: string; uses: number; lastUsedAt?: string; enabled: boolean };
type Index = Record<string, Metadata>;

export interface SkillSaved { name: string; title: string; version: number; updated: boolean }

/** 技能目录里的技能目录名（不含 .archive、导入暂存这些点开头的目录）。 */
function skillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/** 一份技能的文件列表和内容（不含 .history）。 */
function tree(dir: string, prefix = ""): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".history") continue;
      for (const [key, value] of tree(path, rel)) files.set(key, value);
    } else if (entry.isFile()) files.set(rel, readFileSync(path, "utf8"));
  }
  return files;
}

function sameTree(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/** 跑脚本留下的缓存目录不算改动，直接删掉。 */
function dropCaches(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === "__pycache__") rmSync(path, { recursive: true, force: true });
    else dropCaches(path);
  }
}

/** 底稿：每个技能目录（不含版本历史）加上 skills.json。每次沉淀重新拍一份。 */
export function snapshotSkills(skillsDir: string, base: string): void {
  mkdirSync(base, { recursive: true });
  for (const entry of readdirSync(base)) if (entry !== ".target.json") rmSync(join(base, entry), { recursive: true, force: true });
  if (existsSync(skillsDir)) for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile() && entry.name === "skills.json") cpSync(join(skillsDir, entry.name), join(base, entry.name));
    if (entry.isDirectory()) cpSync(join(skillsDir, entry.name), join(base, entry.name), { recursive: true, filter: (source) => !source.endsWith("/.history") && !source.endsWith("\\.history") });
  }
  writeFileSync(join(base, ".snapshot-ready"), "");
}

/** 一份技能照底稿恢复：内容换回底稿的样子，版本历史留着。 */
function restoreDir(from: string, to: string): void {
  if (existsSync(to)) {
    for (const entry of readdirSync(to)) if (entry !== ".history") rmSync(join(to, entry), { recursive: true, force: true });
  } else {
    mkdirSync(to, { recursive: true });
  }
  for (const entry of readdirSync(from)) cpSync(join(from, entry), join(to, entry), { recursive: true });
}

/**
 * 登记以底稿和这一轮的结果为准：用量计数和启用开关是别处一直在改的，这两项照现在的记。
 * 模型自己往 skills.json 里写的东西不算，写回去的总是按底稿推出来的那份。
 */
function keptIndex(skillsDir: string, base: string): Index {
  const live = readIndex(join(skillsDir, "skills.json"));
  const index = readIndex(join(base, "skills.json"));
  for (const [name, data] of Object.entries(index)) {
    const now = live[name];
    if (!now) continue;
    index[name] = {
      ...data,
      ...(typeof now.uses === "number" ? { uses: now.uses } : {}),
      ...(now.lastUsedAt ? { lastUsedAt: now.lastUsedAt } : {}),
      ...(typeof now.enabled === "boolean" ? { enabled: now.enabled } : {}),
    };
  }
  return index;
}

/**
 * 把这一轮动过的技能照底稿放回去（沉淀被停下、出错、进程重启时用）：
 * 改过的、删掉的换回底稿；底稿里没有的目录都是这一轮建的，删掉。用量和开关照现在的。
 */
export function restoreSkills(skillsDir: string, base: string): void {
  if (!existsSync(base)) return;
  mkdirSync(skillsDir, { recursive: true });
  dropCaches(skillsDir);
  const before = skillDirs(base);
  for (const name of skillDirs(skillsDir)) {
    if (!before.includes(name)) rmSync(join(skillsDir, name), { recursive: true, force: true });
  }
  for (const name of before) {
    const target = join(skillsDir, name);
    if (!existsSync(target) || !sameTree(tree(target), tree(join(base, name)))) restoreDir(join(base, name), target);
  }
  saveAssistantSkillsIndex(skillsDir, keptIndex(skillsDir, base));
}

/** 目录里的符号链接（相对技能目录的路径）。 */
function links(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) found.push(rel);
    else if (entry.isDirectory()) found.push(...links(join(dir, entry.name), rel));
  }
  return found;
}

/** scripts/ 和 references/ 下的文件（相对技能目录的路径）。 */
function attachments(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? attachments(join(dir, entry.name), rel) : entry.isFile() ? [rel] : [];
  });
}

type Inspection = { ok: true; title: string; description: string } | { ok: false; reasons: string[] };

/**
 * 一份技能能不能用。新建的查全套 Hob 约定（目录名、metadata.title、说明 120 字以内、顶层只放两个目录）；
 * 改已有的只查底线（有 SKILL.md、name 和目录对得上、有 description、没有符号链接、不超大小）：
 * 导入的技能不是 Hob 的格式，为了能改不能把它们改坏。
 */
export function inspectSkill(skillsDir: string, name: string, options: { existing: boolean }): Inspection {
  if (!options.existing && !SKILL_NAME.test(name)) return { ok: false, reasons: [`目录名「${name}」只能用小写字母、数字和连字符，2 到 48 个字`] };
  if (!isSkillName(name)) return { ok: false, reasons: [`「${name}」不能当技能目录名`] };
  const root = join(skillsDir, name);
  if (!existsSync(join(root, "SKILL.md"))) return { ok: false, reasons: [`「${name}」里没有 SKILL.md：要建技能就补上，不是技能就删掉这个目录`] };
  const reasons: string[] = [];
  for (const path of links(root)) reasons.push(`「${name}」里不能有符号链接：${path}`);
  if (reasons.length) return { ok: false, reasons };
  const text = readFileSync(join(root, "SKILL.md"), "utf8");
  let head: SkillHead;
  try { head = skillHead(text); }
  catch (error) { return { ok: false, reasons: [`「${name}」的 SKILL.md 开头读不出来：${(error instanceof Error ? error.message : String(error)).split("\n")[0].replace(/[:：]\s*$/, "")}`] }; }
  for (const key of ["name", "description"] as const) {
    if (!head[key]) reasons.push(`「${name}」的 SKILL.md 开头缺 ${key}`);
  }
  if (!options.existing && !head.title) reasons.push(`「${name}」的 SKILL.md 开头缺 metadata.title`);
  if (head.name && head.name !== name) reasons.push(`「${name}」的 SKILL.md 开头 name 要和目录名一样，现在是「${head.name}」`);
  const length = [...(head.description ?? "")].length;
  if (!options.existing && head.description && length > DESCRIPTION_LIMIT) reasons.push(`「${name}」的 description 超过 ${DESCRIPTION_LIMIT} 字（现在 ${length} 字）`);
  if ([...text].length > SKILL_TEXT_LIMIT) reasons.push(`「${name}」的 SKILL.md 超过 ${SKILL_TEXT_LIMIT} 字`);
  if (!options.existing) {
    for (const entry of readdirSync(root)) {
      if (!TOP_LEVEL.has(entry)) reasons.push(`「${name}」里的 ${entry} 放错了地方：脚本放 scripts/，参考资料放 references/`);
    }
  }
  const files = [...attachments(join(root, "scripts"), "scripts"), ...attachments(join(root, "references"), "references")];
  if (!options.existing && files.length > ATTACHMENT_COUNT) reasons.push(`「${name}」的附件超过 ${ATTACHMENT_COUNT} 个`);
  for (const path of files) {
    const size = statSync(join(root, path)).size;
    if (size > ATTACHMENT_LIMIT) reasons.push(`「${name}」的 ${path} 超过 200 KB`);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, title: head.title ?? name, description: head.description! };
}

function readIndex(file: string): Index {
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" ? (data as Index) : {};
  } catch {
    return {};
  }
}

/** 版本历史最多留 5 版，删最旧的。 */
function pruneHistory(dir: string): void {
  if (!existsSync(dir)) return;
  const versions = readdirSync(dir).filter((entry) => /^\d+$/.test(entry)).map(Number).sort((a, b) => b - a);
  for (const version of versions.slice(HISTORY_KEEP)) rmSync(join(dir, String(version)), { recursive: true, force: true });
}

/**
 * 拿现在的技能目录和底稿对账：已有技能变了升一版、新目录登记第 1 版，
 * 模型删掉的照底稿放回去。校验不过就一条都不动。
 */
export function reconcileSkills(skillsDir: string, base: string, jobId: string, now = new Date().toISOString()): { ok: true; saved: SkillSaved[] } | { ok: false; reasons: string[] } {
  dropCaches(skillsDir);
  mkdirSync(skillsDir, { recursive: true });
  const before = skillDirs(base);
  for (const name of before) if (!existsSync(join(skillsDir, name))) restoreDir(join(base, name), join(skillsDir, name));
  const index = keptIndex(skillsDir, base);
  const checks = skillDirs(skillsDir).flatMap((name) => {
    if (before.includes(name)) return sameTree(tree(join(skillsDir, name)), tree(join(base, name))) ? [] : [{ name, updated: Boolean(index[name]) }];
    // 沉淀期间别的入口改不了这个目录：底稿里没有的目录都是这一轮建的
    return [{ name, updated: false }];
  });
  const reasons: string[] = [];
  const ready: { name: string; updated: boolean; title: string }[] = [];
  for (const item of checks) {
    const inspection = inspectSkill(skillsDir, item.name, { existing: before.includes(item.name) });
    if (inspection.ok) ready.push({ name: item.name, updated: item.updated, title: inspection.title });
    else reasons.push(...inspection.reasons);
  }
  if (reasons.length) return { ok: false, reasons };
  const saved: SkillSaved[] = [];
  for (const item of ready) {
    const old = index[item.name];
    if (item.updated && old) {
      const version = old.version + 1;
      const history = join(skillsDir, item.name, ".history");
      mkdirSync(history, { recursive: true });
      const snapshot = join(history, String(old.version));
      if (!existsSync(snapshot)) cpSync(join(base, item.name), snapshot, { recursive: true });
      pruneHistory(history);
      index[item.name] = { ...old, title: item.title, version, updatedAt: now, fromJobId: jobId };
      saved.push({ name: item.name, title: item.title, version, updated: true });
    } else {
      index[item.name] = { title: item.title, version: 1, createdAt: now, updatedAt: now, fromJobId: jobId, uses: 0, enabled: true };
      saved.push({ name: item.name, title: item.title, version: 1, updated: false });
    }
  }
  saveAssistantSkillsIndex(skillsDir, index);
  return { ok: true, saved };
}
