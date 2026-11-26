// 技能按「谁能用」分三档：本群、助手自己、通用。通用里 Lore 和本机 ~/.agents/skills 不归 Hob 管，只读。
// 一个助手看得到哪些技能、每份能不能改，只在这里算；提示词、任务、改删都用这一份。
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantSkill, SkillImportResult, SkillImportSource, SkillImportView, SkillSource, SkillView, VisibleSkill } from "../../shared/skills.ts";
import { assistantSkillsDir, groupSkillsDir, isSkillName, skillHead, skillIndex, listSkills, saveAssistantSkillsIndex } from "./assistant-skills.ts";
import type { HobRuntime } from "./runtime.ts";
import type { Group } from "../../shared/types.ts";

/** 通用技能目录：所有助手都能用，Hob 管得着的那一档（能改、能删、有版本）。 */
export function generalSkillsDir(home: string): string {
  return join(home, "skills");
}

/**
 * 通用技能目录里的索引：目录名和 frontmatter 的 name 不一样时把目录改名成 name（索引、版本历史、
 * 改删都按 name 走，改名后这几处才对得上）；同名目录已经在了就跳过这一份并记日志。
 * 已经导入的技能多半不是 Hob 的格式，登记时只补索引：第 1 版、标题取 metadata.title（没有就用名字）、
 * 时间取 SKILL.md 的修改时间。
 */
export function syncGeneralIndex(dir: string): void {
  const root = resolve(dir);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return;
  const index = skillIndex(root);
  let changed = false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (index[entry.name]) continue;
    let file = join(root, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    let head;
    try { head = skillHead(readFileSync(file, "utf8")); }
    catch (error) { console.error(`跳过读不了的技能「${entry.name}」：`, error); continue; }
    if (!head.description) continue;
    const name = head.name ?? entry.name;
    if (!isSkillName(name)) { console.error(`技能名不能当目录名，跳过：${entry.name}（name: ${name}）`); continue; }
    if (name !== entry.name) {
      const target = join(root, name);
      if (existsSync(target)) { console.error(`技能「${entry.name}」的 name 是 ${name}，但已经有同名目录了，跳过`); continue; }
      renameSync(join(root, entry.name), target);
      file = join(target, "SKILL.md");
    }
    const at = statSync(file).mtime.toISOString();
    index[name] = { title: head.title ?? name, version: 1, createdAt: at, updatedAt: at, uses: 0, enabled: true };
    changed = true;
  }
  if (changed) saveAssistantSkillsIndex(root, index);
}

/** 能改的通用技能：索引里的全部，开关只看设置里的 skills.disabled。 */
export function generalSkills(home: string, disabled: string[] = []): AssistantSkill[] {
  const dir = generalSkillsDir(home);
  syncGeneralIndex(dir);
  return listSkills(dir).filter((skill) => !disabled.includes(`hob:${skill.name}`));
}

function editable(skill: AssistantSkill, scope: VisibleSkill["scope"]): VisibleSkill {
  return { name: skill.name, title: skill.title, description: skill.description, path: skill.path, dir: dirname(skill.path), scope, editable: true, version: skill.version, updatedAt: skill.updatedAt, enabled: skill.enabled, ...(skill.fromJobId ? { fromJobId: skill.fromJobId } : {}) };
}

/** 一档技能目录里的全部技能：开着的排在前面，同名时开着的那份生效。 */
function tierSkills(dir: string): AssistantSkill[] {
  try { return listSkills(dir).sort((a, b) => Number(b.enabled) - Number(a.enabled)); }
  catch (error) { console.error("读取技能失败：", error); return []; }
}

export function bundledPlaywrightSkillDir(): string {
  return fileURLToPath(new URL("../../node_modules/playwright-core/lib/tools/skills/playwright-cli", import.meta.url));
}

function builtinSkills(): VisibleSkill[] {
  const dir = bundledPlaywrightSkillDir();
  if (!existsSync(dir)) return [];
  return loadSkillsFromDir({ dir, source: "common" }).skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.filePath,
    dir: skill.baseDir,
    scope: "general" as const,
    editable: false,
    source: "builtin" as const,
  }));
}

