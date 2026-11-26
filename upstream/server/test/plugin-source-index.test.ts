import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pluginConfig } from "../src/plugin-config.ts";

const script = fileURLToPath(new URL("./fixtures/hob-plugins/scripts/build-index.mjs", import.meta.url));
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hob-source-index-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  cpSync(script, join(root, "scripts/build-index.mjs"));
  mkdirSync(join(root, "example/skills/guide"), { recursive: true });
  writeFileSync(join(root, "example/plugin.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
  writeFileSync(join(root, "example/mcp.json"), JSON.stringify({ mcpServers: {} }));
  writeFileSync(join(root, "example/skills/guide/SKILL.md"), "# Guide\n");
  return root;
}
function build(root: string) {
  return spawnSync(process.execPath, [join(root, "scripts/build-index.mjs")], { encoding: "utf8" });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("official source index builder", () => {
  it("indexes the actual official plugin files with valid Hob configuration", () => {
    const source = fileURLToPath(new URL("./fixtures/hob-plugins/", import.meta.url));
    const root = mkdtempSync(join(tmpdir(), "hob-source-index-"));
    roots.push(root);
    cpSync(source, root, { recursive: true });
    expect(build(root).status).toBe(0);
    const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
    expect(index.plugins.map((entry: { id: string }) => entry.id)).toEqual(["github", "gmail", "email"]);
    for (const entry of index.plugins) {
      const dir = join(root, entry.path);
      const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(() => pluginConfig(manifest, mcp)).not.toThrow();
      expect(entry.files).toContain("plugin.json");
      expect(entry.files).toContain("mcp.json");
      for (const file of entry.files) expect(readFileSync(join(dir, file)).length).toBeGreaterThan(0);
    }
  });
  it("lists nested files using paths relative to the plugin directory", () => {
    const root = fixture();
    expect(build(root).status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "index.json"), "utf8"))).toEqual({
      name: "Hob 官方",
      plugins: [{ id: "example", path: "example", files: ["mcp.json", "plugin.json", "skills/guide/SKILL.md"] }],
    });
    const previous = readFileSync(join(root, "index.json"), "utf8");
    expect(build(root).status).toBe(0);
    expect(readFileSync(join(root, "index.json"), "utf8")).toBe(previous);
  });

  it("rejects invalid manifests and leaves the previous index intact", () => {
    const root = fixture();
    expect(build(root).status).toBe(0);
    const previous = readFileSync(join(root, "index.json"), "utf8");
    writeFileSync(join(root, "example/plugin.json"), JSON.stringify({ version: 12 }));
    expect(build(root).status).not.toBe(0);
    expect(readFileSync(join(root, "index.json"), "utf8")).toBe(previous);
    writeFileSync(join(root, "example/plugin.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(root, "example/mcp.json"), "{}");
    expect(build(root).status).not.toBe(0);
  });

  it("rejects symbolic links in a plugin", () => {
    const root = fixture();
    symlinkSync(join(root, "scripts"), join(root, "example/link"));
    const result = build(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Symbolic link");
  });
});
