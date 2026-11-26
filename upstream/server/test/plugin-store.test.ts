import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginStore } from "../src/plugin-store.ts";
import { writeSecret } from "../src/secrets.ts";
import { seedPluginSource } from "./helpers.ts";

const homes: string[] = [];
function store(): PluginStore {
  const home = mkdtempSync(join(tmpdir(), "hob-plugins-"));
  homes.push(home);
  seedPluginSource(home);
  return new PluginStore(home);
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("plugin storage", () => {
  it("migrates the legacy email service path once without changing configuration", () => {
    const plugins = store();
    plugins.install("email");
    plugins.patch("email", { assistants: ["hob"] });
    const path = join(plugins.home, "plugins/email/mcp.json");
    const mcp = JSON.parse(readFileSync(path, "utf8"));
    mcp.mcpServers.email.args = ["${hob.root}/server/plugins/email/server.mjs"];
    writeFileSync(path, JSON.stringify(mcp));
    plugins.migrateEmailService();
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.email.args).toEqual(["${hob.root}/server/mcp/email.mjs"]);
    expect(plugins.get("email").assistants).toEqual(["hob"]);
    const before = statSync(path).mtimeMs;
    plugins.migrateEmailService();
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("installs bundled plugins, keeps secrets private, validates values and removes secrets", () => {
    const plugins = store();
    expect(plugins.catalog().map(p => p.id)).toEqual(["vault", "github", "gmail", "email"]);
    plugins.install("github");
    expect(plugins.view("github").missing).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    plugins.saveConfig("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "private-value" });
    const view = plugins.view("github");
    expect(view.missing).toEqual([]);
    expect(view.config.GITHUB_PERSONAL_ACCESS_TOKEN.configured).toBe(true);
    expect(view.config.GITHUB_PERSONAL_ACCESS_TOKEN).toMatchObject({ title: "个人访问令牌", required: true, sensitive: true });
    expect(view.config.GITHUB_PERSONAL_ACCESS_TOKEN.description).toContain("https://github.com/settings/personal-access-tokens");
    expect(JSON.stringify(view)).not.toContain("private-value");
    expect(readFileSync(join(plugins.home, "system/plugins.json"), "utf8")).not.toContain("private-value");
    expect(statSync(join(plugins.home, "system/secrets.json")).mode & 0o777).toBe(0o600);
    expect(plugins.values("github").GITHUB_PERSONAL_ACCESS_TOKEN).toBe("private-value");
    expect(() => plugins.saveConfig("github", { BAD: "x" })).toThrow(/BAD/);
    plugins.patch("github", { enabled: false, assistants: ["a"], tools: { list: { enabled: false } } });
    plugins.install("github", true);
    expect(plugins.get("github")).toMatchObject({ enabled: false, assistants: ["a"] });
    plugins.remove("github");
    expect(readFileSync(join(plugins.home, "system/secrets.json"), "utf8")).not.toContain("private-value");
  });
  it("migrates old services once, turns hidden tools off and hides secrets", () => {
    const plugins = store();
    const dir = join(plugins.home, "system/engine"); mkdirSync(dir, { recursive: true });
    const original = JSON.stringify({ mcpServers: { fixture: { command: "node", args: ["server.js"], env: { ACCESS: "literal-token" }, exposure: "deferred", toolExposure: { read: "direct", remove: "hidden" } } } });
    writeFileSync(join(dir, "mcp.json"), original);
    plugins.migrateLegacy();
    expect(readFileSync(join(dir, "mcp.json.bak"), "utf8")).toBe(original);
    expect(existsSync(join(dir, "mcp.json"))).toBe(false);
    expect(plugins.get("fixture")).toMatchObject({ source: "custom", tools: { remove: { enabled: false } } });
    expect(plugins.get("fixture")).not.toHaveProperty("exposure");
    expect(JSON.stringify(plugins.files("fixture"))).not.toContain("literal-token");
    expect(JSON.stringify(plugins.view("fixture"))).not.toContain("literal-token");
    expect(Object.values(plugins.values("fixture"))).toContain("literal-token");
    plugins.migrateLegacy();
    expect(plugins.list()).toHaveLength(1);
  });
  it("migrates valid entries while preserving the original and interrupted directories", () => {
    const plugins = store(); const dir = join(plugins.home, "system/engine"); mkdirSync(dir, { recursive: true });
    const original = JSON.stringify({ mcpServers: { good: { command: "node" }, bad: { command: "node", exposure: "unknown" } } });
    writeFileSync(join(dir, "mcp.json"), original);
    mkdirSync(join(plugins.home, "plugins/good"), { recursive: true });
    writeFileSync(join(plugins.home, "plugins/good/partial"), "preserved");
    expect(plugins.migrateLegacy().join(" ")).toContain("bad");
    expect(plugins.get("good").legacyMcp).toBe(true);
    expect(readFileSync(join(dir, "mcp.json"), "utf8")).toBe(original);
    const retained = readdirSync(join(plugins.home, "plugins")).find(name => name.startsWith("good.interrupted-"));
    expect(readFileSync(join(plugins.home, "plugins", retained!, "partial"), "utf8")).toBe("preserved");
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { good: { command: "node" }, bad: { command: "node" } } }));
    expect(plugins.migrateLegacy()).toEqual([]);
    expect(existsSync(join(dir, "mcp.json.bak"))).toBe(true);
    expect(plugins.list()).toHaveLength(2);
  });
  it("leaves the legacy file in place on validation failure", () => {
    const plugins = store(); const dir = join(plugins.home, "system/engine"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { bad: { command: "node", exposure: "unknown" } } }));
    const errors = plugins.migrateLegacy();
    expect(errors.join(" ")).toMatch(/bad/);
    expect(existsSync(join(dir, "mcp.json"))).toBe(true);
  });
  it("preserves values when updating and moves newly sensitive values into secrets", () => {
    const plugins = store(); plugins.install("gmail");
    const path = join(plugins.home, "system/plugins.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.plugins[0].version = "0.9.0";
    doc.plugins[0].config = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "private-value", OLD_FIELD: "kept" };
    writeFileSync(path, JSON.stringify(doc));
    plugins.install("gmail", true);
    expect(readFileSync(path, "utf8")).not.toContain("private-value");
    expect(plugins.values("gmail")).toMatchObject({ GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "private-value" });
    expect(plugins.get("gmail").config.OLD_FIELD).toBe("kept");
    expect(plugins.view("gmail").missing).toEqual([]);
  });
  it("preserves nonsecret values, supports clearing and rejects path traversal", () => {
    const plugins = store();
    plugins.install("gmail");
    plugins.saveConfig("gmail", { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" });
    expect(plugins.view("gmail").config.GOOGLE_CLIENT_ID.value).toBe("client");
    expect(JSON.stringify(plugins.view("gmail"))).not.toContain('"secret"');
    plugins.saveConfig("gmail", { GOOGLE_CLIENT_SECRET: null });
    expect(plugins.view("gmail").missing).toEqual(["GOOGLE_CLIENT_SECRET"]);
    expect(() => plugins.get("../system")).toThrow(/id/);
  });
  it("stores profiles separately and removes profile secrets", () => {
    const plugins = store();
    plugins.install("email");
    expect(plugins.get("email")).toMatchObject({ profiles: [] });
    expect(plugins.get("email")).not.toHaveProperty("config");
    const first = plugins.addProfile("email", "工作邮箱");
    plugins.saveProfileConfig("email", first.id, { EMAIL_ADDRESS: "work@example.test", EMAIL_PASSWORD: "private" });
    const path = join(plugins.home, "system/plugins.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.plugins.find((plugin: any) => plugin.id === "email").profiles[0].config.PROXY = "http://old-user:old-pass@proxy.example.test:8080";
    writeFileSync(path, JSON.stringify(doc));
    expect(plugins.completeProfiles("email")[0].config).not.toHaveProperty("PROXY");
    expect(() => plugins.saveProfileConfig("email", first.id, { PROXY: "http://proxy.example.test:8080" })).toThrow("未声明的配置项 PROXY");
    expect(plugins.view("email").profiles?.[0]?.missing).toEqual([]);
    expect(JSON.stringify(plugins.view("email"))).not.toContain("private");
    expect(readFileSync(join(plugins.home, "system/secrets.json"), "utf8")).toContain(`plugin:email:profile:${first.id}:config:EMAIL_PASSWORD`);
    expect(() => plugins.addProfile("email", "工作邮箱")).toThrow("已经有叫「工作邮箱」的配置了");
    const second = plugins.addProfile("email", "QQ 邮箱");
    expect(() => plugins.renameProfile("email", second.id, "工作邮箱")).toThrow("已经有叫「工作邮箱」的配置了");
    plugins.deleteProfile("email", first.id);
    expect(readFileSync(join(plugins.home, "system/secrets.json"), "utf8")).not.toContain(first.id);
  });
  it("migrates an old single configuration into the first profile", () => {
    const plugins = store();
    plugins.install("email");
    const path = join(plugins.home, "system/plugins.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    delete doc.plugins[0].profiles;
    doc.plugins[0].config = { EMAIL_ADDRESS: "old@example.test" };
    writeFileSync(path, JSON.stringify(doc));
    writeSecret(plugins.home, "plugin:email:config:EMAIL_PASSWORD", JSON.stringify("old-secret"));
    expect(plugins.migrateProfiles()).toEqual([]);
    const profile = plugins.get("email").profiles?.[0];
    expect(profile?.name).toBe("邮箱");
    expect(plugins.get("email")).not.toHaveProperty("config");
    expect(readFileSync(join(plugins.home, "system/secrets.json"), "utf8")).toContain(`plugin:email:profile:${profile?.id}:config:EMAIL_PASSWORD`);
    expect(readFileSync(join(plugins.home, "system/secrets.json"), "utf8")).not.toContain("plugin:email:config:EMAIL_PASSWORD");
  });
});
