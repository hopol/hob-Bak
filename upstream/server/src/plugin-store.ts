import { validateMcpEntry, mcpConfigPath } from "./mcp.ts";
import { newerPluginVersion } from "../../shared/plugin-version.ts";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { PluginSources, OFFICIAL_SOURCE } from "./plugin-sources.ts";
import type { ProxyEnvironmentSettings } from "./network-proxy.ts";
import { binDeclaration, diffCapabilities, pluginCapabilities, pluginConfig, profileDeclaration, providerDeclarations, validatePluginValues, type PluginCapabilitySnapshot, type PluginConfig, type PluginConfigValue } from "./plugin-config.ts";
import { readSecrets, writeSecret } from "./secrets.ts";
import { systemDir } from "./config.ts";
import { markDefaultPluginUninstalled } from "./dev-team.ts";

export interface PluginProfile {
  id: string;
  name: string;
  config: Record<string, PluginConfigValue>;
}
export interface InstalledPlugin {
  id: string;
  version: string;
  source: string;
  sourceName?: string;
  enabled: boolean;
  assistants?: string[];
  tools: Record<string, { enabled?: boolean }>;
  config?: Record<string, PluginConfigValue>;
  profiles?: PluginProfile[];
  legacyMcp?: boolean;
  /** 旧 MCP 配置中通过命令求值的敏感项。 */
  secretCommands?: string[];
  /** 已确认的能力快照；更新后能力变化时需重新确认。 */
  approvedCapabilities?: PluginCapabilitySnapshot;
  /** 更新后能力变化，等待用户重新确认。 */
  needsApproval?: boolean;
  capabilityChanges?: string[];
  /** 上次更新失败原因，保留旧插件继续运行。 */
  updateError?: string;
}
type Document = { plugins: InstalledPlugin[] };
type Obj = Record<string, unknown>;
const validId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const BUILTIN_SOURCE = "builtin";
const secretPrefix = (id: string) => `plugin:${id}:config:`;
const profileSecretPrefix = (id: string, profileId: string) => `plugin:${id}:profile:${profileId}:config:`;
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);

