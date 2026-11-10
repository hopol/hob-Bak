// HOB_HOME 的目录布局（v2）和 v1 → v2 的一次性迁移。
//
// v2 按归属放：system/ 放配置和凭据，cache/ 放删了能重建的东西，assistants/<id>/ 放这个助手自己的
// 档案、任务、定时、文件和对话。迁移在启动时自动跑一次，中途断掉也能从备份恢复后重跑；
// 会话文件一个字节都不改，老路径靠 system/moves.json 在取文件时解析。
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, statfsSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  LAYOUT_VERSION,
  archiveAssistantsDir,
  assistantDir,
  assistantFilesDir,
  cacheDir,
  layoutFile,
  movesFile,
  systemDir,
} from "./config.ts";

/** 迁移前至少要留出的余量：备份之外还要写日志和后续运行。 */
const SPACE_MARGIN = 64 * 1024 * 1024;
const BACKUP_PREFIX = "backup-v1-";
const BACKUP_MARKER = ".hob-backup.json";
/** 一个人都不认的文件归主助手。 */
const FALLBACK_OWNER = "hob";

/** 只有 v2 布局才有的根条目：根上出现别的东西就说明还是 v1。 */
const V2_ROOT_ENTRIES = new Set(["layout.json", "system", "cache", "knowledge", "skills", "assistants", "archive"]);

type MoveKind = "dir" | "file";

export interface PlannedMove {
  from: string;
  to: string;
  kind: MoveKind;
  /** 归属怎么判的 */
  reason: string;
}

export interface PlannedSplit {
  /** 根上的老文件 */
  from: string;
  to: string;
  items: { id?: unknown }[];
  /** 目标已有一份时按 id 合并（归档目录里已经有 routines.json） */
  merge?: boolean;
}

export interface MigrationPlan {
  moves: PlannedMove[];
  splits: PlannedSplit[];
  orphans: string[];
  /** 页面、图片、上传的归属判定结果 */
  owners: { path: string; assistantId: string; reason: string }[];
}

export interface MigrationSummary {
  status: "current" | "created" | "migrated" | "dry-run";
  backupDir?: string;
  files: number;
  jobs: number;
  orphans: string[];
  logPath?: string;
  durationMs: number;
  plan?: MigrationPlan;
}

export interface MigrateOptions {
  /** 只打印计划，不动磁盘 */
  dryRun?: boolean;
  /** 测试用：覆盖检测到的可用空间（字节） */
  availableBytes?: number;
  log?: (line: string) => void;
  /** 测试用的钩子：改坏备份、模拟断电 */
  hooks?: {
    afterBackup?: (backupDir: string) => void;
    afterMove?: (index: number, total: number) => void;
  };
}

// ---------- 小工具 ----------

function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface TreeEntry {
  rel: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  hash?: string;
  link?: string;
}

/** 走一遍目录：相对路径、符号链接、每个文件的大小和 sha256。 */
function manifestTree(root: string, skip: (rel: string) => boolean = () => false): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (skip(rel)) continue;
      if (entry.isSymbolicLink()) out.push({ rel, kind: "symlink", size: 0, link: readlinkSync(path) });
      else if (entry.isDirectory()) {
        out.push({ rel, kind: "dir", size: 0 });
        walk(path);
      } else if (entry.isFile()) {
        out.push({ rel, kind: "file", size: statSync(path).size, hash: sha256(path) });
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function countFiles(entries: TreeEntry[]): number {
  return entries.filter((entry) => entry.kind === "file" || entry.kind === "symlink").length;
}

function totalBytes(entries: TreeEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.size, 0);
}

/** 复制一项，保权限、时间、相对符号链接（和 cp -a 一样）。 */
function copyEntry(source: string, target: string): void {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    return;
  }
  if (stats.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copyEntry(join(source, name), join(target, name));
    utimesSync(target, stats.atime, stats.mtime);
    return;
  }
  copyFileSync(source, target);
  chmodSync(target, stats.mode & 0o777);
  utimesSync(target, stats.atime, stats.mtime);
}

