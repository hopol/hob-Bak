import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUNDLED_PLUGINS, defaultPluginsRoot, seedDefaultPlugins } from "../src/dev-team.ts";
import { OFFICIAL_SOURCE } from "../src/plugin-sources.ts";
import { makeHob } from "./helpers.ts";

describe("default bundled plugins", () => {
  it("ships bundled default plugins in vendor/ (included in npm package and Dockerfile)", () => {
    expect(DEFAULT_BUNDLED_PLUGINS).toContain("github");
    const root = defaultPluginsRoot();
    expect(existsSync(join(root, "github", "plugin.json"))).toBe(true);
    expect(existsSync(join(root, "github", "mcp.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("vendor");
    const dockerfile = readFileSync(fileURLToPath(new URL("../../Dockerfile", import.meta.url)), "utf8");
    expect(dockerfile).toContain("COPY vendor ./vendor");
  });

  it("installs bundled plugins offline on first startup as official source and updates normally from official source", () => {
    const hob = makeHob();
    try {
      // No cache/plugin-sources/official exists (offline startup)
      expect(existsSync(join(hob.home, "cache", "plugin-sources", "official"))).toBe(false);

      seedDefaultPlugins(hob.runtime.plugins.store);

      const installed = hob.runtime.plugins.store.get("github");
      expect(installed.enabled).toBe(true);
      expect(installed.source).toBe(OFFICIAL_SOURCE);
      expect(installed.source).not.toBe("builtin");
      expect(existsSync(join(hob.home, "plugins", "github", "plugin.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(hob.home, "system", "seeded.json"), "utf8"))).toMatchObject({
        plugins: { github: "installed" },
      });

      // Later when official source cache gets a newer version, normal update works
      const officialDir = join(hob.home, "cache", "plugin-sources", "official");
      mkdirSync(join(officialDir, "github"), { recursive: true });
      cpSync(join(defaultPluginsRoot(), "github"), join(officialDir, "github"), { recursive: true });
      const manifest = JSON.parse(readFileSync(join(officialDir, "github", "plugin.json"), "utf8")) as Record<string, unknown>;
      manifest.version = "9.9.9";
      writeFileSync(join(officialDir, "github", "plugin.json"), JSON.stringify(manifest));
      writeFileSync(join(officialDir, "index.json"), JSON.stringify({ plugins: [{ id: "github", path: "github" }] }));

      const updated = hob.runtime.plugins.store.install("github", true);
      expect(updated.version).toBe("9.9.9");
      expect(updated.source).toBe(OFFICIAL_SOURCE);
    } finally {
      hob.close();
    }
  });

  it("does not reinstall after the user uninstalls a default plugin", () => {
    const hob = makeHob();
    try {
      seedDefaultPlugins(hob.runtime.plugins.store);
      expect(hob.runtime.plugins.store.get("github").enabled).toBe(true);

      hob.runtime.plugins.store.remove("github");
      expect(JSON.parse(readFileSync(join(hob.home, "system", "seeded.json"), "utf8"))).toMatchObject({
        plugins: { github: "uninstalled" },
      });

      // Restarting must not reinstall it
      seedDefaultPlugins(hob.runtime.plugins.store);
      expect(() => hob.runtime.plugins.store.get("github")).toThrow("插件 github 未安装");
    } finally {
      hob.close();
    }
  });

  it("leaves an already-installed plugin with the same id untouched regardless of source", () => {
    const hob = makeHob();
    try {
      const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
      hob.runtime.plugins.store.addCustom("github", { command: process.execPath, args: [fixture], enabled: false });

      seedDefaultPlugins(hob.runtime.plugins.store);

      const kept = hob.runtime.plugins.store.get("github");
      expect(kept.source).toBe("custom");
      expect(kept.enabled).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("works with arbitrary bundled plugin directories and preserves seeded.json keys", () => {
    const hob = makeHob();
    const bundle = mkdtempSync(join(tmpdir(), "hob-bundle-"));
    try {
      const capFixture = fileURLToPath(new URL("./fixtures/cap-plugin", import.meta.url));
      cpSync(capFixture, join(bundle, "cap-plugin"), { recursive: true });
      writeFileSync(join(hob.home, "system", "seeded.json"), JSON.stringify({ devTeam: true, vault: true }));

      seedDefaultPlugins(hob.runtime.plugins.store, { root: bundle, ids: ["cap-plugin"] });

      expect(hob.runtime.plugins.store.get("cap-plugin")).toMatchObject({
        id: "cap-plugin",
        source: OFFICIAL_SOURCE,
        enabled: true,
      });
      const seeded = JSON.parse(readFileSync(join(hob.home, "system", "seeded.json"), "utf8")) as Record<string, unknown>;
      expect(seeded).toMatchObject({ devTeam: true, vault: true, plugins: { "cap-plugin": "installed" } });

      // Removing a seeded non-hardcoded test plugin also marks uninstalled and prevents re-seeding
      hob.runtime.plugins.store.remove("cap-plugin");
      seedDefaultPlugins(hob.runtime.plugins.store, { root: bundle, ids: ["cap-plugin"] });
      expect(() => hob.runtime.plugins.store.get("cap-plugin")).toThrow("插件 cap-plugin 未安装");
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      hob.close();
    }
  });
});
