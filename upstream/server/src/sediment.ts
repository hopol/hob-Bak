import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSkillName, skillHead, type SkillHead } from "./assistant-skills.ts";

/** 新建技能的目录名：小写字母、数字和连字符，2 到 48 个字。 */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,47}$/;
const ATTACHMENT_LIMIT = 200 * 1024;
const ATTACHMENT_COUNT = 20;
const SKILL_TEXT_LIMIT = 20000;
const DESCRIPTION_LIMIT = 120;
const TOP_LEVEL = new Set(["SKILL.md", "scripts", "references", ".history"]);

function links(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) found.push(rel);
    else if (entry.isDirectory()) found.push(...links(join(dir, entry.name), rel));
  }
  return found;
}

function attachments(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? attachments(join(dir, entry.name), rel) : entry.isFile() ? [rel] : [];
  });
}

type Inspection = { ok: true; title: string; description: string } | { ok: false; reasons: string[] };

/** 新建技能查完整约定；修改已有技能只查底线，兼容导入格式。 */
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
  for (const key of ["name", "description"] as const) if (!head[key]) reasons.push(`「${name}」的 SKILL.md 开头缺 ${key}`);
  if (!options.existing && !head.title) reasons.push(`「${name}」的 SKILL.md 开头缺 metadata.title`);
  if (head.name && head.name !== name) reasons.push(`「${name}」的 SKILL.md 开头 name 要和目录名一样，现在是「${head.name}」`);
  const length = [...(head.description ?? "")].length;
  if (!options.existing && head.description && length > DESCRIPTION_LIMIT) reasons.push(`「${name}」的 description 超过 ${DESCRIPTION_LIMIT} 字（现在 ${length} 字）`);
  if ([...text].length > SKILL_TEXT_LIMIT) reasons.push(`「${name}」的 SKILL.md 超过 ${SKILL_TEXT_LIMIT} 字`);
  if (!options.existing) for (const entry of readdirSync(root)) if (!TOP_LEVEL.has(entry)) reasons.push(`「${name}」里的 ${entry} 放错了地方：脚本放 scripts/，参考资料放 references/`);
  const files = [...attachments(join(root, "scripts"), "scripts"), ...attachments(join(root, "references"), "references")];
  if (!options.existing && files.length > ATTACHMENT_COUNT) reasons.push(`「${name}」的附件超过 ${ATTACHMENT_COUNT} 个`);
  for (const path of files) if (statSync(join(root, path)).size > ATTACHMENT_LIMIT) reasons.push(`「${name}」的 ${path} 超过 200 KB`);
  return reasons.length ? { ok: false, reasons } : { ok: true, title: head.title ?? name, description: head.description! };
}
