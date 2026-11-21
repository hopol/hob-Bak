import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = 1;
const COOKIE_LIMIT = 4096;

function cookieKey(cookie) {
  return [cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? ""].join("\u0000");
}

export function changedCookies(previous, current) {
  const before = new Map((previous ?? []).filter(validCookie).map((cookie) => [cookieKey(cookie), JSON.stringify(cookie)]));
  return (current ?? []).filter(validCookie).filter((cookie) => before.get(cookieKey(cookie)) !== JSON.stringify(cookie));
}

export function removedCookies(previous, current) {
  const after = new Set((current ?? []).filter(validCookie).map((cookie) => cookieKey(cookie)));
  return (previous ?? []).filter(validCookie).filter((cookie) => !after.has(cookieKey(cookie))).map((cookie) => ({ name: cookie.name, domain: cookie.domain, path: cookie.path, ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}) }));
}

export function withoutCookies(current, removed) {
  const keys = new Set((removed ?? []).map((cookie) => cookieKey(cookie)));
  return (current ?? []).filter(validCookie).filter((cookie) => !keys.has(cookieKey(cookie))).map((cookie) => ({ ...cookie }));
}

export function refreshAllowed(history, now) {
  return history.filter((at) => now - at < 60_000).length < 3;
}

export function cookieSite(cookie) {
  return typeof cookie?.domain === "string" ? cookie.domain.replace(/^\./, "").toLowerCase() : "";
}

export function pageMatchesCookieSite(url, site) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !!site && (host === site || host.endsWith(`.${site}`));
  } catch {
    return false;
  }
}

export async function pushCookiesToBrowsers(source, browsers, cookies, setCookies, removed = []) {
  await Promise.all([...browsers.entries()].map(async ([profile, entry]) => {
    if (profile === source || !entry.settledOk || entry.stopping || (!cookies.length && !removed.length)) return;
    try {
      await setCookies(entry, cookies, removed);
    } catch {
      // One browser may be closing; the common snapshot still belongs to the source.
    }
  }));
}

function validCookie(cookie) {
  return cookie && typeof cookie === "object" && typeof cookie.name === "string" && cookie.name.length <= 4096
    && typeof cookie.value === "string" && typeof cookie.domain === "string" && typeof cookie.path === "string";
}

export function mergeCookies(current, incoming) {
  const merged = new Map();
  for (const cookie of [...(current ?? []), ...(incoming ?? [])]) {
    if (validCookie(cookie)) merged.set(cookieKey(cookie), { ...cookie });
  }
  return [...merged.values()].slice(-COOKIE_LIMIT);
}

export function sharedLoginPaths(dataDir) {
  const dir = path.join(dataDir, "shared-login");
  return { dir, cookies: path.join(dir, "cookies.json"), state: path.join(dir, "state.json") };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`共享登录数据损坏：${file}`);
  }
}

function atomicWrite(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * Each desktop profile has its own X display and Chromium process. This store is
 * the small common part between them: a cookie snapshot and a first-use marker.
 */
export class SharedLoginStore {
  #paths;
  #queue = Promise.resolve();

  constructor(dataDir) {
    this.#paths = sharedLoginPaths(dataDir);
  }

  get paths() {
    return this.#paths;
  }

  #readCookies() {
    const value = readJson(this.#paths.cookies, { version: STORE_VERSION, cookies: [] });
    if (!value || value.version !== STORE_VERSION || !Array.isArray(value.cookies)) throw new Error(`共享登录 cookie 文件格式不对：${this.#paths.cookies}`);
    return mergeCookies([], value.cookies);
  }

  #readState() {
    const value = readJson(this.#paths.state, { version: STORE_VERSION, profiles: {} });
    if (!value || value.version !== STORE_VERSION || !value.profiles || typeof value.profiles !== "object") throw new Error(`共享登录状态文件格式不对：${this.#paths.state}`);
    return value;
  }

  #write(cookies, state) {
    fs.mkdirSync(this.#paths.dir, { recursive: true, mode: 0o700 });
    atomicWrite(this.#paths.cookies, { version: STORE_VERSION, cookies });
    atomicWrite(this.#paths.state, state);
  }

  #locked(task) {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  snapshot() {
    return this.#readCookies();
  }

  /** Merge a profile's pre-sync cookies once, or after a clean manual handoff, then return the common snapshot. */
  migrateProfile(profile, cookies) {
    return this.#locked(() => {
      const state = this.#readState();
      const known = state.profiles[profile] === true;
      const current = this.#readCookies();
      const currentKeys = new Set(current.map((cookie) => cookieKey(cookie)));
      const incoming = !known ? cookies.filter((cookie) => !currentKeys.has(cookieKey(cookie))) : changedCookies(current, cookies);
      const merged = mergeCookies(current, incoming);
      state.profiles[profile] = true;
      this.#write(merged, state);
      return merged;
    });
  }

  /** Export changes made by a browser after a login or browser operation. */
  syncProfile(profile, cookies, removed = []) {
    return this.#locked(() => {
      const state = this.#readState();
      const current = withoutCookies(this.#readCookies(), removed);
      const merged = mergeCookies(current, cookies);
      state.profiles[profile] = true;
      this.#write(merged, state);
      return merged;
    });
  }
}