/** 只读的一档：Lore 的工作副本、本机 ~/.agents/skills。Hob 管不了，只能照着用。 */
function readOnly(root: string, source: "lore" | "local"): VisibleSkill[] {
  if (!existsSync(root)) return [];
  const skills: VisibleSkill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!isSkillName(entry.name)) continue;
    const file = join(root, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    for (const skill of loadSkillsFromDir({ dir: join(root, entry.name), source }).skills) {
      if (skill.filePath !== file) continue;
      let title: string | undefined;
      try { title = skillHead(readFileSync(file, "utf8")).title; } catch { title = undefined; }
      skills.push({ name: skill.name, ...(title ? { title } : {}), description: skill.description, path: file, dir: skill.baseDir, scope: "general", editable: false, source });
    }
  }
  return skills;
}

function loreRoots(runtime: HobRuntime): string[] {
  return runtime.settings.memory().provider === "lore" ? runtime.pi.loreSkillPaths : [];
}

/**
 * 这个助手看得到哪些技能：本群 → 助手自己 → 通用（Hob 的）→ Lore → 本机 ~/.agents/skills。
 * 同名的只留先出现的那一份。停用的通用技能不出现；本群和自己的停用技能仍在清单里（带 enabled），
 * 只是不加载、不进提示词，能改、能删、能重新开。
 */
export function visibleSkills(runtime: HobRuntime, assistantId: string, group?: Group, userHome = homedir()): VisibleSkill[] {
  const disabled = runtime.settings.settings.skills?.disabled ?? [];
  const all: VisibleSkill[] = [];
  const add = (skill: VisibleSkill) => {
    if (skill.editable && !skill.version) return;
    if (all.some((item) => item.name === skill.name)) return;
    all.push(skill);
  };
  const groupDir = group ? groupSkillsDir(runtime.home, group.parentId ?? group.id) : undefined;
  const groupItems = groupDir ? tierSkills(groupDir).map((skill) => editable(skill, "group")) : [];
  const ownItems = tierSkills(assistantSkillsDir(runtime.home, assistantId)).map((skill) => editable(skill, "assistant"));
  const generalItems = generalSkills(runtime.home, disabled).map((skill) => editable(skill, "general"));
  // 开着的先排：停用的一份同名时不能把开着的那份挤掉
  for (const pass of [true, false]) {
    for (const skill of groupItems) if ((skill.enabled !== false) === pass) add(skill);
    for (const skill of ownItems) if ((skill.enabled !== false) === pass) add(skill);
    if (pass) for (const skill of generalItems) add(skill);
  }
  const desktop = runtime.desktop?.view();
  if (desktop?.enabled && desktop.url && desktop.tokenConfigured) for (const skill of builtinSkills()) add(skill);
  for (const root of loreRoots(runtime)) for (const skill of readOnly(root, "lore")) if (!disabled.includes(`lore:${skill.name}`)) add(skill);
  for (const skill of readOnly(join(userHome, ".agents", "skills"), "local")) if (!disabled.includes(`common:${skill.name}`)) add(skill);
  return all;
}

/** 交给 pi 的技能：能改的和本机的各按档位标来源，Lore 的由插件自己发现，不重复给。停用的不给。 */
export function loadedVisibleSkills(skills: VisibleSkill[]): Skill[] {
  return skills.filter((skill) => skill.enabled !== false).flatMap((skill) => {
    if (skill.source === "lore") return [];
    if (skill.source === "builtin") return loadSkillsFromDir({ dir: skill.dir, source: "common" }).skills.filter((item) => item.filePath === skill.path);
    const source = skill.source === "local" ? "common" : skill.scope === "general" ? "hob" : "assistant";
    return loadSkillsFromDir({ dir: skill.dir, source }).skills.filter((item) => item.filePath === skill.path);
  });
}

/** 一份技能落在哪一档的目录：改、删、锁都按这个目录算。 */
export function skillDirOf(runtime: HobRuntime, skill: VisibleSkill, assistantId: string, group?: Group): string {
  if (skill.scope === "general") return generalSkillsDir(runtime.home);
  return skill.scope === "group" && group ? groupSkillsDir(runtime.home, group.parentId ?? group.id) : assistantSkillsDir(runtime.home, assistantId);
}

