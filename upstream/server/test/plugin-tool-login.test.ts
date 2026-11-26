import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { pluginToolsForAssistant } from "../src/plugin-host.ts";
import type { PluginToolLoginPollResult, PluginToolLoginStartResult, PluginToolLoginStatus, PluginsView } from "../../shared/types.ts";
import { makeHob } from "./helpers.ts";

const CAP_FIXTURE = fileURLToPath(new URL("./fixtures/cap-plugin", import.meta.url));

function installCapPlugin(home: string) {
  const sourceDir = join(home, "cache", "plugin-sources", "official");
  mkdirSync(join(sourceDir, "cap-plugin"), { recursive: true });
  cpSync(CAP_FIXTURE, join(sourceDir, "cap-plugin"), { recursive: true });
  writeFileSync(
    join(sourceDir, "index.json"),
    JSON.stringify({ plugins: [{ id: "cap-plugin", path: "cap-plugin" }] }),
  );
}

async function authHeaders(app: ReturnType<typeof createApp>) {
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, "content-type": "application/json" };
}

it("discovers _meta['hob/login'] tools, hides them from models and tool lists, and runs status/start/poll/logout", async () => {
  const hob = makeHob();
  try {
    installCapPlugin(hob.home);
    hob.runtime.plugins.store.install("cap-plugin");
    await hob.runtime.plugins.reload("cap-plugin");

    // Login tools must not be visible to the model
    const modelTools = pluginToolsForAssistant(hob.runtime.plugins, "hob");
    expect(modelTools.map((tool) => tool.name)).toEqual(["cap-plugin_ping"]);

    const app = createApp(hob.runtime, { home: hob.home });
    const headers = await authHeaders(app);

    // GET /api/plugins includes login view and hides app-only tools from services[].tools
    const listRes = await app.request("/api/plugins", { headers });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as PluginsView;
    const item = listBody.plugins.find((p) => p.plugin.id === "cap-plugin")!;
    expect(item.services[0]?.tools.map((tool) => tool.name)).toEqual(["ping"]);
    expect(item.login).toEqual({
      service: "cap",
      roles: ["status", "start", "poll", "logout"],
      status: { signedIn: false },
    });

    // 1. status
    const statusRes = await app.request("/api/plugins/cap-plugin/login/status", { headers });
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json() as PluginToolLoginStatus).toEqual({ signedIn: false });

    // 2. start (device_code)
    const startRes = await app.request("/api/plugins/cap-plugin/login/start", { method: "POST", headers, body: "{}" });
    expect(startRes.status).toBe(200);
    const started = await startRes.json() as PluginToolLoginStartResult;
    expect(started.kind).toBe("device_code");
    if (started.kind === "device_code") {
      expect(started.url).toBe("https://example.invalid/device");
      expect(started.userCode).toBe("WXYZ-2670");
      expect(started.interval).toBe(1);
      expect(started.expiresAt).toBeTruthy();
    }

    // 3. poll: pending -> done
    const dataDir = join(hob.home, "plugin-data", "cap-plugin");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "pending.txt"), "1");

    const poll1 = await app.request("/api/plugins/cap-plugin/login/poll", { method: "POST", headers, body: "{}" });
    expect(poll1.status).toBe(200);
    expect(await poll1.json() as PluginToolLoginPollResult).toEqual({ state: "pending" });

    const poll2 = await app.request("/api/plugins/cap-plugin/login/poll", { method: "POST", headers, body: "{}" });
    expect(poll2.status).toBe(200);
    expect(await poll2.json() as PluginToolLoginPollResult).toEqual({ state: "done" });

    // Token file was stored by the plugin itself with 0600 permissions
    const mode = statSync(join(dataDir, "session.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    // Cached view in GET /api/plugins and live status both report signedIn: true
    const afterList = await (await app.request("/api/plugins", { headers })).json() as PluginsView;
    const signedInItem = afterList.plugins.find((p) => p.plugin.id === "cap-plugin")!;
    expect(signedInItem.login?.status).toEqual({
      signedIn: true,
      account: "alice",
      detail: "已登录 alice · [管理授权](https://example.invalid/apps)",
    });

    // Login changes what the plugin offers: Hob re-lists tools without a reconnect
    expect(pluginToolsForAssistant(hob.runtime.plugins, "hob").map((tool) => tool.name)).toEqual(["cap-plugin_ping", "cap-plugin_whoami"]);

    // 4. logout
    const logoutRes = await app.request("/api/plugins/cap-plugin/login/logout", { method: "POST", headers, body: "{}" });
    expect(logoutRes.status).toBe(200);
    const logoutBody = await logoutRes.json() as { ok: boolean; status?: PluginToolLoginStatus };
    expect(logoutBody).toEqual({ ok: true, status: { signedIn: false } });

    const finalList = await (await app.request("/api/plugins", { headers })).json() as PluginsView;
    expect(finalList.plugins.find((p) => p.plugin.id === "cap-plugin")?.login?.status).toEqual({ signedIn: false });
    expect(pluginToolsForAssistant(hob.runtime.plugins, "hob").map((tool) => tool.name)).toEqual(["cap-plugin_ping"]);
  } finally {
    await hob.runtime.plugins.close();
    hob.close();
  }
});

