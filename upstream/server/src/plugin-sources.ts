import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pluginConfig, providerDeclarations } from "./plugin-config.ts";
import { proxyEnvironment, type ProxyEnvironmentSettings } from "./network-proxy.ts";

export const OFFICIAL_SOURCE = "official";
export const OFFICIAL_SOURCE_URL = "https://github.com/FFatTiger/hob-plugins";
const FILE_LIMIT = 1024 * 1024;
const SOURCE_LIMIT = 20 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const exec = promisify(execFile);
type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface PluginSource { id: string; url: string; name: string; updatedAt?: string; error?: string }
export interface SourceEntry { id: string; version: string; manifest: Obj; source: string; sourceName: string; path: string; hasProviders?: boolean; error?: string }

function safePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\\") || isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === "..") || /[?#\x00-\x1f]/.test(value)) throw new Error("插件源包含不安全的文件路径");
  return value;
}
function sourceName(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (parsed.pathname.toLowerCase().endsWith(".json")) return parsed.hostname;
      const parts = parsed.pathname.replace(/\/$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
      return parts.length >= 2 ? parts.slice(-2).join("/") : parsed.hostname;
    }
    return parsed.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/, "") || url;
  } catch { return url.split("/").filter(Boolean).at(-1)?.replace(/\.git$/, "") || url; }
}
function isJsonUrl(url: string): boolean {
  try { const parsed = new URL(url); return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.pathname.toLowerCase().endsWith(".json"); } catch { return false; }
}
function checkTree(root: string): void {
  let total = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("插件源不能包含符号链接");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        if (stat.size > FILE_LIMIT) throw new Error(`插件源文件超过 1 MB：${name}`);
        total += stat.size;
        if (total > SOURCE_LIMIT) throw new Error("插件源超过 20 MB");
      } else throw new Error("插件源包含不支持的文件");
    }
  };
  walk(root);
}