/** 把 from 里的每一项复制进已经存在的 to。 */
function copyChildren(from: string, to: string, skip: (name: string) => boolean = () => false): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (skip(name)) continue;
    const target = join(to, name);
    if (existsSync(target)) throw new Error(`复制目标已存在：${target}`);
    copyEntry(join(from, name), target);
  }
}

/** 和一份清单逐项核对；返回不一致的描述。 */
function compareTree(root: string, expected: TreeEntry[], skip: (rel: string) => boolean = () => false): string[] {
  const actual = new Map(manifestTree(root, skip).map((entry) => [entry.rel, entry]));
  const problems: string[] = [];
  for (const want of expected) {
    const got = actual.get(want.rel);
    if (!got) {
      problems.push(`缺 ${want.rel}`);
      continue;
    }
    actual.delete(want.rel);
    if (got.kind !== want.kind) problems.push(`类型不一致 ${want.rel}`);
    else if (want.kind === "file" && got.hash !== want.hash) problems.push(`内容不一致 ${want.rel}`);
    else if (want.kind === "symlink" && got.link !== want.link) problems.push(`链接不一致 ${want.rel}`);
  }
  for (const extra of actual.keys()) problems.push(`多出 ${extra}`);
  return problems;
}

// ---------- 布局 ----------

export function readLayoutVersion(home: string): number | undefined {
  const version = readJsonFile<{ version?: unknown }>(layoutFile(home))?.version;
  return typeof version === "number" ? version : undefined;
}

export function isCurrentLayout(home: string): boolean {
  return readLayoutVersion(home) === LAYOUT_VERSION;
}

function createFreshLayout(home: string): void {
  for (const dir of ["system", "cache", "knowledge", "skills", "assistants", "archive/assistants"]) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  writeJsonAtomic(layoutFile(home), { version: LAYOUT_VERSION });
}

/** 根上除了 v2 该有的东西以外还有别的：说明是 v1（或者半搬的）数据。 */
function looksLegacy(home: string): boolean {
  if (!existsSync(home)) return false;
  return readdirSync(home).some((name) => !V2_ROOT_ENTRIES.has(name) && !name.startsWith(BACKUP_PREFIX));
}

export function findBackups(home: string): string[] {
  if (!existsSync(home)) return [];
  return readdirSync(home)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && isDir(join(home, name)))
    .map((name) => join(home, name))
    .sort();
}

function isCompleteBackup(dir: string): boolean {
  return existsSync(join(dir, BACKUP_MARKER));
}

function latestCompleteBackup(home: string): string | undefined {
  return findBackups(home).filter(isCompleteBackup).at(-1);
}

/** 遍历数据目录时跳过根上的备份目录（备份里有整份数据，不能算进数据本身）。 */
function skipBackup(rel: string): boolean {
  return rel.split(sep)[0]!.startsWith(BACKUP_PREFIX);
}

function dataManifest(home: string): TreeEntry[] {
  return manifestTree(home, skipBackup);
}

// ---------- 路径映射（moves.json） ----------

interface MovesFile {
  version: number;
  home: string;
  movedAt: string;
  entries: { from: string; to: string }[];
}

export class PathMap {
  private entries: { from: string; to: string }[] = [];

  constructor(entries: { from: string; to: string }[] = []) {
    for (const entry of entries) this.add(entry.from, entry.to);
    this.sort();
  }

  add(from: string, to: string): void {
    if (from === to) return;
    this.entries.push({ from, to });
    this.sort();
  }

  private sort(): void {
    this.entries.sort((a, b) => b.from.length - a.from.length);
  }

  /** 最长前缀匹配：目录按整个前缀换，文件按整条路径换；换不了就原样返回。 */
  map(path: string): string {
    for (const entry of this.entries) {
      if (path === entry.from) return entry.to;
      if (path.startsWith(`${entry.from}${sep}`)) return `${entry.to}${path.slice(entry.from.length)}`;
    }
    return path;
  }

  toJSON(): { from: string; to: string }[] {
    return [...this.entries].sort((a, b) => a.from.localeCompare(b.from));
  }
}

