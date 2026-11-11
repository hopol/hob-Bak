import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileKind, isTextKind } from "../../shared/files.ts";
import { knowledgeGroup, type KnowledgeCollection, type KnowledgeEntry, type KnowledgeEntryView, type KnowledgeGroup, type KnowledgeOrigin, type KnowledgePage } from "../../shared/knowledge.ts";
import type { EmbeddingSettings } from "../../shared/types.ts";
import { embed, embeddingKey, embeddingModel } from "./embedding.ts";
import { extractChunks, UnsupportedIndex, type IndexedChunk } from "./knowledge-index.ts";
import type { Bus } from "./bus.ts";
import { looksText, isInPagesDir } from "./files.ts";
import { newId } from "./ids.ts";
import type { Store } from "./store.ts";

/** 从数据目录内的相对路径推任务 id：老布局 jobs/<jid>/…，新布局 assistants/<aid>/jobs/<jid>/… */
function jobIdFromPath(rel: string): string | undefined {
  return /^(?:assistants[/\\][^/\\]+[/\\])?jobs[/\\]([^/\\]+)[/\\]/.exec(rel)?.[1];
}

type Entry = KnowledgeEntry & { sourceKey?: string };
type CollectInput = { origin: "output" | "chat"; path: string; name?: string; description?: string; assistantId: string; itemId?: string; jobId?: string };
type Query = { origin?: string; collection?: string; kind?: string; assistantId?: string; groupId?: string; q?: string; before?: string; limit?: number };
type Collection = Omit<KnowledgeCollection, "count">;
type IndexFile = { model: string; dims: number; name?: string; chunks: IndexedChunk[] };
type SearchResult = { entry: KnowledgeEntry; chunk: IndexedChunk; score: number };
// 评测（knowledge-eval.mjs）：0.55 保留 19/20 相关问题，无关误附 0/8。
// 只有关键词时不自动附：同一组题，覆盖率门槛 0.3 只附对 8/20，附错 7 次，噪音比收益大，交给模型自己调工具。
const VECTOR_GATE = 0.55;
function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? [];
  return words.flatMap((word) => /^[\u3400-\u9fff]+$/.test(word) && word.length > 1 ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]);
}

