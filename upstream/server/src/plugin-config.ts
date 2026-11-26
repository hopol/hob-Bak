import { isAbsolute } from "node:path";
import { isSemver } from "../../shared/plugin-version.ts";
import type { PluginProviderSpec } from "../../shared/types.ts";

export type PluginConfigValue = string | number | boolean | (string | number | boolean)[];
export interface PluginConfigField {
  type: "string" | "number" | "boolean" | "file" | "directory";
  title?: string;
  description?: string;
  required?: boolean;
  default?: PluginConfigValue;
  options?: (string | number | boolean)[];
  multiple?: boolean;
  sensitive?: boolean;
  min?: number;
  max?: number;
}
export type PluginConfig = Record<string, PluginConfigField>;

type RecordValue = Record<string, unknown>;
export interface PluginProfilesDeclaration { title?: string }
const isRecord = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const fields = new Set(["type", "title", "description", "required", "default", "options", "multiple", "sensitive", "min", "max"]);
const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reference = /\$\{(?:(hob)\.(root|plugin_root|plugin_data|profiles)|(user_config\.)?([A-Za-z_][A-Za-z0-9_]*))\}/g;

export interface PluginCapabilitySnapshot {
  providers: string[];
  permissions: string[];
  mcpServers: string[];
}

const PKG_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i;
const INTEGRITY = /^sha512-[A-Za-z0-9+/=]+$/;

/** 读取并校验 plugin.json 的 extensions["com.hob.plugins"].providers 声明。 */
export function providerDeclarations(manifest: unknown): PluginProviderSpec[] {
  if (!isRecord(manifest)) return [];
  const extensions = manifest.extensions;
  const hob = isRecord(extensions) ? extensions["com.hob.plugins"] : undefined;
  if (!isRecord(hob) || hob.providers === undefined) return [];
  if (!Array.isArray(hob.providers)) throw new Error("extensions.com.hob.plugins.providers 必须是数组");
  const out: PluginProviderSpec[] = [];
  const seen = new Set<string>();
  for (const item of hob.providers) {
    if (!isRecord(item)) throw new Error("providers 中的每一项必须是对象");
    const pkg = typeof item.package === "string" ? item.package.trim() : "";
    const version = typeof item.version === "string" ? item.version.trim() : "";
    const integrity = typeof item.integrity === "string" ? item.integrity.trim() : "";
    if (!pkg || !PKG_NAME.test(pkg)) throw new Error(`providers.package 无效：${pkg || "(空)"}`);
    if (!isSemver(version)) throw new Error(`providers.version 必须是 semver：${pkg}`);
    if (!INTEGRITY.test(integrity)) throw new Error(`providers.integrity 必须是 sha512-... 格式：${pkg}`);
    if (seen.has(pkg)) throw new Error(`providers 中存在重复的包：${pkg}`);
    seen.add(pkg);
    let tarball: string | undefined;
    if (item.tarball !== undefined) {
      if (typeof item.tarball !== "string" || !item.tarball.trim()) throw new Error(`providers.tarball 必须是网址：${pkg}`);
      let parsed: URL;
      try { parsed = new URL(item.tarball.trim()); } catch { throw new Error(`providers.tarball 网址无效：${pkg}`); }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`providers.tarball 只支持 http(s) 协议：${pkg}`);
      tarball = parsed.toString();
    }
    out.push({ package: pkg, version, integrity, ...(tarball ? { tarball } : {}) });
  }
  return out;
}

/** 提取插件声明的能力快照（用于更新时检测能力变化，变化后需用户重新确认）。 */
export function pluginCapabilities(manifest: unknown, mcp: unknown): PluginCapabilitySnapshot {
  const providers = providerDeclarations(manifest).map((p) => p.package).sort();
  const extensions = isRecord(manifest) ? manifest.extensions : undefined;
  const hob = isRecord(extensions) ? extensions["com.hob.plugins"] : undefined;
  const rawPerms = isRecord(hob) && Array.isArray(hob.permissions) ? hob.permissions : [];
  const permissions = [...new Set(rawPerms.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()))].sort();
  const mcpServers = isRecord(mcp) && isRecord(mcp.mcpServers) ? Object.keys(mcp.mcpServers).sort() : [];
  return { providers, permissions, mcpServers };
}

/** 比较更新前后的能力快照，只报告新增或变化的能力项。 */
export function diffCapabilities(before: PluginCapabilitySnapshot, after: PluginCapabilitySnapshot): string[] {
  const changes: string[] = [];
  for (const pkg of after.providers) {
    if (!before.providers.includes(pkg)) changes.push(`新增模型包：${pkg}`);
  }
  for (const perm of after.permissions) {
    if (!before.permissions.includes(perm)) changes.push(`新增权限：${perm}`);
  }
  for (const srv of after.mcpServers) {
    if (!before.mcpServers.includes(srv)) changes.push(`新增工具服务：${srv}`);
  }
  return changes;
}

