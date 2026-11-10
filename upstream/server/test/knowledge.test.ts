import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/bus.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { knowledgeLink, parseKnowledgeLink } from "../../shared/knowledge.ts";
import { Store } from "../src/store.ts";
import { createApp } from "../src/http.ts";
import { call, makeHob, text } from "./helpers.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function setup(maxBytes?: number) {
  const home = mkdtempSync(join(tmpdir(), "hob-knowledge-")); homes.push(home);
  const bus = new Bus(); const store = new Store(home); store.init();
  return { home, knowledge: new KnowledgeStore(home, bus, store, maxBytes) };
}
describe("知识库存储", () => {
  it("去重、版本、中文搜索与筛选", async () => {
    const { home, knowledge } = setup(); const path = join(home, "u-abcdef-笔记.txt");
    writeFileSync(path, "一些中文资料");
    const first = await knowledge.collect({ origin: "chat", path, assistantId: "hob", itemId: "i1" });
    expect(first?.name).toBe("笔记.txt");
    await knowledge.collect({ origin: "output", path, assistantId: "hob" });
    expect((await knowledge.list()).entries).toHaveLength(1);
    writeFileSync(path, "新版重要知识内容");
    await knowledge.collect({ origin: "chat", path, assistantId: "hob" });
    const result = await knowledge.list({ q: "知识", origin: "chat", kind: "document", assistantId: "hob" });
    expect(result.entries[0]?.snippet).toContain("重要知识");
    expect(result.entries[0]?.versions?.[0]?.hash).toBe(first?.hash);
    expect((await knowledge.list({ before: result.entries[0]!.updatedAt })).entries).toHaveLength(0);
  });
  it("HTML 搜索只收正文，不收样式和脚本", async () => {
    const { home, knowledge } = setup();
    const path = join(home, "page.html");
    writeFileSync(path, `<html><head>
      <STYLE type="text/css">\nbody { color: red; }\n</STYLE>
      <script defer>\nconst hiddenScript = "秘密";\n</script>
      </head><body><h1>真实正文</h1><p>中文资料</p></body></html>`);
    await knowledge.collect({ origin: "output", path, assistantId: "hob" });
    expect((await knowledge.list({ q: "color" })).entries).toHaveLength(0);
    expect((await knowledge.list({ q: "hiddenScript" })).entries).toHaveLength(0);
    expect((await knowledge.list({ q: "秘密" })).entries).toHaveLength(0);
    const result = await knowledge.list({ q: "中文" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.snippet).toContain("真实正文");
    expect(result.entries[0]?.snippet).toContain("中文资料");
  });
  it("删除库时保留其他库的文件，删除最后一个库时清理内容", async () => {
    const { home, knowledge } = setup(); const path = join(home, "a.txt"); writeFileSync(path, "内容");
    const a = await knowledge.createCollection("甲"); const b = await knowledge.createCollection("乙");
    const entry = (await knowledge.upload({ path, name: "a.txt" }, a.id))!;
    await knowledge.upload({ path, name: "a.txt" }, b.id);
    expect((await knowledge.list({ collection: b.id })).entries).toHaveLength(1);
    expect(await knowledge.deleteCollection(a.id)).toBe(0); expect(existsSync(entry.path)).toBe(true);
    expect(await knowledge.deleteCollection(b.id)).toBe(1); expect(existsSync(entry.path)).toBe(false);
  });
  it("并发写入保留全部条目，时间相同时也能逐页浏览", async () => {
    const { home, knowledge } = setup();
    const paths = ["a.txt", "b.txt", "c.txt"].map((name) => join(home, name));
    paths.forEach((path, index) => writeFileSync(path, `文件${index}`));
    await Promise.all(paths.map((path) => knowledge.collect({ origin: "output", path, assistantId: "hob" })));
    const seen: string[] = []; let before: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await knowledge.list({ limit: 1, before });
      expect(page.entries).toHaveLength(1); seen.push(page.entries[0]!.id); before = page.entries[0]!.updatedAt;
      expect(page.hasMore).toBe(i < 2);
    }
    expect(new Set(seen).size).toBe(3);
    expect(await knowledge.list({ q: "文件", limit: 2 })).toMatchObject({ entries: [{ snippet: "文件2" }, { snippet: "文件1" }], hasMore: true });
    expect((await knowledge.list({ q: "文件", limit: 3 })).hasMore).toBe(false);
  });
  it("拒绝过大文件", async () => {
    const { home, knowledge } = setup(2); const path = join(home, "a.txt"); writeFileSync(path, "123");
    expect(await knowledge.collect({ origin: "chat", path, assistantId: "hob" })).toBeUndefined();
  });
});

