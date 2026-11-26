import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginStore } from "../src/plugin-store.ts";
import { PluginSources } from "../src/plugin-sources.ts";
import { searchPluginsTool } from "../src/search-plugins.ts";
import { PluginHost } from "../src/plugin-host.ts";

const dirs: string[] = [];
const servers: Server[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "hob-source-test-")); dirs.push(dir); return dir; }
function git(dir: string, ...args: string[]) { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }); }
function repository() {
  const dir = temp();
  cpSync(new URL("./fixtures/hob-plugins/", import.meta.url), dir, { recursive: true });
  git(dir, "init", "-q"); git(dir, "add", ".");
  git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture");
  return dir;
}
function commit(dir: string) { git(dir, "add", "-A"); git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "change"); }
async function http(files: Record<string, string | Buffer>) {
  const server = createServer((req, res) => {
    const file = files[req.url ?? ""];
    if (file === undefined) { res.writeHead(404); res.end(); }
    else { res.writeHead(200); res.end(file); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("plugin sources", () => {
  it("clones an official source, preserves a cached snapshot on failure, and updates old official installs", async () => {
    const repo = repository(), home = temp();
    const store = new PluginStore(home, undefined, pathToFileURL(repo).href);
    await store.sources.open();
    expect(store.catalog().map(entry => entry.id)).toEqual(["vault", "github", "gmail", "email"]);
    store.install("github");
    const docPath = join(home, "system/plugins.json");
    const doc = JSON.parse(readFileSync(docPath, "utf8"));
    delete doc.plugins[0].sourceName;
    writeFileSync(docPath, JSON.stringify(doc));
    const manifestPath = join(repo, "github/plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")); manifest.version = "2.0.0";
    writeFileSync(manifestPath, JSON.stringify(manifest)); commit(repo);
    await store.sources.refresh("official");
    expect(store.install("github", true).version).toBe("2.0.0");
    rmSync(repo, { recursive: true, force: true });
    await expect(store.sources.refresh("official")).rejects.toThrow();
    expect(store.sources.list()[0].error).toBeTruthy();
    expect(store.catalog().find(entry => entry.id === "github")?.version).toBe("2.0.0");
    expect(() => store.sources.remove("official")).toThrow();
  });

  it("downloads JSON sources with and without file lists and isolates malformed entries", async () => {
    const files: Record<string, string | Buffer> = {
      "/index.json": JSON.stringify({ name: "示例源", plugins: [{ id: "one", path: "one", files: ["plugin.json", "mcp.json", "skills/guide/SKILL.md"] }, { id: "two", path: "two" }, { id: "broken", path: "broken" }] }),
      "/one/plugin.json": JSON.stringify({ name: "one", version: "1.0.0" }), "/one/mcp.json": JSON.stringify({ mcpServers: {} }), "/one/skills/guide/SKILL.md": "guide",
      "/two/plugin.json": JSON.stringify({ name: "two", version: "1.0.0", extensions: { "com.hob.plugins": { icon: "icon.svg" } } }), "/two/mcp.json": JSON.stringify({ mcpServers: {} }), "/two/icon.svg": "<svg />",
      "/broken/plugin.json": "{}", "/broken/mcp.json": "{}",
    };
    const base = await http(files), home = temp();
    const sources = new PluginSources(home, undefined, "file:///missing");
    const added = await sources.add(`${base}/index.json`);
    expect(added.name).toBe("示例源");
    expect(sources.catalog().map(entry => [entry.id, Boolean(entry.error)])).toEqual([["one", false], ["two", false], ["broken", true]]);
    expect(readFileSync(join(home, "cache/plugin-sources", added.id, "one/skills/guide/SKILL.md"), "utf8")).toBe("guide");
    expect(readFileSync(join(home, "cache/plugin-sources", added.id, "two/icon.svg"), "utf8")).toBe("<svg />");
    await expect(sources.add(`${base}/index.json`)).rejects.toThrow("这个源已经添加过了");
    files["/index.json"] = "invalid";
    await expect(sources.refresh(added.id)).rejects.toThrow();
    expect(sources.catalog()).toHaveLength(3);
  });

  it("rejects traversal, oversized files and git symbolic links without replacing the previous snapshot", async () => {
    const repo = repository(), home = temp();
    const sources = new PluginSources(home, undefined, pathToFileURL(repo).href);
    await sources.open();
    symlinkSync("/etc/passwd", join(repo, "github/link")); commit(repo);
    await expect(sources.refresh("official")).rejects.toThrow("符号链接");
    expect(sources.catalog()).toHaveLength(3);
    const files: Record<string, string | Buffer> = { "/index.json": JSON.stringify({ plugins: [{ id: "bad", path: "../bad" }] }) };
    const base = await http(files);
    await expect(sources.add(`${base}/index.json`)).rejects.toThrow("不安全");
    files["/index.json"] = JSON.stringify({ plugins: [{ id: "big", path: "big" }] });
    files["/big/plugin.json"] = Buffer.alloc(1024 * 1024 + 1);
    await expect(sources.add(`${base}/index.json`)).rejects.toThrow("1 MB");
  });

  it("reports unavailable git and keeps first-load failures visible", async () => {
    const home = temp();
    const sources = new PluginSources(home, undefined, "file:///missing-test-source");
    const previous = process.env.PATH;
    process.env.PATH = join(home, "no-git");
    try { await sources.open(); }
    finally { process.env.PATH = previous; }
    expect(sources.list()[0].error).toContain("这台机器没有装 git");
    expect(sources.list()[0].updatedAt).toBeUndefined();
    expect(sources.catalog()).toEqual([]);
  });

  it("reports request timeouts without retaining a failed source", async () => {
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(80));
    const sources = new PluginSources(temp(), undefined, "file:///missing");
    try { await expect(sources.add(`http://127.0.0.1:${port}/index.json`)).rejects.toThrow(); }
    finally { spy.mockRestore(); server.closeAllConnections(); }
    expect(sources.list()).toHaveLength(1);
  });

  it("rejects a source whose combined files exceed 20 MB", async () => {
    const names = Array.from({ length: 21 }, (_, i) => `${i}.bin`);
    const files: Record<string, string | Buffer> = {
      "/index.json": JSON.stringify({ plugins: [{ id: "big", path: "big", files: ["plugin.json", "mcp.json", ...names] }] }),
      "/big/plugin.json": JSON.stringify({ version: "1.0.0" }), "/big/mcp.json": JSON.stringify({ mcpServers: {} }),
    };
    const buffer = Buffer.alloc(1024 * 1024);
    for (const name of names) files[`/big/${name}`] = buffer;
    const base = await http(files);
    await expect(new PluginSources(temp(), undefined, "file:///missing").add(`${base}/index.json`)).rejects.toThrow("20 MB");
  });

  it("keeps same-id plugins separate and installed plugins usable after source removal", async () => {
    const official = repository(), other = repository(), home = temp();
    const store = new PluginStore(home, undefined, pathToFileURL(official).href);
    await store.sources.open();
    const source = await store.sources.add(pathToFileURL(other).href);
    store.install("github");
    expect(store.catalog().filter(entry => entry.id === "github")).toHaveLength(2);
    expect(() => store.install("github", false, false, source.id)).toThrow("已经装了来自「Hob 官方」的 GitHub，先卸载它再装这个");
    store.remove("github");
    store.install("github", false, false, source.id);
    store.sources.remove(source.id);
    expect(store.files("github").manifest.name).toBe("github");
    expect(() => store.install("github", true)).toThrow();
  });

  it("reports source names in search only when there is more than one source", async () => {
    const repo = repository(), other = repository(), home = temp();
    const host = new PluginHost(home);
    const sources = host.store.sources as unknown as { officialUrl: string };
    sources.officialUrl = pathToFileURL(repo).href;
    await host.store.sources.open();
    const search = searchPluginsTool(host, "hob");
    const single = (await search.execute("1", { query: "github" })).content[0].text;
    expect(single).not.toContain("来自「");
    await host.store.sources.add(pathToFileURL(other).href);
    const multi = (await search.execute("2", { query: "github" })).content[0].text;
    expect(multi).toContain("来自「Hob 官方」。\n状态：");
    expect(multi.match(/来自「/g)).toHaveLength(2);
    await host.close();
  });
});