let movesCache: { file: string; stamp: string; map: PathMap } | undefined;

/** 读 system/moves.json；坏文件当成没有（老路径解析不了，但不影响新数据）。 */
export function movesIndex(home: string): PathMap {
  const file = movesFile(home);
  if (!existsSync(file)) return new PathMap();
  const stats = statSync(file);
  const stamp = `${stats.size}:${stats.mtimeMs}`;
  if (movesCache?.file === file && movesCache.stamp === stamp) return movesCache.map;
  const stored = readJsonFile<MovesFile>(file);
  const map = new PathMap(Array.isArray(stored?.entries) ? stored.entries : []);
  movesCache = { file, stamp, map };
  return map;
}

/** 旧路径换到新位置；换不了就原样返回。 */
export function resolveMovedPath(home: string, path: string): string {
  return movesIndex(home).map(path);
}

// ---------- 规划 ----------

function assistantDirs(home: string): Map<string, string> {
  const root = join(home, "assistants");
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    if (existsSync(join(dir, "profile.json"))) out.set(id, dir);
  }
  return out;
}

function archivedDirs(home: string): Map<string, string> {
  const root = archiveAssistantsDir(home);
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  for (const folder of readdirSync(root)) {
    const dir = join(root, folder);
    if (!isDir(dir)) continue;
    const profile = readJsonFile<{ id?: unknown }>(join(dir, "profile.json"));
    const id = typeof profile?.id === "string" && profile.id ? profile.id : folder;
    if (!out.has(id)) out.set(id, dir);
  }
  return out;
}

interface JobDir {
  id: string;
  dir: string;
  assistantId: string;
}

function jobDirs(home: string): JobDir[] {
  const root = join(home, "jobs");
  if (!existsSync(root)) return [];
  const out: JobDir[] = [];
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    const stored = readJsonFile<{ assistantId?: unknown }>(join(dir, "job.json"));
    if (!stored) continue;
    out.push({ id, dir, assistantId: typeof stored.assistantId === "string" && stored.assistantId ? stored.assistantId : FALLBACK_OWNER });
  }
  return out;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** 归属判定用的语料：各助手的对话 + 各任务的 job.json，主助手先、其余按 id 排。 */
function attributionCorpus(live: Map<string, string>, archived: Map<string, string>, jobs: JobDir[]): { assistantId: string; text: string }[] {
  const out: { assistantId: string; text: string }[] = [];
  for (const [id, dir] of [...live.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ assistantId: id, text: readText(join(dir, "router.jsonl")) });
  }
  for (const [id, dir] of [...archived.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ assistantId: id, text: readText(join(dir, "router.jsonl")) });
  }
  for (const job of jobs) out.push({ assistantId: job.assistantId, text: readText(join(job.dir, "job.json")) });
  return out;
}