describe("知识库接入", () => {
  it("收集页面、文件卡片、对话图片、对话附件及任务报告", async () => {
    const hob = makeHob();
    try {
      const pages = join(hob.home, "assistants", "hob", "files", "pages"); mkdirSync(pages, { recursive: true });
      const page = join(pages, "page.html"); writeFileSync(page, "<h1>页面内容</h1>");
      const file = join(hob.home, "output.txt"); writeFileSync(file, "文件内容");
      const image = join(hob.home, "picture.png"); writeFileSync(image, "图片内容");
      const upload = join(hob.home, "assistants", "hob", "files", "uploads", "u-abcdef-附件.txt"); mkdirSync(dirname(upload), { recursive: true }); writeFileSync(upload, "附件内容");
      const report = join(hob.home, "report.txt"); writeFileSync(report, "报告内容");
      const pageItem = await hob.runtime.router.addItem("hob", { kind: "file", path: page, name: "标题", meta: "摘要" });
      await hob.runtime.router.addItem("hob", { kind: "file", path: file, name: "output.txt" });
      const imageItem = await hob.runtime.router.addItem("hob", { kind: "image", status: "pending", prompt: "画一只猫", startedAt: new Date().toISOString() });
      await hob.runtime.router.updateImage("hob", imageItem.id, { status: "done", path: image });
      hob.faux.setResponses([text("收到")]);
      const user = await hob.runtime.router.send("hob", { text: "附件", files: [upload] });
      await hob.runtime.router.waitIdle("hob");
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成", files: [report] }), text("好"), text("完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "整理报告", instruction: "报告" });
      await hob.runtime.jobs.waitIdle(); await hob.runtime.router.waitIdle("hob"); await hob.runtime.knowledge.whenIdle();
      const entries = (await hob.runtime.knowledge.list()).entries;
      expect(entries.find((e) => e.name === "标题")).toMatchObject({ origin: "output", description: "摘要", source: { assistantId: "hob", itemId: pageItem.id } });
      expect(entries.find((e) => e.name === "output.txt")).toMatchObject({ origin: "output" });
      expect(entries.find((e) => e.name === "picture.png")).toMatchObject({ description: "画一只猫", source: { itemId: imageItem.id } });
      expect(entries.find((e) => e.name === "附件.txt")).toMatchObject({ origin: "chat", source: { itemId: user.id } });
      expect(entries.find((e) => e.name === "report.txt")).toMatchObject({ description: "整理报告", source: { jobId: job.id } });
    } finally { await hob.runtime.knowledge.whenIdle(); hob.close(); }
  });

  it("未配置模型时也收集发出的对话附件", async () => {
    const hob = makeHob({}, { keepSettings: true });
    try {
      const path = join(hob.home, "assistants", "hob", "files", "uploads", "u-abcdef-原文.txt"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "没有模型");
      const item = await hob.runtime.router.send("hob", { text: "附件", files: [path] });
      const entries = (await hob.runtime.knowledge.list({ origin: "chat" })).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ name: "原文.txt", source: { assistantId: "hob", itemId: item.id } });
    } finally { await hob.runtime.knowledge.whenIdle(); hob.close(); }
  });

  it("接口管理知识库和页面预览，缺失对象返回 404", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      const created = await app.request("/api/knowledge/collections", json("POST", { name: "资料" }));
      const { collection } = await created.json() as { collection: { id: string } };
      expect(created.status).toBe(200);
      expect((await app.request(`/api/knowledge/collections/${collection.id}`, json("PATCH", { name: "新资料" }))).status).toBe(200);
      const form = new FormData(); form.append("file", new File(["中文内容"], "资料.txt"));
      const uploaded = await app.request(`/api/knowledge/upload?collection=${collection.id}`, { method: "POST", headers: { cookie }, body: form });
      const { entries } = await uploaded.json() as { entries: { id: string; updatedAt: string }[] };
      expect(uploaded.status).toBe(200); expect(entries).toHaveLength(1);
      const renamed = await app.request(`/api/knowledge/entries/${entries[0]!.id}`, json("PATCH", { name: "改名" }));
      expect(renamed.status).toBe(200);
      expect((await renamed.json() as { entry: { name: string; updatedAt: string } }).entry).toMatchObject({ name: "改名", updatedAt: entries[0]!.updatedAt });
      expect((await app.request(`/api/knowledge?collection=${collection.id}`, { headers: { cookie } })).status).toBe(200);
      expect((await app.request(`/api/knowledge/entries/${entries[0]!.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
      expect((await app.request(`/api/knowledge/collections/${collection.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
      expect((await app.request("/api/knowledge/collections/missing", json("PATCH", { name: "x" }))).status).toBe(404);
      expect((await app.request("/api/knowledge/collections/missing", { method: "DELETE", headers: { cookie } })).status).toBe(404);
      expect((await app.request("/api/knowledge/entries/missing", json("PATCH", { name: "x" }))).status).toBe(404);
      expect((await app.request("/api/knowledge/entries/missing", { method: "DELETE", headers: { cookie } })).status).toBe(404);
      expect((await app.request("/api/knowledge/upload?collection=missing", { method: "POST", headers: { cookie } })).status).toBe(404);
      const pages = join(hob.home, "assistants", "hob", "files", "pages"); mkdirSync(pages, { recursive: true }); const page = join(pages, "original.html"); writeFileSync(page, "<p>页面</p>");
      const saved = (await hob.runtime.knowledge.collect({ origin: "output", path: page, assistantId: "hob" }))!;
      const meta = await app.request(`/api/files/meta?path=${encodeURIComponent(saved.path)}`, { headers: { cookie } });
      expect(await meta.json()).toMatchObject({ page: true });
    } finally { await hob.runtime.knowledge.whenIdle(); hob.close(); }
  });
});

describe("出处链接", () => {
  it("生成和解析 #k/<条目>/<段>，别的链接不认", () => {
    expect(knowledgeLink("k-abc123", 3)).toBe("#k/k-abc123/3");
    expect(parseKnowledgeLink("#k/k-abc123/3")).toEqual({ entryId: "k-abc123", chunk: 3 });
    expect(parseKnowledgeLink("#k/k-abc123")).toEqual({ entryId: "k-abc123" });
    for (const bad of ["#k/x/1", "#k/k-abc/1/2", "https://x.com/#k/k-a/1", "#k/k-a/-1"]) expect(parseKnowledgeLink(bad)).toBeNull();
  });
});
