import { isAbsolute, relative } from "node:path";

/** 左栏头像下的小字：去掉多余空白，超过 max 个字直接截断（不补省略号，放不下）。 */
export function clampDuty(value: string, max = 8): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

/** 活动流里的路径：在工作目录下的就显示相对路径。 */
export function showPath(path: string, cwd: string): string {
  if (!path || !cwd || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}
