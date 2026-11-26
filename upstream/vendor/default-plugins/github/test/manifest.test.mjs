import { strict as assert } from "node:assert";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const GITHUB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

test("plugin.json 与 mcp.json 符合 2.0.0 规范且 bin 命令可执行", () => {
  const manifest = JSON.parse(readFileSync(join(GITHUB_DIR, "plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(GITHUB_DIR, "mcp.json"), "utf8"));

  assert.equal(manifest.name, "github");
  assert.equal(manifest.version, "2.0.6");
  assert.equal(manifest.extensions["com.hob.plugins"].bin, "bin");
  assert.ok(manifest.extensions["com.hob.plugins"].summary.zh);
  assert.ok(manifest.extensions["com.hob.plugins"].summary.en);
  assert.ok(manifest.extensions["com.hob.plugins"].description.zh);
  assert.ok(manifest.extensions["com.hob.plugins"].description.en);

  // Config schema checks
  const allowedFields = new Set(["type", "title", "description", "required", "default", "options", "multiple", "sensitive", "min", "max"]);
  for (const [key, field] of Object.entries(manifest.userConfig)) {
    for (const prop of Object.keys(field)) {
      assert.ok(allowedFields.has(prop), `unexpected field userConfig.${key}.${prop}`);
    }
    assert.equal(typeof field.title, "string");
    assert.equal(typeof field.description, "string");
  }

  assert.equal(manifest.userConfig.GITHUB_PERSONAL_ACCESS_TOKEN.required, undefined);
  assert.equal(manifest.userConfig.GITHUB_PERSONAL_ACCESS_TOKEN.sensitive, true);
  assert.equal(manifest.userConfig.ATTRIBUTION.type, "boolean");
  assert.equal(manifest.userConfig.ATTRIBUTION.default, true);
  assert.ok(manifest.userConfig.GITHUB_APP_ID);
  assert.ok(manifest.userConfig.GITHUB_APP_PRIVATE_KEY);
  assert.equal(manifest.userConfig.GITHUB_APP_PRIVATE_KEY.sensitive, true);

  // Every ${user_config.KEY} in mcp.json must be declared in manifest.userConfig
  const server = mcp.mcpServers.github;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${hob.plugin_root}/server.mjs"]);
  for (const val of Object.values(server.env)) {
    for (const match of String(val).matchAll(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      assert.ok(Object.hasOwn(manifest.userConfig, match[1]), `undeclared user_config.${match[1]}`);
    }
  }

  // Executable permissions on bin/*
  for (const bin of ["git", "git-credential-hob", "gh"]) {
    const binPath = join(GITHUB_DIR, "bin", bin);
    assert.ok((statSync(binPath).mode & 0o111) !== 0, `bin/${bin} must be executable`);
    assert.ok(readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node\n"), `bin/${bin} must start with #!/usr/bin/env node`);
  }
});
