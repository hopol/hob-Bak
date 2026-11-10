// MCP 服务配置：读写的目标就是引擎自己读的那份 HOB_HOME/system/engine/mcp.json（SDK 的 MCP 扩展
// 在会话启动时连服务）。设置页的所有接口都经过这里；密钥（环境变量 / 请求头的值）只在
// 本模块和文件之间流动，接口只回「已设置」或不含密钥的整值 ${VAR} / !command 引用。
import { exec as execCallback } from "node:child_process";
import { lstatSync, mkdirSync, openSync, closeSync, existsSync, readFileSync, renameSync, rmSync, writeSync, fsyncSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  McpAuthRequiredError,
  McpClient,
  McpHttpError,
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import type {
  McpExposureChoice,
  McpImportItem,
  McpImportResult,
  McpImportView,
  McpSecretMutation,
  McpSecretValue,
  McpServerPatch,
  McpServerSave,
  McpServerView,
  McpTestResult,
  McpView,
} from "../../shared/mcp.ts";
import { localPiDir } from "./imports.ts";
import { engineDir } from "./config.ts";

const exec = promisify(execCallback);

const MAX_BYTES = 128 * 1024;
/** 服务名：字母、数字、_、-（和引擎一致；- 和 _ 视为同名）。 */
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 整值 `${VAR}` 引用（不含密钥，可以原样回显）。 */
const ENV_REF_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
/** 值里的 `${VAR}` / $VAR 引用（探测和引擎都会展开）。 */
const ENV_INLINE_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
/** 整值 `!command`（引擎会执行命令取输出）。 */
const COMMAND_VALUE_RE = /^!.+/;
const PROBE_TIMEOUT_MS = 15_000;
const COMMAND_VALUE_TIMEOUT_MS = 10_000;
const PROBE_CACHE_TTL_MS = 30_000;
const PROBE_STDERR_LINES = 8;
const PROBE_ERROR_MAX = 400;
const PROBE_CONCURRENCY = 4;
const CLIENT_INFO = { name: "hob", version: "1.0" };

export function mcpConfigPath(home: string): string {
  return join(engineDir(home), "mcp.json");
}

/** 服务名身份：- 和 _ 是同一个服务（引擎规则），重名按这个比。 */
export function normalizeMcpName(name: string): string {
  return name.replaceAll("-", "_");
}

export function isMcpNameValid(name: string): boolean {
  return NAME_RE.test(name);
}

interface ValidEntry {
  kind: "stdio" | "http";
  enabled: boolean;
  exposure: McpExposureChoice;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  description?: string;
  toolExposure?: Record<string, string>;
}

type Validated = { valid: true; entry: ValidEntry } | { valid: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown, field: string): Record<string, string> | string {
  if (!isRecord(value)) return `${field} 必须是字符串到字符串的对象`;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return `${field}.${key} 必须是字符串`;
  }
  return value as Record<string, string>;
}

/** 和引擎一致：/sse 结尾是老的 SSE 传输，不受支持。 */
function sseHint(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/sse");
  } catch {
    return false;
  }
}

/**
 * 校验一个 mcpServers 条目（读取和保存共用）。exposure 未写的按「按需搜索」处理：
 * 外部客户端的配置都不写这个字段，而 Hob 的任务会话始终注册按需搜索，行为等价；
 * codemode / hidden 是 Hob 不提供的方式，标记为无效，编辑保存后就成了 direct / deferred。
 */