/** Plugin files and user state are independent: updating files preserves settings. */
export class PluginStore {
  readonly sources: PluginSources;
  constructor(readonly home: string, proxy?: () => ProxyEnvironmentSettings, officialUrl?: string) { this.sources = new PluginSources(home, proxy, officialUrl); }
  private get path(): string { return join(systemDir(this.home), "plugins.json"); }
  private dir(id: string): string {
    if (!validId.test(id)) throw new Error(`插件 id 无效：${id}`);
    return join(this.home, "plugins", id);
  }
  private builtinRoot(): string { return fileURLToPath(new URL("../mcp/vault", import.meta.url)); }
  private builtinCatalog(): { id: string; version: string; manifest: Obj; source: string; sourceName: string; path: string; error?: string }[] {
    const path = this.builtinRoot();
    try {
      const manifest = readJson(join(path, "plugin.json"));
      const mcp = readJson(join(path, "mcp.json"));
      if (!object(manifest) || typeof manifest.version !== "string") return [];
      pluginConfig(manifest, mcp);
      return [{ id: "vault", version: manifest.version, manifest, source: BUILTIN_SOURCE, sourceName: "Hob 自带", path }];
    } catch { return []; }
  }
  private builtinEntry(id: string) { return this.builtinCatalog().find(entry => entry.id === id); }
  private read(): Document {
    if (!existsSync(this.path)) return { plugins: [] };
    const value = readJson(this.path);
    if (!object(value) || !Array.isArray(value.plugins)) throw new Error("plugins.json 格式无效");
    const ids = new Set<string>();
    for (const p of value.plugins) {
      if (!object(p) || typeof p.id !== "string" || !validId.test(p.id) || ids.has(p.id) || typeof p.version !== "string" || typeof p.source !== "string" || !validId.test(p.source) || typeof p.enabled !== "boolean" || (!object(p.config) && !Array.isArray(p.profiles)) || (p.config !== undefined && !object(p.config)) || (p.profiles !== undefined && (!Array.isArray(p.profiles) || p.profiles.some(profile => !object(profile) || typeof profile.id !== "string" || typeof profile.name !== "string" || !object(profile.config)))) || !object(p.tools)) throw new Error("plugins.json 中的插件条目无效");
      ids.add(p.id);
    }
    return value as unknown as Document;
  }
  private write(doc: Document): void {
    mkdirSync(systemDir(this.home), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
  }
  list(): InstalledPlugin[] { return this.read().plugins; }
  get(id: string): InstalledPlugin {
    this.dir(id);
    const plugin = this.list().find(p => p.id === id);
    if (!plugin) throw new Error(`插件 ${id} 未安装`);
    return plugin;
  }
  files(id: string): { manifest: Obj; mcp: Obj; config: PluginConfig } {
    const dir = this.dir(id);
    const manifest = readJson(join(dir, "plugin.json"));
    if (!object(manifest)) throw new Error(`插件 ${id} 清单无效`);
    const providers = providerDeclarations(manifest);
    const mcpPath = join(dir, "mcp.json");
    const mcp = existsSync(mcpPath) ? readJson(mcpPath) : providers.length > 0 ? { mcpServers: {} } : undefined;
    if (!object(mcp)) throw new Error(`插件 ${id} 清单无效`);
    return { manifest, mcp, config: pluginConfig(manifest, mcp) };
  }
  providersOf(id: string) {
    return providerDeclarations(this.files(id).manifest);
  }
  pluginDir(id: string): string {
    return this.dir(id);
  }
  binDir(id: string): string | null {
    try {
      const { manifest } = this.files(id);
      const rel = binDeclaration(manifest);
      if (!rel) return null;
      const root = realpathSync(this.dir(id));
      const target = resolve(root, rel);
      if (!existsSync(target) || lstatSync(target).isSymbolicLink()) return null;
      const actual = realpathSync(target);
      const checked = relative(root, actual);
      if (!checked || checked === ".." || checked.startsWith(`..${sep}`) || isAbsolute(checked)) return null;
      if (!statSync(actual).isDirectory()) return null;
      return actual;
    } catch {
      return null;
    }
  }
  skills(id: string): string[] {
    this.get(id);
    const dir = join(this.dir(id), "skills");
    if (!existsSync(dir)) return [];
    if (lstatSync(dir).isSymbolicLink()) throw new Error("插件技能目录不能是符号链接");
    return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md"))).map(entry => entry.name);
  }
  icon(id: string, sourceId?: string): { content: Buffer; type: string } | null {
    const installed = this.list().some(p => p.id === id) && !sourceId;
    const catalogEntry = installed ? undefined : this.catalog().find(p => p.id === id && (!sourceId || p.source === sourceId));
    const entry = installed ? this.files(id).manifest : catalogEntry?.manifest;
    if (!entry) throw new Error("插件不存在");
    const extensions = entry.extensions;
    const hob = object(extensions) ? extensions["com.hob.plugins"] : undefined;
    const icon = object(hob) ? hob.icon : undefined;
    if (typeof icon !== "string" || !/\.(svg|png|jpg|jpeg|webp)$/i.test(icon) || isAbsolute(icon)) return null;
    const root = installed ? this.dir(id) : catalogEntry!.path;
    const path = resolve(root, icon);
    if (!existsSync(path)) return null;
    const actual = realpathSync(path);
    const rel = relative(realpathSync(root), actual);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(actual).isFile()) return null;
    const lower = icon.toLowerCase();
    const type = lower.endsWith(".svg") ? "image/svg+xml" : lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg";
    return { content: readFileSync(actual), type };
  }
  catalog() { return [...this.builtinCatalog(), ...this.sources.catalog()]; }
  /** Copy an official plugin source to an isolated staging directory before provider dependencies are installed. */
  prepareProviderDirectory(id: string, update = false, sourceId?: string): string {
    const installed = this.list().find((plugin) => plugin.id === id);
    const wanted = update ? installed?.source : (sourceId ?? (id === "vault" ? BUILTIN_SOURCE : OFFICIAL_SOURCE));
    const entry = wanted === BUILTIN_SOURCE ? this.builtinEntry(id) : this.catalog().find((item) => item.id === id && item.source === wanted);
    if (!entry) throw new Error(`插件源没有插件 ${id}`);
    if (entry.error) throw new Error(entry.error);
    if (update && installed?.source === "custom") throw new Error("自定义插件不能从插件源更新");
    if (update && !installed) throw new Error(`插件 ${id} 未安装`);
    if (!update && installed) throw new Error(`插件 ${id} 已安装`);
    const staging = join(this.home, `.plugin-stage-${randomUUID()}`);
    try {
      cpSync(entry.path, staging, { recursive: true, errorOnExist: true });
      return staging;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  install(id: string, update = false, force = false, sourceId?: string, preparedSource?: string): InstalledPlugin {
    const doc = this.read();
    const old = doc.plugins.find(p => p.id === id);
    const wanted = update ? old?.source : (sourceId ?? (id === "vault" ? BUILTIN_SOURCE : OFFICIAL_SOURCE));
    if (old && update && old.source === "custom") throw new Error("自定义插件不能从插件源更新");
    const entry = wanted === BUILTIN_SOURCE ? this.builtinEntry(id) : this.catalog().find(item => item.id === id && item.source === wanted);
    if (!entry) throw new Error(`插件源没有插件 ${id}`);
    if (entry.error) throw new Error(entry.error);
    const source = preparedSource ?? entry.path;
    const manifest = readJson(join(source, "plugin.json"));
    const providers = providerDeclarations(manifest);
    const mcpPath = join(source, "mcp.json");
    const mcp = existsSync(mcpPath) ? readJson(mcpPath) : providers.length > 0 ? { mcpServers: {} } : (() => { throw new Error(`插件 ${id} 缺少 mcp.json`); })();
    const definitions = pluginConfig(manifest, mcp);
    if (old && !update && old.source !== wanted) {
      const installedManifest = this.files(id).manifest;
      const name = typeof installedManifest.displayName === "string" ? installedManifest.displayName : typeof installedManifest.name === "string" ? installedManifest.name : id;
      throw new Error(`已经装了来自「${old.sourceName ?? this.sources.list().find(s => s.id === old.source)?.name ?? old.source}」的 ${name}，先卸载它再装这个`);
    }
    if (old && !update) throw new Error(`插件 ${id} 已安装`);
    if (!old && update) throw new Error(`插件 ${id} 未安装`);
    if (old && !force && !newerPluginVersion(entry.version, old.version)) return old;
    const nextCapabilities = pluginCapabilities(manifest, mcp);
    let previousCapabilities = old?.approvedCapabilities;
    if (old && !previousCapabilities) {
      try {
        const prev = this.files(id);
        previousCapabilities = pluginCapabilities(prev.manifest, prev.mcp);
      } catch { /* fallback */ }
    }
    const capabilityChanges = old && previousCapabilities ? diffCapabilities(previousCapabilities, nextCapabilities) : [];
    const declaration = profileDeclaration(manifest);
    const next: InstalledPlugin = old
      ? {
          ...old,
          version: entry.version,
          sourceName: entry.sourceName,
          ...(capabilityChanges.length
            ? { enabled: false, needsApproval: true, capabilityChanges, approvedCapabilities: previousCapabilities }
            : { approvedCapabilities: nextCapabilities, needsApproval: undefined, capabilityChanges: undefined }),
        }
      : { id, version: entry.version, source: entry.source, sourceName: entry.sourceName, enabled: true, tools: {}, approvedCapabilities: nextCapabilities };
    if (old) delete next.updateError;
    if (!next.needsApproval) { delete next.needsApproval; delete next.capabilityChanges; }
    if (declaration) {
      if (old && !next.profiles) {
        const profile: PluginProfile = { id: randomUUID(), name: declaration.title ?? "配置", config: {} };
        for (const [key, value] of Object.entries(next.config ?? {})) profile.config[key] = value;
        next.profiles = [profile];
        delete next.config;
      } else if (!next.profiles) next.profiles = [];
    } else next.config ??= {};
    const secrets = readSecrets(this.home);
    const secretChanges: { key: string; before?: string; after: string }[] = [];
    for (const [key, field] of Object.entries(definitions)) {
      if (declaration && next.profiles?.length) {
        const profile = next.profiles[0];
        const oldKey = secretPrefix(id) + key;
        const newKey = profileSecretPrefix(id, profile.id) + key;
        if (field.sensitive && Object.hasOwn(profile.config, key)) {
          secretChanges.push({ key: newKey, before: secrets[newKey], after: JSON.stringify(profile.config[key]) });
          delete profile.config[key];
        } else if (field.sensitive && secrets[oldKey] !== undefined && secrets[newKey] === undefined) {
          secretChanges.push({ key: newKey, before: secrets[newKey], after: secrets[oldKey] });
          secretChanges.push({ key: oldKey, before: secrets[oldKey], after: "" });
        }
      } else if (!declaration) {
        next.config ??= {};
        const name = secretPrefix(id) + key;
        if (field.sensitive && Object.hasOwn(next.config, key)) {
          secretChanges.push({ key: name, before: secrets[name], after: JSON.stringify(next.config[key]) });
          delete next.config[key];
        } else if (!field.sensitive && secrets[name] !== undefined && !Object.hasOwn(next.config, key)) {
          next.config[key] = JSON.parse(secrets[name]) as PluginConfigValue;
          secretChanges.push({ key: name, before: secrets[name], after: "" });
        }
      }
    }
    const dir = this.dir(id);
    mkdirSync(join(this.home, "plugins"), { recursive: true });
    const temp = `${dir}.${randomUUID()}.tmp`;
    const backup = `${dir}.${randomUUID()}.bak`;
    let moved = false;
    try {
      cpSync(source, temp, { recursive: true, errorOnExist: true });
      this.ensureBinExecutable(temp, manifest);
      if (existsSync(dir)) { renameSync(dir, backup); moved = true; }
      try {
        renameSync(temp, dir);
        for (const change of secretChanges) writeSecret(this.home, change.key, change.after);
        this.write({ plugins: [...doc.plugins.filter(p => p.id !== id), next] });
      } catch (error) {
        for (const change of secretChanges) writeSecret(this.home, change.key, change.before ?? "");
        rmSync(dir, { recursive: true, force: true });
        if (moved) renameSync(backup, dir);
        throw error;
      }
      rmSync(backup, { recursive: true, force: true });
    } finally { rmSync(temp, { recursive: true, force: true }); }
    return next;
  }
  private ensureBinExecutable(rootDir: string, manifest: unknown): void {
    const binRel = binDeclaration(manifest);
    if (!binRel) return;
    const root = realpathSync(rootDir);
    const binTarget = resolve(root, binRel);
    if (!existsSync(binTarget) || lstatSync(binTarget).isSymbolicLink()) return;
    const actualBin = realpathSync(binTarget);
    const checked = relative(root, actualBin);
    if (!checked || checked === ".." || checked.startsWith(`..${sep}`) || isAbsolute(checked) || !statSync(actualBin).isDirectory()) return;
    for (const entry of readdirSync(actualBin)) {
      const entryPath = join(actualBin, entry);
      const stat = lstatSync(entryPath);
      if (!stat.isSymbolicLink() && stat.isFile()) {
        const mode = stat.mode & 0o777;
        chmodSync(entryPath, mode | ((mode & 0o444) >> 2));
      }
    }
  }
  /** Install a bundled default plugin from a local directory while recording its source as official. */
  installBundled(id: string, sourceDir: string): InstalledPlugin {
    const doc = this.read();
    const existing = doc.plugins.find(p => p.id === id);
    if (existing) return existing;
    const manifest = readJson(join(sourceDir, "plugin.json"));
    if (!object(manifest) || typeof manifest.version !== "string" || !manifest.version) throw new Error(`插件 ${id} 清单无效`);
    const providers = providerDeclarations(manifest);
    const mcpPath = join(sourceDir, "mcp.json");
    const mcp = existsSync(mcpPath) ? readJson(mcpPath) : providers.length > 0 ? { mcpServers: {} } : (() => { throw new Error(`插件 ${id} 缺少 mcp.json`); })();
    pluginConfig(manifest, mcp);
    const nextCapabilities = pluginCapabilities(manifest, mcp);
    const declaration = profileDeclaration(manifest);
    const next: InstalledPlugin = {
      id,
      version: manifest.version,
      source: OFFICIAL_SOURCE,
      sourceName: "Hob 官方",
      enabled: true,
      tools: {},
      approvedCapabilities: nextCapabilities,
      ...(declaration ? { profiles: [] } : { config: {} }),
    };
    const dir = this.dir(id);
    mkdirSync(join(this.home, "plugins"), { recursive: true });
    const temp = `${dir}.${randomUUID()}.tmp`;
    try {
      cpSync(sourceDir, temp, { recursive: true, errorOnExist: true });
      this.ensureBinExecutable(temp, manifest);
      renameSync(temp, dir);
      try {
        this.write({ plugins: [...doc.plugins, next] });
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    return next;
  }
  /** Adds a custom MCP server without storing header or environment values in its files. */
  addCustom(id: string, raw: unknown, legacyMcp = false): InstalledPlugin {
    this.dir(id);
    const valid = validateMcpEntry(id, raw);
    if (!valid.valid) throw new Error(valid.reason);
    if (!object(raw)) throw new Error("MCP 服务必须是对象");
    const doc = this.read();
    if (doc.plugins.some(p => p.id === id)) throw new Error(`插件 ${id} 已安装`);
    const entry = structuredClone(raw);
    const config: Record<string, unknown> = Object.create(null);
    const values: Record<string, PluginConfigValue> = Object.create(null);
    const secretCommands: string[] = [];
    let counter = 0;
    for (const field of ["headers", "env"]) {
      const entries = entry[field];
      if (!object(entries)) continue;
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value !== "string") throw new Error(`${field}.${key} 必须是字符串`);
        const reference = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value);
        if (reference) { entries[key] = `\${${reference[1] ?? reference[2]}}`; continue; }
        const name = `HOB_CUSTOM_SECRET_${++counter}`;
        if (value.startsWith("!")) secretCommands.push(name);
        config[name] = { type: "string", title: key, required: true, sensitive: true };
        values[name] = value;
        entries[key] = `\${user_config.${name}}`;
      }
    }
    if (object(entry.oauth) && typeof entry.oauth.clientSecret === "string" && !entry.oauth.clientSecret.includes("${")) {
      const name = `HOB_CUSTOM_SECRET_${++counter}`;
      config[name] = { type: "string", title: "OAuth client secret", sensitive: true };
      values[name] = entry.oauth.clientSecret;
      entry.oauth.clientSecret = `\${user_config.${name}}`;
    }
    // 提供方式由插件的工具数量自动决定，旧配置里的 exposure 不再迁移；隐藏的工具迁成关掉
    const tools: InstalledPlugin["tools"] = Object.create(null);
    for (const [name, mode] of Object.entries(valid.entry.toolExposure ?? {})) if (mode === "hidden") tools[name] = { enabled: false };
    delete entry.enabled; delete entry.exposure; delete entry.toolExposure;
    const manifest = { name: id, version: "1.0.0", userConfig: config };
    const mcp = { mcpServers: { [id]: entry } };
    const definitions = pluginConfig(manifest, mcp);
    if (!legacyMcp) for (const [name, field] of Object.entries(definitions)) if (field.sensitive && values[name] === undefined && process.env[name] !== undefined) values[name] = process.env[name]!;
    const plugin: InstalledPlugin = { id, version: "1.0.0", source: "custom", enabled: valid.entry.enabled, tools, config: {}, ...(legacyMcp ? { legacyMcp: true } : {}), ...(secretCommands.length ? { secretCommands } : {}) };
    const dir = this.dir(id);
    if (existsSync(dir)) throw new Error(`插件目录 ${id} 已存在`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      writeFileSync(join(dir, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 });
      for (const [name, value] of Object.entries(values)) writeSecret(this.home, secretPrefix(id) + name, JSON.stringify(value));
      this.write({ plugins: [...doc.plugins, plugin] });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      for (const name of Object.keys(values)) writeSecret(this.home, secretPrefix(id) + name, "");
      throw error;
    }
    return plugin;
  }
  /** Copy valid entries independently; preserve the original until every entry is handled. */
  migrateLegacy(): string[] {
    const path = mcpConfigPath(this.home);
    if (!existsSync(path)) return [];
    const backup = `${path}.bak`;
    const doc = readJson(path);
    if (!object(doc) || (doc.mcpServers !== undefined && !object(doc.mcpServers))) throw new Error("mcp.json 格式无效");
    const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
    const errors: string[] = [];
    for (const [id, entry] of Object.entries(servers)) {
      try {
        const existing = this.list().find(p => p.id === id);
        if (existing) {
          if (!existing.legacyMcp) throw new Error(`插件 ${id} 已存在`);
          continue;
        }
        const checked = validateMcpEntry(id, entry);
        if (!checked.valid) throw new Error(checked.reason);
        const dir = this.dir(id);
        // 中断的迁移可能已建目录但还没登记；保留原目录，重新复制这一项。
        if (existsSync(dir)) renameSync(dir, `${dir}.interrupted-${randomUUID()}`);
        this.addCustom(id, entry, true);
      } catch (error) {
        errors.push(`${id}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (existsSync(backup)) errors.push("MCP 迁移备份已存在，无法覆盖");
    if (!errors.length) renameSync(path, backup);
    return [...errors, ...this.migrateProfiles()];
  }
  /** Update the old bundled email service path without changing custom servers. */
  migrateEmailService(): void {
    const plugin = this.list().find(item => item.id === "email" && item.source !== "custom");
    if (!plugin) return;
    const path = join(this.dir("email"), "mcp.json");
    const mcp = readJson(path);
    if (!object(mcp) || !object(mcp.mcpServers) || !object(mcp.mcpServers.email) || !Array.isArray(mcp.mcpServers.email.args)) return;
    const args = mcp.mcpServers.email.args;
    const oldPath = "${hob.root}/server/plugins/email/server.mjs";
    if (!args.includes(oldPath)) return;
    mcp.mcpServers.email.args = args.map(arg => arg === oldPath ? "${hob.root}/server/mcp/email.mjs" : arg);
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
  migrateProfiles(): string[] {
    const doc = this.read();
    const errors: string[] = [];
    let changed = false;
    const secrets = readSecrets(this.home);
    for (const plugin of doc.plugins) {
      try {
        const { manifest } = this.files(plugin.id);
        const declaration = profileDeclaration(manifest);
        if (!declaration || plugin.profiles) continue;
        const profile: PluginProfile = { id: randomUUID(), name: declaration.title ?? "配置", config: {} };
        for (const [key, value] of Object.entries(plugin.config ?? {})) profile.config[key] = value;
        const config = this.files(plugin.id).config;
        for (const [key, field] of Object.entries(config)) if (field.sensitive) {
          const oldKey = secretPrefix(plugin.id) + key;
          const newKey = profileSecretPrefix(plugin.id, profile.id) + key;
          if (secrets[oldKey] !== undefined) {
            writeSecret(this.home, newKey, secrets[oldKey]);
            writeSecret(this.home, oldKey, "");
          }
          delete profile.config[key];
        }
        plugin.profiles = [profile];
        delete plugin.config;
        changed = true;
      } catch (error) { errors.push(`${plugin.id}：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (changed) this.write(doc);
    return errors;
  }
  remove(id: string): void {
    const doc = this.read();
    if (!doc.plugins.some(p => p.id === id)) throw new Error(`插件 ${id} 未安装`);
    this.write({ plugins: doc.plugins.filter(p => p.id !== id) });
    rmSync(this.dir(id), { recursive: true, force: true });
    for (const key of Object.keys(readSecrets(this.home))) if (key.startsWith(`plugin:${id}:`)) writeSecret(this.home, key, "");
    markDefaultPluginUninstalled(this.home, id);
  }
  private profile(id: string, profileId: string): { plugin: InstalledPlugin; profile: PluginProfile; config: PluginConfig } {
    const plugin = this.get(id);
    const profile = plugin.profiles?.find(item => item.id === profileId);
    if (!profile) throw new Error(`配置 ${profileId} 不存在`);
    return { plugin, profile, config: this.files(id).config };
  }
  profileDeclaration(id: string) { return profileDeclaration(this.files(id).manifest); }
  private profileValues(id: string, profile: PluginProfile): Record<string, PluginConfigValue> {
    const { config, manifest } = this.files(id);
    const declarations = object(manifest.userConfig) ? manifest.userConfig : {};
    const secrets = readSecrets(this.home);
    const values: Record<string, PluginConfigValue> = Object.create(null);
    for (const [key, value] of Object.entries(profile.config)) if (Object.hasOwn(config, key) && !config[key].sensitive) values[key] = value;
    for (const [key, field] of Object.entries(config)) if (field.sensitive) {
      const encoded = secrets[profileSecretPrefix(id, profile.id) + key];
      if (encoded !== undefined) values[key] = JSON.parse(encoded) as PluginConfigValue;
    }
    for (const [key, field] of Object.entries(config)) if (!Object.hasOwn(values, key) && field.default !== undefined) values[key] = field.default;
    for (const [key, value] of Object.entries(values)) if (!Object.hasOwn(declarations, key) && !Object.hasOwn(config, key)) delete values[key];
    return values;
  }
  completeProfiles(id: string): { name: string; config: Record<string, unknown> }[] {
    const plugin = this.get(id);
    const { config } = this.files(id);
    return (plugin.profiles ?? []).flatMap(profile => {
      const values = this.profileValues(id, profile);
      return validatePluginValues(config, values).length ? [] : [{ name: profile.name, config: values }];
    });
  }
  profileMissing(id: string, profileId: string): string[] {
    const { profile, config } = this.profile(id, profileId);
    return validatePluginValues(config, this.profileValues(id, profile));
  }
  values(id: string): Record<string, PluginConfigValue> {
    const plugin = this.get(id);
    if (plugin.profiles) throw new Error("支持多个 profile 的插件请先选择配置");
    const { config, manifest } = this.files(id);
    const declarations = object(manifest.userConfig) ? manifest.userConfig : {};
    const secrets = readSecrets(this.home);
    const values: Record<string, PluginConfigValue> = Object.create(null);
    for (const [key, value] of Object.entries(plugin.config ?? {})) if (Object.hasOwn(config, key) && !config[key].sensitive) values[key] = value;
    for (const [key, field] of Object.entries(config)) {
      if (plugin.legacyMcp && !Object.hasOwn(declarations, key)) {
        if (process.env[key] !== undefined) values[key] = process.env[key]!;
        continue;
      }
      if (!field.sensitive) continue;
      const encoded = secrets[secretPrefix(id) + key];
      if (encoded !== undefined) values[key] = JSON.parse(encoded) as PluginConfigValue;
    }
    return values;
  }
  saveConfig(id: string, changes: Record<string, unknown>): boolean {
    const doc = this.read();
    const plugin = doc.plugins.find(p => p.id === id);
    if (!plugin) throw new Error(`插件 ${id} 未安装`);
    if (plugin.profiles) {
      if (plugin.profiles.length > 1) throw new Error("支持多个 profile 的插件请先选择配置");
      if (!plugin.profiles.length) {
        plugin.profiles.push({ id: randomUUID(), name: this.profileDeclaration(id)?.title ?? "配置", config: {} });
        this.write(doc);
      }
      return this.saveProfileConfig(id, plugin.profiles[0].id, changes);
    }
    const { config } = this.files(id);
    const values = this.values(id);
    const before = { ...values };
    for (const [key, value] of Object.entries(changes)) {
      if (!Object.hasOwn(config, key)) throw new Error(`未声明的配置项 ${key}`);
      if (value === null) delete values[key];
      else values[key] = value as PluginConfigValue;
    }
    validatePluginValues(config, values);
    const changed = Object.keys(config).some(key => JSON.stringify(before[key]) !== JSON.stringify(values[key])) || (plugin.secretCommands ?? []).some(key => Object.hasOwn(changes, key));
    if (!changed) return false;
    if (plugin.secretCommands) plugin.secretCommands = plugin.secretCommands.filter(key => !Object.hasOwn(changes, key));
    plugin.config ??= {};
    for (const [key, value] of Object.entries(changes)) {
      if (config[key].sensitive) {
        writeSecret(this.home, secretPrefix(id) + key, value === null ? "" : JSON.stringify(value));
        delete plugin.config[key];
      } else if (value === null) delete plugin.config[key];
      else plugin.config[key] = value as PluginConfigValue;
    }
    this.write(doc);
    return true;
  }
  saveProfileConfig(id: string, profileId: string, changes: Record<string, unknown>): boolean {
    const doc = this.read();
    const plugin = doc.plugins.find(item => item.id === id);
    if (!plugin) throw new Error(`插件 ${id} 未安装`);
    const profile = plugin.profiles?.find(item => item.id === profileId);
    if (!profile) throw new Error(`配置 ${profileId} 不存在`);
    const config = this.files(id).config;
    const values = this.profileValues(id, profile);
    const before = { ...values };
    for (const [key, value] of Object.entries(changes)) {
      if (!Object.hasOwn(config, key)) throw new Error(`未声明的配置项 ${key}`);
      if (value === null) delete values[key]; else values[key] = value as PluginConfigValue;
    }
    validatePluginValues(config, values);
    const changed = Object.keys(config).some(key => JSON.stringify(before[key]) !== JSON.stringify(values[key]));
    if (!changed) return false;
    for (const [key, value] of Object.entries(changes)) {
      if (config[key].sensitive) {
        writeSecret(this.home, profileSecretPrefix(id, profileId) + key, value === null ? "" : JSON.stringify(value));
        delete profile.config[key];
      } else if (value === null) delete profile.config[key];
      else profile.config[key] = value as PluginConfigValue;
    }
    this.write(doc);
    return true;
  }
  addProfile(id: string, name: string): PluginProfile {
    const doc = this.read();
    const plugin = doc.plugins.find(item => item.id === id);
    if (!plugin) throw new Error(`插件 ${id} 未安装`);
    if (!this.profileDeclaration(id)) throw new Error("这个插件不支持多份配置");
    name = name.trim();
    if (!name) throw new Error("名称不能为空");
    if ((plugin.profiles ?? []).some(profile => profile.name === name)) throw new Error(`已经有叫「${name}」的配置了`);
    const profile = { id: randomUUID(), name, config: {} };
    (plugin.profiles ??= []).push(profile);
    this.write(doc);
    return profile;
  }
  renameProfile(id: string, profileId: string, name: string): void {
    const doc = this.read();
    const plugin = doc.plugins.find(item => item.id === id);
    if (!plugin) throw new Error(`插件 ${id} 未安装`);
    const profile = plugin.profiles?.find(item => item.id === profileId);
    if (!profile) throw new Error(`配置 ${profileId} 不存在`);
    name = name.trim();
    if (!name) throw new Error("名称不能为空");
    if ((plugin.profiles ?? []).some(item => item.id !== profileId && item.name === name)) throw new Error(`已经有叫「${name}」的配置了`);
    profile.name = name;
    this.write(doc);
  }
  deleteProfile(id: string, profileId: string): void {
    const doc = this.read();
    const plugin = doc.plugins.find(item => item.id === id);
    if (!plugin) throw new Error(`插件 ${id} 未安装`);
    if (!plugin.profiles?.some(profile => profile.id === profileId)) throw new Error(`配置 ${profileId} 不存在`);
    plugin.profiles = plugin.profiles.filter(profile => profile.id !== profileId);
    for (const key of Object.keys(readSecrets(this.home))) if (key.startsWith(profileSecretPrefix(id, profileId))) writeSecret(this.home, key, "");
    this.write(doc);
  }
  recordUpdateError(id: string, message: string): void {
    const doc = this.read();
    const plugin = doc.plugins.find(item => item.id === id);
    if (!plugin) throw new Error(`插件 ${id} 未安装`);
    plugin.updateError = message.slice(0, 1000);
    this.write(doc);
  }

  approve(id: string): InstalledPlugin {
    const doc = this.read();
    const p = doc.plugins.find(item => item.id === id);
    if (!p) throw new Error(`插件 ${id} 未安装`);
    if (!p.needsApproval) throw new Error("插件没有待确认的能力变化");
    const { manifest, mcp } = this.files(id);
    p.approvedCapabilities = pluginCapabilities(manifest, mcp);
    delete p.needsApproval;
    delete p.capabilityChanges;
    p.enabled = true;
    this.write(doc);
    return p;
  }
  patch(id: string, patch: { enabled?: boolean; assistants?: string[] | null; tools?: InstalledPlugin["tools"] }): void {
    const doc = this.read();
    const p = doc.plugins.find(item => item.id === id);
    if (!p) throw new Error(`插件 ${id} 未安装`);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
      if (patch.enabled && p.needsApproval) throw new Error("插件更新后能力有变化，请先确认后再启用");
      p.enabled = patch.enabled;
    }
    if (patch.assistants !== undefined) { if (patch.assistants !== null && (!Array.isArray(patch.assistants) || patch.assistants.some(a => typeof a !== "string"))) throw new Error("assistants 必须是字符串数组"); if (patch.assistants === null) delete p.assistants; else p.assistants = patch.assistants; }
    if (patch.tools !== undefined) {
      if (!object(patch.tools)) throw new Error("tools 必须是对象");
      for (const tool of Object.values(patch.tools)) if (!object(tool) || (tool.enabled !== undefined && typeof tool.enabled !== "boolean")) throw new Error("工具设置无效");
      p.tools = patch.tools;
    }
    this.write(doc);
  }
  view(id: string): { plugin: InstalledPlugin; manifest: Obj; config: Record<string, Obj>; profiles?: { id: string; name: string; config: Record<string, Obj>; missing: string[] }[]; missing: string[] } {
    const plugin = this.get(id);
    const { manifest, config } = this.files(id);
    const fieldView = (values: Record<string, PluginConfigValue>) => Object.fromEntries(Object.entries(config).map(([key, field]) => {
      const { default: defaultValue, ...rest } = field;
      const effective = values[key] ?? defaultValue;
      return [key, field.sensitive ? { ...rest, configured: effective !== undefined && effective !== "" && (!Array.isArray(effective) || effective.length > 0) } : { ...rest, ...(defaultValue !== undefined ? { default: defaultValue } : {}), value: effective }];
    }));
    const safeManifest = { ...manifest }; delete safeManifest.userConfig;
    if (plugin.profiles) {
      const profiles = plugin.profiles.map(profile => ({ id: profile.id, name: profile.name, config: fieldView(this.profileValues(id, profile)), missing: validatePluginValues(config, this.profileValues(id, profile)) }));
      return { plugin: { ...plugin, config: {}, profiles: plugin.profiles.map(profile => ({ ...profile, config: Object.fromEntries(Object.entries(profile.config).filter(([key]) => !config[key]?.sensitive)) })) }, manifest: safeManifest, config: {}, profiles, missing: [...new Set(profiles.flatMap(profile => profile.missing))] };
    }
    const values = this.values(id);
    const safeConfig = Object.fromEntries(Object.entries(plugin.config ?? {}).filter(([key]) => !config[key]?.sensitive));
    return { plugin: { ...plugin, config: safeConfig }, manifest: safeManifest, config: fieldView(values), missing: validatePluginValues(config, values) };
  }
}
