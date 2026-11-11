// HOB_HOME/system/secrets.json：密钥只写不读回界面，文件 0600，原子写。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { systemDir } from "./config.ts";

export type Secrets = Record<string, string>;

function file(home: string): string {
  return join(systemDir(home), "secrets.json");
}

export function readSecrets(home: string): Secrets {
  const path = file(home);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Secrets = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch (error) {
    throw new Error(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** 写一个密钥（value 为空字符串 = 删掉）。文件权限 0600。 */
export function writeSecret(home: string, key: string, value: string): void {
  const path = file(home);
  const all = readSecrets(home);
  if (value) all[key] = value;
  else delete all[key];
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  if (!Object.keys(all).length) {
    chmodSync(path, 0o600);
  }
}

/** 测试用：把文件删掉。 */
export function clearSecrets(home: string): void {
  rmSync(file(home), { force: true });
}