export function validateMcpEntry(name: string, value: unknown): Validated {
  if (!isMcpNameValid(name)) return { valid: false, reason: "名称只能用字母、数字、_ 和 -，最长 64 字符" };
  if (!isRecord(value)) return { valid: false, reason: "条目必须是对象" };
  if (value.type !== undefined) {
    if (value.type === "sse") return { valid: false, reason: "SSE 传输不受支持：请使用 streamable HTTP 地址（通常是 /mcp 结尾）" };
    if (value.type !== "stdio" && value.type !== "http" && value.type !== "streamable-http") {
      return { valid: false, reason: `不认识的类型 ${String(value.type)}` };
    }
  }
  const hasCommand = value.command !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasCommand && hasUrl) return { valid: false, reason: "command 和 url 不能同时出现" };
  const kind: "stdio" | "http" | undefined = hasCommand ? "stdio" : hasUrl ? "http" : undefined;
  if (!kind) return { valid: false, reason: "缺少本地命令（stdio）或远程地址（HTTP）" };
  if (value.type !== undefined && value.type !== kind && !(value.type === "streamable-http" && kind === "http")) {
    return { valid: false, reason: `类型 ${String(value.type)} 和字段不匹配` };
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return { valid: false, reason: "enabled 必须是布尔值" };
  const exposureRaw = value.exposure;
  let exposure: McpExposureChoice;
  if (exposureRaw === undefined) exposure = "deferred";
  else if (exposureRaw === "direct" || exposureRaw === "deferred") exposure = exposureRaw;
  else return { valid: false, reason: "提供方式只支持 direct（直接提供）或 deferred（按需搜索）" };

  const entry: ValidEntry = { kind, enabled: value.enabled !== false, exposure };
  if (kind === "stdio") {
    if (typeof value.command !== "string" || !value.command.trim()) return { valid: false, reason: "command 必须是一个可执行文件（不是整条 shell 命令）" };
    entry.command = value.command;
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) return { valid: false, reason: "args 必须是字符串数组" };
      entry.args = value.args as string[];
    }
    if (value.cwd !== undefined) {
      if (typeof value.cwd !== "string" || !value.cwd.trim()) return { valid: false, reason: "cwd 必须是非空字符串" };
      entry.cwd = value.cwd;
    }
    if (value.env !== undefined) {
      const env = stringRecord(value.env, "env");
      if (typeof env === "string") return { valid: false, reason: env };
      entry.env = env;
    }
  } else {
    const url = typeof value.url === "string" ? value.url.trim() : "";
    if (!url) return { valid: false, reason: "url 必须是非空字符串" };
    if (!/^https?:\/\//i.test(url)) return { valid: false, reason: "url 必须以 http(s):// 开头" };
    if (sseHint(url)) return { valid: false, reason: "SSE 传输不受支持：请使用 streamable HTTP 地址（通常是 /mcp 结尾）" };
    entry.url = url;
    if (value.headers !== undefined) {
      const headers = stringRecord(value.headers, "headers");
      if (typeof headers === "string") return { valid: false, reason: headers };
      entry.headers = headers;
    }
    if (value.command !== undefined || value.args !== undefined || value.env !== undefined || value.cwd !== undefined) {
      return { valid: false, reason: "command / args / env / cwd 只适用于本地命令服务" };
    }
  }
  if (value.timeout !== undefined) {
    if (typeof value.timeout !== "number" || !Number.isSafeInteger(value.timeout) || value.timeout <= 0 || value.timeout > 86_400) {
      return { valid: false, reason: "timeout 必须是正整数（秒）" };
    }
    entry.timeout = value.timeout;
  }
  if (value.description !== undefined) {
    if (typeof value.description !== "string" || value.description.length > 300) return { valid: false, reason: "说明最多 300 字" };
    entry.description = value.description;
  }
  if (value.toolExposure !== undefined) {
    const toolExposure = stringRecord(value.toolExposure, "toolExposure");
    if (typeof toolExposure === "string") return { valid: false, reason: toolExposure };
    entry.toolExposure = toolExposure;
  }
  return { valid: true, entry };
}

// ---------------------------------------------------------------------------
// 文档读写：原子写、新建 0600、只改目标条目、坏文件报错
// ---------------------------------------------------------------------------

interface McpDoc {
  /** 顶层对象（不含 mcpServers），重写时原样保留 */
  raw: Record<string, unknown>;
  servers: Record<string, unknown>;
}

class McpFileError extends Error {}

function readDoc(path: string): McpDoc {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: {}, servers: {} };
    throw new McpFileError("mcp.json 无法读取");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new McpFileError("mcp.json 超过大小限制（128KB）");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 坏文件不能当成空列表：设置页要能看到错误并修好它
    throw new McpFileError("mcp.json 不是有效的 JSON");
  }
  if (!isRecord(parsed)) throw new McpFileError("mcp.json 必须是 JSON 对象");
  const servers = parsed.mcpServers;
  if (servers !== undefined && !isRecord(servers)) throw new McpFileError("mcp.json 的 mcpServers 必须是对象");
  const { mcpServers: _drop, ...raw } = parsed;
  return { raw, servers: (servers ?? {}) as Record<string, unknown> };
}

