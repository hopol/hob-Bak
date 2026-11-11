// v1 → v2 的目录迁移：老布局的造假 HOB_HOME + 各种坏情况（断电、空间不够、备份坏、恢复）。
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { isCurrentLayout, migrateHome, movesIndex, restoreHome } from "../src/layout.ts";
import { Store } from "../src/store.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

it("分拆旧审批时所有目标写完才删除来源", () => {
  const home = legacyHome();
  const source = join(home, "approvals.json");
  const original = fs.default.renameSync;
  let writes = 0;
  fs.default.renameSync = ((from, to) => {
    if (String(to).endsWith("/approvals.json") && ++writes === 2) throw new Error("注入第二个目标写入失败");
    return original(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    expect(() => migrateHome(home)).toThrow("注入第二个目标写入失败");
    expect(existsSync(source)).toBe(true);
    expect(JSON.parse(readFileSync(source, "utf8"))).toHaveLength(3);
  } finally { fs.default.renameSync = original; syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); }
});

function write(path: string, data: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  if (mode !== undefined) chmodSync(path, mode);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface SnapshotEntry {
  kind: "file" | "dir" | "symlink";
  hash?: string;
  link?: string;
  mode?: number;
}

/** 相对路径 → 内容摘要；内容里的 home 前缀统一成 <HOME>，方便比较两个临时目录。 */
function snapshot(home: string, options: { skip?: (rel: string) => boolean; normalize?: boolean } = {}): Map<string, SnapshotEntry> {
  const out = new Map<string, SnapshotEntry>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(home, path);
      if (options.skip?.(rel)) continue;
      if (entry.isSymbolicLink()) out.set(rel, { kind: "symlink", link: readlinkSync(path) });
      else if (entry.isDirectory()) {
        out.set(rel, { kind: "dir" });
        walk(path);
      } else {
        const text = readFileSync(path);
        const hash = createHash("sha256")
          .update(options.normalize ? text.toString("utf8").replaceAll(home, "<HOME>") : text)
          .digest("hex");
        out.set(rel, { kind: "file", hash, mode: statSync(path).mode & 0o777 });
      }
    }
  };
  walk(home);
  return out;
}

function skipVolatile(rel: string): boolean {
  return rel.split("/")[0]!.startsWith("backup-v1-") || rel.startsWith("system/migrations") || rel === "system/moves.json";
}

