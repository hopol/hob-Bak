import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSecrets } from "./secrets.ts";
import { pluginOAuthLoggedIn, pluginOAuthNeedsRelogin, pluginOAuthProvider, type PluginOAuthConfig } from "./plugin-oauth.ts";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { McpAuthRequiredError, McpClient, McpHttpError, StdioTransport, StreamableHttpTransport, limitMcpContent, normalizeMcpInputSchema, toLlmContent, validateMcpServerConfig, type Tool } from "@earendil-works/pi-mcp";
import type { Card } from "../../shared/cards.ts";
import type { PluginCredentialRole, PluginLoginRole, PluginToolLoginPollResult, PluginToolLoginStartResult, PluginToolLoginStatus, PluginToolLoginView } from "../../shared/types.ts";
import { t } from "../../shared/i18n.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { cardTitle, validateCard } from "./cards.ts";
import type { TSchema } from "typebox";
import { resolvePluginMcp, validatePluginValues } from "./plugin-config.ts";
import { PluginStore } from "./plugin-store.ts";
import { proxyEnvironment, type ProxyEnvironmentSettings } from "./network-proxy.ts";

export type PluginConnectionStatus = "pending_config" | "connecting" | "idle" | "connected" | "needs_login" | "needs_relogin" | "error";
export interface PluginServiceState { pluginId: string; name: string; status: PluginConnectionStatus; missing?: string[]; error?: string; tools: Tool[]; toolErrors?: { name: string; reason: string }[]; oauth?: { declared: boolean; loggedIn: boolean }; login?: { roles: PluginLoginRole[]; status?: PluginToolLoginStatus } }
export interface CredentialProvider { pluginId: string; providerName: string; service: string; tool: string; role: PluginCredentialRole }
export interface LoginToolProvider { pluginId: string; service: string; tool: string; role: PluginLoginRole }
type Connection = {
  state: PluginServiceState;
  client?: McpClient;
  retry?: NodeJS.Timeout;
  retryCount?: number;
  activeCalls?: number;
  onIdle?: Set<() => void>;
  idle?: NodeJS.Timeout;
  connecting?: Promise<void>;
  closing?: Promise<void>;
  raw?: unknown;
  kind?: "stdio" | "http";
  keepAlive?: boolean;
  stopped: boolean;
  hadCredentials?: boolean;
};
export const PLUGIN_IDLE_MS = 10 * 60 * 1000;
const execSecret = promisify(execCallback);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const LOGIN_ROLES = new Set<PluginLoginRole>(["status", "start", "poll", "logout"]);

function loginToolsIn(tools: Tool[]): Partial<Record<PluginLoginRole, Tool>> {
  const found: Partial<Record<PluginLoginRole, Tool>> = {};
  for (const tool of tools) {
    const meta = isObject(tool._meta) ? tool._meta : undefined;
    const role = meta?.["hob/login"];
    if (typeof role === "string" && LOGIN_ROLES.has(role as PluginLoginRole) && !found[role as PluginLoginRole]) {
      found[role as PluginLoginRole] = tool;
    }
  }
  return found;
}

function parseLoginPayload(
  response: { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean },
  redact: (text: string) => string,
  fallbackError: string,
): Record<string, unknown> {
  const text = (response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  if (response.isError) {
    const structuredMessage = isObject(response.structuredContent) && typeof response.structuredContent.message === "string"
      ? response.structuredContent.message.trim()
      : "";
    throw new Error(redact(text || structuredMessage || fallbackError));
  }
  if (isObject(response.structuredContent)) return response.structuredContent;
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isObject(parsed)) return parsed;
    } catch { /* ignore non-JSON text */ }
  }
  return {};
}

function parseLoginStatus(
  response: { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean },
  redact: (text: string) => string,
): PluginToolLoginStatus {
  const data = parseLoginPayload(response, redact, "查询登录状态失败");
  if (typeof data.signedIn !== "boolean") throw new Error("插件登录状态工具返回格式无效");
  return {
    signedIn: data.signedIn,
    ...(data.optional === true ? { optional: true } : {}),
    ...(typeof data.startLabel === "string" && data.startLabel.trim() ? { startLabel: redact(data.startLabel.trim()) } : {}),
    ...(typeof data.account === "string" && data.account ? { account: redact(data.account) } : {}),
    ...(typeof data.detail === "string" && data.detail ? { detail: redact(data.detail) } : {}),
  };
}