export function buildMigrationPlan(home: string): MigrationPlan {
  const live = assistantDirs(home);
  const archived = archivedDirs(home);
  const jobs = jobDirs(home);
  const orphans = new Set<string>();
  const moves: PlannedMove[] = [];
  const splits: PlannedSplit[] = [];
  const owners: MigrationPlan["owners"] = [];

  const ownerDir = (assistantId: string): string => {
    const dir = live.get(assistantId) ?? archived.get(assistantId);
    if (dir) return dir;
    orphans.add(assistantId);
    return join(archiveAssistantsDir(home), `${assistantId}-orphan`);
  };

  const add = (from: string, to: string, kind: MoveKind, reason: string): void => {
    if (existsSync(from)) moves.push({ from, to, kind, reason });
  };

  // 根上的配置、凭据和引擎目录
  for (const name of ["config.json", "settings.json", "secrets.json", "push.json"]) {
    add(join(home, name), join(systemDir(home), name), "file", "系统文件");
  }
  for (const name of ["engine", "lore", "memory"]) {
    add(join(home, name), join(systemDir(home), name), "dir", "系统目录");
  }
  add(join(home, "usage-prices.json"), join(cacheDir(home), "usage-prices.json"), "file", "缓存");
  add(join(home, "github-cache"), join(cacheDir(home), "github"), "dir", "缓存");
  add(join(home, "previews"), join(cacheDir(home), "previews"), "dir", "缓存");

  // 助手的截图跟着助手走
  for (const [id, dir] of live) {
    add(join(dir, "screenshots"), assistantFilesDir(home, id, "screenshots"), "dir", `${id} 的截图`);
  }

  // 任务跟着所属助手走
  for (const job of jobs) {
    add(job.dir, join(ownerDir(job.assistantId), "jobs", job.id), "dir", `任务属于 ${job.assistantId}`);
  }

  // 页面、图片、上传：按对话里第一次提到它的助手
  const corpus = attributionCorpus(live, archived, jobs);
  const flat: { dir: string; kind: "pages" | "images" | "uploads" }[] = [
    { dir: join(home, "pages"), kind: "pages" },
    { dir: join(home, "images"), kind: "images" },
    { dir: join(home, "uploads"), kind: "uploads" },
  ];
  for (const group of flat) {
    if (!isDir(group.dir)) continue;
    for (const name of readdirSync(group.dir)) {
      const from = join(group.dir, name);
      if (!lstatSync(from).isFile()) continue;
      const hit = corpus.find((item) => item.text.includes(from));
      const assistantId = hit?.assistantId ?? FALLBACK_OWNER;
      const reason = hit ? `${assistantId} 提过它` : `谁都没提过，归 ${FALLBACK_OWNER}`;
      owners.push({ path: from, assistantId, reason });
      add(from, join(ownerDir(assistantId), "files", group.kind, name), "file", reason);
    }
  }

  // 定时任务的工作目录
  const routineRoot = join(home, "routines");
  if (isDir(routineRoot)) {
    const defined = readJsonFile<{ id?: unknown; assistantId?: unknown }[]>(join(home, "routines.json")) ?? [];
    for (const rid of readdirSync(routineRoot)) {
      const from = join(routineRoot, rid);
      if (!isDir(from)) continue;
      const routine = defined.find((item) => item.id === rid);
      const assistantId = typeof routine?.assistantId === "string" && routine.assistantId ? routine.assistantId : FALLBACK_OWNER;
      add(from, join(ownerDir(assistantId), "routines", rid), "dir", `定时属于 ${assistantId}`);
    }
  }

  // 审批、定时定义按助手拆开；草稿和委派都是主助手发出来的
  const split = (name: string, targetName: string, merge: boolean): void => {
    const from = join(home, name);
    const list = readJsonFile<{ assistantId?: unknown; id?: unknown }[]>(from);
    if (!Array.isArray(list) || !list.length) return;
    const byOwner = new Map<string, { id?: unknown }[]>();
    for (const item of list) {
      const assistantId = typeof item.assistantId === "string" && item.assistantId ? item.assistantId : FALLBACK_OWNER;
      byOwner.set(assistantId, [...(byOwner.get(assistantId) ?? []), item]);
    }
    for (const [assistantId, items] of byOwner) splits.push({ from, to: join(ownerDir(assistantId), targetName), items, merge });
  };
  split("approvals.json", "approvals.json", false);
  split("routines.json", "routines.json", true);
  for (const [name, target] of [["drafts.json", "drafts.json"], ["delegations.json", "delegations.json"]] as const) {
    const from = join(home, name);
    const items = readJsonFile<{ id?: unknown }[]>(from);
    if (Array.isArray(items)) splits.push({ from, to: join(assistantDir(home, FALLBACK_OWNER), target), items });
  }

  return { moves, splits, orphans: [...orphans], owners };
}

// ---------- 迁移 ----------

