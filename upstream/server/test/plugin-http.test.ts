import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime } from "../src/runtime.ts";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { makeHob, seedPluginSource } from "./helpers.ts";

it.each(["invalid-json", "backup-exists"])("keeps startup available and reports migration error: %s", async mode => {
  const hob = makeHob();
  try {
    const dir = join(hob.home, "system/engine"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), mode === "invalid-json" ? "{ invalid" : JSON.stringify({ mcpServers: {} }));
    if (mode === "backup-exists") writeFileSync(join(dir, "mcp.json.bak"), "prior backup");
    const runtime = createRuntime({ home: hob.home, config: hob.runtime.config, pi: hob.runtime.pi });
    const app = createApp(runtime, { home: hob.home });
    const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const response = await app.request("/api/plugins", { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as { migrationErrors: string[] };
    expect(body.migrationErrors.length).toBeGreaterThan(0);
    expect(body.migrationErrors[0]).toMatch(mode === "backup-exists" ? /备份已存在/ : /JSON|property|position/i);
    await runtime.plugins.close();
  } finally { await hob.runtime.plugins.close(); hob.close(); }
});

it("manages custom plugins over the authenticated API without exposing secrets", async () => {
  const hob = makeHob();
  seedPluginSource(hob.home);
  try {
    const app = createApp(hob.runtime, { home: hob.home });
    const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { cookie, "content-type": "application/json" };
    const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
    const added = await app.request("/api/plugins/custom", { method: "POST", headers, body: JSON.stringify({ id: "sample", server: { command: process.execPath, args: [fixture], env: { TOKEN: "private-example" } } }) });
    expect(added.status).toBe(200);
    expect(await added.text()).not.toContain("private-example");
    const icon = await app.request("/api/plugins/github/icon", { headers });
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    const manifestPath = join(hob.home, "plugins/sample/plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    mkdirSync(join(hob.home, "plugins/sample/assets"), { recursive: true });
    writeFileSync(join(hob.home, "plugins/sample/assets/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    manifest.extensions = { "com.hob.plugins": { icon: "assets/icon.svg" } };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect((await app.request("/api/plugins/sample/icon", { headers })).status).toBe(200);
    writeFileSync(join(hob.home, "plugins/outside.svg"), "outside");
    manifest.extensions["com.hob.plugins"].icon = "../outside.svg";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect((await app.request("/api/plugins/sample/icon", { headers })).status).toBe(404);
    manifest.extensions["com.hob.plugins"].icon = "assets/icon.svg";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    mkdirSync(join(hob.home, "plugins/sample/skills/example"), { recursive: true });
    writeFileSync(join(hob.home, "plugins/sample/skills/example/SKILL.md"), "---\nname: example\ndescription: Example\n---\n");
    const list = await app.request("/api/plugins", { headers });
    const body = await list.text();
    expect(body).toContain('"skills":["example"]'); expect(body).toContain("connected"); expect(body).toContain("echo"); expect(body).toContain('"toolName":"sample_echo"'); expect(body).not.toContain("private-example");
    const patch = await app.request("/api/plugins/sample", { method: "PATCH", headers, body: JSON.stringify({ enabled: false }) });
    expect(patch.status).toBe(200);
    const remove = await app.request("/api/plugins/sample", { method: "DELETE", headers });
    expect(remove.status).toBe(200);
    expect((await app.request("/api/mcp", { headers })).status).toBe(404);
  } finally { await hob.runtime.plugins.close(); hob.close(); }
});

it("manages profile names through the authenticated API", async () => {
  const hob = makeHob();
  try {
    seedPluginSource(hob.home);
    hob.runtime.plugins.store.install("email");
    const app = createApp(hob.runtime, { home: hob.home });
    const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0]!, "content-type": "application/json" };
    const added = await app.request("/api/plugins/email/profiles", { method: "POST", headers, body: JSON.stringify({ name: "工作邮箱" }) });
    expect(added.status).toBe(200);
    const first = (await added.json() as { profiles: { id: string; name: string }[] }).profiles[0]!;
    expect(first.name).toBe("工作邮箱");
    const renamed = await app.request(`/api/plugins/email/profiles/${first.id}`, { method: "PATCH", headers, body: JSON.stringify({ name: "主邮箱" }) });
    expect(renamed.status).toBe(200);
    expect((await renamed.json() as { profiles: { name: string }[] }).profiles[0]!.name).toBe("主邮箱");
    const duplicate = await app.request("/api/plugins/email/profiles", { method: "POST", headers, body: JSON.stringify({ name: "主邮箱" }) });
    expect(duplicate.status).toBe(400);
    const removed = await app.request(`/api/plugins/email/profiles/${first.id}`, { method: "DELETE", headers });
    expect(removed.status).toBe(200);
    expect((await removed.json() as { profiles: unknown[] }).profiles).toHaveLength(0);
  } finally { await hob.runtime.plugins.close(); hob.close(); }
});