it("handles start returning kind='done' and passes plugin login errors through verbatim", async () => {
  const hob = makeHob();
  try {
    installCapPlugin(hob.home);
    hob.runtime.plugins.store.install("cap-plugin");
    await hob.runtime.plugins.reload("cap-plugin");

    const app = createApp(hob.runtime, { home: hob.home });
    const headers = await authHeaders(app);
    const dataDir = join(hob.home, "plugin-data", "cap-plugin");
    mkdirSync(dataDir, { recursive: true });

    // start -> done updates cached status
    writeFileSync(join(dataDir, "start-done"), "1");
    const startDone = await app.request("/api/plugins/cap-plugin/login/start", { method: "POST", headers, body: "{}" });
    expect(startDone.status).toBe(200);
    expect(await startDone.json()).toEqual({ kind: "done" });
    expect(hob.runtime.plugins.loginView("cap-plugin")?.status?.signedIn).toBe(true);
    rmSync(join(dataDir, "start-done"));

    // poll returns { state: "error", message } verbatim
    writeFileSync(join(dataDir, "fail.txt"), "poll:授权码已失效，请重新发起");
    const pollErr = await app.request("/api/plugins/cap-plugin/login/poll", { method: "POST", headers, body: "{}" });
    expect(pollErr.status).toBe(200);
    expect(await pollErr.json()).toEqual({ state: "error", message: "授权码已失效，请重新发起" });

    // MCP isError on status / start / poll / logout is passed through verbatim
    writeFileSync(join(dataDir, "fail.txt"), "status:上游服务返回 503");
    const statusErr = await app.request("/api/plugins/cap-plugin/login/status", { headers });
    expect(statusErr.status).toBe(400);
    expect(await statusErr.json()).toEqual({ error: "上游服务返回 503" });

    writeFileSync(join(dataDir, "fail.txt"), "start:当前账号已被限流 60 秒");
    const startErr = await app.request("/api/plugins/cap-plugin/login/start", { method: "POST", headers, body: "{}" });
    expect(startErr.status).toBe(400);
    expect(await startErr.json()).toEqual({ error: "当前账号已被限流 60 秒" });

    writeFileSync(join(dataDir, "fail.txt"), "poll-tool-error:网络超时 ETIMEDOUT");
    const pollToolErr = await app.request("/api/plugins/cap-plugin/login/poll", { method: "POST", headers, body: "{}" });
    expect(pollToolErr.status).toBe(400);
    expect(await pollToolErr.json()).toEqual({ error: "网络超时 ETIMEDOUT" });

    writeFileSync(join(dataDir, "fail.txt"), "logout:令牌文件只读，无法删除");
    const logoutErr = await app.request("/api/plugins/cap-plugin/login/logout", { method: "POST", headers, body: "{}" });
    expect(logoutErr.status).toBe(400);
    expect(await logoutErr.json()).toEqual({ error: "令牌文件只读，无法删除" });
  } finally {
    await hob.runtime.plugins.close();
    hob.close();
  }
});

it("returns 400 when calling login endpoints on a plugin without login tools", async () => {
  const hob = makeHob();
  try {
    const app = createApp(hob.runtime, { home: hob.home });
    const headers = await authHeaders(app);
    const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
    const added = await app.request("/api/plugins/custom", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "plain", server: { command: process.execPath, args: [fixture] } }),
    });
    expect(added.status).toBe(200);
    const status = await app.request("/api/plugins/plain/login/status", { headers });
    expect(status.status).toBe(400);
  } finally {
    await hob.runtime.plugins.close();
    hob.close();
  }
});
