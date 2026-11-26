// Shared helpers for Hob GitHub plugin CLI wrappers (bin/git, bin/git-credential-hob, bin/gh).

import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

function safeRealpath(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

export function findRealBinary(name, skipDir) {
  const skip = safeRealpath(skipDir);
  const pathEnv = process.env.PATH || "";
  for (const rawEntry of pathEnv.split(delimiter)) {
    if (!rawEntry) continue;
    if (safeRealpath(rawEntry) === skip) continue;
    const candidate = join(rawEntry, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not present or not executable in this PATH entry.
    }
  }
  return null;
}

export function parseGitHubRepoSpec(value) {
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (!trimmed) return {};

  // Match full GitHub URLs (HTTPS, SSH, git@)
  const urlMatch = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|github\.com\/)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }

  // Match shorthand "owner/repo" (used by gh -R owner/repo)
  const shortMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2] };
  }

  return {};
}

export function parseGitHubRemote(remoteUrl) {
  if (typeof remoteUrl !== "string") return {};
  const trimmed = remoteUrl.trim();
  const match = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (!match) return {};
  return { owner: match[1], repo: match[2] };
}

export function detectGitHubRemote(realGit, cwd) {
  if (!realGit) return {};
  try {
    const origin = execFileSync(realGit, ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = parseGitHubRemote(origin);
    if (parsed.owner) return parsed;
  } catch {
    // Not a git repo or no origin remote.
  }

  try {
    const list = execFileSync(realGit, ["-C", cwd, "remote", "-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let remotes = 0;
    for (const line of list.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        remotes++;
        const parsed = parseGitHubRemote(parts[1]);
        if (parsed.owner) return parsed;
      }
    }
    // Remotes exist but none is on github.com: callers leave this repo alone.
    if (remotes) return { foreign: true };
  } catch {
    // Ignore errors outside a git repository.
  }
  return {};
}

export async function fetchHobCredentials(scope = {}) {
  const url = process.env.HOB_TOOLS_URL;
  const token = process.env.HOB_TOOLS_TOKEN;
  if (!url || !token) return null;

  const args = {};
  if (scope.owner) args.owner = scope.owner;
  if (scope.repo) args.repo = scope.repo;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "github_command_credentials", args }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const value = data?.value;
    if (value && typeof value === "object" && typeof value.token === "string" && value.token) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export function runPassthrough(command, args, { env = process.env, stdinData = null } = {}) {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, {
      env,
      stdio: stdinData !== null ? ["pipe", "inherit", "inherit"] : "inherit",
    });
    if (stdinData !== null && child.stdin) {
      child.stdin.end(stdinData);
    }
    child.on("error", (error) => {
      process.stderr.write(`${command}: ${error.message}\n`);
      resolveExit({ code: 127, signal: null });
    });
    child.on("close", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
}

export function finishWith({ code, signal }) {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
}