/** 只读技能改不了：说清它在哪、去哪改。找不到就是没有这份技能。 */
export function notEditable(name: string, skills: VisibleSkill[]): string {
  const skill = skills.find((item) => item.name === name);
  if (skill?.source === "lore") return `${name} 来自 Lore，只能照着用，Hob 里改不了；要改，到 Lore 里改，或者让任务另存一份 Hob 的技能。`;
  if (skill?.source === "local") return `${name} 在本机 ~/.agents/skills 里，只能照着用，Hob 里改不了；要改得在那个目录里改，或者让任务另存一份 Hob 的技能。`;
  if (skill?.source === "builtin") return `${name} 是 Hob 自带的只读技能；要改可以让任务另存一份 Hob 的技能。`;
  return `没有这个技能：${name}`;
}

const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const IMPORT_DIRS: Record<SkillImportSource, string[]> = {
  pi: [".pi", "agent", "skills"], claude: [".claude", "skills"], codex: [".codex", "skills"],
};

function importRoot(source: SkillImportSource, userHome: string): string {
  const parts = IMPORT_DIRS[source];
  if (!parts) throw new Error("技能导入来源无效");
  return join(userHome, ...parts);
}

function validId(id: string): boolean {
  return id !== "." && id !== ".." && id.length > 0 && !id.includes("/") && !id.includes("\\") && !id.includes("\0");
}

function directSkills(root: string, source: string, confined = false): Skill[] {
  if (!existsSync(root)) return [];
  const result: Skill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!validId(entry.name) || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    if (confined && (!contained(realpathSync(root), realpathSync(dir)) || !contained(realpathSync(dir), realpathSync(file)))) continue;
    result.push(...loadSkillsFromDir({ dir, source }).skills.filter((skill) => skill.filePath === file));
  }
  return result;
}

/** 三个来源原样展示，覆盖关系不影响列表中的开关。Hob 的带版本和更新时间，能回退。 */
export function skillViews(home: string, disabled: string[], lorePaths: string[], userHome = homedir()): SkillView[] {
  syncGeneralIndex(generalSkillsDir(home));
  const own = listSkills(generalSkillsDir(home)).map((skill): SkillView => ({
    id: skill.name, name: skill.name, title: skill.title, description: skill.description, source: "hob",
    content: readFileSync(skill.path, "utf8"), enabled: !disabled.includes(`hob:${skill.name}`), overridden: false,
    version: skill.version, updatedAt: skill.updatedAt, ...(skill.origin ? { origin: skill.origin } : {}), ...(skill.fromJobId ? { fromJobId: skill.fromJobId } : {}),
    rollbackable: existsSync(join(dirname(skill.path), ".history")) && readdirSync(join(dirname(skill.path), ".history")).some((entry) => /^\d+$/.test(entry)),
  }));
  const groups: [SkillSource, Skill[]][] = [
    ["lore", lorePaths.flatMap((root) => directSkills(root, "lore"))],
    ["common", directSkills(join(userHome, ".agents", "skills"), "common")],
  ];
  const seen = new Set(own.filter((skill) => skill.enabled).map((skill) => skill.name));
  return [...own, ...groups.flatMap(([source, skills]) => skills.map((skill) => {
    const enabled = !disabled.includes(`${source}:${skill.name}`);
    const overridden = seen.has(skill.name);
    if (enabled) seen.add(skill.name);
    return { id: basename(skill.baseDir), name: skill.name, description: skill.description, source,
      content: readFileSync(skill.filePath, "utf8"), enabled, overridden };
  }))];
}