export function binDeclaration(manifest: unknown): string | undefined {
  if (!isRecord(manifest)) return undefined;
  const extensions = manifest.extensions;
  const hob = isRecord(extensions) ? extensions["com.hob.plugins"] : undefined;
  if (!isRecord(hob) || hob.bin === undefined) return undefined;
  if (typeof hob.bin !== "string") throw new Error("extensions.com.hob.plugins.bin 必须是相对目录路径");
  const value = hob.bin.replace(/\/+$/, "");
  if (!value || value.includes("\\") || isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..") || /[?#\x00-\x1f]/.test(value)) {
    throw new Error("extensions.com.hob.plugins.bin 必须是插件内的相对目录");
  }
  return value;
}

export function profileDeclaration(manifest: unknown): PluginProfilesDeclaration | null {
  if (!isRecord(manifest)) return null;
  const extensions = manifest.extensions;
  const hob = isRecord(extensions) ? extensions["com.hob.plugins"] : undefined;
  if (!isRecord(hob) || hob.profiles === undefined) return null;
  if (!isRecord(hob.profiles)) throw new Error("extensions.com.hob.plugins.profiles 必须是对象");
  if (hob.profiles.title !== undefined && typeof hob.profiles.title !== "string") throw new Error("extensions.com.hob.plugins.profiles.title 必须是字符串");
  return { ...(typeof hob.profiles.title === "string" && hob.profiles.title ? { title: hob.profiles.title } : {}) };
}

/** 校验声明，并从允许的位置收集旧格式环境变量引用。 */
export function pluginConfig(manifest: unknown, mcp: unknown): PluginConfig {
  if (!isRecord(manifest)) throw new Error("插件清单必须是对象");
  const providers = providerDeclarations(manifest);
  const resolvedMcp = mcp === undefined && providers.length > 0 ? { mcpServers: {} } : mcp;
  if (!isRecord(resolvedMcp) || !isRecord(resolvedMcp.mcpServers)) throw new Error("插件清单和 mcpServers 必须是对象");
  const raw = manifest.userConfig ?? {};
  if (!isRecord(raw)) throw new Error("userConfig 必须是对象");
  binDeclaration(manifest);
  const profiles = profileDeclaration(manifest);
  if (profiles && isRecord(resolvedMcp.mcpServers) && Object.values(resolvedMcp.mcpServers).some(server => isRecord(server) && server.oauth !== undefined)) throw new Error("支持多个 profile 的插件暂时不能用 OAuth 登录");
  const config: PluginConfig = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (!keyPattern.test(key) || !isRecord(value)) throw new Error(`userConfig.${key} 无效`);
    for (const field of Object.keys(value)) if (!fields.has(field)) throw new Error(`userConfig.${key} 不认识字段 ${field}`);
    if (!["string", "number", "boolean", "file", "directory"].includes(String(value.type))) throw new Error(`userConfig.${key}.type 无效`);
    for (const field of ["title", "description"]) if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`userConfig.${key}.${field} 必须是字符串`);
    for (const field of ["required", "multiple", "sensitive"]) if (value[field] !== undefined && typeof value[field] !== "boolean") throw new Error(`userConfig.${key}.${field} 必须是布尔值`);
    for (const field of ["min", "max"]) if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) throw new Error(`userConfig.${key}.${field} 必须是数字`);
    if (typeof value.min === "number" && typeof value.max === "number" && value.min > value.max) throw new Error(`userConfig.${key} 的 min 大于 max`);
    const itemType = value.type === "number" ? "number" : value.type === "boolean" ? "boolean" : "string";
    const validItem = (item: unknown) => typeof item === itemType && (typeof item !== "number" || Number.isFinite(item));
    if (value.options !== undefined && (!Array.isArray(value.options) || !value.options.every(validItem))) throw new Error(`userConfig.${key}.options 无效`);
    if (value.default !== undefined && !(value.multiple ? Array.isArray(value.default) && value.default.every(validItem) : validItem(value.default))) throw new Error(`userConfig.${key}.default 无效`);
    config[key] = value as unknown as PluginConfigField;
  }
  forEachTemplate(resolvedMcp, (text, location) => {
    for (const match of text.matchAll(reference)) {
      const [, builtin, path, explicit, key] = match;
      if (builtin) continue;
      if (profiles) {
        const referenceName = explicit ? "${user_config." + key + "}" : key;
        throw new Error(`支持多个 profile 的插件用 \${hob.profiles} 读配置，不用 ${referenceName}`);
      }
      if (explicit && !Object.hasOwn(raw, key)) throw new Error(`${location} 引用了未声明的配置项 ${key}`);
      if (!explicit && !Object.hasOwn(config, key)) config[key] = { type: "string", title: key, required: true, sensitive: true };
    }
    return text;
  });
  validatePluginValues(config, {});
  return config;
}