/** 造一份老布局的 HOB_HOME：每类文件都有，带权限、符号链接、绝对路径和归属。 */
function legacyHome(): string {
  const home = mkdtempSync(join(tmpdir(), "hob-migrate-"));
  // 根上的配置、凭据、缓存
  write(join(home, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 30148, passwordHash: "scrypt$x", cookieSecret: "s" }), 0o600);
  write(join(home, "settings.json"), JSON.stringify({ revision: 3, settings: {} }));
  write(join(home, "secrets.json"), JSON.stringify({ "provider:openai": "sk-x" }), 0o600);
  write(join(home, "push.json"), JSON.stringify({ publicKey: "k" }), 0o600);
  write(join(home, "usage-prices.json"), JSON.stringify({ prices: {} }));
  write(join(home, "rules.json"), JSON.stringify([]));
  write(join(home, "approvals.json"), JSON.stringify([
    { id: "ap-hob", assistantId: "hob", title: "主助手的审批", status: "pending", options: [], source: "router", createdAt: "2026-11-01T00:00:00.000Z" },
    { id: "ap-one", assistantId: "a-one", title: "一号的审批", status: "answered", options: [], source: "router", createdAt: "2026-11-02T00:00:00.000Z" },
    { id: "ap-gone", assistantId: "a-gone", title: "孤儿的审批", status: "expired", options: [], source: "job", createdAt: "2026-11-03T00:00:00.000Z" },
  ]));
  write(join(home, "routines.json"), JSON.stringify([
    { id: "rt-hob", assistantId: "hob", name: "早报", instruction: "写早报", schedules: ["0 8 * * *"], active: true, createdAt: "2026-11-01T00:00:00.000Z", runs: [] },
    { id: "rt-one", assistantId: "a-one", name: "周报", instruction: "写周报", schedules: ["0 8 * * 5"], active: true, createdAt: "2026-11-01T00:00:00.000Z", runs: [] },
    { id: "rt-gone", assistantId: "a-gone", name: "孤儿定时", instruction: "跑", schedules: ["0 8 * * *"], active: false, createdAt: "2026-11-01T00:00:00.000Z", runs: [] },
  ]));
  write(join(home, "drafts.json"), JSON.stringify([{ id: "d-1", assistantId: "hob", name: "写作", status: "pending" }]));
  write(join(home, "delegations.json"), JSON.stringify([{ id: "dgl-1", from: "hob", to: "a-one", jobIds: [] }]));
  // 引擎、Lore、记忆、缓存
  write(join(home, "engine", "auth.json"), "{}", 0o600);
  write(join(home, "engine", "models.json"), JSON.stringify({ providers: {} }));
  write(join(home, "engine", "bin", "rg"), "bin", 0o700);
  write(join(home, "lore", "config.json"), JSON.stringify({ base_url: "http://127.0.0.1:18901" }), 0o600);
  write(join(home, "memory", "memories.json"), JSON.stringify([]));
  write(join(home, "cache", "thumbs", "t.jpg"), "thumb");
  write(join(home, "github-cache", "owner", "repo", "clone.txt"), "clone");
  write(join(home, "previews", "p.png"), PNG);
  // 全局技能和知识库
  write(join(home, "skills", "search", "SKILL.md"), "# 搜索");
  write(join(home, "knowledge", "blobs", "abc.txt"), "blob");
  write(join(home, "knowledge", "text", "abc.txt"), "blob");
  // 助手：主助手、一号、归档的 a-old
  write(join(home, "assistants", "hob", "profile.json"), JSON.stringify({ id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, pinned: true, hidden: false, notify: true, createdAt: "2026-10-01T00:00:00.000Z" }));
  write(join(home, "assistants", "hob", "rules.json"), JSON.stringify([]));
  write(join(home, "assistants", "a-one", "profile.json"), JSON.stringify({ id: "a-one", name: "一号", duty: "干活", sprite: "hob", primary: false, pinned: false, hidden: false, notify: true, createdAt: "2026-10-02T00:00:00.000Z" }));
  write(join(home, "assistants", "a-one", "screenshots", "shot.png"), PNG);
  write(join(home, "assistants", "a-one", "skills", "wr", "SKILL.md"), "# 写作");
  write(join(home, "archive", "assistants", "a-old-2026-11-05T01-43-48-838Z", "profile.json"), JSON.stringify({ id: "a-old", name: "老的", duty: "旧", sprite: "hob", primary: false, pinned: false, hidden: false, notify: true, createdAt: "2026-09-01T00:00:00.000Z" }));
  write(join(home, "archive", "assistants", "a-old-2026-11-05T01-43-48-838Z", "rules.json"), JSON.stringify([]));
  // 定时的工作目录
  write(join(home, "routines", "rt-hob", "last_alert"), "2026-11-06");
  write(join(home, "routines", "rt-one", "state"), "1");
  write(join(home, "routines", "rt-gone", "state"), "0");
  // 页面、图片、上传
  write(join(home, "pages", "11111111-1111-1111-1111-111111111111.html"), "<p>共用页面</p>");
  write(join(home, "pages", "22222222-2222-2222-2222-222222222222.html"), "<p>一号的页面</p>");
  write(join(home, "pages", "33333333-3333-3333-3333-333333333333.html"), "<p>孤儿任务的页面</p>");
  write(join(home, "pages", "44444444-4444-4444-4444-444444444444.html"), "<p>没人提过</p>");
  write(join(home, "images", "img-one.png"), PNG);
  write(join(home, "images", "img-none.png"), PNG);
  write(join(home, "uploads", "u-1-笔记.txt"), "上传一");
  write(join(home, "uploads", "u-2-笔记.txt"), "上传二");
  // 任务：主助手、一号、归档助手、孤儿
  const job = (id: string, assistantId: string, extra: Record<string, unknown> = {}) => {
    const dir = join(home, "jobs", id);
    write(join(dir, "job.json"), JSON.stringify({
      id,
      assistantId,
      assistantName: assistantId,
      title: `任务 ${id}`,
      instruction: "干活",
      kind: "local",
      status: "done",
      createdAt: "2026-11-01T00:00:00.000Z",
      stats: { reads: 0, commands: 0, edits: 0 },
      activity: [],
      cwd: join(dir, "work"),
      reportPath: join(dir, "report.md"),
      ...extra,
    }));
    write(join(dir, "worker.jsonl"), `${JSON.stringify({ type: "session", cwd: join(dir, "work") })}\n${JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: `读 ${join(dir, "work", "a.txt")}` }] })}\n`);
    write(join(dir, "report.md"), `# ${id} 的报告\n读 ${join(dir, "work", "a.txt")}\n`);
    write(join(dir, "steps", "s1.txt"), "工具输出");
    write(join(dir, "work", "a.txt"), `产出 ${id}`);
  };
  job("t-hob", "hob", {
    files: [join(home, "jobs", "t-hob", "work", "a.txt"), join(home, "pages", "11111111-1111-1111-1111-111111111111.html")],
    rounds: [{ round: 1, at: "2026-11-01T00:00:00.000Z", reportPath: join(home, "jobs", "t-hob", "report.md"), files: [join(home, "jobs", "t-hob", "work", "a.txt")] }],
    inputs: [join(home, "uploads", "u-1-笔记.txt")],
  });
  job("t-one", "a-one", { files: [join(home, "jobs", "t-one", "work", "a.txt")] });
  job("t-old", "a-old");
  job("t-orph", "a-gone", { files: [join(home, "pages", "33333333-3333-3333-3333-333333333333.html")] });
  // 权限和符号链接：任务里有 0600 文件和指向同目录文件的相对链接
  write(join(home, "jobs", "t-one", "work", "secret.txt"), "只给自己看", 0o600);
  write(join(home, "jobs", "t-one", "work", "CLAUDE.md"), "# 项目说明");
  symlinkSync("CLAUDE.md", join(home, "jobs", "t-one", "work", ".cursorrules"));
  // 对话：卡片和事件里写的是老路径
  const routerLine = (path: string) => `${JSON.stringify({ type: "custom", customType: "hob.item", data: { kind: "file", path } })}\n`;
  const eventLine = (path: string) => `${JSON.stringify({ type: "custom_message", customType: "hob.event", content: `任务结束。全文：${path}` })}\n`;
  write(join(home, "assistants", "hob", "router.jsonl"), [
    `${JSON.stringify({ type: "session", cwd: home })}\n`,
    routerLine(join(home, "pages", "11111111-1111-1111-1111-111111111111.html")),
    routerLine(join(home, "pages", "22222222-2222-2222-2222-222222222222.html")),
    routerLine(join(home, "uploads", "u-1-笔记.txt")),
    eventLine(join(home, "jobs", "t-hob", "report.md")),
  ].join(""));
  write(join(home, "assistants", "a-one", "router.jsonl"), [
    `${JSON.stringify({ type: "session", cwd: home })}\n`,
    routerLine(join(home, "pages", "22222222-2222-2222-2222-222222222222.html")),
    `${JSON.stringify({ type: "custom", customType: "hob.item", data: { kind: "image", status: "done", path: join(home, "images", "img-one.png") } })}\n`,
  ].join(""));
  // 知识条目：原始路径、去重键、历史版本
  write(join(home, "knowledge", "entries.json"), JSON.stringify([
    {
      id: "k-1",
      name: "一号的页面",
      path: join(home, "knowledge", "pages", `${"a".repeat(64)}.html`),
      hash: "a".repeat(64),
      size: 10,
      kind: "html",
      origin: "output",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      collections: [],
      sourceKey: join(home, "pages", "22222222-2222-2222-2222-222222222222.html"),
      source: { assistantId: "a-one" },
      versions: [{ hash: "b".repeat(64), path: join(home, "knowledge", "blobs", `${"b".repeat(64)}.html`), size: 9, at: "2026-10-31T00:00:00.000Z" }],
    },
  ]));
  write(join(home, "knowledge", "pages", `${"a".repeat(64)}.html`), "<p>页面副本</p>");
  write(join(home, "knowledge", "blobs", `${"b".repeat(64)}.html`), "<p>旧副本</p>");
  return home;
}

