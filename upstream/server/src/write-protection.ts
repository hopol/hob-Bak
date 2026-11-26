import { constants, lstatSync, readlinkSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

const BLOCKED = "这是 Hob 自己的数据，不能直接改：用户发来的文件复制到你的工作目录再改；技能在你的工作目录写好，用 save_skill 存；助手和群的资料用对应的工具。";
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

/** 目标尚不存在时，先解开存在的祖先目录，再拼回剩下的路径。 */
function canonical(path: string, depth = 0): string {
  if (depth > 40) throw new Error("符号链接层数过多");
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (let i = 0; i < parts.length; i++) {
    const next = resolve(current, parts[i]);
    try {
      if (lstatSync(next).isSymbolicLink()) return canonical(resolve(current, readlinkSync(next), ...parts.slice(i + 1)), depth + 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return resolve(next, ...parts.slice(i + 1));
    }
    current = next;
  }
  return current;
}

export function writablePath(home: string, roots: string[], requested: string): string {
  const path = resolve(requested), actual = canonical(path), homePath = resolve(home), actualHome = canonical(homePath);
  if (inside(homePath, path) || inside(actualHome, actual)) {
    const allowed = roots.some((root) => {
      const absolute = resolve(root), actualRoot = canonical(absolute);
      if (!inside(homePath, absolute)) return false;
      const expected = resolve(actualHome, relative(homePath, absolute));
      if (!inside(expected, actualRoot)) return false;
      return inside(actualRoot, actual);
    });
    if (!allowed) throw new Error(BLOCKED);
  }
  return path;
}

export function protectedFileTools(cwd: string, home: string, roots: () => string[]) {
  const check = (path: string) => writablePath(home, roots(), path);
  const edit = createEditToolDefinition(cwd, { operations: {
    access: async (path) => { await access(check(path), constants.R_OK | constants.W_OK); },
    readFile: async (path) => readFile(check(path)),
    writeFile: async (path, content) => { await writeFile(check(path), content); },
  } });
  const write = createWriteToolDefinition(cwd, { operations: {
    mkdir: async (path) => { await mkdir(check(path), { recursive: true }); },
    writeFile: async (path, content) => { await writeFile(check(path), content); },
  } });
  return [edit, write];
}