function parseLoginStart(
  response: { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean },
  redact: (text: string) => string,
): PluginToolLoginStartResult {
  const data = parseLoginPayload(response, redact, "启动登录失败");
  if (data.kind === "done") return { kind: "done" };
  if (data.kind === "device_code") {
    if (typeof data.url !== "string" || !data.url || typeof data.userCode !== "string" || !data.userCode) {
      throw new Error("插件设备码登录缺少验证网址或验证码");
    }
    const expiresAt = typeof data.expiresAt === "string" && data.expiresAt
      ? data.expiresAt
      : typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt)
        ? new Date(data.expiresAt > 1e12 ? data.expiresAt : data.expiresAt * 1000).toISOString()
        : undefined;
    const interval = typeof data.interval === "number" && Number.isFinite(data.interval) && data.interval > 0
      ? data.interval
      : undefined;
    return {
      kind: "device_code",
      url: data.url,
      userCode: data.userCode,
      ...(expiresAt ? { expiresAt } : {}),
      ...(interval !== undefined ? { interval } : {}),
    };
  }
  throw new Error("插件登录启动返回了不支持的类型");
}

function parseLoginPoll(
  response: { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean },
  redact: (text: string) => string,
): PluginToolLoginPollResult {
  const data = parseLoginPayload(response, redact, "查询登录结果失败");
  if (data.state !== "pending" && data.state !== "done" && data.state !== "error") {
    throw new Error("插件登录轮询返回格式无效");
  }
  return {
    state: data.state,
    ...(typeof data.message === "string" && data.message ? { message: redact(data.message) } : {}),
  };
}