function rootEntries(home: string): string[] {
  return readdirSync(home).sort();
}

function expectCleanRoot(home: string): void {
  const allowed = new Set(["layout.json", "rules.json", "system", "cache", "knowledge", "skills", "assistants", "groups", "archive"]);
  const unexpected = rootEntries(home).filter((name) => !allowed.has(name) && !name.startsWith("backup-v1-"));
  expect(unexpected).toEqual([]);
}

describe("HOB_HOME 迁移 v2", () => {
  it("按归属搬好每个文件，结构和权限不变，会话文件一个字节没改", () => {
    const home = legacyHome();
    const before = snapshot(home);
    const routerBefore = readFileSync(join(home, "assistants", "hob", "router.jsonl"));
    try {
      const summary = migrateHome(home, { log: () => {} });
      expect(summary.status).toBe("migrated");
      expect(isCurrentLayout(home)).toBe(true);
      expect(movesIndex(home).map(join(home, "settings.json"))).toBe(join(home, "system", "settings.json"));
      expect(typeof summary.backupDir).toBe("string");
      expect(summary.backupDir && existsSync(summary.backupDir)).toBe(true);
      expect(summary.logPath && existsSync(summary.logPath)).toBe(true);

      // 根上只剩布局里该有的东西
      expectCleanRoot(home);

      // 系统文件和引擎目录
      for (const rel of ["system/config.json", "system/settings.json", "system/secrets.json", "system/push.json", "system/engine/auth.json", "system/engine/models.json", "system/engine/bin/rg", "system/lore/config.json", "system/memory/memories.json"]) {
        expect(existsSync(join(home, rel)), rel).toBe(true);
      }
      expect(statSync(join(home, "system", "secrets.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, "system", "engine", "auth.json")).mode & 0o777).toBe(0o600);
      // 缓存
      expect(existsSync(join(home, "cache", "usage-prices.json"))).toBe(true);
      expect(existsSync(join(home, "cache", "github", "owner", "repo", "clone.txt"))).toBe(true);
      expect(existsSync(join(home, "cache", "previews", "p.png"))).toBe(true);
      expect(existsSync(join(home, "cache", "thumbs", "t.jpg"))).toBe(true);
      // 任务跟着助手走
      for (const [assistant, jobId] of [["hob", "t-hob"], ["a-one", "t-one"], ["a-old", "t-old"]]) {
        const base = assistant === "a-old"
          ? join(home, "archive", "assistants", "a-old-2026-11-05T01-43-48-838Z", "jobs", jobId)
          : join(home, "assistants", assistant, "jobs", jobId);
        for (const name of ["job.json", "worker.jsonl", "report.md", "steps/s1.txt", "work/a.txt"]) {
          expect(existsSync(join(base, name)), `${assistant}/${jobId}/${name}`).toBe(true);
        }
      }
      // 0600 和相对符号链接都保住了
      expect(statSync(join(home, "assistants", "a-one", "jobs", "t-one", "work", "secret.txt")).mode & 0o777).toBe(0o600);
      const link = join(home, "assistants", "a-one", "jobs", "t-one", "work", ".cursorrules");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe("CLAUDE.md");
      // 页面、图片、上传的归属
      expect(existsSync(join(home, "assistants", "hob", "files", "pages", "11111111-1111-1111-1111-111111111111.html"))).toBe(true);
      expect(existsSync(join(home, "assistants", "hob", "files", "pages", "44444444-4444-4444-4444-444444444444.html"))).toBe(true);
      expect(existsSync(join(home, "assistants", "a-one", "files", "pages", "22222222-2222-2222-2222-222222222222.html"))).toBe(true);
      expect(existsSync(join(home, "assistants", "a-one", "files", "images", "img-one.png"))).toBe(true);
      expect(existsSync(join(home, "assistants", "hob", "files", "images", "img-none.png"))).toBe(true);
      expect(existsSync(join(home, "assistants", "hob", "files", "uploads", "u-1-笔记.txt"))).toBe(true);
      expect(existsSync(join(home, "assistants", "hob", "files", "uploads", "u-2-笔记.txt"))).toBe(true);
      expect(existsSync(join(home, "assistants", "a-one", "files", "screenshots", "shot.png"))).toBe(true);
      // 孤儿助手：任务、页面、审批、定时都进 orphan 目录，一个不丢
      const orphan = join(home, "archive", "assistants", "a-gone-orphan");
      expect(existsSync(join(orphan, "jobs", "t-orph", "job.json"))).toBe(true);
      expect(existsSync(join(orphan, "files", "pages", "33333333-3333-3333-3333-333333333333.html"))).toBe(true);
      expect(readJsonArray(join(orphan, "approvals.json")).map((item) => item.id)).toEqual(["ap-gone"]);
      expect(readJsonArray(join(orphan, "routines.json")).map((item) => item.id)).toEqual(["rt-gone"]);
      expect(existsSync(join(orphan, "routines", "rt-gone", "state"))).toBe(true);
      // 审批和定时按助手拆开
      expect(readJsonArray(join(home, "assistants", "hob", "approvals.json")).map((item) => item.id)).toEqual(["ap-hob"]);
      expect(readJsonArray(join(home, "assistants", "a-one", "approvals.json")).map((item) => item.id)).toEqual(["ap-one"]);
      expect(readJsonArray(join(home, "assistants", "hob", "routines.json")).map((item) => item.id)).toEqual(["rt-hob"]);
      expect(readJsonArray(join(home, "assistants", "a-one", "routines.json")).map((item) => item.id)).toEqual(["rt-one"]);
      expect(existsSync(join(home, "assistants", "hob", "routines", "rt-hob", "last_alert"))).toBe(true);
      expect(existsSync(join(home, "assistants", "a-one", "routines", "rt-one", "state"))).toBe(true);
      // 草稿和委派跟主助手走
      expect(readJsonArray(join(home, "assistants", "hob", "drafts.json")).map((item) => item.id)).toEqual(["d-1"]);
      expect(readJsonArray(join(home, "assistants", "hob", "delegations.json")).map((item) => item.id)).toEqual(["dgl-1"]);

      // 会话文件逐字节没变
      expect(readFileSync(join(home, "assistants", "hob", "router.jsonl")).equals(routerBefore)).toBe(true);

      // 结构化 JSON 的绝对路径都改成新位置，而且都指得到文件
      const migrated = JSON.parse(readFileSync(join(home, "assistants", "hob", "jobs", "t-hob", "job.json"), "utf8")) as Record<string, any>;
      expect(migrated.cwd).toBe(join(home, "assistants", "hob", "jobs", "t-hob", "work"));
      expect(existsSync(migrated.cwd)).toBe(true);
      expect(existsSync(migrated.reportPath)).toBe(true);
      expect(migrated.files.every((path: string) => existsSync(path))).toBe(true);
      expect(migrated.inputs.every((path: string) => existsSync(path))).toBe(true);
      expect(existsSync(migrated.rounds[0].reportPath)).toBe(true);
      expect(migrated.rounds[0].files.every((path: string) => existsSync(path))).toBe(true);
      const entries = readJsonArray(join(home, "knowledge", "entries.json"));
      expect(existsSync(String(entries[0]!.path))).toBe(true);
      expect(existsSync(String(entries[0]!.sourceKey))).toBe(true);
      expect(existsSync(String((entries[0]!.versions as any[])[0].path))).toBe(true);
      expect(String(entries[0]!.sourceKey)).toContain("assistants/a-one/files/pages");

      // 会话里的每个老路径都能按 moves.json 解析到存在的文件
      const moves = movesIndex(home);
      for (const rel of ["assistants/hob/router.jsonl", "assistants/a-one/router.jsonl"]) {
        const text = readFileSync(join(home, rel), "utf8");
        for (const match of text.matchAll(/"(\/[^"]+)"/g)) {
          const old = match[1]!;
          if (!old.startsWith(home) || old === home) continue;
          const mapped = moves.map(old);
          expect(mapped, old).not.toBe(old);
          expect(existsSync(mapped), mapped).toBe(true);
        }
      }

      // 内容和权限：每个原文件都在某个新位置上有同样内容（会被重写的结构化 JSON 另有断言）
      const rewritten = /(^|\/)(job\.json|entries\.json|approvals\.json|routines\.json|drafts\.json|delegations\.json)$/;
      const after = snapshot(home, { skip: skipVolatile });
      const afterHashes = new Set([...after.values()].filter((entry) => entry.kind === "file").map((entry) => entry.hash));
      for (const [rel, entry] of before) {
        if (entry.kind !== "file" || rewritten.test(rel)) continue;
        expect(afterHashes.has(entry.hash), rel).toBe(true);
      }

      // 迁移后的数据能被 Store 正常读出来
      const store = new Store(home);
      expect(store.jobs().map((item) => item.id).sort()).toEqual(["t-hob", "t-old", "t-one", "t-orph"]);
      expect(store.job("t-old")?.assistantId).toBe("a-old");
      expect(store.approvals().map((item) => item.id).sort()).toEqual(["ap-gone", "ap-hob", "ap-one"]);
      expect(store.routines().map((item) => item.id).sort()).toEqual(["rt-hob", "rt-one"]);

      // 跑第二遍什么都不做
      const afterFirst = snapshot(home, { normalize: true });
      expect(migrateHome(home, { log: () => {} }).status).toBe("current");
      expect(snapshot(home, { normalize: true })).toEqual(afterFirst);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("全新安装直接得到新布局", () => {
    const home = mkdtempSync(join(tmpdir(), "hob-migrate-fresh-"));
    try {
      expect(migrateHome(home, { log: () => {} }).status).toBe("created");
      expect(JSON.parse(readFileSync(join(home, "layout.json"), "utf8"))).toEqual({ version: 2 });
      for (const rel of ["system", "cache", "knowledge", "skills", "assistants", "archive/assistants"]) {
        expect(existsSync(join(home, rel)), rel).toBe(true);
      }
      expect(readdirSync(home).filter((name) => name.startsWith("backup-v1-"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("搬的过程中断电：下次启动先恢复再重迁，结果和一次跑完一样", () => {
    const baseline = legacyHome();
    try {
      migrateHome(baseline, { log: () => {} });
      const expected = snapshot(baseline, { skip: skipVolatile, normalize: true });
      for (const index of [0, 12, -1]) {
        const home = legacyHome();
        try {
          let moves = 0;
          expect(() => migrateHome(home, {
            log: () => {},
            hooks: {
              afterMove: (at, all) => {
                moves = all;
                if (at === (index < 0 ? all - 1 : Math.min(index, all - 1))) throw new Error("模拟断电");
              },
            },
          })).toThrow("模拟断电");
          expect(moves).toBeGreaterThan(0);
          // 断电后数据还是半搬的，但备份是完整的
          expect(isCurrentLayout(home)).toBe(false);
          // 再启动一次：恢复 + 重迁
          const summary = migrateHome(home, { log: () => {} });
          expect(summary.status).toBe("migrated");
          expect(snapshot(home, { skip: skipVolatile, normalize: true })).toEqual(expected);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(baseline, { recursive: true, force: true });
    }
  });

  it("空间不够就拒绝启动，数据不动", () => {
    const home = legacyHome();
    try {
      const before = snapshot(home);
      expect(() => migrateHome(home, { log: () => {}, availableBytes: 1024 * 1024 })).toThrow(/空间不够/);
      expect(isCurrentLayout(home)).toBe(false);
      expect(snapshot(home)).toEqual(before);
      expect(readdirSync(home).filter((name) => name.startsWith("backup-v1-"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("备份核对不上就拒绝启动，数据不动", () => {
    const home = legacyHome();
    try {
      const before = snapshot(home);
      expect(() => migrateHome(home, {
        log: () => {},
        hooks: { afterBackup: (dir) => writeFileSync(join(dir, "settings.json"), "改坏了") },
      })).toThrow(/备份核对不上/);
      expect(isCurrentLayout(home)).toBe(false);
      expect(snapshot(home)).toEqual(before);
      // 坏掉的备份已经删掉，不会把下次启动骗进「从坏备份恢复」
      expect(readdirSync(home).filter((name) => name.startsWith("backup-v1-"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--restore 之后和迁移前逐文件一致", () => {
    const home = legacyHome();
    try {
      const before = snapshot(home);
      migrateHome(home, { log: () => {} });
      expect(isCurrentLayout(home)).toBe(true);
      restoreHome(home, { log: () => {} });
      expect(isCurrentLayout(home)).toBe(false);
      expect(snapshot(home, { skip: (rel) => rel.startsWith("backup-v1-") })).toEqual(before);
      // 恢复后能再迁一次，结果和第一次一样
      expect(migrateHome(home, { log: () => {} }).status).toBe("migrated");
      expectCleanRoot(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("dry-run 只打印计划，一个文件都不动", () => {
    const home = legacyHome();
    try {
      const before = snapshot(home);
      const lines: string[] = [];
      const summary = migrateHome(home, { dryRun: true, log: (line) => lines.push(line) });
      expect(summary.status).toBe("dry-run");
      expect(lines.some((line) => line.includes("jobs/t-hob"))).toBe(true);
      expect(snapshot(home)).toEqual(before);
      expect(isCurrentLayout(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function readJsonArray(path: string): any[] {
  return JSON.parse(readFileSync(path, "utf8")) as any[];
}
