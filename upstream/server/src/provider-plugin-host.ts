// 共享 Bun 供应商插件宿主进程管理器：按需启动、闲置 10 分钟自动停、崩溃下次再起、stdio NDJSON 通信。
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  PluginAuthMethodView,
  PluginAuthPromptView,
  PluginProviderUsageView,
  ProviderHostStatus,
  ProviderHostStatusView,
} from "../../shared/types.ts";
import { BunRuntime, sanitizedBunEnv } from "./bun-runtime.ts";
import type { ProxyEnvironmentSettings } from "./network-proxy.ts";

interface RpcScope {
  pluginId: string;
  providerId: string;
  accountId: string;
}

/** 默认不因闲置停宿主：插件（如 agy-cli）把对话会话放在宿主进程里，停了下次就整段重发、缓存全丢。0 表示不停。 */
export const DEFAULT_HOST_IDLE_MS = 0;

export interface HostPluginLoadSpec {
  pluginId: string;
  dataDir: string;
  packages: { package: string; dir: string; version?: string }[];
  userConfig?: { provider?: Record<string, unknown> };
}

export interface HostModelEntry {
  id: string;
  apiId: string;
  name: string;
  npm: string;
  url: string;
  context: number;
  output: number;
  reasoning: boolean;
  image: boolean;
  variants: string[];
  cost?: { input: number; output: number };
  free?: boolean;
  also?: string[];
}

export interface HostLoadedProvider {
  providerId: string;
  name: string;
  npm: string;
  api: string;
  icon: string;
  single: boolean;
  methods: PluginAuthMethodView[];
  usageSupported: boolean;
  refreshSupported: boolean;
  refreshLead: number;
  cli: { name: string; manual?: string } | null;
  models: HostModelEntry[];
}

export interface HostLoadedPlugin {
  pluginId: string;
  error?: string;
  providers: HostLoadedProvider[];
}

export interface HostFetchParams {
  pluginId: string;
  provider: string;
  accountId: string;
  auth: Record<string, unknown>;
  model: string;
  npm: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  session?: string;
  seedProvider?: { models?: Record<string, unknown> };
}

export interface HostFetchResponse {
  status: number;
  headers: Record<string, string>;
  stream: AsyncIterable<Buffer>;
}

export interface HostAuthUpdateEvent {
  requestId: string;
  pluginId: string;
  provider: string;
  accountId: string;
  auth: Record<string, unknown>;
}

export interface ProviderPluginHostOptions {
  home: string;
  bun: BunRuntime;
  proxy?: () => ProxyEnvironmentSettings;
  getPlugins: () => HostPluginLoadSpec[];
  onAuthUpdate?: (event: HostAuthUpdateEvent) => void;
  onStatusChange?: (status: ProviderHostStatusView) => void;
  onLoaded?: (plugins: HostLoadedPlugin[]) => void;
  redact?: (text: string) => string;
  /** 闲置自动停机时长，默认 10 分钟；测试可调短。 */
  idleMs?: number;
  /** 宿主脚本路径覆盖（测试可用）。 */
  hostScriptPath?: string;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  scope?: RpcScope;
}

interface StreamingFetch {
  scope?: RpcScope;
  headResolved: boolean;
  resolveHead: (head: { status: number; headers: Record<string, string> }) => void;
  rejectHead: (error: Error) => void;
  chunks: Buffer[];
  ended: boolean;
  error?: Error;
  wake?: () => void;
}

export class HostRpcError extends Error {
  readonly signIn?: "expired" | "kept" | "renewed";
  constructor(message: string, signIn?: "expired" | "kept" | "renewed") {
    super(message);
    this.signIn = signIn;
  }
}

