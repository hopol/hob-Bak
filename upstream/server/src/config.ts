import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashPassword, isPasswordHash } from "./password.ts";
import type { ThinkingLevel } from "../../shared/types.ts";

export type { ThinkingLevel };

/**
 * 启动用的配置（HOB_HOME/config.json）。界面能改的东西都在 settings.json，
 * 这里只留启动项：端口、host、密码哈希和 cookie 签名密钥。模型在设置 → 模型里。
 */
export interface HobConfig {
  host: string;
  port: number;
  /** scrypt 哈希，见 password.ts；明文密码在首次启动时转成它 */
  passwordHash: string;
  cookieSecret: string;
}

export const DEFAULT_CONFIG: Omit<HobConfig, "passwordHash" | "cookieSecret"> = {
  host: "127.0.0.1",
  port: 30148,
};

export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.HOB_HOME?.trim() || join(homedir(), ".hob"));
}

/** HOB_HOME 的布局版本；layout.json 里有它说明已经是 v2 布局。 */
export const LAYOUT_VERSION = 2;

/** 配置、凭据和引擎内部状态：/api/files 和读文件工具整个挡住。 */
export function systemDir(home: string): string {
  return join(home, "system");
}

/** 删了能重建的东西（缩略图、GitHub 抓取缓存、模型单价表）。 */
export function cacheDir(home: string): string {
  return join(home, "cache");
}

/** 引擎目录（凭据、资源）：Hob 自己管，放在 HOB_HOME 里。 */
export function engineDir(home: string): string {
  return join(home, "system", "engine");
}

/** 本地记忆插件的目录（插件在模块加载时就读这个环境变量）。 */
export function memoryDir(home: string): string {
  return join(home, "system", "memory");
}

/** Lore 连接的目录：Hob 自己的 config.json 在这里，不碰其他 Lore 客户端的那份。 */
export function loreDir(home: string): string {
  return join(home, "system", "lore");
}

/** 一个助手的目录。 */
export function assistantDir(home: string, id: string): string {
  return join(home, "assistants", id);
}

/** 这个助手的任务目录。 */
export function assistantJobsDir(home: string, id: string): string {
  return join(assistantDir(home, id), "jobs");
}

/** 这个助手自己的上传、生图、页面、截图。 */
export function assistantFilesDir(home: string, id: string, kind?: "uploads" | "images" | "pages" | "screenshots"): string {
  return kind ? join(assistantDir(home, id), "files", kind) : join(assistantDir(home, id), "files");
}

/** 归档助手的地方：一个助手一个目录，目录名是 <id>-<归档时间>。 */
export function archiveAssistantsDir(home: string): string {
  return join(home, "archive", "assistants");
}

/** v1 → v2 迁移记下的「旧路径 → 新路径」；会话文件里的老路径靠它解析。 */
export function movesFile(home: string): string {
  return join(systemDir(home), "moves.json");
}

export function layoutFile(home: string): string {
  return join(home, "layout.json");
}

const CONFIG_FILE = "config.json";
/** 搬进 settings.json 之后不再写回去的旧键。 */
export const LEGACY_MODEL_KEYS = ["routerModel", "routerThinking", "workerModel", "workerThinking"];


/** 里面有密码哈希和 cookieSecret：只给自己读写（和 secrets.json 一样 0600）。 */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** 读 HOB_HOME/system/config.json；首次启动时创建（cookieSecret 随机生成）。
 * 密码存哈希：文件里还是明文 password，或者用了 HOB_PASSWORD，就转成哈希写回。
 */
export function loadConfig(home: string, env: NodeJS.ProcessEnv = process.env): HobConfig {
  mkdirSync(systemDir(home), { recursive: true });
  // 对话、任务、引擎日志（MCP 服务发来的日志原样落盘）都在这里：只给本人读
  chmodSync(home, 0o700);
  const file = join(systemDir(home), CONFIG_FILE);
  const stored: Record<string, unknown> = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
    : {};
  const plain = typeof stored.password === "string" ? stored.password.trim() : "";
  const fromEnv = (env.HOB_PASSWORD ?? "").trim();
  const storedHash = typeof stored.passwordHash === "string" ? stored.passwordHash.trim() : "";
  const passwordHash = isPasswordHash(storedHash)
    ? storedHash
    : plain || fromEnv
      ? hashPassword(plain || fromEnv)
      : "";
  if (!passwordHash) {
    throw new Error(
      `没有设置密码：请在 ${file} 里填 password（会转成哈希），或启动时设置 HOB_PASSWORD。`,
    );
  }
  const needWrite = !isPasswordHash(storedHash) || !stored.cookieSecret || hasLegacyModelKeys(home);
  const config: HobConfig = {
    host: (env.HOB_HOST ?? (typeof stored.host === "string" ? stored.host : "") ?? "").trim() || DEFAULT_CONFIG.host,
    port: Number(stored.port) > 0 ? Number(stored.port) : DEFAULT_CONFIG.port,
    passwordHash,
    cookieSecret:
      typeof stored.cookieSecret === "string" && stored.cookieSecret ? stored.cookieSecret : randomBytes(32).toString("hex"),
  };
  if (needWrite) writeConfig(home, config);
  return config;
}

function hasLegacyModelKeys(home: string): boolean {
  try {
    const stored = JSON.parse(readFileSync(join(systemDir(home), CONFIG_FILE), "utf8")) as Record<string, unknown>;
    return LEGACY_MODEL_KEYS.some((key) => key in stored);
  } catch {
    return false;
  }
}

/** 只写已知字段：搬走的旧键（模型、theme、timezone、maxJobs…）不留在文件里。 */
export function writeConfig(home: string, config: HobConfig): void {
  mkdirSync(systemDir(home), { recursive: true });
  const out = {
    host: config.host,
    port: config.port,
    passwordHash: config.passwordHash,
    cookieSecret: config.cookieSecret,
  };
  writeAtomic(join(systemDir(home), CONFIG_FILE), `${JSON.stringify(out, null, 2)}\n`);
}

/** 改密码：写回 config.json。 */
export function setPassword(home: string, config: HobConfig, password: string): HobConfig {
  const next: HobConfig = { ...config, passwordHash: hashPassword(password) };
  writeConfig(home, next);
  return next;
}