/** 仅替换插件协议允许引用的位置，不改变原始文件。 */
function forEachTemplate(mcp: RecordValue, visit: (text: string, location: string) => string): RecordValue {
  const copy = structuredClone(mcp);
  if (!isRecord(copy.mcpServers)) throw new Error("mcpServers 必须是对象");
  for (const [name, raw] of Object.entries(copy.mcpServers)) {
    if (!isRecord(raw)) throw new Error(`服务 ${name} 必须是对象`);
    const replace = (obj: RecordValue, key: string, location: string) => {
      if (obj[key] !== undefined && typeof obj[key] !== "string") throw new Error(`${location} 必须是字符串`);
      if (typeof obj[key] === "string") obj[key] = visit(obj[key], location);
    };
    replace(raw, "url", `${name}.url`);
    for (const field of ["headers", "env"]) {
      if (raw[field] === undefined) continue;
      if (!isRecord(raw[field])) throw new Error(`${name}.${field} 必须是对象`);
      for (const key of Object.keys(raw[field])) replace(raw[field], key, `${name}.${field}.${key}`);
    }
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args)) throw new Error(`${name}.args 必须是数组`);
      raw.args = raw.args.map((arg, index) => {
        if (typeof arg !== "string") throw new Error(`${name}.args.${index} 必须是字符串`);
        return visit(arg, `${name}.args.${index}`);
      });
    }
    if (raw.oauth !== undefined) {
      if (!isRecord(raw.oauth)) throw new Error(`${name}.oauth 必须是对象`);
      for (const key of ["clientId", "clientSecret"]) replace(raw.oauth, key, `${name}.oauth.${key}`);
    }
  }
  return copy;
}

export function validatePluginValues(config: PluginConfig, values: Record<string, unknown>): string[] {
  for (const key of Object.keys(values)) if (!Object.hasOwn(config, key)) throw new Error(`未声明的配置项 ${key}`);
  const missing: string[] = [];
  for (const [key, field] of Object.entries(config)) {
    const value = (Object.hasOwn(values, key) ? values[key] : undefined) ?? field.default;
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      if (field.required) missing.push(key);
      continue;
    }
    const items = field.multiple ? value : [value];
    if (!Array.isArray(items) || (!field.multiple && Array.isArray(value))) throw new Error(`${key} 的值无效`);
    const type = field.type === "number" ? "number" : field.type === "boolean" ? "boolean" : "string";
    for (const item of items) {
      if (typeof item !== type || (typeof item === "number" && (!Number.isFinite(item) || (field.min !== undefined && item < field.min) || (field.max !== undefined && item > field.max))) || (field.options && !field.options.includes(item as string | number | boolean))) throw new Error(`${key} 的值无效`);
    }
  }
  return missing;
}

export function resolvePluginMcp(mcp: RecordValue, config: PluginConfig, values: Record<string, unknown>, paths?: { root: string; plugin_root: string; plugin_data: string; profiles?: { name: string; config: Record<string, unknown> }[] }): RecordValue {
  const missing = paths?.profiles ? [] : validatePluginValues(config, values);
  if (missing.length) throw new Error(`缺少配置项：${missing.join(", ")}`);
  const resolved = forEachTemplate(mcp, (text, location) => text.replace(reference, (_match, builtin: string, path: "root" | "plugin_root" | "plugin_data" | "profiles", _explicit: string, key: string) => {
    if (builtin) {
      if (!paths || (path === "profiles" ? !paths.profiles : !paths[path])) throw new Error(`${location} 缺少插件路径`);
      return path === "profiles" ? JSON.stringify(paths.profiles) : paths[path];
    }
    if (!Object.hasOwn(config, key)) throw new Error(`${location} 引用了未声明的配置项 ${key}`);
    const value = (Object.hasOwn(values, key) ? values[key] : undefined) ?? config[key].default;
    return Array.isArray(value) ? value.join(",") : String(value ?? "");
  }));
  const originalServers = mcp.mcpServers;
  const resolvedServers = resolved.mcpServers;
  if (isRecord(originalServers) && isRecord(resolvedServers)) for (const [name, original] of Object.entries(originalServers)) {
    const target = resolvedServers[name];
    if (!isRecord(original) || !Array.isArray(original.args) || !isRecord(target) || !Array.isArray(target.args)) continue;
    const args = target.args;
    target.args = original.args.flatMap((arg: unknown, index: number) => {
      const match = typeof arg === "string" ? /^\$\{(?:user_config\.)?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(arg) : null;
      const value = match ? ((Object.hasOwn(values, match[1]) ? values[match[1]] : undefined) ?? config[match[1]]?.default) : undefined;
      return Array.isArray(value) ? value.map(String) : [args[index]];
    });
  }
  return resolved;
}
