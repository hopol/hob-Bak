// 模型单价：默认从 models.dev 拉，一天最多更新一次；存在 HOB_HOME/cache/usage-prices.json，拉不到就用上次的。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TokenPrice } from "../../shared/types.ts";
import { cacheDir } from "./config.ts";

const SOURCE = "https://models.dev/api.json";
const FILE = "usage-prices.json";
const DAY = 24 * 3600 * 1000;
/** 失败后这么久不再试：价格表本来就一天更新一次，失败时别让每次打开页面都等一次超时。 */
const RETRY = 10 * 60 * 1000;
const TIMEOUT = 10_000;

/** 模型厂商自己那一家：同一个模型 id 出现在多个服务商里时优先它。 */
const VENDOR_PROVIDERS = new Set(["openai", "anthropic", "deepseek", "google", "xai", "mistral", "zhipuai", "moonshotai"]);

/** HOB_HOME/cache/usage-prices.json：拉到的单价 + 上次更新和上次尝试的时间。 */
interface PriceFile {
  fetchedAt: string | null;
  attemptAt: string | null;
  error: string | null;
  prices: Record<string, TokenPrice>;
}

const EMPTY: PriceFile = { fetchedAt: null, attemptAt: null, error: null, prices: {} };

function readFile(home: string): PriceFile {
  const path = join(cacheDir(home), FILE);
  if (!existsSync(path)) return EMPTY;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as Partial<PriceFile>;
    const prices = stored.prices && typeof stored.prices === "object" ? stored.prices : {};
    return {
      fetchedAt: typeof stored.fetchedAt === "string" ? stored.fetchedAt : null,
      attemptAt: typeof stored.attemptAt === "string" ? stored.attemptAt : null,
      error: typeof stored.error === "string" ? stored.error : null,
      prices: Object.fromEntries(Object.entries(prices).filter(([, price]) => isPrice(price))),
    };
  } catch {
    return EMPTY;
  }
}

function isPrice(value: unknown): value is TokenPrice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const price = value as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof price[key] === "number" && Number.isFinite(price[key]) && (price[key] as number) >= 0);
}

/** 用户填的单价：四项都是大于等于 0 的数字，不合法说清哪一项。 */
export function checkPrice(raw: unknown): TokenPrice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("单价要填四项：输入、输出、缓存读、缓存写。");
  const input = raw as Record<string, unknown>;
  const names: Record<keyof TokenPrice, string> = { input: "输入", output: "输出", cacheRead: "缓存读", cacheWrite: "缓存写" };
  const out = {} as TokenPrice;
  for (const key of Object.keys(names) as (keyof TokenPrice)[]) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`「${names[key]}」的单价要填大于等于 0 的数字（美元 / 百万 token）。`);
    }
    out[key] = Number(value.toFixed(6));
  }
  return out;
}

function failureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "请求超时";
    return error.message;
  }
  return String(error);
}

/**
 * models.dev 的整份数据 → 模型 id → 单价。
 * 同一个模型 id 在多个服务商里都有时，优先模型厂商自己那家（`canonical_model_id` 指回自己，或 id 在厂商名单里）。
 */
export function indexPrices(raw: unknown): Record<string, TokenPrice> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("返回的不是服务商列表");
  const candidates = new Map<string, { vendor: boolean; price: TokenPrice }[]>();
  for (const [providerId, provider] of Object.entries(raw as Record<string, unknown>)) {
    const models = (provider as { models?: unknown } | null)?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      const cost = (model as { cost?: unknown } | null)?.cost as Record<string, unknown> | null | undefined;
      if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue;
      const canonical = (model as { canonical_model_id?: unknown }).canonical_model_id;
      const vendor = (typeof canonical === "string" && canonical.split("/")[0] === providerId) || VENDOR_PROVIDERS.has(providerId);
      const price: TokenPrice = {
        input: cost.input,
        output: cost.output,
        cacheRead: typeof cost.cache_read === "number" ? cost.cache_read : 0,
        cacheWrite: typeof cost.cache_write === "number" ? cost.cache_write : 0,
      };
      const list = candidates.get(modelId) ?? [];
      list.push({ vendor, price });
      candidates.set(modelId, list);
    }
  }
  const prices: Record<string, TokenPrice> = Object.fromEntries([...candidates].map(([modelId, list]) => [modelId, (list.find((item) => item.vendor) ?? list[0]).price]));
  if (!Object.keys(prices).length) throw new Error("返回里没有模型价格");
  return prices;
}

/**
 * 价格表：一天最多更新一次；拉不到就留着上次的，并把原因写下来给页面显示。
 * `fetchImpl` 和 `now` 只为测试注入（不连真实网络）。
 */
export class UsagePrices {
  private file: PriceFile;
  private loading?: Promise<void>;

  constructor(private readonly options: { home: string; fetchImpl?: typeof fetch; now?: () => number }) {
    this.file = readFile(options.home);
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** 需要更新时拉一次（同一时刻只拉一次）；要更新时会把结果写进 HOB_HOME。 */
  async ensure(): Promise<void> {
    this.loading ??= this.refresh().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
  }

  /** 现在用的价格和上次更新的状态。 */
  table(): { fetchedAt: string | null; error: string | null; prices: Record<string, TokenPrice> } {
    return { fetchedAt: this.file.fetchedAt, error: this.file.error, prices: this.file.prices };
  }

  private async refresh(): Promise<void> {
    const now = this.now;
    const fetchedAt = this.file.fetchedAt ? Date.parse(this.file.fetchedAt) : 0;
    if (now - fetchedAt < DAY) return;
    const attemptAt = this.file.attemptAt ? Date.parse(this.file.attemptAt) : 0;
    if (attemptAt > fetchedAt && now - attemptAt < RETRY) return;
    try {
      this.file = { fetchedAt: new Date(now).toISOString(), attemptAt: new Date(now).toISOString(), error: null, prices: indexPrices(await this.fetchSource()) };
    } catch (error) {
      this.file = { ...this.file, attemptAt: new Date(now).toISOString(), error: failureReason(error) };
    }
    this.write();
  }

  private async fetchSource(): Promise<unknown> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(SOURCE, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error("返回的不是有效 JSON");
    }
  }

  private write(): void {
    const path = join(cacheDir(this.options.home), FILE);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`);
    renameSync(tmp, path);
  }
}