/** Owns one connection per enabled, configured service; all sessions share these clients. */
export class PluginHost {
  readonly store: PluginStore;
  private connections = new Map<string, Connection>();
  private reloads = new Map<string, Promise<void>>();
  private redactionValues = new Map<string, string[]>();
  private closed = false;
  migrationErrors: string[] = [];
  onToolsChanged?: () => void;
  constructor(home: string, private readonly proxySettings: () => ProxyEnvironmentSettings = () => ({ proxy: "", noProxy: "" }), private readonly idleMs = PLUGIN_IDLE_MS) { this.store = new PluginStore(home, proxySettings, process.env.HOB_PLUGIN_OFFICIAL_URL); }
  private paths(id: string, profiles?: { name: string; config: Record<string, unknown> }[]) {
    return { root: fileURLToPath(new URL("../../", import.meta.url)), plugin_root: join(this.store.home, "plugins", id), plugin_data: join(this.store.home, "plugin-data", id), ...(profiles ? { profiles } : {}) };
  }
  private pluginKeepAlive(id: string): boolean {
    try {
      const { manifest } = this.store.files(id);
      const extensions = isObject(manifest.extensions) ? manifest.extensions["com.hob.plugins"] : undefined;
      return isObject(extensions) && extensions.keepAlive === true;
    } catch { return false; }
  }
  private key(id: string, name: string): string { return JSON.stringify([id, name]); }
  states(id?: string): PluginServiceState[] {
    return [...this.connections.values()].filter(c => !id || c.state.pluginId === id).map(c => structuredClone(c.state));
  }
  binDirsForAssistant(assistantId: string): string[] {
    const dirs: string[] = [];
    for (const plugin of this.store.list()) {
      if (!plugin.enabled || (plugin.assistants && !plugin.assistants.includes(assistantId))) continue;
      const dir = this.store.binDir(plugin.id);
      if (dir) dirs.push(dir);
    }
    return dirs;
  }
  credentialProviders(assistantId: string, role?: PluginCredentialRole): CredentialProvider[] {
    const providers: CredentialProvider[] = [];
    for (const plugin of this.store.list()) {
      if (!plugin.enabled || (plugin.assistants && !plugin.assistants.includes(assistantId))) continue;
      providers.push(...this.providersForPlugin(plugin.id, role));
    }
    return providers;
  }
  credentialProvidersForPlugin(pluginId: string, role?: PluginCredentialRole): CredentialProvider[] {
    return this.providersForPlugin(pluginId, role);
  }
  credentialRolesForPlugin(pluginId: string): PluginCredentialRole[] {
    return [...new Set(this.providersForPlugin(pluginId).map(provider => provider.role))];
  }
  private providersForPlugin(pluginId: string, role?: PluginCredentialRole): CredentialProvider[] {
    const plugin = this.store.list().find(item => item.id === pluginId);
    if (!plugin?.enabled) return [];
    const providers: CredentialProvider[] = [];
    for (const state of this.connections.values()) {
      if (state.state.pluginId !== plugin.id || !["connected", "idle", "connecting"].includes(state.state.status)) continue;
      for (const tool of state.state.tools) {
        const meta = isObject(tool._meta) ? tool._meta : undefined;
        const value = meta?.["hob/credentials"];
        if (!["list", "secret", "generate", "save", "delete"].includes(String(value)) || (role && value !== role)) continue;
        if (plugin.tools[tool.name]?.enabled === false) continue;
        providers.push({ pluginId: plugin.id, providerName: this.displayName(plugin.id), service: state.state.name, tool: tool.name, role: value as PluginCredentialRole });
      }
    }
    return providers;
  }
  hasCredentialProvider(assistantId: string): boolean {
    return this.credentialProviders(assistantId, "list").length > 0 && this.credentialProviders(assistantId, "secret").length > 0;
  }
  hasPasswordGenerator(assistantId: string): boolean {
    return this.hasCredentialProvider(assistantId)
      && this.credentialProviders(assistantId, "generate").length > 0
      && this.credentialProviders(assistantId, "save").length > 0;
  }
  async callCredential(provider: CredentialProvider, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.call(provider.pluginId, provider.service, provider.tool, args, signal);
    if (response.isError) {
      const message = (response.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join(" ").trim() || "凭据工具调用失败";
      throw new Error(this.redact(provider.pluginId, message));
    }
    if (!isObject(response.structuredContent)) throw new Error("凭据工具没有返回结构化结果");
    return response.structuredContent;
  }
  private findLoginTool(pluginId: string, role: PluginLoginRole, service?: string): { connection: Connection; tool: Tool } | undefined {
    const plugin = this.store.list().find(item => item.id === pluginId);
    if (!plugin?.enabled) return undefined;
    for (const connection of this.connections.values()) {
      const { state } = connection;
      if (state.pluginId !== pluginId || (service && state.name !== service)) continue;
      if (!["connected", "idle", "connecting"].includes(state.status)) continue;
      const tool = loginToolsIn(state.tools)[role];
      if (tool) return { connection, tool };
    }
    return undefined;
  }
  loginView(pluginId: string): PluginToolLoginView | undefined {
    const plugin = this.store.list().find(item => item.id === pluginId);
    if (!plugin?.enabled) return undefined;
    for (const connection of this.connections.values()) {
      const { state } = connection;
      if (state.pluginId !== pluginId || !state.login) continue;
      return {
        service: state.name,
        roles: [...state.login.roles],
        ...(state.login.status ? { status: { ...state.login.status } } : {}),
      };
    }
    return undefined;
  }
  private setLoginStatus(connection: Connection, status: PluginToolLoginStatus): void {
    const roles = (Object.keys(loginToolsIn(connection.state.tools)) as PluginLoginRole[]);
    connection.state.login = { roles, status };
  }
  // 登录、退出会改变插件能给出的工具（没登录时可能只有登录工具），重新列一次
  private async relistTools(pluginId: string, service: string): Promise<void> {
    const connection = this.connections.get(this.key(pluginId, service));
    const client = connection?.client;
    if (!connection || !client) return;
    try {
      const tools = await client.listTools();
      if (connection.client !== client || JSON.stringify(tools) === JSON.stringify(connection.state.tools)) return;
      connection.state.tools = tools;
      this.onToolsChanged?.();
    } catch { /* 列不出来就保留原来的工具，下次重连再列 */ }
  }
  private async refreshLoginStatus(pluginId: string, service: string, fallbackSignedIn: boolean): Promise<PluginToolLoginStatus | undefined> {
    await this.relistTools(pluginId, service);
    const statusTarget = this.findLoginTool(pluginId, "status", service);
    if (statusTarget) {
      try {
        return await this.loginStatus(pluginId, service);
      } catch {
        const fallback: PluginToolLoginStatus = { signedIn: fallbackSignedIn };
        this.setLoginStatus(statusTarget.connection, fallback);
        return fallback;
      }
    }
    const connection = this.connections.get(this.key(pluginId, service));
    if (connection?.state.login) {
      const fallback: PluginToolLoginStatus = { signedIn: fallbackSignedIn };
      connection.state.login = { ...connection.state.login, status: fallback };
      return fallback;
    }
    return undefined;
  }
  async loginStatus(pluginId: string, service?: string): Promise<PluginToolLoginStatus> {
    const target = this.findLoginTool(pluginId, "status", service);
    if (!target) throw new Error("这个插件没有声明登录状态工具");
    try {
      const response = await this.call(pluginId, target.connection.state.name, target.tool.name, {});
      const status = parseLoginStatus(response, (text) => this.redact(pluginId, text));
      this.setLoginStatus(target.connection, status);
      return status;
    } catch (error) {
      const message = this.redact(pluginId, error instanceof Error ? error.message : String(error));
      this.setLoginStatus(target.connection, { signedIn: false, error: message });
      throw new Error(message, { cause: error });
    }
  }
  async loginStart(pluginId: string, service?: string): Promise<PluginToolLoginStartResult> {
    const target = this.findLoginTool(pluginId, "start", service);
    if (!target) throw new Error("这个插件没有声明开始登录工具");
    const response = await this.call(pluginId, target.connection.state.name, target.tool.name, {});
    const result = parseLoginStart(response, (text) => this.redact(pluginId, text));
    if (result.kind === "done") {
      await this.refreshLoginStatus(pluginId, target.connection.state.name, true);
    }
    return result;
  }
  async loginPoll(pluginId: string, service?: string): Promise<PluginToolLoginPollResult> {
    const target = this.findLoginTool(pluginId, "poll", service);
    if (!target) throw new Error("这个插件没有声明登录轮询工具");
    const response = await this.call(pluginId, target.connection.state.name, target.tool.name, {});
    const result = parseLoginPoll(response, (text) => this.redact(pluginId, text));
    if (result.state === "done") {
      await this.refreshLoginStatus(pluginId, target.connection.state.name, true);
    }
    return result;
  }
  async loginLogout(pluginId: string, service?: string): Promise<{ ok: true; status?: PluginToolLoginStatus }> {
    const target = this.findLoginTool(pluginId, "logout", service);
    if (!target) throw new Error("这个插件没有声明退出登录工具");
    const response = await this.call(pluginId, target.connection.state.name, target.tool.name, {});
    parseLoginPayload(response, (text) => this.redact(pluginId, text), "退出登录失败");
    const status = await this.refreshLoginStatus(pluginId, target.connection.state.name, false);
    return { ok: true, ...(status ? { status } : {}) };
  }
  setToolErrors(id: string, service: string, errors: { name: string; reason: string }[]): void {
    const state = this.connections.get(this.key(id, service))?.state;
    if (!state) return;
    if (errors.length) state.toolErrors = errors;
    else delete state.toolErrors;
  }
  async start(): Promise<void> { await Promise.all(this.store.list().map(p => this.reload(p.id))); }
  async reload(id: string): Promise<void> {
    const previous = this.reloads.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.reloadPlugin(id));
    this.reloads.set(id, next);
    try { await next; } finally { if (this.reloads.get(id) === next) this.reloads.delete(id); }
  }
  private async reloadPlugin(id: string): Promise<void> {
    await this.stopPlugin(id);
    if (this.closed) return;
    const plugin = this.store.get(id);
    if (!plugin.enabled) return;
    let files: ReturnType<PluginStore["files"]>;
    let values: ReturnType<PluginStore["values"]> = {};
    try { files = this.store.files(id); values = plugin.profiles ? {} : this.store.values(id); }
    catch (error) {
      const reason = this.redact(id, error instanceof Error ? error.message : String(error));
      this.connections.set(this.key(id, id), { stopped: false, state: { pluginId: id, name: id, status: "error", error: reason, tools: [] } });
      return;
    }
    const { mcp, config } = files;
    if (!isObject(mcp.mcpServers)) throw new Error("mcpServers 必须是对象");
    if (!Object.keys(mcp.mcpServers).length) return;
    const profileValues = plugin.profiles ? this.store.completeProfiles(id) : undefined;
    const missing = plugin.profiles
      ? (profileValues!.length ? [] : plugin.profiles.length ? [...new Set(plugin.profiles.flatMap(profile => this.store.profileMissing(id, profile.id)))] : Object.entries(config).filter(([, field]) => field.required).map(([key]) => key))
      : validatePluginValues(config, values);
    if (missing.length) {
      for (const [name, entry] of Object.entries(mcp.mcpServers)) this.connections.set(this.key(id, name), { stopped: false, state: { pluginId: id, name, status: "pending_config", missing, tools: [], ...(isObject(entry) && typeof entry.url === "string" ? { oauth: { declared: isObject(entry.oauth), loggedIn: false } } : {}) } });
      return;
    }
    try {
      for (const key of plugin.secretCommands ?? []) {
        const command = values[key];
        if (typeof command !== "string" || !command.startsWith("!")) throw new Error(`配置项 ${key} 的命令无效`);
        try { values[key] = (await execSecret(command.slice(1), { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim(); }
        catch { throw new Error(`配置项 ${key} 的取值命令执行失败`); }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const name of Object.keys(mcp.mcpServers)) this.connections.set(this.key(id, name), { stopped: false, state: { pluginId: id, name, status: "error", error: reason, tools: [] } });
      return;
    }
    this.redactionValues.set(id, Object.entries(config).flatMap(([key, field]) => field.sensitive && typeof values[key] === "string" && values[key] ? [values[key] as string] : []).concat((profileValues ?? []).flatMap(profile => Object.entries(profile.config).filter(([key]) => config[key]?.sensitive && typeof profile.config[key] === "string" && profile.config[key]).map(([, value]) => value as string))));
    const resolved = resolvePluginMcp(mcp, config, plugin.profiles ? {} : values, this.paths(id, profileValues));
    if (!isObject(resolved.mcpServers)) throw new Error("mcpServers 必须是对象");
    await Promise.all(Object.entries(resolved.mcpServers).map(async ([name, raw]) => {
      if (isObject(raw) && raw.enabled === false) return;
      const connection: Connection = { stopped: false, raw, keepAlive: this.pluginKeepAlive(id), state: { pluginId: id, name, status: "connecting", tools: [] } };
      this.connections.set(this.key(id, name), connection);
      await this.connect(connection, raw);
    }));
  }
  oauthTarget(id: string, service: string): { home: string; id: string; service: string; url: string; config: PluginOAuthConfig } {
    const { mcp, config } = this.store.files(id);
    const values = this.store.values(id);
    const resolved = resolvePluginMcp(mcp, config, values, this.paths(id));
    const server = isObject(resolved.mcpServers) ? resolved.mcpServers[service] : undefined;
    if (!isObject(server) || typeof server.url !== "string") throw new Error(`插件服务 ${id}/${service} 不是远程服务`);
    const oauth = isObject(server.oauth) ? server.oauth as PluginOAuthConfig : {};
    return { home: this.store.home, id, service, url: server.url, config: oauth };
  }
  private scheduleRetry(connection: Connection, raw: unknown): void {
    if (connection.stopped || this.closed || connection.retry) return;
    const delay = Math.min(1000 * 2 ** Math.min(connection.retryCount ?? 0, 5), 30_000);
    connection.retryCount = (connection.retryCount ?? 0) + 1;
    connection.retry = setTimeout(() => {
      connection.retry = undefined;
      void this.connect(connection, raw);
    }, delay);
    connection.retry.unref();
  }
  private armIdle(connection: Connection): void {
    if (connection.idle) clearTimeout(connection.idle);
    connection.idle = undefined;
    if (connection.keepAlive || connection.kind !== "stdio" || connection.stopped || this.closed || !connection.client || connection.state.status !== "connected") return;
    connection.idle = setTimeout(() => void this.stopIdle(connection), this.idleMs);
    connection.idle.unref();
  }
  private async stopIdle(connection: Connection): Promise<void> {
    connection.idle = undefined;
    if (connection.stopped || this.closed || connection.keepAlive || connection.kind !== "stdio" || connection.activeCalls || connection.state.status !== "connected") {
      this.armIdle(connection);
      return;
    }
    const client = connection.client;
    if (!client) return;
    connection.client = undefined;
    connection.state.status = "idle";
    connection.closing = client.close().catch(() => {}).finally(() => {
      if (connection.closing) connection.closing = undefined;
    });
    await connection.closing;
  }
  private async connect(connection: Connection, raw: unknown): Promise<void> {
    if (connection.stopped || this.closed) return;
    if (connection.connecting) return connection.connecting;
    const task = this.connectOnce(connection, raw);
    connection.connecting = task;
    try { await task; } finally { if (connection.connecting === task) connection.connecting = undefined; }
  }
  private async connectOnce(connection: Connection, raw: unknown): Promise<void> {
    if (connection.stopped || this.closed) return;
    const state = connection.state;
    // 闲置后重新拉起：工具列表照旧时不算工具变化
    const wake = state.status === "idle" ? JSON.stringify(state.tools) : undefined;
    state.status = "connecting"; delete state.error;
    const parsed = validateMcpServerConfig(state.name, raw);
    if (parsed.kind === "invalid") { state.status = "error"; state.error = this.redact(state.pluginId, parsed.error); this.scheduleRetry(connection, raw); return; }
    connection.kind = parsed.kind;
    const client = new McpClient({ name: "Hob", version: "1.0", requestTimeoutMs: (parsed.config.timeout ?? 15) * 1000 });
    connection.client = client;
    client.onClose(() => {
      if (connection.stopped || this.closed || connection.client !== client) return;
      connection.client = undefined;
      if (connection.idle) clearTimeout(connection.idle);
      connection.idle = undefined;
      state.status = "error"; state.error = "MCP 连接已断开"; state.tools = []; delete state.login;
      this.onToolsChanged?.();
      this.scheduleRetry(connection, raw);
    });
    let hadCredentials = false;
    let transport: StdioTransport | StreamableHttpTransport | undefined;
    try {
      if (parsed.kind === "http") {
        connection.hadCredentials = hadCredentials = pluginOAuthLoggedIn(this.oauthTarget(state.pluginId, state.name));
        state.oauth = { declared: isObject(raw) && isObject(raw.oauth), loggedIn: hadCredentials };
      }
      transport = parsed.kind === "stdio"
        ? new StdioTransport({ command: parsed.config.command, args: parsed.config.args, cwd: parsed.config.cwd, env: { ...parsed.config.env, ...proxyEnvironment(process.env, this.proxySettings()) } })
        : new StreamableHttpTransport({ url: parsed.config.url, headers: parsed.config.headers, authProvider: pluginOAuthProvider(this.oauthTarget(state.pluginId, state.name)) });
      await client.connect(transport);
      const tools = await client.listTools();
      if (connection.stopped || this.closed) { await client.close(); return; }
      state.tools = tools; connection.retryCount = 0;
      const loginTools = loginToolsIn(tools);
      const loginRoles = Object.keys(loginTools) as PluginLoginRole[];
      if (loginRoles.length) {
        let loginStatus: PluginToolLoginStatus | undefined;
        if (loginTools.status) {
          try {
            const response = await client.callTool(loginTools.status.name, {});
            if (connection.stopped || this.closed) { await client.close(); return; }
            loginStatus = parseLoginStatus(response, (text) => this.redact(state.pluginId, text));
          } catch (error) {
            if (connection.stopped || this.closed) { await client.close(); return; }
            loginStatus = { signedIn: false, error: this.redact(state.pluginId, error instanceof Error ? error.message : String(error)) };
          }
        }
        state.login = { roles: loginRoles, ...(loginStatus ? { status: loginStatus } : {}) };
      } else {
        delete state.login;
      }
      // 有的服务不登录也能列出工具（如 Gmail），没登录就不算连上：工具留着给插件页看，不交给助手
      if (state.oauth?.declared && !hadCredentials) { state.status = "needs_login"; state.error = undefined; if (connection.client === client) connection.client = undefined; await client.close().catch(() => {}); }
      else { state.status = "connected"; this.armIdle(connection); }
      if (wake === undefined || state.status !== "connected" || JSON.stringify(tools) !== wake) this.onToolsChanged?.();
    } catch (error) {
      if (connection.stopped || this.closed) return;
      const authError = error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError || (error instanceof McpHttpError && (error.status === 401 || error.status === 403));
      state.status = authError ? (hadCredentials || (parsed.kind === "http" && pluginOAuthNeedsRelogin(this.oauthTarget(state.pluginId, state.name))) ? "needs_relogin" : "needs_login") : "error";
      // 本地服务启动就退出时，原因在它的 stderr 里；只取最后几行
      const stderr = transport instanceof StdioTransport ? transport.stderr.trim().split("\n").slice(-5).join("\n").slice(-600) : "";
      const message = error instanceof Error ? error.message : String(error);
      state.error = state.status === "needs_login" ? undefined : this.redact(state.pluginId, stderr ? `${message}：${stderr}` : message);
      if (connection.client === client) connection.client = undefined;
      await client.close().catch(() => {});
      this.scheduleRetry(connection, raw);
    }
  }
  displayName(id: string): string {
    try { const { manifest } = this.store.files(id); return typeof manifest.displayName === "string" ? manifest.displayName : typeof manifest.name === "string" ? manifest.name : id; }
    catch { return id; }
  }
  redact(id: string, message: string): string {
    for (const value of this.redactionValues.get(id) ?? []) message = message.replaceAll(value, "[已隐藏]");
    for (const [key, raw] of Object.entries(readSecrets(this.store.home))) {
      if (key.startsWith(`plugin:${id}:config:`) || key.startsWith(`plugin:${id}:profile:`)) {
        const value: unknown = JSON.parse(raw);
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) if (typeof item === "string" && item) message = message.replaceAll(item, "[已隐藏]");
      }
      if (!key.startsWith(`plugin:${id}:oauth:`)) continue;
      const stored = JSON.parse(raw) as { tokens?: { access_token?: string; refresh_token?: string } };
      for (const token of [stored.tokens?.access_token, stored.tokens?.refresh_token]) if (token) message = message.replaceAll(token, "[已隐藏]");
    }
    return message;
  }
  private async ensureConnected(connection: Connection): Promise<void> {
    if (connection.closing) await connection.closing;
    if (connection.stopped || this.closed) throw new Error(`插件服务 ${connection.state.pluginId}/${connection.state.name} 未连接`);
    if (connection.state.status === "idle" || connection.state.status === "connecting") await this.connect(connection, connection.raw);
    if (connection.state.status !== "connected" || !connection.client) throw new Error(connection.state.error ?? `插件服务 ${connection.state.pluginId}/${connection.state.name} 未连接`);
  }
  async call(id: string, service: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const connection = this.connections.get(this.key(id, service));
    if (!connection) throw new Error(`插件服务 ${id}/${service} 未连接`);
    await this.ensureConnected(connection);
    const client = connection.client;
    if (!client) throw new Error(connection.state.error ?? `插件服务 ${id}/${service} 未连接`);
    const hadCredentials = connection.hadCredentials === true;
    connection.activeCalls = (connection.activeCalls ?? 0) + 1;
    if (connection.idle) clearTimeout(connection.idle);
    connection.idle = undefined;
    try { return await client.callTool(tool, args, signal ? { signal, timeoutMs: 0 } : {}); }
    catch (error) {
      const authError = error instanceof McpOAuthAuthorizationRequiredError || (error instanceof McpHttpError && (error.status === 401 || error.status === 403));
      if (authError) connection.state.status = hadCredentials ? "needs_relogin" : "needs_login";
      const reason = this.redact(id, error instanceof Error ? error.message : String(error));
      connection.state.error = reason;
      const name = this.displayName(id);
      const message = authError
        ? `${name} ${hadCredentials ? "需要重新登录" : "还没登录"}：请用户到「插件 → ${name}」点「${hadCredentials ? "重新连接" : "连接"}」。服务返回：${reason}`
        : reason;
      if (connection.state.status !== "connected") this.onToolsChanged?.();
      throw new Error(message, { cause: error });
    } finally {
      connection.activeCalls!--;
      if (!connection.activeCalls) {
        for (const resolve of connection.onIdle ?? []) resolve();
        connection.onIdle?.clear();
        this.armIdle(connection);
      }
    }
  }
  async stopPlugin(id: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, connection] of this.connections) {
      if (connection.state.pluginId !== id) continue;
      connection.stopped = true;
      if (connection.retry) clearTimeout(connection.retry);
      if (connection.idle) clearTimeout(connection.idle);
      connection.idle = undefined;
      this.connections.delete(key);
      if (connection.client || connection.closing) {
        const client = connection.client;
        closing.push((async () => {
          if (connection.activeCalls) await new Promise<void>(resolve => (connection.onIdle ??= new Set()).add(resolve));
          if (connection.closing) await connection.closing;
          else if (client) await client.close().catch(() => {});
        })());
      }
    }
    if (closing.length) this.onToolsChanged?.();
    await Promise.all(closing);
    this.redactionValues.delete(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.reloads.values()].map(task => task.catch(() => {})));
    await Promise.all([...new Set([...this.connections.values()].map(c => c.state.pluginId))].map(id => this.stopPlugin(id)));
  }
}

