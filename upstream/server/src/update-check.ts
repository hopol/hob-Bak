// 版本检查：查 npm registry 上 hob-bot 的最新版本，只在内存保存结果，不写文件。
// 定时由 main.ts 在真正启动服务时开启；createRuntime 里不发网络请求。
import { readFileSync } from "node:fs";
import { t } from "../../shared/i18n.ts";
import type { UpdateCheck } from "../../shared/types.ts";

export const UPDATE_SOURCE = "https://registry.npmjs.org/hob-bot/latest";
export const UPDATE_INTERVAL_MS = 6 * 3600 * 1000;
const TIMEOUT_MS = 10_000;

/** 严格解析 x.y.z 三段非负整数版本号；格式不对返回 null。 */
export function parseVersion(raw: unknown): [number, number, number] | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 仅当 remote 和 current 都是合法的 x.y.z 且 remote 严格大于 current 时返回 true。 */
export function isNewerVersion(remote: string, current: string): boolean {
  const r = parseVersion(remote);
  const c = parseVersion(current);
  if (!r || !c) return false;
  if (r[0] !== c[0]) return r[0] > c[0];
  if (r[1] !== c[1]) return r[1] > c[1];
  return r[2] > c[2];
}

/** 读取本机 package.json 的版本号。 */
export function readCurrentVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

function failureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return t("请求超时");
    const cause = error.cause;
    if (error.message === "fetch failed" && cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}

function sameResult(a: UpdateCheck | undefined, b: UpdateCheck): boolean {
  if (!a || a.status !== b.status) return false;
  if (a.status === "error" && b.status === "error") return a.error === b.error;
  if (a.status !== "error" && b.status !== "error") return a.latest === b.latest;
  return false;
}

export interface UpdateCheckerOptions {
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  onChange?: (update: UpdateCheck) => void;
}

/**
 * 定时检查 npm 上是否有比本机更新的 hob-bot 版本。
 * 默认走 globalThis.fetch（已由 applyNetworkProxy 挂上全局代理）。
 */
export class UpdateChecker {
  readonly currentVersion: string;
  private result: UpdateCheck | undefined;
  private checking?: Promise<UpdateCheck>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: UpdateCheckerOptions = {}) {
    this.currentVersion = options.currentVersion ?? readCurrentVersion();
  }

  /** 最近一次检查结果；尚未完成检查时返回 undefined。 */
  status(): UpdateCheck | undefined {
    return this.result;
  }

  /** 立刻查一次并开始每 6 小时定时检查（幂等）。 */
  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, this.options.intervalMs ?? UPDATE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** 停止定时检查。 */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 查一次最新版本（同一时刻只发一次请求）；失败不抛异常，如实记在结果里。 */
  async check(): Promise<UpdateCheck> {
    this.checking ??= this.doCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async doCheck(): Promise<UpdateCheck> {
    let next: UpdateCheck;
    try {
      const latest = await this.fetchLatestVersion();
      next = isNewerVersion(latest, this.currentVersion)
        ? { status: "available", latest }
        : { status: "up-to-date", latest };
    } catch (error) {
      next = { status: "error", error: failureReason(error) };
    }
    const changed = !sameResult(this.result, next);
    this.result = next;
    if (changed) this.options.onChange?.(next);
    return next;
  }

  private async fetchLatestVersion(): Promise<string> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(UPDATE_SOURCE, {
      signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error(t("返回的不是有效 JSON"));
    }
    const raw = data && typeof data === "object" && !Array.isArray(data) ? (data as { version?: unknown }).version : undefined;
    if (typeof raw !== "string" || !parseVersion(raw)) {
      throw new Error(t("返回的版本号无效"));
    }
    return raw.trim();
  }
}