export class KnowledgeStore {
  private root: string;
  private pending: Promise<unknown> = Promise.resolve();
  private indexing: Promise<unknown> = Promise.resolve();
  private generations = new Map<string, number>();
  private eventTimer?: ReturnType<typeof setTimeout>;
  constructor(private home: string, private bus: Bus, private store: Store, private maxBytes = 100 * 1024 * 1024, private embedding: () => EmbeddingSettings = () => ({ source: "off" })) {
    this.root = join(home, "knowledge");
    queueMicrotask(() => { void this.refreshIndexes().catch((error) => console.error("知识库启动索引检查失败：", error)); });
  }
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.pending.then(fn);
    this.pending = next.catch(() => {});
    return next;
  }
  whenIdle(): Promise<unknown> {
    return this.pending;
  }
  private read<T>(name: string): T[] {
    const path = join(this.root, name);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T[] : [];
  }
  private write(name: string, data: unknown): void {
    const path = join(this.root, name);
    mkdirSync(this.root, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }
  private changed(): void {
    this.bus.emit({ type: "knowledge" });
  }
  private indexChanged(): void {
    if (this.eventTimer) return;
    this.eventTimer = setTimeout(() => { this.eventTimer = undefined; this.changed(); }, 1000);
    this.eventTimer.unref();
  }
  private indexPath(hash: string, ext: "json" | "vec"): string { return join(this.root, "index", `${hash}.${ext}`); }
  private model(): string { return embeddingModel(this.embedding()); }
  private readIndex(hash: string): IndexFile | undefined {
    const path = this.indexPath(hash, "json");
    if (!existsSync(path)) return;
    return JSON.parse(readFileSync(path, "utf8")) as IndexFile;
  }
  private removeUnusedIndex(hash: string, entries = this.entries()): void {
    if (entries.some((e) => e.hash === hash && e.collections.length)) return;
    rmSync(this.indexPath(hash, "json"), { force: true });
    rmSync(this.indexPath(hash, "vec"), { force: true });
  }
  private schedule(entry: Entry): void {
    const generation = (this.generations.get(entry.id) ?? 0) + 1;
    this.generations.set(entry.id, generation);
    this.indexing = this.indexing.then(() => this.buildIndex(entry.id, entry.hash, generation)).catch((error) => console.warn("知识库索引失败：", error));
  }
  async whenIndexed(): Promise<void> { await this.whenIdle(); await this.indexing; await this.whenIdle(); }
  async refreshIndexes(force = false): Promise<void> {
    await this.enqueue(() => {
      const entries = this.entries();
      for (const entry of entries) {
        if (!entry.collections.length) continue;
        let existing: IndexFile | undefined;
        try { existing = this.readIndex(entry.hash); } catch { /* 损坏的索引重新生成 */ }
        const incomplete = !existing || existing.model !== this.model() || (existing.dims > 0 && !existsSync(this.indexPath(entry.hash, "vec")));
        if (force || (incomplete && entry.index?.state !== "unsupported" && entry.index?.state !== "failed") || entry.index?.state === "queued" || entry.index?.state === "indexing") {
          entry.index = { state: "queued" };
          this.schedule(entry);
        } else if (!entry.index && existing) entry.index = { state: "ready", chunks: existing.chunks.length };
      }
      this.write("entries.json", entries);
      this.indexChanged();
    });
  }
  private async buildIndex(id: string, hash: string, generation: number): Promise<void> {
    let entry: Entry | undefined;
    await this.enqueue(() => {
      const all = this.entries();
      entry = all.find((e) => e.id === id && e.hash === hash && e.collections.length > 0);
      if (!entry || this.generations.get(id) !== generation) { entry = undefined; return; }
      entry.index = { state: "indexing" };
      this.write("entries.json", all);
      this.indexChanged();
    });
    if (!entry) return;
    const config = this.embedding();
    const model = this.model();
    const indexedName = entry.name;
    try {
      const chunks = await extractChunks(entry);
      if (!chunks.length) throw new UnsupportedIndex("文件没有可索引的文字");
      const vectors = config.source === "openai" && chunks.length ? await embed(config, embeddingKey(this.home), chunks.map((c) => `${c.heading}\n${c.text}`)) : [];
      await this.enqueue(() => {
        const all = this.entries();
        const current = all.find((e) => e.id === id && e.hash === hash && e.collections.length);
        if (!current || this.generations.get(id) !== generation || model !== this.model()) return;
        const dir = join(this.root, "index");
        mkdirSync(dir, { recursive: true });
        const dims = vectors[0]?.length ?? 0;
        const vector = new Float32Array(vectors.flat());
        if (dims) writeFileSync(this.indexPath(hash, "vec"), Buffer.from(vector.buffer), { mode: 0o600 });
        else rmSync(this.indexPath(hash, "vec"), { force: true });
        const file = this.indexPath(hash, "json");
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ model, dims, name: indexedName, chunks } satisfies IndexFile), { mode: 0o600 });
        renameSync(tmp, file);
        current.index = { state: "ready", chunks: chunks.length };
        this.write("entries.json", all);
        this.indexChanged();
      });
    } catch (error) {
      await this.enqueue(() => {
        const all = this.entries();
        const current = all.find((e) => e.id === id && e.hash === hash && e.collections.length);
        if (!current || this.generations.get(id) !== generation) return;
        current.index = { state: error instanceof UnsupportedIndex ? "unsupported" : "failed", error: error instanceof Error ? error.message : String(error) };
        this.write("entries.json", all);
        this.indexChanged();
      });
    }
  }
  private entries(): Entry[] {
    return this.read<Entry>("entries.json");
  }
  private collections(): Collection[] {
    return this.read<Collection>("collections.json");
  }
  private timestamp(entries: Entry[]): string {
    return new Date(Math.max(Date.now(), ...entries.map((entry) => Date.parse(entry.updatedAt) + 1))).toISOString();
  }
  private collectFile(input: { origin: KnowledgeOrigin; path: string; name?: string; description?: string; assistantId?: string; itemId?: string; jobId?: string }, collectionId?: string): Entry | undefined {
    let stat;
    try {
      stat = statSync(input.path);
    } catch (error) {
      console.warn("知识库跳过文件：", input.path, error);
      return;
    }
    if (!stat.isFile() || stat.size > this.maxBytes) {
      console.warn("知识库跳过目录或过大文件：", input.path);
      return;
    }
    // ponytail: 文件上限 100 MB，目前同步读写；需要处理更大文件时改为流式哈希和复制。
    const data = readFileSync(input.path);
    if (data.length > this.maxBytes) {
      console.warn("知识库跳过过大文件：", input.path);
      return;
    }
    const hash = createHash("sha256").update(data).digest("hex");
    const entries = this.entries();
    const duplicate = entries.find((entry) => entry.hash === hash);
    if (duplicate) {
      if (collectionId && !duplicate.collections.includes(collectionId)) {
        duplicate.collections.push(collectionId);
        if (duplicate.collections.length === 1) { duplicate.index = { state: "queued" }; this.schedule(duplicate); }
        this.write("entries.json", entries);
        this.changed();
      }
      return duplicate;
    }
    const sourceKey = input.origin === "upload" ? undefined : resolve(input.path);
    const previous = sourceKey ? entries.find((entry) => entry.sourceKey === sourceKey) : undefined;
    const originalName = basename(input.path);
    const name = input.name || (input.origin === "chat" ? originalName.replace(/^u-[^-]+-/, "") : originalName);
    const kind = fileKind(originalName) ?? (looksText(data) ? "text" : "other");
    const inPages = isInPagesDir(relative(this.home, resolve(input.path)));
    const ext = extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, "");
    const path = join(this.root, inPages ? "pages" : "blobs", `${hash}${inPages ? ".html" : ext}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, { mode: 0o600 });
    if (isTextKind(kind)) {
      mkdirSync(join(this.root, "text"), { recursive: true });
      const content = data.toString("utf8");
      const text = kind === "html"
        ? content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ")
        : content;
      writeFileSync(join(this.root, "text", `${hash}.txt`), Buffer.from(text).subarray(0, 64 * 1024), { mode: 0o600 });
    }
    const rel = relative(this.home, resolve(input.path));
    const jobId = input.jobId || jobIdFromPath(rel);
    const description = input.description || (jobId ? this.store.job(jobId)?.title : undefined);
    const now = this.timestamp(entries);
    if (previous) {
      previous.versions = [...(previous.versions ?? []), { hash: previous.hash, path: previous.path, size: previous.size, at: previous.updatedAt }];
      const oldHash = previous.hash;
      Object.assign(previous, { path, hash, size: data.length, kind, updatedAt: now });
      if (previous.collections.length) { previous.index = { state: "queued" }; this.schedule(previous); }
      this.removeUnusedIndex(oldHash, entries);
      if (description) previous.description = description;
      this.write("entries.json", entries);
      this.changed();
      return previous;
    }
    const entry: Entry = {
      id: newId("k-"),
      origin: input.origin,
      name,
      ...(description ? { description } : {}),
      kind,
      path,
      hash,
      size: data.length,
      createdAt: now,
      updatedAt: now,
      collections: collectionId ? [collectionId] : [],
      ...(sourceKey ? { sourceKey } : {}),
      ...(input.assistantId ? { source: { assistantId: input.assistantId, ...(input.itemId ? { itemId: input.itemId } : {}), ...(jobId ? { jobId } : {}) } } : {}),
    };
    entries.push(entry);
    if (entry.collections.length) { entry.index = { state: "queued" }; this.schedule(entry); }
    this.write("entries.json", entries);
    this.changed();
    return entry;
  }
  collect(input: CollectInput): Promise<Entry | undefined> {
    return this.enqueue(() => this.collectFile(input));
  }
  upload(file: { path: string; name: string }, collectionId: string): Promise<Entry | undefined> {
    return this.enqueue(() => {
      if (!this.collections().some((c) => c.id === collectionId)) throw new Error("知识库不存在");
      return this.collectFile({ origin: "upload", ...file }, collectionId);
    });
  }
  async list(query: Query = {}): Promise<KnowledgePage> {
    await this.whenIdle();
    const all = this.entries();
    const collections = this.collections().map((c) => {
      const entries = all.filter((e) => e.collections.includes(c.id));
      return { ...c, count: entries.length, indexed: entries.filter((e) => e.index?.state === "ready").length, failed: entries.filter((e) => e.index?.state === "failed").length, unsupported: entries.filter((e) => e.index?.state === "unsupported").length };
    });
    const q = query.q?.toLocaleLowerCase();
    const limit = Math.max(1, Math.min(200, query.limit || 50));
    const candidates = all.filter((e) => (!query.origin || e.origin === query.origin) && (!query.groupId || (e.origin === "output" && (query.groupId === "none" ? !e.source?.jobId || !this.store.job(e.source.jobId)?.groupId : !!e.source?.jobId && !!this.store.job(e.source.jobId) && this.store.groupMatches(query.groupId, this.store.job(e.source.jobId)?.groupId)))) && (!query.collection || e.collections.includes(query.collection)) && (!query.kind || knowledgeGroup(e.kind) === query.kind as KnowledgeGroup) && (!query.assistantId || e.source?.assistantId === query.assistantId) && (!query.before || e.updatedAt < query.before)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // ponytail: 几千条以内线性扫描，凑够一页（多一条判断 hasMore）就停；后续向量检索时改为索引。
    const entries: (KnowledgeEntry & { snippet?: string })[] = [];
    for (const e of candidates) {
      if (entries.length > limit) break;
      if (!q) { entries.push(e); continue; }
      const textPath = join(this.root, "text", `${e.hash}.txt`);
      const body = existsSync(textPath) ? readFileSync(textPath, "utf8") : "";
      const index = body.toLocaleLowerCase().indexOf(q);
      if (index < 0 && !e.name.toLocaleLowerCase().includes(q) && !e.description?.toLocaleLowerCase().includes(q)) continue;
      entries.push({ ...e, ...(index >= 0 ? { snippet: body.slice(Math.max(0, index - 40), index + q.length + 40) } : {}) });
    }
    return { entries: entries.slice(0, limit), hasMore: entries.length > limit, collections };
  }
  async entry(id: string, chunk?: number): Promise<KnowledgeEntryView | undefined> {
    await this.whenIdle();
    const entry = this.entries().find((e) => e.id === id);
    if (!entry) return;
    const index = entry.index?.state === "ready" ? this.readIndex(entry.hash) : undefined;
    const selected = chunk === undefined ? undefined : index?.chunks.find((c) => c.index === chunk);
    const displayed = selected && index?.name && selected.heading.startsWith(index.name) ? { ...selected, heading: entry.name + selected.heading.slice(index.name.length) } : selected;
    return { entry, ...(displayed ? { chunk: displayed } : {}) };
  }
  /** 不给 collectionId 就重试所有库里失败的（换了 Key 时用）。 */
  reindex(collectionId?: string): Promise<boolean> {
    return this.enqueue(() => {
      if (collectionId && !this.collections().some((c) => c.id === collectionId)) return false;
      const all = this.entries();
      for (const entry of all) if ((collectionId ? entry.collections.includes(collectionId) : entry.collections.length > 0) && entry.index?.state === "failed") {
        entry.index = { state: "queued" };
        this.schedule(entry);
      }
      this.write("entries.json", all);
      this.indexChanged();
      return true;
    });
  }
  async search(query: string, collectionIds: string[], options: { limit?: number; gate?: boolean } = {}): Promise<SearchResult[]> {
    await this.whenIdle();
    const words = [...new Set(terms(query))];
    if (!words.length || !collectionIds.length || (options.gate && this.embedding().source !== "openai")) return [];
    const all = this.entries().filter((e) => e.index?.state === "ready" && e.collections.some((id) => collectionIds.includes(id)));
    const candidates: { entry: Entry; chunk: IndexedChunk; words: string[]; vector?: Float32Array; bm: number; cosine?: number; score: number }[] = [];
    // ponytail: 几万块以内线性扫描；更大时换 SQLite FTS5 和近似最近邻。
    for (const entry of all) {
      let index: IndexFile | undefined;
      try { index = this.readIndex(entry.hash); } catch (error) { console.warn("知识库索引读取失败：", error); continue; }
      if (!index || index.model !== this.model()) continue;
      let values: Float32Array | undefined;
      if (index.dims && existsSync(this.indexPath(entry.hash, "vec"))) {
        const data = readFileSync(this.indexPath(entry.hash, "vec"));
        if (data.length === index.chunks.length * index.dims * 4) values = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
      }
      index.chunks.forEach((stored, i) => {
        const chunk = index.name && stored.heading.startsWith(index.name) ? { ...stored, heading: entry.name + stored.heading.slice(index.name.length) } : stored;
        const text = `${chunk.heading} ${chunk.text}`;
        const tokens = terms(text);
        for (const word of words) if (/^[\u3400-\u9fff]$/.test(word)) tokens.push(...Array.from(text).filter((char) => char === word));
        candidates.push({ entry, chunk, words: tokens, ...(values ? { vector: values.slice(i * index.dims, (i + 1) * index.dims) } : {}), bm: 0, score: 0 });
      });
    }
    if (!candidates.length) return [];
    const avg = candidates.reduce((sum, c) => sum + c.words.length, 0) / candidates.length || 1;
    const dfs = words.map((word) => candidates.filter((c) => c.words.includes(word)).length);
    for (const c of candidates) {
      words.forEach((word, i) => {
        const frequency = c.words.filter((term) => term === word).length;
        if (!frequency) return;
        const idf = Math.log(1 + (candidates.length - dfs[i]! + 0.5) / (dfs[i]! + 0.5));
        c.bm += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * c.words.length / avg));
      });
    }
    const rankedWords = candidates.filter((c) => c.bm > 0).sort((a, b) => b.bm - a.bm);
    rankedWords.forEach((c, i) => { c.score += 1 / (60 + i + 1); });
    let vectorAvailable = false;
    const config = this.embedding();
    if (config.source === "openai" && candidates.some((c) => c.vector)) {
      try {
        const [q] = await embed(config, embeddingKey(this.home), [query]);
        const norm = Math.hypot(...q!);
        if (!norm) throw new Error("查询向量为零");
        for (const c of candidates) {
          if (!c.vector || c.vector.length !== q!.length) continue;
          let dot = 0; let square = 0;
          for (let i = 0; i < q!.length; i++) { dot += q![i]! * c.vector[i]!; square += c.vector[i]! ** 2; }
          if (square) c.cosine = dot / (norm * Math.sqrt(square));
        }
        const ranked = candidates.filter((c) => c.cosine !== undefined).sort((a, b) => b.cosine! - a.cosine!);
        vectorAvailable = ranked.length > 0;
        ranked.forEach((c, i) => { c.score += 1 / (60 + i + 1); });
      } catch (error) { console.warn("知识库向量检索失败，退回关键词：", error); }
    }
    if (options.gate && !vectorAvailable) return [];
    const counts = new Map<string, number>();
    return candidates.filter((c) => c.score > 0 && (!options.gate || (c.cosine ?? -1) >= VECTOR_GATE))
      .sort((a, b) => b.score - a.score).filter((c) => {
        const n = counts.get(c.entry.id) ?? 0;
        if (n >= 3) return false;
        counts.set(c.entry.id, n + 1);
        return true;
      }).slice(0, Math.max(0, options.limit ?? 6)).map(({ entry, chunk, score }) => ({ entry, chunk, score }));
  }
  createCollection(name: string): Promise<Collection> {
    return this.enqueue(() => {
      const list = this.collections();
      const item = { id: newId("kc-"), name, createdAt: new Date().toISOString() };
      list.push(item);
      this.write("collections.json", list);
      this.changed();
      return item;
    });
  }
  renameCollection(id: string, name: string): Promise<Collection | undefined> {
    return this.enqueue(() => {
      const list = this.collections();
      const item = list.find((c) => c.id === id);
      if (!item) return;
      item.name = name;
      this.write("collections.json", list);
      this.changed();
      return item;
    });
  }
  private cleanup(removed: Entry[], remaining: Entry[]): void {
    const used = new Set(remaining.flatMap((e) => [e.path, ...(e.versions ?? []).map((v) => v.path)]));
    const hashes = new Set(remaining.flatMap((e) => [e.hash, ...(e.versions ?? []).map((v) => v.hash)]));
    for (const e of removed) {
      for (const v of [e, ...(e.versions ?? [])]) {
        if (!used.has(v.path)) rmSync(v.path, { force: true });
        if (!hashes.has(v.hash)) rmSync(join(this.root, "text", `${v.hash}.txt`), { force: true });
      }
    }
  }
  deleteCollection(id: string): Promise<number | undefined> {
    return this.enqueue(() => {
      const collections = this.collections();
      if (!collections.some((c) => c.id === id)) return;
      const all = this.entries();
      const removed: Entry[] = [];
      const kept = all.filter((e) => {
        const had = e.collections.includes(id);
        e.collections = e.collections.filter((c) => c !== id);
        if (had && e.origin === "upload" && !e.collections.length) {
          removed.push(e);
          return false;
        }
        return true;
      });
      this.write("entries.json", kept);
      this.write("collections.json", collections.filter((c) => c.id !== id));
      this.cleanup(removed, kept);
      for (const entry of all) if (!entry.collections.length) { delete entry.index; this.removeUnusedIndex(entry.hash, kept); }
      this.write("entries.json", kept);
      for (const assistant of this.store.assistants()) {
        if (assistant.knowledge?.includes(id)) {
          this.store.saveAssistant({ ...assistant, knowledge: assistant.knowledge.filter((value) => value !== id) });
          this.bus.emit({ type: "profile", assistantId: assistant.id });
        }
      }
      this.changed();
      return removed.length;
    });
  }
  updateEntry(id: string, patch: { name?: string; collections?: string[] }): Promise<Entry | undefined> {
    return this.enqueue(() => {
      const all = this.entries();
      const entry = all.find((e) => e.id === id);
      if (!entry) return;
      if (patch.collections && patch.collections.some((id) => !this.collections().some((c) => c.id === id))) throw new Error("知识库不存在");
      if (patch.name !== undefined) entry.name = patch.name;
      const wasIndexed = entry.collections.length > 0;
      if (patch.collections !== undefined) entry.collections = [...new Set(patch.collections)];
      if (!wasIndexed && entry.collections.length) { entry.index = { state: "queued" }; this.schedule(entry); }
      if (wasIndexed && !entry.collections.length) { delete entry.index; this.removeUnusedIndex(entry.hash, all); }
      // 改名、整理不算更新：updatedAt 只跟内容走，列表顺序和「最近几天」都不受整理影响
      this.write("entries.json", all);
      this.changed();
      return entry;
    });
  }
  deleteEntry(id: string): Promise<boolean> {
    return this.enqueue(() => {
      const all = this.entries();
      const entry = all.find((e) => e.id === id);
      if (!entry) return false;
      const kept = all.filter((e) => e.id !== id);
      this.write("entries.json", kept);
      this.cleanup([entry], kept);
      this.removeUnusedIndex(entry.hash, kept);
      this.changed();
      return true;
    });
  }
}