/** 同目录临时文件 + rename；新建 0600，已存在的文件保持原权限。 */
function writeDoc(path: string, doc: McpDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  const created = !existsSync(path);
  // Hob 的任务模型不一定写得来脚本调用工具，不开 codemode；新建文件时写明，已有的原样保留
  const payload =
    `${JSON.stringify(
      created ? { autoEnableCodemode: false, ...doc.raw, mcpServers: doc.servers } : { ...doc.raw, mcpServers: doc.servers },
      null,
      2,
    )}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_BYTES) throw new McpFileError("mcp.json 超过大小限制（128KB）");
  let mode = 0o600;
  if (!created) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new McpFileError("mcp.json 必须是普通文件");
    mode = info.mode & 0o777;
  }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", mode);
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    if (error instanceof McpFileError) throw error;
    throw new McpFileError("mcp.json 无法写入");
  }
}

/** 写操作串行化：并发修改不会交错写坏文件。 */
let writeTail: Promise<unknown> = Promise.resolve();
function runWrite<T>(mutate: () => Promise<T> | T): Promise<T> {
  const run = writeTail.then(mutate, mutate);
  writeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// 视图（不含密钥）
// ---------------------------------------------------------------------------

function secretValue(value: string): McpSecretValue {
  return ENV_REF_RE.test(value) || COMMAND_VALUE_RE.test(value) ? { redacted: false, value } : { redacted: true };
}

function secretRecord(record: Record<string, string> | undefined): Record<string, McpSecretValue> | undefined {
  if (record === undefined) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, secretValue(value)]));
}

export function serverView(name: string, value: unknown): McpServerView {
  const validated = validateMcpEntry(name, value);
  if (!validated.valid) {
    return { name, valid: false, invalidReason: validated.reason, enabled: isRecord(value) && value.enabled !== false, exposure: "deferred" };
  }
  const entry = validated.entry;
  return {
    name,
    valid: true,
    kind: entry.kind,
    enabled: entry.enabled,
    exposure: entry.exposure,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.kind === "stdio"
      ? {
          command: entry.command,
          ...(entry.args?.length ? { args: entry.args } : {}),
          ...(entry.env ? { env: secretRecord(entry.env) } : {}),
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
        }
      : {
          url: entry.url,
          ...(entry.headers ? { headers: secretRecord(entry.headers) } : {}),
        }),
    ...(entry.toolExposure
      ? { hiddenTools: Object.entries(entry.toolExposure).filter(([, v]) => v === "hidden").map(([k]) => k) }
      : {}),
  };
}

/** 列表：文件坏了把错误抛给接口（fail-closed，不当成空列表）。 */
export function mcpView(home: string): McpView {
  const doc = readDoc(mcpConfigPath(home));
  return { servers: Object.entries(doc.servers).map(([name, value]) => serverView(name, value)) };
}

/** 任务会话要不要加载 MCP：文件里有启用中的服务就加载；文件坏了不加载（错误在设置页能看到）。 */
export function mcpEnabled(home: string): boolean {
  try {
    const doc = readDoc(mcpConfigPath(home));
    return Object.values(doc.servers).some((value) => !isRecord(value) || value.enabled !== false);
  } catch {
    return false;
  }
}

/** 任务过程显示用：转义后的服务名 → 配置里的原名（mcp__my_srv__x → my-srv · x）。 */
export function mcpServerDisplay(home: string): Record<string, string> {
  try {
    const doc = readDoc(mcpConfigPath(home));
    return Object.fromEntries(Object.keys(doc.servers).map((name) => [name.replace(/-/g, "_"), name]));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 保存 / 删除 / 补丁
// ---------------------------------------------------------------------------

function assertName(name: string): void {
  if (!isMcpNameValid(name)) throw new Error("名称只能用字母、数字、_ 和 -，最长 64 字符");
}

function assertNoConflict(servers: Record<string, unknown>, name: string): void {
  for (const other of Object.keys(servers)) {
    if (other !== name && normalizeMcpName(other) === normalizeMcpName(name)) {
      throw new Error(`和已有服务「${other}」重名（- 和 _ 视为同名）`);
    }
  }
}

/** env / headers 逐键套用：保留 / 删除 / 替换。 */
function applySecretMutations(
  existing: Record<string, string> | undefined,
  mutations: Record<string, McpSecretMutation> | undefined,
  field: string,
): Record<string, string> {
  const out: Record<string, string> = { ...(existing ?? {}) };
  for (const [key, mutation] of Object.entries(mutations ?? {})) {
    if (!key.trim()) throw new Error(`${field} 的键不能为空`);
    if (mutation.mode === "remove") delete out[key];
    else if (mutation.mode === "preserve") {
      if (existing === undefined || !(key in existing)) throw new Error(`要保留的 ${field}.${key} 不存在`);
    } else out[key] = mutation.value;
  }
  return out;
}

/** 编辑时保留与服务种类无关的字段（提供方式、工具开关、超时、OAuth 客户端设置）。 */
function preservedFields(previous: unknown): Record<string, unknown> {
  if (!isRecord(previous)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["exposure", "toolExposure", "timeout", "oauth"]) {
    if (previous[key] !== undefined) out[key] = previous[key];
  }
  if (previous.enabled === false) out.enabled = false;
  return out;
}
/** 新建或改一个服务（PUT）。名称是地址参数；重名（-/_）拒绝。 */
export async function saveMcpServer(home: string, name: string, body: McpServerSave): Promise<McpView> {
  assertName(name);
  if (!body || (body.kind !== "stdio" && body.kind !== "http")) throw new Error("服务种类必须是本地命令（stdio）或远程地址（HTTP）");
  const command = typeof body.command === "string" ? body.command.trim() : undefined;
  const url = typeof body.url === "string" ? body.url.trim() : undefined;
  const args = Array.isArray(body.args) ? body.args.map((arg) => String(arg).trim()).filter(Boolean) : undefined;
  const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined;
  const description = typeof body.description === "string" && body.description.trim() ? body.description.trim() : undefined;
  if (body.kind === "stdio" && !command) throw new Error("本地命令服务需要填写命令");
  if (body.kind === "http" && !url) throw new Error("远程地址服务需要填写地址");
  if (body.kind === "http" && sseHint(url!)) throw new Error("SSE 传输不受支持：请使用 streamable HTTP 地址（通常是 /mcp 结尾）");

  return runWrite(() => {
    const path = mcpConfigPath(home);
    const doc = readDoc(path);
    assertNoConflict(doc.servers, name);
    const previous = doc.servers[name];
    const previousEntry = isRecord(previous) ? validateMcpEntry(name, previous) : null;
    // 上一个条目有效才保留它的额外字段；手改坏的条目按新填的来（提供方式用默认的直接提供）
    const keep = previousEntry?.valid === true ? preservedFields(previous) : {};
    const env = applySecretMutations(
      previousEntry?.valid === true ? previousEntry.entry.env : undefined,
      body.env as Record<string, McpSecretMutation> | undefined,
      "环境变量",
    );
    const headers = applySecretMutations(
      previousEntry?.valid === true ? previousEntry.entry.headers : undefined,
      body.headers as Record<string, McpSecretMutation> | undefined,
      "请求头",
    );
    const entry: Record<string, unknown> = {
      ...keep,
      ...(body.kind === "stdio" ? { command } : { url }),
      ...(body.kind === "stdio" && args?.length ? { args } : {}),
      ...(body.kind === "stdio" && Object.keys(env).length ? { env } : {}),
      ...(body.kind === "stdio" && cwd ? { cwd } : {}),
      ...(body.kind === "http" && Object.keys(headers).length ? { headers } : {}),
      ...(description ? { description } : {}),
      // 提供方式始终写明：引擎的默认值是 codemode，Hob 不提供
      exposure: previousEntry?.valid === true ? previousEntry.entry.exposure : "direct",
    };
    const check = validateMcpEntry(name, entry);
    if (!check.valid) throw new Error(check.reason);
    doc.servers = { ...doc.servers, [name]: entry };
    writeDoc(path, doc);
    return mcpView(home);
  });
}

/** 启用 / 停用、提供方式、单独关掉的工具（PATCH）。 */
export async function patchMcpServer(home: string, name: string, patch: McpServerPatch): Promise<McpView> {
  assertName(name);
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
  if (patch.exposure !== undefined && patch.exposure !== "direct" && patch.exposure !== "deferred") {
    throw new Error("提供方式只支持直接提供或按需搜索");
  }
  if (patch.hiddenTools !== undefined && (!Array.isArray(patch.hiddenTools) || patch.hiddenTools.some((t) => typeof t !== "string"))) {
    throw new Error("hiddenTools 必须是字符串数组");
  }
  return runWrite(() => {
    const path = mcpConfigPath(home);
    const doc = readDoc(path);
    const existing = doc.servers[name];
    if (existing === undefined) throw new Error(`没有名为「${name}」的服务`);
    if (!isRecord(existing)) throw new Error(`服务「${name}」的条目无效，请编辑或删除`);
    const next: Record<string, unknown> = { ...existing };
    if (patch.enabled !== undefined) {
      // 引擎默认启用：开启时删掉字段，关闭时写 false
      delete next.enabled;
      if (!patch.enabled) next.enabled = false;
    }
    if (patch.exposure) next.exposure = patch.exposure;
    if (patch.hiddenTools) {
      const toolExposure: Record<string, unknown> = {};
      for (const [tool, value] of Object.entries(isRecord(next.toolExposure) ? next.toolExposure : {})) {
        if (value === "hidden") continue;
        toolExposure[tool] = value;
      }
      for (const tool of patch.hiddenTools) toolExposure[tool] = "hidden";
      if (Object.keys(toolExposure).length) next.toolExposure = toolExposure;
      else delete next.toolExposure;
    }
    const check = validateMcpEntry(name, next);
    if (!check.valid) throw new Error(check.reason);
    doc.servers = { ...doc.servers, [name]: next };
    writeDoc(path, doc);
    return mcpView(home);
  });
}

/** 删除一个服务。 */
export async function removeMcpServer(home: string, name: string): Promise<McpView> {
  assertName(name);
  return runWrite(() => {
    const path = mcpConfigPath(home);
    const doc = readDoc(path);
    if (!(name in doc.servers)) throw new Error(`没有名为「${name}」的服务`);
    const servers = { ...doc.servers };
    delete servers[name];
    doc.servers = servers;
    writeDoc(path, doc);
    return mcpView(home);
  });
}

// ---------------------------------------------------------------------------
// 测试连接（connect → 列工具 → 关闭）
// ---------------------------------------------------------------------------

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/** 值里的环境变量引用展开（缺失就报清是哪个变量）；`!command` 用 shell 跑一次取输出。 */
async function resolveValue(raw: string, field: string): Promise<string> {
  if (COMMAND_VALUE_RE.test(raw)) {
    try {
      const { stdout } = await exec(raw.slice(1), { timeout: COMMAND_VALUE_TIMEOUT_MS, maxBuffer: 64 * 1024 });
      return stdout.trim();
    } catch {
      throw new Error(`${field} 的命令取值失败`);
    }
  }
  return raw.replace(ENV_INLINE_RE, (whole, name: string) => {
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`${field}：环境变量 ${name} 未设置`);
    return value;
  });
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function raceTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return Promise.race([task, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`超时（${Math.round(ms / 1000)} 秒）`)), ms))]);
}

function gate<T>(task: () => Promise<T>): Promise<T> {
  const wait = () => {
    if (probeActive < PROBE_CONCURRENCY) {
      probeActive += 1;
      return Promise.resolve();
    }
    return new Promise<void>((release) => probeWaiting.push(release));
  };
  return (async () => {
    await wait();
    try {
      return await task();
    } finally {
      probeActive -= 1;
      probeWaiting.shift()?.();
    }
  })();
}

let probeActive = 0;
const probeWaiting: Array<() => void> = [];

/** 一次探测：连接 → 列工具 → 关闭。stdio 的子进程由 close 收掉（关 stdin 后对整个进程组 SIGTERM/SIGKILL）。 */
async function probeEntry(entry: ValidEntry): Promise<McpTestResult> {
  let stderrBuffer = "";
  const secrets: string[] = [];
  const resolveSecret = async (raw: string, field: string) => {
    for (const match of raw.matchAll(ENV_INLINE_RE)) {
      const value = process.env[match[1]!];
      if (value) secrets.push(value);
    }
    const value = await resolveValue(raw, field);
    if (value) secrets.push(value);
    return value;
  };
  const redact = (text: string) => secrets.reduce((out, secret) => out.split(secret).join("•••"), text);
  try {
    let transport: StdioTransport | StreamableHttpTransport;
    if (entry.kind === "stdio") {
      const env: Record<string, string> = {};
      for (const [key, raw] of Object.entries(entry.env ?? {})) {
        env[key] = await resolveSecret(raw, `环境变量 ${key}`);
      }
      const cwd = entry.cwd ? resolve(homedir(), expandHome(entry.cwd)) : undefined;
      transport = new StdioTransport({
        command: expandHome(entry.command!),
        ...(entry.args?.length ? { args: entry.args.map(expandHome) } : {}),
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        stderr: "pipe",
        onStderr: (chunk) => {
          stderrBuffer = (stderrBuffer + chunk).slice(-16 * 1024);
        },
      });
    } else {
      const headers: Record<string, string> = {};
      for (const [key, raw] of Object.entries(entry.headers ?? {})) {
        headers[key] = await resolveSecret(raw, `请求头 ${key}`);
      }
      transport = new StreamableHttpTransport({ url: entry.url!, ...(Object.keys(headers).length ? { headers } : {}) });
    }
    const client = new McpClient(CLIENT_INFO);
    try {
      await raceTimeout(client.connect(transport), PROBE_TIMEOUT_MS);
      const listed = await raceTimeout(client.listTools(), PROBE_TIMEOUT_MS);
      return {
        ok: true,
        tools: listed.map((tool) => ({ name: redact(tool.name), description: truncate(redact(tool.description ?? ""), 200) })),
      };
    } finally {
      await raceTimeout(client.close().catch(() => undefined), 5_000);
    }
  } catch (error) {
    const tail = stderrBuffer
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .slice(-PROBE_STDERR_LINES)
      // 密钥的明文值不能跟着错误信息漏出去
      .map((line) => truncate(redact(line), 200));
    if (
      error instanceof McpAuthRequiredError ||
      (error instanceof McpHttpError && (error.status === 401 || error.status === 403))
    ) {
      return { ok: false, state: "needs_auth", error: "服务要求登录，暂不支持", stderrTail: tail };
    }
    const message = error instanceof Error ? error.message : "连接失败";
    return { ok: false, state: "failed", error: truncate(redact(message), PROBE_ERROR_MAX), stderrTail: tail };
  }
}

interface ProbeCacheEntry {
  fingerprint: string;
  result: McpTestResult;
  at: number;
}

const probeCache = new Map<string, ProbeCacheEntry>();

/** Worker 会话的工具白名单要加的：MCP 工具全体 + 按需搜索（deferred 的服务靠它加载）。 */
export const MCP_SESSION_TOOLS = ["mcp__*", "tool_search"];

/** 测试一个服务的连接；refresh = false 时 30 秒内的相同配置直接用缓存。 */
export async function testMcpServer(home: string, name: string, refresh: boolean): Promise<McpTestResult> {
  assertName(name);
  const path = mcpConfigPath(home);
  const doc = readDoc(path);
  const value = doc.servers[name];
  if (value === undefined) throw new Error(`没有名为「${name}」的服务`);
  const validated = validateMcpEntry(name, value);
  if (!validated.valid) throw new Error(validated.reason);
  const fingerprint = JSON.stringify(value);
  const key = `${path}::${name}`;
  const cached = probeCache.get(key);
  if (!refresh && cached && cached.fingerprint === fingerprint && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
    return cached.result;
  }
  const result = await gate(() => probeEntry(validated.entry));
  probeCache.set(key, { fingerprint, result, at: Date.now() });
  return result;
}

// ---------------------------------------------------------------------------
// 从本机导入（只读来源文件）
// ---------------------------------------------------------------------------

type ImportSource = "pi" | "claude" | "cursor";

const IMPORT_LABEL: Record<ImportSource, string> = { pi: "pi", claude: "Claude Code", cursor: "Cursor" };

/** 三个来源的默认位置：pi 用启动时记下的本机目录，其余在用户主目录。 */
function importSourcePath(source: ImportSource): string {
  if (source === "pi") return join(localPiDir(), "mcp.json");
  if (source === "claude") return join(homedir(), ".claude.json");
  return join(homedir(), ".cursor", "mcp.json");
}

/** 测试注入临时目录用；不传就用默认位置。 */
export type McpImportDirs = Partial<Record<ImportSource, string>>;

interface ImportCandidate {
  item: McpImportItem;
  /** 可导入时有值：要写进 mcp.json 的原条目 */
  raw?: Record<string, unknown>;
}

function existingNames(home: string): Set<string> {
  try {
    return new Set(Object.keys(readDoc(mcpConfigPath(home)).servers).map(normalizeMcpName));
  } catch {
    // Hob 自己的文件坏了也先列出可导入的：导入时会报错并提示先修文件
    return new Set();
  }
}

/** 三个来源的 mcpServers 读出来（只读；Claude Code 只看顶层 mcpServers）。 */
function collectImportCandidates(home: string, dirs?: McpImportDirs): { sources: string[]; candidates: ImportCandidate[] } {
  const sources: string[] = [];
  const candidates: ImportCandidate[] = [];
  const existing = existingNames(home);
  for (const source of ["pi", "claude", "cursor"] as ImportSource[]) {
    const path = dirs?.[source] ?? importSourcePath(source);
    if (!existsSync(path)) continue;
    let servers: Record<string, unknown> | undefined;
    try {
      const text = readFileSync(path, "utf8");
      if (Buffer.byteLength(text, "utf8") > MAX_BYTES) continue;
      const parsed: unknown = JSON.parse(text);
      servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? (parsed.mcpServers as Record<string, unknown>) : undefined;
    } catch {
      continue;
    }
    if (!servers) continue;
    sources.push(`${IMPORT_LABEL[source]}（${path}）`);
    for (const [name, value] of Object.entries(servers)) {
      const validated = validateMcpEntry(name, value);
      const taken = existing.has(normalizeMcpName(name));
      const note = !validated.valid
        ? validated.reason
        : taken
          ? "已有同名服务，导入会跳过"
          : undefined;
      candidates.push({
        item: {
          id: `${source}:${name}`,
          name,
          source,
          ...(validated.valid ? { kind: validated.entry.kind } : {}),
          exists: taken,
          selectable: validated.valid && !taken,
          ...(note ? { note } : {}),
        },
        ...(validated.valid && isRecord(value) ? { raw: value } : {}),
      });
    }
  }
  return { sources, candidates };
}

export function listMcpImports(home: string, dirs?: McpImportDirs): McpImportView {
  const { sources, candidates } = collectImportCandidates(home, dirs);
  return { sources, items: candidates.map((candidate) => candidate.item) };
}

/** 导入所选（同名跳过）。导入的条目补上提供方式 direct，其余字段原样复制。 */
export async function importMcpServers(home: string, ids: string[], dirs?: McpImportDirs): Promise<McpImportResult> {
  const wanted = new Set(ids);
  return runWrite(() => {
    const result: McpImportResult = { imported: [], skipped: [] };
    const path = mcpConfigPath(home);
    const doc = readDoc(path);
    const { candidates } = collectImportCandidates(home, dirs);
    for (const id of wanted) {
      const candidate = candidates.find((item) => item.item.id === id && item.item.selectable);
      if (!candidate) {
        result.skipped.push(`${id}：不可导入（不存在、无效或同名）`);
        continue;
      }
      if (Object.keys(doc.servers).some((name) => normalizeMcpName(name) === normalizeMcpName(candidate.item.name))) {
        result.skipped.push(`${candidate.item.name}：已有同名服务，跳过`);
        continue;
      }
      doc.servers = {
        ...doc.servers,
        [candidate.item.name]: { ...(candidate.raw ?? {}), exposure: "direct" },
      };
      result.imported.push(candidate.item.name);
    }
    if (result.imported.length) writeDoc(path, doc);
    return result;
  });
}
