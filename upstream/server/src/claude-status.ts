import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { applyEngineEnv } from "./boot.ts";
import type { ClaudeCodeStatus } from "../../shared/types.ts";

const run = promisify(execFile);

/** 找不到或不可执行时不回退到 SDK 自带的程序。 */
export function findClaude(path: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const candidates = path ? [path] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "claude"));
  return candidates.find((candidate) => {
    if (!isAbsolute(candidate)) return false;
    try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
  });
}

/** 只保留状态展示需要的字段，不返回程序的原始输出或错误。 */
export async function claudeStatus(home: string, path?: string, inherited = process.env): Promise<ClaudeCodeStatus> {
  const env = { ...inherited };
  applyEngineEnv(env, home);
  const executable = findClaude(path, env);
  if (!executable) return { found: false, loggedIn: false };
  let version: string | undefined;
  try {
    const result = await run(executable, ["--version"], { env, timeout: 10_000, maxBuffer: 16_384 });
    version = result.stdout.match(/^\s*(\d+\.\d+\.\d+(?:[-.][\w.-]+)?)/)?.[1];
  } catch {
    return { found: true, executable, loggedIn: false, error: "无法运行 Claude Code，请检查程序路径。" };
  }
  let output: string;
  try {
    output = (await run(executable, ["auth", "status", "--json"], { env, timeout: 10_000, maxBuffer: 16_384 })).stdout;
  } catch (error) {
    output = typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
  }
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    if (typeof value.loggedIn !== "boolean") throw new Error("invalid status");
    const email = typeof value.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) && value.email.length <= 254 ? value.email : undefined;
    const plan = typeof value.subscriptionType === "string" && /^(pro|max|team|enterprise)$/i.test(value.subscriptionType) ? value.subscriptionType : undefined;
    return { found: true, executable, ...(version ? { version } : {}), loggedIn: value.loggedIn === true, ...(email ? { email } : {}), ...(plan ? { plan } : {}) };
  } catch {
    return { found: true, executable, ...(version ? { version } : {}), loggedIn: false, error: "无法检测 Claude Code 登录状态。" };
  }
}
