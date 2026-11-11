// 消耗：不另外记账，直接从会话文件里 assistant 消息的 usage 统计（见 docs/architecture.md“消耗”）。
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { TokenPrice, UsageAssistant, UsageModelPrice, UsagePrices, UsageRow, UsageSource, UsageView } from "../../shared/types.ts";
import type { SettingsStore } from "./settings.ts";
import type { Store } from "./store.ts";
import type { UsagePrices as PriceTable } from "./usage-prices.ts";

/** 一条 assistant 消息的用量；日志按毫秒记，归到哪一天按设置的时区算。 */
interface UsageRecord {
  at: number;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 一个会话文件：大小和修改时间没变就不重读，变长时只读追加的那一段。 */
interface CachedFile {
  size: number;
  mtimeMs: number;
  offset: number; // 已读到的字节位置（只到最后一个完整换行，半行留着下次读）
  records: UsageRecord[];
  assistantId: string;
  assistantName: string;
  source: UsageSource;
}

interface Target {
  file: string;
  assistantId: string;
  assistantName: string;
  source: UsageSource;
  /** 沉淀会话开头抄的是任务会话：只算这个时间以后的 */
  since?: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 一行会话记录 → 用量；不是带用量字段的 assistant 消息就返回 undefined。 */
function recordOf(line: string): UsageRecord | undefined {
  let entry: { type?: unknown; timestamp?: unknown; message?: any };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return undefined; // 半行（进程被杀）跳过
  }
  if (entry?.type !== "message") return undefined;
  const message = entry.message;
  if (message?.role !== "assistant") return undefined;
  const provider = typeof message.provider === "string" ? message.provider : "";
  const model = typeof message.model === "string" ? message.model : "";
  if (!provider || !model) return undefined;
  const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(message.timestamp ?? entry.timestamp ?? ""));
  if (!Number.isFinite(at)) return undefined;
  const usage = message.usage ?? {};
  return {
    at,
    provider,
    model,
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
  };
}

