import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PluginStore } from "../src/plugin-store.ts";
import { resolvePluginMcp } from "../src/plugin-config.ts";

it("preserves literal secrets containing dollar signs and recognizes only whole references", () => {
  const home = mkdtempSync(join(tmpdir(), "hob-plugin-dollar-"));
  const previous = process.env.HOB_TEST_WHOLE_REF;
  try {
    process.env.HOB_TEST_WHOLE_REF = "referenced";
    const dir = join(home, "system/engine"); mkdirSync(dir, { recursive: true });
    const env = { A: "price$123", B: "x$WORD", C: "Bearer ${TOKEN}", D: "$HOB_TEST_WHOLE_REF", E: "${HOB_TEST_WHOLE_REF}" };
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { sample: { command: "node", env } } }));
    const store = new PluginStore(home);
    expect(store.migrateLegacy()).toEqual([]);
    const files = store.files("sample");
    const output = resolvePluginMcp(files.mcp, files.config, store.values("sample")) as { mcpServers: { sample: { env: Record<string, string> } } };
    expect(output.mcpServers.sample.env).toEqual({ ...env, D: "referenced", E: "referenced" });
    expect(JSON.stringify(files)).not.toContain("Bearer ${TOKEN}");
    expect(JSON.stringify(store.view("sample"))).not.toContain("price$123");
  } finally {
    if (previous === undefined) delete process.env.HOB_TEST_WHOLE_REF; else process.env.HOB_TEST_WHOLE_REF = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
