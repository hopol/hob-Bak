import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { makeHob, seedPluginSource } from "./helpers.ts";

it("reports a broken plugin without hiding other plugins", async () => {
  const hob = makeHob();
  try {
    const host = hob.runtime.plugins;
    host.store.addCustom("broken", { command: "node" });
    host.store.addCustom("other", { command: "node", enabled: false });
    writeFileSync(join(hob.home, "plugins/broken/mcp.json"), "{ broken");
    await host.start();
    expect(host.states("broken")[0]).toMatchObject({ status: "error", error: expect.stringMatching(/JSON|property|position/i) });
    const app = createApp(hob.runtime, { home: hob.home });
    const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const response = await app.request("/api/plugins", { headers: { cookie } });
    const data = await response.json() as { plugins: { plugin: { id: string }; services: { status: string }[] }[] };
    expect(response.status).toBe(200);
    expect(data.plugins.find(p => p.plugin.id === "broken")?.services[0].status).toBe("error");
    expect(data.plugins.some(p => p.plugin.id === "other")).toBe(true);
  } finally { await hob.runtime.plugins.close(); hob.close(); }
});

it("redacts secrets from server configuration validation errors", async () => {
  const hob = makeHob();
  try {
    const host = hob.runtime.plugins;
    seedPluginSource(hob.home);
    host.store.install("github");
    host.store.saveConfig("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "private-value" });
    writeFileSync(join(hob.home, "plugins/github/mcp.json"), JSON.stringify({ mcpServers: { "private-value!": { url: "https://example.invalid/mcp", headers: { Authorization: "${GITHUB_PERSONAL_ACCESS_TOKEN}" } } } }));
    await host.reload("github");
    const state = host.states("github")[0];
    expect(state.status).toBe("error");
    expect(state.error).toContain("[已隐藏]");
    expect(state.error).not.toContain("private-value");
  } finally { await hob.runtime.plugins.close(); hob.close(); }
});
