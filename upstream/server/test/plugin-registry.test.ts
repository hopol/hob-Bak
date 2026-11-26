import { describe, expect, it } from "vitest";
import { pluginConfig, resolvePluginMcp } from "../src/plugin-config.ts";
import { registryServerToPlugin } from "../src/plugin-registry.ts";

describe("MCP Registry conversion", () => {
  it("converts remote URL variables and header templates, preferring streamable HTTP", () => {
    const plugin = registryServerToPlugin({ name: "org.example/calendar", version: "1.2.0", remotes: [
      { type: "sse", url: "https://example.invalid/sse" },
      { type: "streamable-http", url: "https://{host}/mcp", variables: { host: { isRequired: true } }, headers: [
        { name: "Authorization", value: "Bearer {TOKEN}", variables: { TOKEN: { isRequired: true, isSecret: true } } },
        { name: "X-Mode", value: "stable" },
      ] },
    ] });
    const config = pluginConfig(plugin.manifest, plugin.mcp);
    expect(config.TOKEN.sensitive).toBe(true);
    expect(resolvePluginMcp(plugin.mcp, config, { host: "example.invalid", TOKEN: "token" })).toEqual({ mcpServers: { calendar: { url: "https://example.invalid/mcp", headers: { Authorization: "Bearer token", "X-Mode": "stable" } } } });
  });

  it("converts package environment inputs and constraints", () => {
    const plugin = registryServerToPlugin({ name: "org.example/notes", version: "2", packages: [{ registryType: "npm", identifier: "@example/notes", version: "2.0.0", transport: { type: "stdio" }, environmentVariables: [{ name: "NOTES_TOKEN", isRequired: true, isSecret: true }, { name: "MODE", format: "string", choices: ["a", "b"], default: "a" }] }] });
    const config = pluginConfig(plugin.manifest, plugin.mcp);
    expect(config.MODE.options).toEqual(["a", "b"]);
    expect(resolvePluginMcp(plugin.mcp, config, { NOTES_TOKEN: "key" })).toEqual({ mcpServers: { notes: { command: "npx", args: ["-y", "@example/notes@2.0.0"], env: { NOTES_TOKEN: "key", MODE: "a" } } } });
  });

  it("rejects repeated arguments and undefined URL variables", () => {
    expect(() => registryServerToPlugin({ name: "x", packages: [{ isRepeated: true }] })).toThrow(/isRepeated/);
    expect(() => registryServerToPlugin({ name: "x", remotes: [{ type: "streamable-http", url: "https://{missing}/mcp" }] })).toThrow(/missing/);
  });
});