/** 唯一共享的 Bun 宿主进程：全部启用的带模型插件共用它。 */
export class ProviderPluginHost {
  private child: ChildProcess | null = null;
  private status: ProviderHostStatus = "stopped";
  private lastError?: string;
  private startPromise?: Promise<HostLoadedPlugin[]>;
  private stopPromise?: Promise<void>;
  private loadedFingerprint = "";
  private loadedSnapshot: HostLoadedPlugin[] = [];
  private nextId = 1;
  private pending = new Map<string, PendingRpc>();
  private fetches = new Map<string, StreamingFetch>();
  private activeCalls = 0;
  private activeSignIns = 0;
  private idleTimer?: NodeJS.Timeout;
  private idleWaiters = new Set<() => void>();
  private stopping = false;
  private closed = false;
  private stderrLines: string[] = [];

  constructor(private readonly options: ProviderPluginHostOptions) {}

  get idleMs(): number {
    if (this.options.idleMs !== undefined) return this.options.idleMs;
    const raw = Number(process.env.HOB_PROVIDER_HOST_IDLE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOST_IDLE_MS;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  statusView(): ProviderHostStatusView {
    return {
      status: this.status,
      bunVersion: this.options.bun.version,
      bunInstalled: this.options.bun.installedPath() !== null,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      idleMs: this.idleMs,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  loaded(): HostLoadedPlugin[] {
    return this.loadedSnapshot;
  }

  private redact(text: string): string {
    return this.options.redact ? this.options.redact(text) : text;
  }

  private setStatus(status: ProviderHostStatus, lastError?: string): void {
    const cleanErr = lastError ? this.redact(lastError) : undefined;
    if (this.status === status && this.lastError === cleanErr) return;
    this.status = status;
    this.lastError = cleanErr;
    this.options.onStatusChange?.(this.statusView());
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private scheduleIdleCheck(): void {
    this.clearIdleTimer();
    if (!this.child || this.stopping || this.closed) return;
    if (this.activeCalls > 0 || this.activeSignIns > 0) return;
    if (this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.activeCalls === 0 && this.activeSignIns === 0 && this.child) {
        void this.stop();
      }
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private activityReleased(): void {
    if (this.activeCalls === 0 && this.activeSignIns === 0) {
      const waiters = [...this.idleWaiters];
      this.idleWaiters.clear();
      for (const resolve of waiters) resolve();
    }
    this.scheduleIdleCheck();
  }

  private waitForIdle(): Promise<void> {
    if (this.activeCalls === 0 && this.activeSignIns === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private rpcScope(params: Record<string, unknown>): RpcScope | undefined {
    if (typeof params.pluginId !== "string" || typeof params.provider !== "string") return undefined;
    return {
      pluginId: params.pluginId,
      providerId: params.provider,
      accountId: typeof params.accountId === "string" ? params.accountId : "",
    };
  }

  private scopeMatches(scope: RpcScope | undefined, event: { pluginId: string; provider: string; accountId: string }): boolean {
    return Boolean(scope && scope.pluginId === event.pluginId && scope.providerId === event.provider && scope.accountId === event.accountId);
  }

  /** 标记一个等待中的登录会话占用宿主，防止登录中途闲置停机。 */
  holdSignIn(): () => void {
    this.activeSignIns++;
    this.clearIdleTimer();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeSignIns = Math.max(0, this.activeSignIns - 1);
      this.activityReleased();
    };
  }

  private fingerprint(plugins: HostPluginLoadSpec[]): string {
    return JSON.stringify(plugins.map((p) => ({
      id: p.pluginId,
      dataDir: p.dataDir,
      pkgs: p.packages.map((pkg) => ({ package: pkg.package, dir: pkg.dir, version: pkg.version ?? "" })),
      cfg: p.userConfig ?? null,
    })));
  }

  /** 按需启动（或插件集合变动时重新加载）；不会在 Hob 启动时自动拉起。 */
  async ensureStarted(): Promise<HostLoadedPlugin[]> {
    if (this.closed) throw new Error("Hob 正在关闭，无法启动插件宿主");
    if (this.stopPromise) await this.stopPromise;
    const desired = this.options.getPlugins();
    const fp = this.fingerprint(desired);

    if (this.child && !this.stopping && this.status === "running" && this.loadedFingerprint === fp) {
      this.scheduleIdleCheck();
      return this.loadedSnapshot;
    }

    if (this.startPromise) {
      await this.startPromise;
      if (this.child && !this.stopping && this.status === "running" && this.loadedFingerprint === fp) {
        return this.loadedSnapshot;
      }
    }

    if (this.child && !this.stopping && this.status === "running" && this.loadedFingerprint !== fp) {
      // 插件集合或版本变了：先等正在进行的请求和登录结束，再停掉旧进程，避免在同一进程里 import 新旧版本。
      await this.waitForIdle();
      if (this.child && !this.stopping && this.loadedFingerprint !== fp) {
        await this.stop();
      }
    }

    this.startPromise = this.spawnAndInit(desired, fp).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async spawnAndInit(desired: HostPluginLoadSpec[], fp: string): Promise<HostLoadedPlugin[]> {
    this.clearIdleTimer();
    this.stopping = false;
    this.stderrLines = [];
    this.setStatus("starting");

    let bun: string;
    try {
      bun = await this.options.bun.ensureBun();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.setStatus("error", msg);
      throw error;
    }

    const hostCwd = mkdtempSync(join(tmpdir(), "hob-provider-host-"));
    const cleanupHostCwd = () => rmSync(hostCwd, { recursive: true, force: true });
    const script = this.options.hostScriptPath ?? fileURLToPath(new URL("./provider-host.mjs", import.meta.url));
    const env = sanitizedBunEnv(this.options.proxy?.() ?? { proxy: "", noProxy: "" });

    const child = spawn(bun, [script], {
      cwd: hostCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    // 子进程意外退出时写入 stdin 可能触发异步 EPIPE，这里吞掉并由 exit/rpc 错误处理接管
    child.stdin?.on("error", () => {});

    const rl = createInterface({ input: child.stdout!, terminal: false });
    rl.on("line", (line) => this.handleStdoutLine(line));

    const errRl = createInterface({ input: child.stderr!, terminal: false });
    errRl.on("line", (line) => {
      const cleaned = this.redact(line).slice(0, 400);
      if (cleaned) {
        this.stderrLines.push(cleaned);
        if (this.stderrLines.length > 20) this.stderrLines.shift();
      }
    });

    child.on("error", (error) => {
      if (this.child !== child) return;
      cleanupHostCwd();
      this.handleExit(`宿主进程启动失败：${error.message}`);
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      cleanupHostCwd();
      if (this.stopping || this.closed) {
        this.child = null;
        this.loadedFingerprint = "";
        this.setStatus("stopped");
        return;
      }
      const tail = this.stderrLines.slice(-5).join("\n").slice(-600);
      const base = signal ? `宿主进程异常退出（信号 ${signal}）` : `宿主进程异常退出（退出码 ${code ?? "未知"}）`;
      this.handleExit(tail ? `${base}：${tail}` : base);
    });

    try {
      const res = await this.rawRpc<{ plugins: HostLoadedPlugin[] }>("init", { plugins: desired });
      if (this.child !== child) throw new Error("宿主进程在初始化期间已停止");
      this.loadedFingerprint = fp;
      this.loadedSnapshot = res.plugins;
      this.setStatus("running");
      this.options.onLoaded?.(res.plugins);
      this.scheduleIdleCheck();
      return res.plugins;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.stop().catch(() => {});
      this.setStatus("error", msg);
      throw error;
    }
  }

  private handleExit(reason: string): void {
    this.clearIdleTimer();
    this.child = null;
    this.loadedFingerprint = "";
    const redacted = this.redact(reason);
    const err = new Error(redacted);
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(err);
    }
    for (const [id, f] of this.fetches) {
      this.fetches.delete(id);
      if (!f.headResolved) {
        f.headResolved = true;
        f.rejectHead(err);
      } else {
        f.error = err;
        f.ended = true;
        f.wake?.();
      }
    }
    this.setStatus("error", redacted);
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof msg.id === "string" ? msg.id : "";

    // 主动事件（无 id）
    if (!id && typeof msg.event === "string") {
      if (msg.event === "auth_update" && msg.auth && typeof msg.auth === "object") {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        const event = {
          requestId,
          pluginId: String(msg.pluginId ?? ""),
          provider: String(msg.provider ?? ""),
          accountId: String(msg.accountId ?? ""),
        };
        const scope = this.pending.get(requestId)?.scope ?? this.fetches.get(requestId)?.scope;
        if (!requestId || !this.scopeMatches(scope, event)) return;
        this.options.onAuthUpdate?.({ ...event, auth: msg.auth as Record<string, unknown> });
      }
      return;
    }

    // 流式 fetch 事件
    const f = this.fetches.get(id);
    if (f) {
      if (msg.event === "head") {
        if (!f.headResolved) {
          f.headResolved = true;
          f.resolveHead({
            status: Number(msg.status) || 500,
            headers: (msg.headers && typeof msg.headers === "object" ? msg.headers : {}) as Record<string, string>,
          });
        }
        return;
      }
      if (msg.event === "chunk" && typeof msg.data === "string") {
        f.chunks.push(Buffer.from(msg.data, "base64"));
        f.wake?.();
        return;
      }
      this.fetches.delete(id);
      if (msg.error && typeof msg.error === "object") {
        const errObj = msg.error as { message?: unknown; signIn?: "expired" | "kept" | "renewed" };
        const err = new HostRpcError(this.redact(String(errObj.message ?? "请求失败")), errObj.signIn);
        if (!f.headResolved) {
          f.headResolved = true;
          f.rejectHead(err);
        } else {
          f.error = err;
          f.ended = true;
          f.wake?.();
        }
      } else {
        if (!f.headResolved) {
          f.headResolved = true;
          f.rejectHead(new Error("插件未返回响应头"));
        } else {
          f.ended = true;
          f.wake?.();
        }
      }
      return;
    }

    // 普通 RPC 响应
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (msg.error && typeof msg.error === "object") {
      const errObj = msg.error as { message?: unknown; signIn?: "expired" | "kept" | "renewed" };
      p.reject(new HostRpcError(this.redact(String(errObj.message ?? "调用失败")), errObj.signIn));
    } else {
      p.resolve(msg.result);
    }
  }

  private sendLine(msg: Record<string, unknown>): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("插件宿主进程未运行");
    }
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private sendAbort(id: string): void {
    try {
      if (this.child?.stdin && !this.child.stdin.destroyed) {
        this.child.stdin.write(`${JSON.stringify({ method: "abort", params: { id } })}\n`);
      }
    } catch { /* ignore */ }
  }

  private rawRpc<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const id = String(this.nextId++);
    const scope = this.rpcScope(params);
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("操作已取消"));
        return;
      }
      const onAbort = () => {
        this.sendAbort(id);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        scope,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      try {
        this.sendLine({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 带按需启动与闲置计数的普通 RPC。 */
  async rpc<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    await this.ensureStarted();
    this.activeCalls++;
    this.clearIdleTimer();
    try {
      return await this.rawRpc<T>(method, params, signal);
    } finally {
      this.activeCalls = Math.max(0, this.activeCalls - 1);
      this.activityReleased();
    }
  }

  /** 带按需启动、取消传播与流式读取的 fetch RPC。 */
  async fetch(params: HostFetchParams, signal?: AbortSignal): Promise<HostFetchResponse> {
    await this.ensureStarted();
    const id = String(this.nextId++);
    this.activeCalls++;
    this.clearIdleTimer();

    let callReleased = false;
    const releaseCall = () => {
      if (callReleased) return;
      callReleased = true;
      this.activeCalls = Math.max(0, this.activeCalls - 1);
      this.activityReleased();
    };

    const onAbort = () => {
      this.sendAbort(id);
      const rec = this.fetches.get(id);
      if (rec) {
        this.fetches.delete(id);
        const err = new DOMException("Aborted", "AbortError");
        if (!rec.headResolved) {
          rec.headResolved = true;
          rec.rejectHead(err);
        } else {
          rec.error = err;
          rec.ended = true;
          rec.wake?.();
        }
      }
      releaseCall();
    };

    if (signal?.aborted) {
      releaseCall();
      throw new DOMException("Aborted", "AbortError");
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    let resolveHead!: (head: { status: number; headers: Record<string, string> }) => void;
    let rejectHead!: (error: Error) => void;
    const headPromise = new Promise<{ status: number; headers: Record<string, string> }>((res, rej) => {
      resolveHead = res;
      rejectHead = rej;
    });

    const record: StreamingFetch = {
      scope: this.rpcScope(params as unknown as Record<string, unknown>),
      headResolved: false,
      resolveHead,
      rejectHead,
      chunks: [],
      ended: false,
    };
    this.fetches.set(id, record);

    try {
      this.sendLine({ id, method: "fetch", params: params as unknown as Record<string, unknown> });
    } catch (error) {
      this.fetches.delete(id);
      signal?.removeEventListener("abort", onAbort);
      releaseCall();
      throw error;
    }

    let head: { status: number; headers: Record<string, string> };
    try {
      head = await headPromise;
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      releaseCall();
      throw error;
    }

    const host = this;
    const stream: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            if (record.chunks.length > 0) {
              yield record.chunks.shift()!;
              continue;
            }
            if (record.error) throw record.error;
            if (record.ended) return;
            await new Promise<void>((resolve) => {
              record.wake = resolve;
            });
            record.wake = undefined;
          }
        } finally {
          if (!record.ended && host.fetches.has(id)) {
            host.fetches.delete(id);
            host.sendAbort(id);
          }
          signal?.removeEventListener("abort", onAbort);
          releaseCall();
        }
      },
    };

    return { status: head.status, headers: head.headers, stream };
  }

  /** 插件列表变动后，若宿主正在运行则同步刷新（未运行时保持停机不提前拉起）。 */
  async syncIfRunning(): Promise<void> {
    if (!this.child || this.status !== "running") return;
    const desired = this.options.getPlugins();
    if (!desired.length) {
      await this.stop();
      return;
    }
    const fp = this.fingerprint(desired);
    if (fp === this.loadedFingerprint) return;
    await this.waitForIdle();
    if (this.child && this.loadedFingerprint !== fp) await this.stop();
    if (this.options.getPlugins().length) await this.ensureStarted();
  }

  /** 主动停止 Bun 宿主进程（闲置超时或 Hob 退出时调用）。 */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.clearIdleTimer();
    const child = this.child;
    if (!child) {
      this.loadedFingerprint = "";
      if (this.status !== "stopped") this.setStatus("stopped");
      return;
    }
    this.stopping = true;
    const task = (async () => {
      const exitPromise = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });
      try {
        child.stdin?.end();
      } catch { /* ignore */ }
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      }, 1000);
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 3000);
      try {
        await exitPromise;
      } finally {
        clearTimeout(timer);
        clearTimeout(killTimer);
      }
      if (this.child === child) this.child = null;
      this.loadedFingerprint = "";
      this.stopping = false;
      this.setStatus("stopped");
    })();
    // 存的是 finally 之后的那个 promise，清理时要和它比，否则第一次停完以后 stopPromise 一直留着，后面的 stop() 都直接返回、不再停进程
    const stopped: Promise<void> = task.finally(() => {
      if (this.stopPromise === stopped) this.stopPromise = undefined;
    });
    this.stopPromise = stopped;
    return stopped;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
  }