function availableBytes(home: string): number {
  let probe = resolve(home);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const stats = statfsSync(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

class Log {
  private lines: string[] = [];
  constructor(private path: string | undefined, private echo: (line: string) => void) {}
  write(line: string): void {
    this.lines.push(line);
    this.echo(line);
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${this.lines.join("\n")}\n`);
    } catch {
      // 日志写不了不影响迁移本身
    }
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function moveOne(move: PlannedMove): void {
  if (existsSync(move.to)) throw new Error(`迁移目标已存在：${move.to}`);
  mkdirSync(dirname(move.to), { recursive: true });
  try {
    renameSync(move.from, move.to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // 跨设备：复制、核对、再删原件
    const expected = manifestTree(move.from);
    copyEntry(move.from, move.to);
    const problems = compareTree(move.to, expected);
    if (problems.length) {
      rmSync(move.to, { recursive: true, force: true });
      throw new Error(`跨设备搬迁核对不上：${problems.slice(0, 3).join("；")}`);
    }
    rmSync(move.from, { recursive: true, force: true });
  }
}

/** 按 moves 改写结构化 JSON 里的绝对路径。 */
function rewritePaths(file: string, map: PathMap): string[] {
  const stored = readJsonFile<unknown>(file);
  if (!stored || typeof stored !== "object") return [];
  const changed: string[] = [];
  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === "string" && isAbsolute(value)) {
      const mapped = map.map(value);
      if (mapped === value) return value;
      changed.push(`${key} → ${mapped}`);
      return mapped;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${key}[${index}]`));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(value)) out[name] = walk(item, key ? `${key}.${name}` : name);
      return out;
    }
    return value;
  };
  const next = walk(stored, "");
  if (!changed.length) return [];
  writeJsonAtomic(file, next);
  return changed;
}

function jobJsonFiles(home: string): string[] {
  const out: string[] = [];
  for (const root of [join(home, "assistants"), archiveAssistantsDir(home)]) {
    if (!existsSync(root)) continue;
    for (const folder of readdirSync(root)) {
      const jobs = join(root, folder, "jobs");
      if (!isDir(jobs)) continue;
      for (const jobId of readdirSync(jobs)) {
        const file = join(jobs, jobId, "job.json");
        if (existsSync(file)) out.push(file);
      }
    }
  }
  return out;
}

function rewriteStructuredData(home: string, map: PathMap, log: Log): void {
  for (const file of jobJsonFiles(home)) {
    const changed = rewritePaths(file, map);
    if (changed.length) log.write(`  改写 ${relative(home, file)}：${changed.length} 处路径`);
  }
  const entries = join(home, "knowledge", "entries.json");
  const changed = rewritePaths(entries, map);
  if (changed.length) log.write(`  改写 knowledge/entries.json：${changed.length} 处路径`);
}

/** 老布局里已经搬空的平铺目录：连同目录一起删掉，根上只留 layout 里该有的东西。 */
const LEGACY_FLAT_DIRS = ["jobs", "pages", "images", "uploads", "routines", "github-cache", "previews"];

function cleanupLegacyDirs(home: string, log: Log): void {
  for (const name of LEGACY_FLAT_DIRS) {
    const dir = join(home, name);
    if (!existsSync(dir) || !isDir(dir)) continue;
    const left = readdirSync(dir);
    if (!left.length) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    // 看不出来归谁的东西不动，留在原地并在日志里说清楚
    log.write(`警告：${name}/ 里还剩 ${left.length} 项没有归属信息（${left.slice(0, 5).join("、")}），原样留着`);
  }
}

