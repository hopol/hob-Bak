import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import type { SkillImportResult, SkillImportSource, SkillImportView, SkillSource, SkillView } from "../../shared/skills.ts";

/** 只读通用目录和 Hob 自己的目录；同名时 Hob 优先。 */
export function availableSkills(home: string, userHome = homedir(), disabled: string[] = [], lorePaths: string[] = []): Skill[] {
  const own = directSkills(join(home, "skills"), "hob");
  const lore = lorePaths.flatMap((dir) => directSkills(dir, "lore"));
  const common = directSkills(join(userHome, ".agents", "skills"), "common");
  const seen = new Set<string>();
  return [...own, ...lore, ...common].filter((skill) => {
    if (disabled.includes(`${skill.sourceInfo.source}:${skill.name}`)) return false;
    if (seen.has(skill.name)) return false;
    seen.add(skill.name);
    return true;
  });
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

/** 三个来源原样展示，覆盖关系不影响列表中的开关。 */
export function skillViews(home: string, disabled: string[], lorePaths: string[], userHome = homedir()): SkillView[] {
  const groups: [SkillSource, Skill[]][] = [
    ["hob", directSkills(join(home, "skills"), "hob")],
    ["lore", lorePaths.flatMap((root) => directSkills(root, "lore"))],
    ["common", directSkills(join(userHome, ".agents", "skills"), "common")],
  ];
  const seen = new Set<string>();
  return groups.flatMap(([source, skills]) => skills.map((skill) => {
    const enabled = !disabled.includes(`${source}:${skill.name}`);
    const overridden = seen.has(skill.name);
    if (enabled) seen.add(skill.name);
    return { id: basename(skill.baseDir), name: skill.name, description: skill.description, source,
      content: readFileSync(skill.filePath, "utf8"), enabled, overridden };
  }));
}

export function listImportSkills(home: string, source: SkillImportSource, userHome = homedir()): SkillImportView {
  const root = importRoot(source, userHome);
  if (!existsSync(root)) return { found: false, skills: [], skipped: [] };
  const own = directSkills(join(home, "skills"), "hob");
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

/** 复制到暂存目录后才替换：限制大小，不让符号链接逃出来源。 */
export function importSkills(home: string, source: SkillImportSource, ids: string[], overwrite: boolean, userHome = homedir()): SkillImportResult {
  const root = importRoot(source, userHome);
  const list = listImportSkills(home, source, userHome);
  const result: SkillImportResult = { imported: [], skipped: [...list.skipped], errors: [] };
  const destination = join(home, "skills");
  mkdirSync(destination, { recursive: true });
  if (lstatSync(destination).isSymbolicLink()) throw new Error("Hob 技能目录不能是符号链接");
  for (const id of new Set(ids)) {
    if (!validId(id) || !list.skills.some((item) => item.id === id)) { result.errors.push(`${id}：技能不存在`); continue; }
    const candidate = list.skills.find((item) => item.id === id)!;
    const existing = directSkills(destination, "hob").find((skill) => skill.name === candidate.name);
    const target = join(destination, existing ? basename(existing.baseDir) : id);
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
          copyFileSync(real, dst);
        }
      };
      copy(from, stage, new Set());
      const backup = join(destination, `.backup-${basename(stage)}`);
      const replacing = existsSync(target);
      if (replacing) renameSync(target, backup);
      try { renameSync(stage, target); }
      catch (error) { if (replacing) renameSync(backup, target); throw error; }
      if (replacing) rmSync(backup, { recursive: true, force: true });
      result.imported.push(id);
    } catch (error) { result.errors.push(`${id}：${error instanceof Error ? error.message : String(error)}`); }
    finally { rmSync(stage, { recursive: true, force: true }); }
  }
  return result;
}

export function deleteOwnSkill(home: string, id: string): void {
  if (!validId(id)) throw new Error("技能名称无效");
  const dir = join(home, "skills");
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Hob 技能目录不能是符号链接");
  const target = join(dir, id);
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("只能删除 Hob 自己的技能目录");
  rmSync(target, { recursive: true });
}
