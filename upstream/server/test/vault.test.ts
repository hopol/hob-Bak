import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedBuiltinVault } from "../src/dev-team.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

const hobs: ReturnType<typeof makeHob>[] = [];
afterEach(async () => {
  for (const hob of hobs.splice(0)) {
    await hob.runtime.plugins.close();
    hob.close();
  }
});

describe("built-in encrypted password vault", () => {
  it("stores credentials encrypted and exposes only the app protocol", async () => {
    const hob = makeHob(); hobs.push(hob);
    const host = hob.runtime.plugins;
    host.store.install("vault");
    await host.start();
    const save = host.credentialProvidersForPlugin("vault", "save")[0];
    const list = host.credentialProvidersForPlugin("vault", "list")[0];
    const secret = host.credentialProvidersForPlugin("vault", "secret")[0];
    const remove = host.credentialProvidersForPlugin("vault", "delete")[0];
    expect(save?.service).toBe("vault");
    expect(list?.service).toBe("vault");
    expect(remove?.service).toBe("vault");
    const password = "vault-only-password-9f2c";
    const saved = await host.callCredential(save!, { name: "Example 论坛", uris: ["https://forum.example.test/login"], username: "person@example.test", password, folder: "论坛" });
    expect(saved.id).toEqual(expect.any(String));
    const listed = await host.callCredential(list!, {});
    expect(JSON.stringify(listed)).not.toContain(password);
    expect(listed.logins).toMatchObject([{ name: "Example 论坛", username: "person@example.test", folder: "论坛", hasPassword: true }]);
    expect(await host.callCredential(secret!, { id: saved.id })).toEqual({ username: "person@example.test", password });
    const vaultPath = join(hob.home, "plugin-data/vault/vault.json");
    expect(existsSync(vaultPath)).toBe(true);
    expect(readFileSync(vaultPath, "utf8")).not.toContain(password);
    expect(statSync(vaultPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(hob.home, "plugin-data/vault/vault.key")).mode & 0o777).toBe(0o600);
    await host.callCredential(remove!, { id: saved.id });
    expect((await host.callCredential(list!, {})).logins).toEqual([]);
  });

  it("serves credential detail actions through the authenticated API", async () => {
    const hob = makeHob(); hobs.push(hob);
    const host = hob.runtime.plugins;
    host.store.install("vault");
    await host.start();
    const app = createApp(hob.runtime, { home: hob.home });
    const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0]!, "content-type": "application/json" };
    const listed = await app.request("/api/plugins/vault/logins", { headers });
    expect(listed.status).toBe(200);
    expect((await listed.json()).logins).toEqual([]);
    const saved = await app.request("/api/plugins/vault/logins", { method: "POST", headers, body: JSON.stringify({ service: "vault", name: "网站", uris: ["https://example.test"], username: "person@example.test", password: "api-secret" }) });
    expect(saved.status).toBe(200);
    const id = (await saved.json()).id as string;
    const secret = await app.request("/api/plugins/vault/logins/secret", { method: "POST", headers, body: JSON.stringify({ service: "vault", id }) });
    expect(await secret.json()).toEqual({ username: "person@example.test", password: "api-secret" });
    const removed = await app.request(`/api/plugins/vault/logins/${id}?service=vault`, { method: "DELETE", headers });
    expect(removed.status).toBe(200);
  });

  it("seeds once and does not reinstall after the user removes it", () => {
    const hob = makeHob(); hobs.push(hob);
    seedBuiltinVault(hob.runtime.plugins.store);
    expect(hob.runtime.plugins.store.get("vault")).toMatchObject({ source: "builtin", enabled: true });
    expect(JSON.parse(readFileSync(join(hob.home, "system/seeded.json"), "utf8"))).toMatchObject({ vault: true });
    hob.runtime.plugins.store.remove("vault");
    seedBuiltinVault(hob.runtime.plugins.store);
    expect(() => hob.runtime.plugins.store.get("vault")).toThrow("插件 vault 未安装");
  });

  it("moves an installed built-in vault to the version Hob ships, keeping its settings", () => {
    const hob = makeHob(); hobs.push(hob);
    const store = hob.runtime.plugins.store;
    seedBuiltinVault(store);
    const shipped = store.get("vault").version;
    const docPath = join(hob.home, "system/plugins.json");
    const doc = JSON.parse(readFileSync(docPath, "utf8"));
    const entry = doc.plugins.find((plugin: { id: string }) => plugin.id === "vault");
    entry.version = "0.9.0"; entry.enabled = false;
    writeFileSync(docPath, JSON.stringify(doc));
    seedBuiltinVault(store);
    expect(store.get("vault")).toMatchObject({ version: shipped, enabled: false });
  });
});