export function listImportSkills(home: string, source: SkillImportSource, userHome = homedir()): SkillImportView {
  const root = importRoot(source, userHome);
  if (!existsSync(root)) return { found: false, skills: [], skipped: [] };
  const own = listSkills(generalSkillsDir(home));
  const skipped = readdirSync(root, { withFileTypes: true }).filter((entry) => {
    if (!entry.isSymbolicLink()) return false;
    try { return !contained(realpathSync(root), realpathSync(join(root, entry.name))); }
    catch { return true; }
  }).map((entry) => `${entry.name}：跳过越界或无效符号链接`);
  return { found: true, skipped, skills: directSkills(root, source, true).map((skill) => ({
    id: basename(skill.baseDir), name: skill.name, description: skill.description,
    exists: own.some((item) => item.name === skill.name) || existsSync(join(home, "skills", basename(skill.baseDir))),
  })) };
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * 复制到暂存目录后才替换：限制大小，不让符号链接逃出来源。
 * 覆盖已存在的同名技能算一次新版本：旧的整份进 .history，索引升一版。
 */
export function importSkills(home: string, source: SkillImportSource, ids: string[], overwrite: boolean, userHome = homedir()): SkillImportResult {
  const root = importRoot(source, userHome);
  const list = listImportSkills(home, source, userHome);
  const result: SkillImportResult = { imported: [], skipped: [...list.skipped], errors: [] };
  const destination = generalSkillsDir(home);
  mkdirSync(destination, { recursive: true });
  if (lstatSync(destination).isSymbolicLink()) throw new Error("Hob 技能目录不能是符号链接");
  syncGeneralIndex(destination);
  for (const id of new Set(ids)) {
    if (!validId(id) || !list.skills.some((item) => item.id === id)) { result.errors.push(`${id}：技能不存在`); continue; }
    const candidate = list.skills.find((item) => item.id === id)!;
    const index = skillIndex(destination);
    const existing = index[candidate.name];
    const target = join(destination, candidate.name);
    if (existsSync(target) && !overwrite) { result.skipped.push(`${id}：已存在`); continue; }
    const stage = mkdtempSync(join(destination, ".import-"));
    try {
      const from = join(root, id);
      const realRoot = realpathSync(from);
      if (!contained(realpathSync(root), realRoot)) throw new Error("技能目录的符号链接指向来源之外");
      let bytes = 0;
      const copy = (src: string, dst: string, parents: Set<string>) => {
        if (basename(src) === ".git" || basename(src) === "node_modules") return;
        let real: string;
        try { real = realpathSync(src); }
        catch (error) {
          if (lstatSync(src).isSymbolicLink()) { result.skipped.push(`${id}：跳过无效符号链接 ${relative(from, src)}`); return; }
          throw error;
        }
        if (!contained(realRoot, real)) { result.skipped.push(`${id}：跳过越界符号链接 ${relative(from, src)}`); return; }
        const stat = statSync(real);
        if (stat.isDirectory()) {
          if (parents.has(real)) { result.skipped.push(`${id}：跳过循环符号链接 ${relative(from, src)}`); return; }
          mkdirSync(dst, { recursive: true });
          const next = new Set(parents); next.add(real);
          for (const entry of readdirSync(src)) copy(join(src, entry), join(dst, entry), next);
        } else if (stat.isFile()) {
          bytes += stat.size;
          if (bytes > MAX_SKILL_BYTES) throw new Error("超过 20MB");
          cpSync(real, dst);
        }
      };
      copy(from, stage, new Set());
      const replacing = existsSync(target);
      let backup: string | undefined;
      if (replacing) {
        // 覆盖算新版本：旧的整份进 .history，超过 5 版删最旧的
        const history = join(target, ".history");
        const snapshot = join(history, String(existing?.version ?? 1));
        if (!existsSync(snapshot)) {
          mkdirSync(snapshot, { recursive: true });
          for (const entry of readdirSync(target)) if (entry !== ".history") cpSync(join(target, entry), join(snapshot, entry), { recursive: true });
        }
        const versions = readdirSync(history).filter((entry) => /^\d+$/.test(entry)).map(Number).sort((a, b) => b - a);
        for (const old of versions.slice(5)) rmSync(join(history, String(old)), { recursive: true, force: true });
        // 先换到旁边的备份名下，再把新的换进去：换不进去就把旧的放回原样
        backup = join(destination, `.backup-${basename(stage)}`);
        renameSync(target, backup);
      }
      try { renameSync(stage, target); }
      catch (error) {
        if (backup && !existsSync(target)) renameSync(backup, target);
        throw error;
      }
      if (backup) {
        if (existsSync(join(backup, ".history"))) renameSync(join(backup, ".history"), join(target, ".history"));
        rmSync(backup, { recursive: true, force: true });
      }
      result.imported.push(id);
      const head = skillHead(readFileSync(join(target, "SKILL.md"), "utf8"));
      const now = new Date().toISOString();
      const next = skillIndex(destination);
      next[candidate.name] = {
        title: head.title ?? candidate.name,
        version: replacing ? (existing?.version ?? 1) + 1 : 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.fromJobId ? { fromJobId: existing.fromJobId } : {}),
        uses: existing?.uses ?? 0,
        ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
        enabled: true,
      };
      saveAssistantSkillsIndex(destination, next);
    } catch (error) { result.errors.push(`${id}：${error instanceof Error ? error.message : String(error)}`); }
    finally { rmSync(stage, { recursive: true, force: true }); }
  }
  return result;
}