export function migrateHome(home: string, options: MigrateOptions = {}): MigrationSummary {
  const started = Date.now();
  const echo = options.log ?? ((line: string) => console.log(line));
  const done = (patch: Partial<MigrationSummary> & { status: MigrationSummary["status"] }): MigrationSummary => ({
    files: 0,
    jobs: 0,
    orphans: [],
    durationMs: Date.now() - started,
    ...patch,
  });

  if (isCurrentLayout(home)) return done({ status: "current" });
  const version = readLayoutVersion(home);
  if (version !== undefined) throw new Error(`数据目录的布局版本是 ${version}，这个版本的 Hob 只认 ${LAYOUT_VERSION}。`);

  const backups = findBackups(home);
  const complete = backups.filter(isCompleteBackup);

  if (options.dryRun) {
    if (complete.length) echo(`[dry-run] 上次迁移没做完：会先从 ${complete.at(-1)} 恢复，再迁移。`);
    if (!looksLegacy(home)) {
      echo(`[dry-run] 全新安装：会建好 v2 布局的目录并写 layout.json。`);
      return done({ status: "dry-run", plan: { moves: [], splits: [], orphans: [], owners: [] } });
    }
    const plan = buildMigrationPlan(home);
    echo(`[dry-run] 数据目录 ${home} 还是老布局，迁移会这样做：`);
    for (const move of plan.moves) echo(`  ${relative(home, move.from)} → ${relative(home, move.to)}（${move.reason}）`);
    for (const split of plan.splits) echo(`  ${relative(home, split.from)} 拆出 ${split.items.length} 条 → ${relative(home, split.to)}`);
    for (const orphan of plan.orphans) echo(`  孤儿助手 ${orphan} → ${relative(home, join(archiveAssistantsDir(home), `${orphan}-orphan`))}`);
    return done({ status: "dry-run", jobs: plan.moves.filter((move) => move.kind === "dir" && move.to.includes(`${sep}jobs${sep}`)).length, orphans: plan.orphans, plan });
  }

  // 上次迁移没做完：有完整备份就恢复后重来，只有半份备份就删掉重来（数据还没动过）。
  if (complete.length) {
    restoreHome(home, { log: echo });
  } else if (backups.length) {
    for (const dir of backups) rmSync(dir, { recursive: true, force: true });
    echo(`上次迁移留下的备份没写完，已删掉半份备份（${backups.map((dir) => relative(home, dir)).join("、")}），数据没动。`);
  }

  if (!looksLegacy(home)) {
    createFreshLayout(home);
    return done({ status: "created" });
  }

  const plan = buildMigrationPlan(home);
  const before = dataManifest(home);
  const needed = totalBytes(before) + SPACE_MARGIN;
  const available = options.availableBytes ?? availableBytes(home);
  if (available < needed) {
    const mb = (value: number): string => `${Math.ceil(value / 1024 / 1024)} MB`;
    throw new Error(`空间不够做迁移：需要 ${mb(needed)}（数据 ${mb(totalBytes(before))} + 余量 ${mb(SPACE_MARGIN)}），现在只剩 ${mb(available)}。腾出空间后再启动。`);
  }

  // 完整备份：出问题就从它恢复
  let backupDir = latestCompleteBackup(home);
  const reusedBackup = !!backupDir;
  if (!backupDir) {
    backupDir = join(home, `${BACKUP_PREFIX}${stamp()}`);
    copyChildren(home, backupDir, (name) => name.startsWith(BACKUP_PREFIX));
    options.hooks?.afterBackup?.(backupDir);
    const problems = compareTree(backupDir, before);
    if (problems.length) {
      rmSync(backupDir, { recursive: true, force: true });
      throw new Error(`迁移前的备份核对不上（${problems.slice(0, 3).join("；")}${problems.length > 3 ? ` 等 ${problems.length} 处` : ""}），已删掉这份备份，数据没有动。`);
    }
    writeJsonAtomic(join(backupDir, BACKUP_MARKER), { version: 1, createdAt: new Date().toISOString(), files: countFiles(before) });
  }

  const logPath = join(systemDir(home), "migrations", `v2-${stamp()}.log`);
  const log = new Log(logPath, echo);
  log.write(`# HOB_HOME 布局迁移 v${LAYOUT_VERSION}（${new Date().toISOString()}）`);
  log.write(`数据目录：${home}`);
  log.write(`备份：${relative(home, backupDir)}${reusedBackup ? "（沿用上次没做完的那份）" : ""}，${countFiles(before)} 个文件，${(totalBytes(before) / 1024 / 1024).toFixed(1)} MB，核对通过`);
  log.write(`可用空间 ${(available / 1024 / 1024).toFixed(0)} MB，需要 ${(needed / 1024 / 1024).toFixed(0)} MB`);

  const map = new PathMap();
  for (let index = 0; index < plan.moves.length; index += 1) {
    const move = plan.moves[index]!;
    log.write(`搬 ${relative(home, move.from)} → ${relative(home, move.to)}（${move.reason}）`);
    moveOne(move);
    map.add(move.from, move.to);
    options.hooks?.afterMove?.(index, plan.moves.length);
  }
  const jobCount = plan.moves.filter((move) => move.kind === "dir" && move.to.includes(`${sep}jobs${sep}`)).length;

  for (const split of plan.splits) {
    const existing = split.merge ? readJsonFile<{ id?: unknown }[]>(split.to) ?? [] : [];
    const merged = [...existing];
    for (const item of split.items) {
      const at = item.id === undefined ? -1 : merged.findIndex((entry) => entry.id === item.id);
      if (at >= 0) merged[at] = item;
      else merged.push(item);
    }
    writeJsonAtomic(split.to, merged);
    log.write(`拆 ${relative(home, split.from)}：${split.items.length} 条 → ${relative(home, split.to)}`);
    rmSync(split.from, { force: true });
  }
  for (const orphan of plan.orphans) {
    log.write(`孤儿助手 ${orphan}：任务、审批、定时搬进 ${relative(home, join(archiveAssistantsDir(home), `${orphan}-orphan`))}`);
  }

  rewriteStructuredData(home, map, log);
  cleanupLegacyDirs(home, log);

  writeJsonAtomic(movesFile(home), { version: LAYOUT_VERSION, home, movedAt: new Date().toISOString(), entries: map.toJSON() } satisfies MovesFile);
  for (const dir of ["cache", "knowledge", "skills", "assistants", "archive/assistants"]) mkdirSync(join(home, dir), { recursive: true });
  writeJsonAtomic(layoutFile(home), { version: LAYOUT_VERSION });
  log.write("写完 system/moves.json 和 layout.json，迁移结束");

  const summary = done({
    status: "migrated",
    backupDir,
    files: countFiles(dataManifest(home)),
    jobs: jobCount,
    orphans: plan.orphans,
    logPath,
  });
  log.write(`合计 ${summary.files} 个文件、${summary.jobs} 个任务，孤儿 ${plan.orphans.length} 个，用了 ${(summary.durationMs / 1000).toFixed(1)} 秒`);
  return summary;
}

