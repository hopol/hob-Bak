import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { assistantWorkDir } from "./config.ts";
import type { Store } from "./store.ts";

/** 自动加载项目 AGENTS.md / CLAUDE.md 的字符上限。 */
export const WORKSPACE_AGENTS_MAX_CHARS = 32_000;

export const PRIMARY_CWD_FORBIDDEN = "主助手不支持设置工作目录。";
export const CWD_IMMUTABLE = "工作目录仅支持在创建时绑定，创建后不可修改。";
export const CWD_BOUND_LOCKED = "当前工作目录已绑定，任务只能在它里面的目录运行：cwd 换成绑定目录下的子目录，或者不填。";
export const topicCwdLockedByGroup = (path: string) =>
  `所属群已绑定工作目录（${path}），话题自动沿用群目录，不支持单独指定。`;

export type WorkspaceSource = "topic" | "group" | "assistant" | "default";

export interface ResolvedWorkspace {
  /** 解析出的绑定外部目录；未绑定任何外部目录时为 undefined */
  bound?: string;
  /** 生效来源 */
  source: WorkspaceSource;
  /** 对话会话实际使用的 cwd：有 bound 用 bound，否则回落到 assistants/<id>/work */
  sessionCwd: string;
}

export interface WorkspaceAgentsFile {
  path: string;
  content: string;
}

export interface ValidateWorkspaceCwdOptions {
  base?: string;
  allowRelative?: boolean;
  allowAncestorOfHome?: boolean;
  /** 后台任务场景在路径指向 HOB_HOME 内部时保留更具体的任务引导文案。 */
  jobError?: boolean;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

/** 规范化用户/工具传入的可选工作目录字段；留空返回 undefined，非字符串报错。 */
export function normalizeWorkspaceCwdInput(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error("工作目录必须是路径文字。");
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return expandHome(trimmed);
}

/** 校验并返回规范化后的工作目录绝对路径（安全判定一律基于 realpathSync）。 */
export function validateWorkspaceCwd(
  raw: string,
  home: string,
  options?: ValidateWorkspaceCwdOptions,
): string {
  const expanded = expandHome(raw.trim());
  if (!expanded) {
    throw new Error("工作目录必须填写绝对路径（如 /workspace/app）。");
  }
  if (!options?.allowRelative && !isAbsolute(expanded)) {
    throw new Error("工作目录必须填写绝对路径（如 /workspace/app）。");
  }
  const candidate = options?.allowRelative && options.base ? resolve(options.base, expanded) : resolve(expanded);
  if (!existsSync(candidate)) {
    throw new Error(`工作目录不存在：${candidate}`);
  }
  let stats;
  try {
    stats = statSync(candidate);
  } catch {
    throw new Error(`工作目录不存在：${candidate}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`工作目录不是文件夹：${candidate}`);
  }
  const realCwd = realpathSync(candidate);
  const realHome = existsSync(home) ? realpathSync(resolve(home)) : resolve(home);
  if (isInside(realHome, realCwd)) {
    throw new Error(
      options?.jobError
        ? "不能把 Hob 的数据目录指定为任务工作目录；不填 cwd 就在任务自己的目录里执行，需要的文件放在 files 里。"
        : "不能把 Hob 的数据目录作为工作目录。",
    );
  }
  if (!options?.allowAncestorOfHome && isInside(realCwd, realHome)) {
    throw new Error("工作目录范围过大（包含 Hob 数据目录），请指定具体的项目目录。");
  }
  return candidate;
}

/**
 * 在哪个会话里，就用哪个会话的目录：
 * - 群和话题里只看群和话题：群设了 cwd，群和它的话题都用群的；群没设，话题用自己的；都没设就是没绑定。助手自己的 cwd 不管。
 * - 单聊用非主助手自己的 cwd。
 * - 没绑定：系统默认（assistants/<id>/work）。
 */
export function resolveWorkspaceCwd(
  store: Store,
  home: string,
  assistantId: string,
  groupId?: string,
): ResolvedWorkspace {
  if (groupId) {
    const group = store.group(groupId);
    if (group?.parentId) {
      const parent = store.group(group.parentId);
      if (parent?.cwd) {
        return { bound: parent.cwd, source: "group", sessionCwd: parent.cwd };
      }
      if (group.cwd) {
        return { bound: group.cwd, source: "topic", sessionCwd: group.cwd };
      }
    } else if (group?.cwd) {
      return { bound: group.cwd, source: "group", sessionCwd: group.cwd };
    }
    return { source: "default", sessionCwd: assistantWorkDir(home, assistantId) };
  }
  const assistant = store.assistant(assistantId);
  if (assistant && !assistant.primary && assistant.cwd) {
    return { bound: assistant.cwd, source: "assistant", sessionCwd: assistant.cwd };
  }
  return { source: "default", sessionCwd: assistantWorkDir(home, assistantId) };
}

/**
 * 仅读取绑定外部工作目录根的 AGENTS.md（无则回退 CLAUDE.md，二选一），
 * 不向上扫描父目录或家目录；拒绝指向目录外的软链；超长按换行截断。
 */
export function loadWorkspaceAgentsFile(workspaceCwd: string | undefined): WorkspaceAgentsFile[] {
  if (!workspaceCwd) return [];
  let realDir: string;
  try {
    realDir = realpathSync(resolve(workspaceCwd));
    if (!statSync(realDir).isDirectory()) return [];
  } catch {
    return [];
  }
  const baseDir = resolve(workspaceCwd);
  for (const name of ["AGENTS.md", "CLAUDE.md"] as const) {
    const candidate = join(baseDir, name);
    if (!existsSync(candidate)) continue;
    let realFile: string;
    try {
      realFile = realpathSync(candidate);
      if (!statSync(realFile).isFile()) continue;
    } catch {
      continue;
    }
    if (!isInside(realDir, realFile)) continue;
    let raw: string;
    try {
      raw = readFileSync(realFile, "utf8");
    } catch {
      continue;
    }
    if (!raw.trim()) continue;
    let content = raw;
    if (content.length > WORKSPACE_AGENTS_MAX_CHARS) {
      const slice = content.slice(0, WORKSPACE_AGENTS_MAX_CHARS);
      const cut = slice.lastIndexOf("\n");
      const head = cut > 0 ? slice.slice(0, cut) : slice;
      content = `${head}\n（以上为前 32,000 字，文件其余部分已省略；如需查看完整内容，请用 read 工具读取 ${candidate}。）`;
    }
    return [{ path: candidate, content }];
  }
  return [];
}

/** 收集所有已绑定工作目录（供 /api/files 等文件读取白名单使用）。 */
export function allowedWorkspaceDirs(store: Store): string[] {
  const dirs = new Set<string>();
  for (const assistant of store.assistants()) {
    if (!assistant.primary && assistant.cwd) dirs.add(assistant.cwd);
  }
  for (const group of store.groups()) {
    if (group.cwd) dirs.add(group.cwd);
  }
  return [...dirs];
}