/** Cached source snapshots are replaced only after the entire download passes safety checks. */
export class PluginSources {
  private pending = new Map<string, Promise<void>>();
  private attempted = new Map<string, number>();
  isRefreshing(id: string): boolean { return this.pending.has(id); }
  constructor(readonly home: string, private readonly proxy: () => ProxyEnvironmentSettings = () => ({ proxy: "", noProxy: "" }), private readonly officialUrl = OFFICIAL_SOURCE_URL) {}
  private get root() { return join(this.home, "cache", "plugin-sources"); }
  private get statePath() { return join(this.home, "system", "plugin-sources.json"); }
  private dir(id: string) { if (!ID.test(id)) throw new Error("插件源 id 无效"); return join(this.root, id); }
  list(): PluginSource[] {
    const saved = existsSync(this.statePath) ? json(this.statePath) : [];
    if (!Array.isArray(saved) || saved.some(s => !object(s) || typeof s.id !== "string" || !ID.test(s.id) || typeof s.url !== "string" || typeof s.name !== "string")) throw new Error("插件源配置无效");
    const sources = saved as PluginSource[];
    return [{ id: OFFICIAL_SOURCE, name: "Hob 官方", ...sources.find(s => s.id === OFFICIAL_SOURCE), url: this.officialUrl }, ...sources.filter(s => s.id !== OFFICIAL_SOURCE)];
  }
  private save(sources: PluginSource[]): void {
    mkdirSync(join(this.home, "system"), { recursive: true });
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, `${JSON.stringify(sources, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, this.statePath); }
    finally { rmSync(temp, { force: true }); }
  }
  async add(address: string): Promise<PluginSource> {
    const url = address.trim();
    if (!url || url.startsWith("-") || /[\x00-\x1f]/.test(url)) throw new Error("插件源地址无效");
    if (this.list().some(s => s.url.replace(/\/$/, "") === url.replace(/\/$/, ""))) throw new Error("这个源已经添加过了");
    const source: PluginSource = { id: randomUUID(), url, name: sourceName(url) };
    this.save([...this.list(), source]);
    try { await this.refresh(source.id); return this.list().find(s => s.id === source.id)!; }
    catch (error) { this.save(this.list().filter(s => s.id !== source.id)); rmSync(this.dir(source.id), { recursive: true, force: true }); throw error; }
  }
  remove(id: string): void {
    if (id === OFFICIAL_SOURCE) throw new Error("不能移除官方源");
    if (!this.list().some(s => s.id === id)) throw new Error("插件源不存在");
    if (this.pending.has(id)) throw new Error("插件源正在更新，请稍后再试");
    this.save(this.list().filter(s => s.id !== id));
    rmSync(this.dir(id), { recursive: true, force: true });
  }
  async open(): Promise<void> {
    await Promise.all(this.list().map(async source => {
      const hasCache = existsSync(join(this.dir(source.id), "index.json"));
      const retryDue = !source.error || Date.now() - (this.attempted.get(source.id) ?? 0) > 60_000;
      if (!hasCache && this.pending.has(source.id)) await this.pending.get(source.id)!.catch(() => {});
      else if (!hasCache && retryDue) await this.refresh(source.id).catch(() => {});
      else if (hasCache && retryDue && (!source.updatedAt || Date.now() - Date.parse(source.updatedAt) > 3600_000)) void this.refresh(source.id).catch(() => {});
    }));
  }
  refresh(id: string): Promise<void> {
    const existing = this.pending.get(id);
    if (existing) return existing;
    this.attempted.set(id, Date.now());
    const promise = this.pull(id).finally(() => this.pending.delete(id));
    this.pending.set(id, promise);
    return promise;
  }
  private async pull(id: string): Promise<void> {
    const source = this.list().find(s => s.id === id);
    if (!source) throw new Error("插件源不存在");
    mkdirSync(this.root, { recursive: true });
    const temp = join(this.root, `${id}-${randomUUID()}.tmp`);
    const backup = join(this.root, `${id}-${randomUUID()}.bak`);
    try {
      if (isJsonUrl(source.url)) await this.downloadJson(source.url, temp);
      else {
        const hash = source.url.indexOf("#");
        const url = hash < 0 ? source.url : source.url.slice(0, hash);
        const branch = hash < 0 ? "" : source.url.slice(hash + 1);
        if (!url || url.startsWith("-") || (hash >= 0 && (!branch || branch.startsWith("-")))) throw new Error("仓库地址或分支无效");
        try {
          await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "clone", "--depth", "1", ...(branch ? ["--branch", branch] : []), "--", url, temp], { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...proxyEnvironment(process.env, this.proxy()), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("这台机器没有装 git，可以改填索引 JSON 的地址");
          throw new Error(`git 拉取失败：${reason(error)}`);
        }
        rmSync(join(temp, ".git"), { recursive: true, force: true });
      }
      checkTree(temp);
      const index = json(join(temp, "index.json"));
      if (!object(index) || !Array.isArray(index.plugins)) throw new Error("插件源索引无效");
      for (const item of index.plugins) if (object(item) && item.path !== undefined) safePath(item.path);
      const dir = this.dir(id);
      let moved = false;
      if (existsSync(dir)) { renameSync(dir, backup); moved = true; }
      try { renameSync(temp, dir); } catch (error) { if (moved) renameSync(backup, dir); throw error; }
      rmSync(backup, { recursive: true, force: true });
      this.save(this.list().map(s => s.id === id ? { ...s, name: id === OFFICIAL_SOURCE ? "Hob 官方" : typeof index.name === "string" && index.name.trim() ? index.name.trim() : sourceName(s.url), updatedAt: new Date().toISOString(), error: undefined } : s));
    } catch (error) {
      this.save(this.list().map(s => s.id === id ? { ...s, error: reason(error) } : s));
      throw error;
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  private async downloadJson(address: string, dir: string): Promise<void> {
    let total = 0;
    const download = async (url: string) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}：${url}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("响应没有内容");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; total += value.length;
          if (size > FILE_LIMIT) throw new Error("插件源文件超过 1 MB");
          if (total > SOURCE_LIMIT) throw new Error("插件源超过 20 MB");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return Buffer.concat(chunks);
    };
    mkdirSync(dir, { recursive: true });
    const indexBytes = await download(address);
    const index: unknown = JSON.parse(indexBytes.toString("utf8"));
    if (!object(index) || !Array.isArray(index.plugins)) throw new Error("插件源索引无效");
    writeFileSync(join(dir, "index.json"), indexBytes);
    for (const item of index.plugins) {
      if (!object(item) || typeof item.path !== "string") continue;
      const path = safePath(item.path);
      const files = item.files === undefined ? ["plugin.json", "mcp.json"] : Array.isArray(item.files) ? item.files.map(safePath) : [];
      if (!files.includes("plugin.json")) files.unshift("plugin.json");
      if (!files.includes("mcp.json")) files.push("mcp.json");
      for (let i = 0; i < files.length; i++) {
        const file = safePath(files[i]);
        const url = new URL(`${path.split("/").map(encodeURIComponent).join("/")}/${file.split("/").map(encodeURIComponent).join("/")}`, address).toString();
        try {
          const bytes = await download(url);
          const target = join(dir, path, file); mkdirSync(resolve(target, ".."), { recursive: true }); writeFileSync(target, bytes);
          if (item.files === undefined && file === "plugin.json") {
            const manifest: unknown = JSON.parse(bytes.toString("utf8"));
            const extensions = object(manifest) ? manifest.extensions : undefined;
            const hob = object(extensions) ? extensions["com.hob.plugins"] : undefined;
            if (object(hob) && typeof hob.icon === "string") files.push(safePath(hob.icon));
          }
        } catch (error) {
          if (/超过|不安全/.test(reason(error))) throw error;
          // Missing or malformed plugin files are reported by catalog() for this entry.
        }
      }
    }
  }
  catalog(): SourceEntry[] {
    const entries: SourceEntry[] = [];
    for (const source of this.list()) {
      const root = this.dir(source.id);
      if (!existsSync(join(root, "index.json"))) continue;
      const index = json(join(root, "index.json"));
      if (!object(index) || !Array.isArray(index.plugins)) throw new Error(`插件源「${source.name}」索引无效`);
      for (const item of index.plugins) {
        const id = object(item) && typeof item.id === "string" ? item.id : "";
        let path = "";
        try {
          if (!ID.test(id)) throw new Error("插件 id 无效");
          path = safePath(object(item) ? item.path : undefined);
          const dir = resolve(root, path);
          if (!dir.startsWith(root + sep)) throw new Error("插件路径无效");
          const manifest = json(join(dir, "plugin.json"));
          const mcpPath = join(dir, "mcp.json");
          const providers = providerDeclarations(manifest);
          const mcp = existsSync(mcpPath) ? json(mcpPath) : providers.length > 0 ? { mcpServers: {} } : (() => { throw new Error("缺少 mcp.json"); })();
          if (!object(manifest) || typeof manifest.version !== "string" || !manifest.version) throw new Error("插件清单缺少版本");
          pluginConfig(manifest, mcp);
          entries.push({ id, version: manifest.version, manifest, source: source.id, sourceName: source.name, path: dir, ...(providers.length > 0 ? { hasProviders: true } : {}) });
        } catch (error) { entries.push({ id, version: "", manifest: {}, source: source.id, sourceName: source.name, path: "", error: reason(error) }); }
      }
    }
    return entries;
  }
}