/** 从备份恢复成老布局；迁移失败和用坏了想退回去都走这里。 */
export function restoreHome(home: string, options: { log?: (line: string) => void } = {}): { backupDir: string; files: number } {
  const echo = options.log ?? ((line: string) => console.log(line));
  const backupDir = latestCompleteBackup(home);
  if (!backupDir) throw new Error(`没有找到完整的备份（${BACKUP_PREFIX}*），没法恢复。`);
  const expected = manifestTree(backupDir, (rel) => rel === BACKUP_MARKER);
  const files = countFiles(expected);
  echo(`从备份恢复：${relative(home, backupDir)}（${files} 个文件）`);
  for (const name of readdirSync(home)) {
    if (name.startsWith(BACKUP_PREFIX)) continue;
    rmSync(join(home, name), { recursive: true, force: true });
  }
  copyChildren(backupDir, home, (name) => name === BACKUP_MARKER);
  const problems = compareTree(home, expected, skipBackup);
  if (problems.length) throw new Error(`从备份恢复后核对不上：${problems.slice(0, 3).join("；")}`);
  echo(`恢复完成，${files} 个文件核对一致`);
  return { backupDir, files };
}

/**
 * 启动前调一次：按需迁移，然后把一行总结打到控制台。
 * 返回 false 表示什么都没做（已经是新布局）。
 */
export function prepareHome(home: string): MigrationSummary {
  const summary = migrateHome(home);
  if (summary.status === "migrated") {
    console.log(
      `HOB_HOME 已迁移到 v2 布局：搬了 ${summary.files} 个文件、${summary.jobs} 个任务，孤儿 ${summary.orphans.length} 个，备份在 ${summary.backupDir}，日志 ${summary.logPath}`,
    );
  } else if (summary.status === "created") {
    console.log(`HOB_HOME（${home}）按 v2 布局建好了`);
  }
  return summary;
}
