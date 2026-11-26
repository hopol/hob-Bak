import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PluginStore } from "../src/plugin-store.ts";

it("keeps migrated environment references live and does not copy their values", () => {
  const home = mkdtempSync(join(tmpdir(), "hob-plugin-env-"));
  const key = "HOB_TEST_PLUGIN_REFERENCE";
  const previous = process.env[key];
  try {
    process.env[key] = "first-value";
    const dir = join(home, "system/engine"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { sample: { command: "node", env: { ACCESS: "${HOB_TEST_PLUGIN_REFERENCE}" } } } }));
    const store = new PluginStore(home);
    expect(store.migrateLegacy()).toEqual([]);
    const secretsPath = join(home, "system/secrets.json");
    expect(existsSync(secretsPath) ? readFileSync(secretsPath, "utf8") : "").not.toContain("first-value");
    expect(store.values("sample")[key]).toBe("first-value");
    process.env[key] = "second-value";
    expect(store.values("sample")[key]).toBe("second-value");
    delete process.env[key];
    expect(store.view("sample").missing).toContain(key);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
