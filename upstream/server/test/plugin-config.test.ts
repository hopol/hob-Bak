import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pluginConfig, providerDeclarations, resolvePluginMcp, validatePluginValues } from "../src/plugin-config.ts";

describe("plugin configuration", () => {
  it("validates the bundled plugin manifests and MCP templates", () => {
    const root = new URL("./fixtures/hob-plugins/", import.meta.url);
    const index = JSON.parse(readFileSync(new URL("index.json", root), "utf8")) as { plugins: { id: string; path: string }[] };
    expect(index.plugins.map((item) => item.id)).toEqual(["github", "gmail", "email"]);
    for (const plugin of index.plugins) {
      const manifest = JSON.parse(readFileSync(new URL(`${plugin.path}/plugin.json`, root), "utf8"));
      const mcp = JSON.parse(readFileSync(new URL(`${plugin.path}/mcp.json`, root), "utf8"));
      expect(manifest.name).toBe(plugin.id);
      expect(() => pluginConfig(manifest, mcp)).not.toThrow();
      expect(readFileSync(new URL(`${plugin.path}/icon.svg`, root), "utf8")).toContain("<svg");
    }
  });
  it("infers legacy variables and resolves declared references without modifying the template", () => {
    const manifest = { userConfig: { CLIENT: { type: "string", required: true }, FLAG: { type: "boolean", default: false } } };
    const mcp = { mcpServers: { mail: { url: "https://example.invalid/${user_config.CLIENT}", headers: { Authorization: "Bearer ${TOKEN}" }, oauth: { clientId: "${user_config.CLIENT}" } } } };
    const config = pluginConfig(manifest, mcp);
    expect(config.TOKEN).toEqual({ type: "string", title: "TOKEN", required: true, sensitive: true });
    expect(validatePluginValues(config, {})).toEqual(["CLIENT", "TOKEN"]);
    expect(resolvePluginMcp(mcp, config, { CLIENT: "app", TOKEN: "secret" })).toEqual({ mcpServers: { mail: { url: "https://example.invalid/app", headers: { Authorization: "Bearer secret" }, oauth: { clientId: "app" } } } });
    expect(mcp.mcpServers.mail.headers.Authorization).toBe("Bearer ${TOKEN}");
  });

  it("rejects unknown declaration fields and identifies undeclared references", () => {
    expect(() => pluginConfig({ userConfig: { A: { type: "string", typo: true } } }, { mcpServers: {} })).toThrow(/typo/);
    expect(() => pluginConfig({ userConfig: { A: { type: "number", min: 0, default: -1 } } }, { mcpServers: {} })).toThrow(/A/);
    expect(() => pluginConfig({}, { mcpServers: { service: { headers: { X: "${A} ${user_config.A}" } } } })).toThrow(/service.headers.X.*A/);
  });

  it("expands multiple arguments and leaves unset optional references empty", () => {
    const mcp = { mcpServers: { local: { command: "node", args: ["${user_config.LIST}", "--tag=${user_config.LIST}"], env: { OPT: "${user_config.OPTIONAL}" } } } };
    const config = pluginConfig({ userConfig: { LIST: { type: "string", multiple: true }, OPTIONAL: { type: "string" } } }, mcp);
    expect(resolvePluginMcp(mcp, config, { LIST: ["one", "two"] })).toEqual({ mcpServers: { local: { command: "node", args: ["one", "two", "--tag=one,two"], env: { OPT: "" } } } });
  });
  it("resolves profile templates and rejects user config and OAuth", () => {
    const manifest = { userConfig: { EMAIL_ADDRESS: { type: "string", required: true } }, extensions: { "com.hob.plugins": { profiles: { title: "邮箱" } } } };
    const mcp = { mcpServers: { mail: { command: "node", env: { PROFILES: "${hob.profiles}", ROOT: "${hob.root}" } } } };
    const config = pluginConfig(manifest, mcp);
    expect(resolvePluginMcp(mcp, config, {}, { root: "/opt/hob", plugin_root: "/plugin", plugin_data: "/data", profiles: [{ name: "工作邮箱", config: { EMAIL_ADDRESS: "work@example.test" } }] })).toMatchObject({ mcpServers: { mail: { env: { PROFILES: JSON.stringify([{ name: "工作邮箱", config: { EMAIL_ADDRESS: "work@example.test" } }]) } } } });
    expect(() => pluginConfig(manifest, { mcpServers: { mail: { env: { ADDRESS: "${user_config.EMAIL_ADDRESS}" } } } })).toThrow("支持多个 profile 的插件用 ${hob.profiles} 读配置，不用 ${user_config.EMAIL_ADDRESS}");
    expect(() => pluginConfig({ extensions: { "com.hob.plugins": { profiles: {} } } }, { mcpServers: { mail: { url: "https://example.test", oauth: {} } } })).toThrow("支持多个 profile 的插件暂时不能用 OAuth 登录");
  });
  it("requires provider versions to be valid semver", () => {
    const base = { package: "demo", integrity: "sha512-abc=" };
    expect(() => providerDeclarations({ extensions: { "com.hob.plugins": { providers: [{ ...base, version: "../../evil" }] } } })).toThrow(/semver/);
    expect(providerDeclarations({ extensions: { "com.hob.plugins": { providers: [{ ...base, version: "1.2.3-beta.1" }] } } })).toHaveLength(1);
  });

  it("validates false and zero as values, constraints, choices and multiple values", () => {
    const config = pluginConfig({ userConfig: { FLAG: { type: "boolean", required: true }, N: { type: "number", min: 0, max: 2 }, CHOICE: { type: "string", options: ["a", "b"], multiple: true } } }, { mcpServers: {} });
    expect(validatePluginValues(config, { FLAG: false, N: 0, CHOICE: ["a", "b"] })).toEqual([]);
    expect(validatePluginValues(config, Object.create({ FLAG: true }))).toEqual(["FLAG"]);
    expect(() => validatePluginValues(config, { FLAG: false, N: 3 })).toThrow(/N/);
    expect(() => validatePluginValues(config, { FLAG: false, CHOICE: ["c"] })).toThrow(/CHOICE/);
  });
});