  // ---- 类型化便捷调用 ------------------------------------------------------

  models(params: { pluginId: string; provider: string; accountId: string; auth?: Record<string, unknown>; seedModels?: Record<string, unknown> }, signal?: AbortSignal) {
    return this.rpc<{ models: HostModelEntry[]; dynamic: boolean }>("models", params as unknown as Record<string, unknown>, signal);
  }

  prompt(params: { pluginId: string; provider: string; method: number; inputs: Record<string, string> }) {
    return this.rpc<{ prompt: PluginAuthPromptView | null }>("prompt", params as unknown as Record<string, unknown>);
  }

  validatePrompt(params: { pluginId: string; provider: string; method: number; key: string; value: string }) {
    return this.rpc<{ error: string | null }>("validatePrompt", params as unknown as Record<string, unknown>);
  }

  apiKey(params: { pluginId: string; provider: string; method: number; inputs: Record<string, string>; key?: string; accountId?: string; auth?: Record<string, unknown> }, signal?: AbortSignal) {
    return this.rpc<{ ok: boolean; error?: string; provider?: string; auth?: Record<string, unknown>; accountInfo?: { displayName?: string; hint?: string } }>(
      "apiKey",
      params as unknown as Record<string, unknown>,
      signal,
    );
  }

  authorize(params: { pluginId: string; provider: string; method: number; inputs: Record<string, string>; accountId?: string; auth?: Record<string, unknown> }, signal?: AbortSignal) {
    return this.rpc<{ ok: boolean; error?: string; session?: string; url?: string; instructions?: string; method?: "auto" | "code"; opened?: boolean }>(
      "authorize",
      params as unknown as Record<string, unknown>,
      signal,
    );
  }