export function pluginToolName(pluginId: string, toolName: string): string {
  return `${pluginId}_${toolName}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function pluginToolDisplayNames(host: PluginHost): Record<string, string> {
  const names: Record<string, string> = Object.create(null);
  for (const plugin of host.store.list()) {
    try {
      const { mcp } = host.store.files(plugin.id);
      if (isObject(mcp.mcpServers)) {
        const services = Object.keys(mcp.mcpServers);
        for (const service of services) names[service.replaceAll("-", "_")] = service;
        if (services.length === 1) names[`plugin:${pluginToolName(plugin.id, "")}`] = services[0];
      }
    } catch { /* A broken plugin cannot supply display names. */ }
    for (const service of host.states(plugin.id)) for (const tool of service.tools) {
      if (!visibleToModel(tool)) continue;
      const name = pluginToolName(plugin.id, tool.name);
      names[name] ??= `${service.name} · ${tool.name}`;
    }
  }
  return names;
}

export type PluginCardHandler = (card: { pluginId: string; pluginName: string; service: string; callbackTool?: string; card: Card }) => void | Promise<void>;
export type PluginCardErrorHandler = (pluginId: string, message: string) => void | Promise<void>;
export interface PluginToolOptions {
  onCard?: PluginCardHandler;
  onCardError?: PluginCardErrorHandler;
}

export type PluginAgentTool = Omit<ToolDefinition<any, any>, "execute"> & {
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: Parameters<ToolDefinition<any, any>["execute"]>[3]): ReturnType<ToolDefinition<any, any>["execute"]>;
};

function visibleToModel(tool: Tool): boolean {
  const meta = tool._meta;
  const ui = isObject(meta?.ui) ? meta.ui : undefined;
  const visibility = ui?.visibility;
  return !(Array.isArray(visibility) && visibility.every((item) => item !== "model"));
}

/** The same tool set is used for assistant, group, worker and future script calls. */
export function pluginToolsForAssistant(host: PluginHost, assistantId: string, reservedNames: ReadonlySet<string> = new Set(), options: PluginToolOptions = {}): PluginAgentTool[] {
  const result: PluginAgentTool[] = [];
  const used = new Set(reservedNames);
  for (const plugin of host.store.list()) {
    if (!plugin.enabled || (plugin.assistants && !plugin.assistants.includes(assistantId))) continue;
    const states = host.states(plugin.id).filter(state => ["connected", "idle", "connecting"].includes(state.status));
    const visibleStates = states.map((state) => ({ ...state, tools: state.tools.filter(visibleToModel) }));
    const count = visibleStates.reduce((n, state) => n + state.tools.length, 0);
    for (const state of visibleStates) {
      const errors: { name: string; reason: string }[] = [];
      for (const tool of state.tools) {
        if (!visibleToModel(tool)) continue;
        const setting = plugin.tools[tool.name];
        if (setting?.enabled === false) continue;
        const name = pluginToolName(plugin.id, tool.name);
        if (name.length > 64 || used.has(name)) {
          errors.push({ name: tool.name, reason: name.length > 64 ? `工具名称超过 64 字符：${name}` : `工具名称冲突：${name}` });
          continue;
        }
        used.add(name);
        result.push({
          name, label: `${plugin.id} · ${tool.title ?? tool.name}`,
          description: tool.description ?? "",
          parameters: normalizeMcpInputSchema(tool.inputSchema) as TSchema,
          namespace: { name: plugin.id },
          exposure: count > 10 ? "deferred" : "direct",
          annotations: tool.annotations,
          execute: async (_callId, args, signal) => {
            if (!isObject(args)) throw new Error("插件工具参数必须是对象");
            const response = await host.call(plugin.id, state.name, tool.name, args, signal);
            if (response.isError) response.content = response.content.map(block => block.type === "text" ? { ...block, text: host.redact(plugin.id, block.text) } : block);
            const limited = await limitMcpContent(toLlmContent(response));
            const content = [...limited.content];
            const cardMeta = isObject(response._meta) ? response._meta["hob/card"] : undefined;
            if (cardMeta !== undefined) {
              const validation = validateCard(cardMeta, { mode: "plugin" });
              if (!validation.ok) {
                const reason = `${host.displayName(plugin.id)} 的卡片格式不对：${validation.error.error}`;
                await options.onCardError?.(plugin.id, reason);
                content.push({ type: "text", text: reason });
              } else {
                let card = validation.value.card;
                if (validation.value.unsupportedCount) {
                  card = {
                    ...card,
                    body: {
                      ...card.body,
                      elements: [...card.body.elements, { tag: "div", text: t("有 {count} 个组件 Hob 显示不了", { count: validation.value.unsupportedCount }) }],
                    },
                  };
                }
                const config = card.config as { callback_tool?: unknown } | undefined;
                if (options.onCard) {
                  await options.onCard({
                    pluginId: plugin.id,
                    pluginName: host.displayName(plugin.id),
                    service: state.name,
                    ...(typeof config?.callback_tool === "string" ? { callbackTool: config.callback_tool } : {}),
                    card,
                  });
                  content.push({ type: "text", text: `（${host.displayName(plugin.id)} 的卡片「${cardTitle(card) || "未命名"}」已显示给用户）` });
                }
              }
            }
            return {
              content,
              details: response.structuredContent,
              ...(response.structuredContent !== undefined ? { structuredContent: response.structuredContent as never } : {}),
              isError: response.isError,
            };
          },
        });
      }
      host.setToolErrors(plugin.id, state.name, errors);
    }
  }
  return result;
}

function isCommandTool(tool: Tool): boolean {
  return isObject(tool._meta) && tool._meta["hob/command"] === true;
}

/** Hidden plugin tools explicitly tagged with _meta["hob/command"]: true are callable only via script-tools. */
export function pluginCommandToolsForAssistant(host: PluginHost, assistantId: string, reservedNames: ReadonlySet<string> = new Set()): (PluginAgentTool & { hidden: true })[] {
  const result: (PluginAgentTool & { hidden: true })[] = [];
  const used = new Set(reservedNames);
  for (const plugin of host.store.list()) {
    if (!plugin.enabled || (plugin.assistants && !plugin.assistants.includes(assistantId))) continue;
    const states = host.states(plugin.id).filter(state => ["connected", "idle", "connecting"].includes(state.status));
    for (const state of states) {
      for (const tool of state.tools) {
        if (visibleToModel(tool) || !isCommandTool(tool)) continue;
        const name = pluginToolName(plugin.id, tool.name);
        if (name.length > 64 || used.has(name)) continue;
        used.add(name);
        result.push({
          name,
          label: `${plugin.id} · ${tool.title ?? tool.name}`,
          description: tool.description ?? "",
          parameters: normalizeMcpInputSchema(tool.inputSchema) as TSchema,
          namespace: { name: plugin.id },
          exposure: "direct",
          annotations: tool.annotations,
          hidden: true,
          execute: async (_callId, args, signal) => {
            if (!isObject(args)) throw new Error("插件工具参数必须是对象");
            const response = await host.call(plugin.id, state.name, tool.name, args, signal);
            if (response.isError) response.content = response.content.map(block => block.type === "text" ? { ...block, text: host.redact(plugin.id, block.text) } : block);
            const limited = await limitMcpContent(toLlmContent(response));
            return {
              content: [...limited.content],
              details: response.structuredContent,
              ...(response.structuredContent !== undefined ? { structuredContent: response.structuredContent as never } : {}),
              isError: response.isError,
            };
          },
        });
      }
    }
  }
  return result;
}

