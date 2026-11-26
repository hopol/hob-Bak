import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { completePluginOAuth, disconnectPluginOAuth, pluginOAuthLoggedIn, pluginOAuthNeedsRelogin, pluginOAuthProvider, startPluginOAuth } from "../src/plugin-oauth.ts";

let server: Server | undefined;
let home: string | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); if (home) rmSync(home, { recursive: true, force: true }); server = undefined; home = undefined; });
it("uses configured OAuth scope and authorization parameters and stores and refreshes tokens", async () => {
  home = mkdtempSync(join(tmpdir(), "hob-plugin-oauth-"));
  const base = "http://127.0.0.1:31802";
  let refreshes = 0;
  let allowRefresh = true;
  server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/oauth-protected-resource/mcp" || request.url === "/.well-known/oauth-protected-resource") return response.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["other"] }));
    if (request.url === "/.well-known/oauth-authorization-server") return response.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "none"] }));
    if (request.url === "/register") return response.end(JSON.stringify({ client_id: "dynamic-client", token_endpoint_auth_method: "none", redirect_uris: ["http://localhost:31801/api/plugins/oauth/callback"] }));
    if (request.url === "/token") {
      let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => {
        const fields = new URLSearchParams(body);
        if (fields.get("grant_type") === "refresh_token") {
          refreshes++;
          if (!allowRefresh) { response.statusCode = 400; response.end(JSON.stringify({ error: "invalid_grant", error_description: "refresh rejected" })); return; }
        }
        response.end(JSON.stringify({ access_token: refreshes ? "refreshed" : "first", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 }));
      }); return;
    }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(31802, "127.0.0.1", resolve); });
  const target = { home, id: "mail", service: "mail", url: `${base}/mcp`, config: { clientId: "client", clientSecret: "secret", scope: "read compose", authorizationParams: { access_type: "offline", prompt: "consent" } } };
  const result = await startPluginOAuth(target, "http://localhost:31801/api/plugins/oauth/callback");
  const url = new URL(result.authorizationUrl!);
  expect(url.searchParams.get("scope")).toBe("read compose");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("prompt")).toBe("consent");
  // 登录中的状态在密钥文件里，Hob 重启（内存清空）也能完成；同一次登录不能完成两次
  expect(readFileSync(join(home, "system/secrets.json"), "utf8")).toContain("oauth-pending");
  await completePluginOAuth(url.searchParams.get("state")!, "code", home);
  expect(pluginOAuthLoggedIn(target)).toBe(true);
  expect(readFileSync(join(home, "system/secrets.json"), "utf8")).not.toContain("oauth-pending");
  await expect(completePluginOAuth(url.searchParams.get("state")!, "code", home)).rejects.toThrow(/找不到这次登录/);
  const auth = pluginOAuthProvider(target);
  expect(await auth.token()).toBe("first");
  await auth.onUnauthorized!({ response: new Response("", { status: 401 }), serverUrl: new URL(target.url), fetch, token: "first" });
  expect(refreshes).toBe(1);
  expect(await auth.token()).toBe("refreshed");
  expect(readFileSync(join(home, "system/secrets.json"), "utf8")).toContain("refreshed");
  allowRefresh = false;
  await expect(auth.onUnauthorized!({ response: new Response("", { status: 401 }), serverUrl: new URL(target.url), fetch, token: "refreshed" })).rejects.toThrow(/refresh rejected/);
  expect(pluginOAuthNeedsRelogin(target)).toBe(true);
  disconnectPluginOAuth(target);
  expect(pluginOAuthNeedsRelogin(target)).toBe(false);
  expect(pluginOAuthLoggedIn(target)).toBe(false);
  const dynamic = { ...target, id: "dynamic", config: {} };
  const dynamicStart = await startPluginOAuth(dynamic, "http://localhost:31801/api/plugins/oauth/callback");
  const dynamicUrl = new URL(dynamicStart.authorizationUrl!);
  expect(dynamicUrl.searchParams.get("client_id")).toBe("dynamic-client");
  await completePluginOAuth(dynamicUrl.searchParams.get("state")!, "code", home);
  expect(pluginOAuthLoggedIn(dynamic)).toBe(true);
}, 30_000);