  callback(params: { session: string; code?: string; pluginId?: string; provider?: string; accountId?: string }, signal?: AbortSignal) {
    return this.rpc<{ ok: boolean; error?: string; provider?: string; auth?: Record<string, unknown>; accountInfo?: { displayName?: string; hint?: string } }>(
      "callback",
      params as unknown as Record<string, unknown>,
      signal,
    );
  }

  cliStatus(params: { pluginId: string; provider: string }) {
    return this.rpc<{ declared: boolean; name?: string; manual?: string; installed?: boolean; error?: string }>(
      "cliStatus",
      params as unknown as Record<string, unknown>,
    );
  }

  cliInstall(params: { pluginId: string; provider: string }, signal?: AbortSignal) {
    return this.rpc<{ installed: boolean }>("cliInstall", params as unknown as Record<string, unknown>, signal);
  }

  load(params: { pluginId: string; provider: string; accountId: string; auth: Record<string, unknown>; seedProvider?: { models?: Record<string, unknown> } }) {
    return this.rpc<{ baseURL: string; apiKey: string; headers: Record<string, string>; hasFetch: boolean }>(
      "load",
      params as unknown as Record<string, unknown>,
    );
  }

  refresh(params: { pluginId: string; provider: string; accountId: string; auth: Record<string, unknown> }, signal?: AbortSignal) {
    return this.rpc<{ refreshed: boolean; auth?: Record<string, unknown>; error?: string; signIn?: "expired" | "kept" | "renewed" }>(
      "refresh",
      params as unknown as Record<string, unknown>,
      signal,
    );
  }

  usage(params: { pluginId: string; provider: string; accountId: string; auth: Record<string, unknown> }, signal?: AbortSignal) {
    return this.rpc<Omit<PluginProviderUsageView, "fetchedAt"> & { signIn?: "expired" | "kept" | "renewed" }>(
      "usage",
      params as unknown as Record<string, unknown>,
      signal,
    );
  }

  async invalidateAccount(params: { pluginId: string; provider: string; accountId?: string }): Promise<void> {
    if (!this.child || this.status !== "running") return;
    await this.rpc("invalidateAccount", params as unknown as Record<string, unknown>).catch(() => {});
  }
}