/** 从 start 字节起读完整的行，返回下一次从这里接着读的字节位置和用量。 */
async function readUsage(file: string, start: number): Promise<{ offset: number; records: UsageRecord[] }> {
  const records: UsageRecord[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let read = start;
  for await (const chunk of createReadStream(file, { start })) {
    const buffer = chunk as Buffer;
    read += buffer.length;
    pending = pending.length ? Buffer.concat([pending, buffer]) : buffer;
    let from = 0;
    for (let at = pending.indexOf(0x0a); at !== -1; at = pending.indexOf(0x0a, from)) {
      const line = pending.toString("utf8", from, at);
      from = at + 1;
      const record = recordOf(line);
      if (record) records.push(record);
    }
    pending = pending.subarray(from);
  }
  return { offset: read - pending.length, records };
}

/** 时间戳 → 设置时区下的日期（同一小时里的本地日期一样，按时段记一下省掉重复的时区换算）。 */
function dayKeyer(timezone: string): (at: number) => string {
  const format = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const memo = new Map<number, string>();
  return (at) => {
    const hour = Math.floor(at / 3_600_000);
    const hit = memo.get(hour);
    if (hit) return hit;
    const day = format.format(new Date(at));
    memo.set(hour, day);
    return day;
  };
}

function readDir(path: string): string[] {
  return existsSync(path) ? readdirSync(path) : [];
}

/** 所有任务的会话目录：在的助手和归档的助手都算。 */
function jobSessionDirs(home: string): string[] {
  const out: string[] = [];
  const roots = [
    ...readDir(join(home, "assistants")).map((id) => join(home, "assistants", id, "jobs")),
    ...readDir(join(home, "archive", "assistants")).map((folder) => join(home, "archive", "assistants", folder, "jobs")),
  ];
  for (const root of roots) for (const id of readDir(root)) out.push(join(root, id));
  return out;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function modelPrice(id: string, table: Record<string, TokenPrice>, overrides: Record<string, TokenPrice>): UsageModelPrice | null {
  const custom = Object.hasOwn(overrides, id) ? overrides[id] : undefined;
  const base = Object.hasOwn(table, id) ? table[id] : undefined;
  if (custom && base) return { price: custom, custom: true, default: base };
  if (custom) return { price: custom, custom: true };
  return base ? { price: base, custom: false } : null;
}

/**
 * 消耗统计：扫出全部会话文件（助手对话、归档助手的对话、任务的会话），按文件缓存解析结果。
 * 第一次扫描是异步流式读，不阻塞其他请求。
 */
export class UsageService {
  private files = new Map<string, CachedFile>();
  private assistants = new Map<string, UsageAssistant>();
  private scanning?: Promise<void>;
  /** 读过几次会话文件（文件没变时不该再读，测试用它看这条） */
  reads = 0;

  constructor(
    private readonly options: {
      home: string;
      store: Store;
      settings: SettingsStore;
      prices: PriceTable;
    },
  ) {}

  /** 启动后先扫一遍；服务不等它。 */
  warmup(): void {
    void this.scan().catch(() => {});
  }

  async view(): Promise<UsageView> {
    await this.scan();
    const timezone = this.options.settings.settings.general.timezone;
    const dayOf = dayKeyer(timezone);
    const rows = new Map<string, UsageRow>();
    for (const file of this.files.values()) {
      for (const record of file.records) {
        const day = dayOf(record.at);
        const key = [day, file.assistantId, file.source, record.provider, record.model].join("\u0000");
        let row = rows.get(key);
        if (!row) {
          row = { day, assistantId: file.assistantId, source: file.source, provider: record.provider, model: record.model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          rows.set(key, row);
        }
        row.requests += 1;
        row.input += record.input;
        row.output += record.output;
        row.cacheRead += record.cacheRead;
        row.cacheWrite += record.cacheWrite;
      }
    }
    return {
      timezone,
      rows: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.assistantId.localeCompare(b.assistantId) || a.source.localeCompare(b.source) || a.model.localeCompare(b.model)),
      assistants: [...this.assistants.values()],
      prices: await this.prices(),
    };
  }

  /** 一个模型现在的单价（`PUT /api/usage/price` 的返回用）。 */
  async priceOf(model: string): Promise<UsageModelPrice | null> {
    await this.options.prices.ensure();
    return modelPrice(model, this.options.prices.table().prices, this.options.settings.settings.usage?.prices ?? {});
  }

  private async priceTable(): Promise<Record<string, UsageModelPrice>> {
    const table = this.options.prices.table().prices;
    const overrides = this.options.settings.settings.usage?.prices ?? {};
    const models: Record<string, UsageModelPrice> = {};
    for (const id of new Set([...Object.keys(table), ...Object.keys(overrides)])) {
      const price = modelPrice(id, table, overrides);
      if (price) models[id] = price;
    }
    return models;
  }

  private async prices(): Promise<UsagePrices> {
    await this.options.prices.ensure();
    const { fetchedAt, error } = this.options.prices.table();
    return { updatedAt: fetchedAt, error, models: await this.priceTable() };
  }

  private async scan(): Promise<void> {
    this.scanning ??= this.doScan().finally(() => {
      this.scanning = undefined;
    });
    await this.scanning;
  }

  private async doScan(): Promise<void> {
    const home = this.options.home;
    const seen = new Set<string>();
    const assistants = new Map<string, UsageAssistant>();
    for (const id of readDir(join(home, "assistants"))) {
      const file = join(home, "assistants", id, "router.jsonl");
      if (!existsSync(file)) continue;
      const name = this.options.store.assistant(id)?.name ?? id;
      assistants.set(id, { id, name, archived: false });
      await this.sync({ file, assistantId: id, assistantName: name, source: "chat" }, seen);
    }
    const archiveRoot = join(home, "archive", "assistants");
    for (const folder of readDir(archiveRoot)) {
      const file = join(archiveRoot, folder, "router.jsonl");
      if (!existsSync(file)) continue;
      // 归档目录名是 <助手 id>-<归档时间>，id 从归档里的档案读
      const profile = readJson(join(archiveRoot, folder, "profile.json"));
      const id = typeof profile?.id === "string" && profile.id ? profile.id : folder;
      const name = typeof profile?.name === "string" && profile.name ? profile.name : id;
      if (!assistants.has(id)) assistants.set(id, { id, name, archived: true });
      await this.sync({ file, assistantId: id, assistantName: name, source: "chat" }, seen);
    }
    // 群会话（groups/<gid>/members/<aid>.jsonl，归档群也算）：记在成员助手名下，算对话
    const groupRoots = [
      ...readDir(join(home, "groups")).map((gid) => ({ root: join(home, "groups", gid), archived: false })),
      ...readDir(join(home, "archive", "groups")).map((folder) => ({ root: join(home, "archive", "groups", folder), archived: true })),
    ];
    for (const { root: dir } of groupRoots) {
      for (const file of readDir(join(dir, "members"))) {
        if (!file.endsWith(".jsonl")) continue;
        const path = join(dir, "members", file);
        if (!existsSync(path)) continue;
        const assistantId = file.slice(0, -".jsonl".length);
        const live = this.options.store.assistant(assistantId);
        const name = assistants.get(assistantId)?.name ?? live?.name ?? assistantId;
        if (!assistants.has(assistantId)) assistants.set(assistantId, { id: assistantId, name, archived: !live });
        await this.sync({ file: path, assistantId, assistantName: name, source: "chat" }, seen);
      }
    }
    for (const jobDir of jobSessionDirs(home)) {
      const file = join(jobDir, "worker.jsonl");
      if (!existsSync(file)) continue;
      const cached = this.files.get(file);
      const job = cached ? undefined : this.options.store.job(basename(jobDir));
      const assistantId = cached?.assistantId ?? job?.assistantId;
      if (!assistantId) continue;
      const live = this.options.store.assistant(assistantId);
      const name = cached?.assistantName ?? job?.assistantName ?? live?.name ?? assistantId;
      if (!assistants.has(assistantId)) assistants.set(assistantId, { id: assistantId, name, archived: !live });
      await this.sync({ file, assistantId, assistantName: name, source: "job" }, seen);
      for (const sediment of readDir(join(jobDir, "sediment"))) {
        if (sediment.endsWith(".jsonl")) await this.sync({ file: join(jobDir, "sediment", sediment), assistantId, assistantName: name, source: "job", since: Number(sediment.slice(0, -".jsonl".length)) }, seen);
      }
    }
    for (const file of [...this.files.keys()]) if (!seen.has(file)) this.files.delete(file);
    this.assistants = assistants;
  }

  private async sync(target: Target, seen: Set<string>): Promise<void> {
    seen.add(target.file);
    let stat;
    try {
      stat = statSync(target.file);
    } catch {
      this.files.delete(target.file);
      return;
    }
    const cached = this.files.get(target.file);
    const usable = cached && cached.assistantId === target.assistantId && cached.source === target.source;
    if (usable && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return;
    // 会话文件只往后写：变长时接着上次的位置读，否则整份重读
    const appendFrom = usable && stat.size > cached.size ? cached.offset : 0;
    let parsed;
    try {
      parsed = await readUsage(target.file, appendFrom);
    } catch {
      return; // 读不了就留着上次的记录，不当成 0
    }
    this.reads += 1;
    const fresh = target.since ? parsed.records.filter((record) => record.at >= target.since!) : parsed.records;
    let records = fresh;
    if (appendFrom && cached) records = [...cached.records, ...fresh];
    this.files.set(target.file, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      offset: parsed.offset,
      records,
      assistantId: target.assistantId,
      assistantName: target.assistantName,
      source: target.source,
    });
  }
}
