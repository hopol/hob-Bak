import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoginAutoEntry } from "../../shared/types.ts";

function file(home: string): string { return join(home, "system", "login-auto.json"); }

export function readLoginAuto(home: string): LoginAutoEntry[] {
  try {
    const value = JSON.parse(readFileSync(file(home), "utf8"));
    return Array.isArray(value) ? value.filter((entry): entry is LoginAutoEntry => entry && typeof entry === "object" && typeof entry.provider === "string" && typeof entry.itemId === "string" && typeof entry.host === "string" && typeof entry.username === "string" && typeof entry.at === "string") : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`读取自动填写设置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function write(home: string, entries: LoginAutoEntry[]): void {
  const path = file(home);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function saveLoginAuto(home: string, entry: Omit<LoginAutoEntry, "at">): LoginAutoEntry {
  const next = { ...entry, at: new Date().toISOString() };
  const entries = readLoginAuto(home).filter((item) => !(item.provider === entry.provider && item.itemId === entry.itemId && item.host === entry.host && item.username === entry.username));
  entries.push(next);
  write(home, entries);
  return next;
}

export function removeLoginAuto(home: string, provider: string, host: string, username: string): boolean {
  const entries = readLoginAuto(home);
  const next = entries.filter((item) => !(item.provider === provider && item.host === host && item.username === username));
  if (next.length === entries.length) return false;
  write(home, next);
  return true;
}
