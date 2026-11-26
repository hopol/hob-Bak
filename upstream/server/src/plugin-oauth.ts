import { McpOAuthAuthorizationRequiredError, McpOAuthProvider, authorizeMcp, parseWwwAuthenticate, type McpOAuthState, type McpOAuthStateStore, type OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import { readSecrets, writeSecret } from "./secrets.ts";

export interface PluginOAuthConfig { clientId?: string; clientSecret?: string; scope?: string; authServerMetadataUrl?: string; authorizationParams?: Record<string, string> }
interface OAuthTarget { home: string; id: string; service: string; url: string; config: PluginOAuthConfig }
interface Pending extends OAuthTarget { redirect: string; challenge?: OAuthChallenge; expires: number }
// 登录中的状态写进密钥文件：用户在授权页时 Hob 重启了，回来照样能完成
const pendingKey = (target: OAuthTarget) => `plugin:${target.id}:oauth-pending:${target.service}`;
function savePending(state: string, entry: Pending): void { writeSecret(entry.home, pendingKey(entry), JSON.stringify({ state, ...entry })); }
function findPending(state: string, home: string): Pending | undefined {
  for (const [key, raw] of Object.entries(readSecrets(home))) {
    if (!key.includes(":oauth-pending:") || !raw) continue;
    const entry = JSON.parse(raw) as Pending & { state: string };
    if (entry.state === state) return entry;
  }
  return undefined;
}
const challenges = new Map<string, OAuthChallenge>();
const targetKey = (target: OAuthTarget) => `plugin:${target.id}:oauth:${target.service}`;
const reloginKey = (target: OAuthTarget) => `plugin:${target.id}:relogin:${target.service}`;
const challengeKey = (target: OAuthTarget) => JSON.stringify([target.home, target.id, target.service, target.url]);

function storage(target: OAuthTarget): McpOAuthStateStore {
  return {
    load: () => {
      const raw = readSecrets(target.home)[targetKey(target)];
      if (!raw) return undefined;
      const state = JSON.parse(raw) as McpOAuthState;
      return state.serverUrl === String(new URL(target.url)) ? state : undefined;
    },
    save: (state) => writeSecret(target.home, targetKey(target), JSON.stringify(state)),
  };
}
function provider(target: OAuthTarget, redirect: string, onRedirect: (url: URL) => void): McpOAuthProvider {
  return new McpOAuthProvider({ serverUrl: target.url, redirectUrl: redirect, clientMetadata: { client_name: "Hob", ...(target.config.scope ? { scope: target.config.scope } : {}) }, clientId: target.config.clientId, clientSecret: target.config.clientSecret, store: storage(target), onRedirect });
}
function flowOptions(target: OAuthTarget, challenge?: OAuthChallenge) {
  return { serverUrl: target.url, ...(target.config.scope ?? challenge?.scope ? { scope: target.config.scope ?? challenge?.scope } : {}), ...(challenge?.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}), ...(target.config.authServerMetadataUrl ? { authorizationServerMetadataUrl: new URL(target.config.authServerMetadataUrl) } : {}) };
}
export function pluginOAuthLoggedIn(target: OAuthTarget): boolean { return Boolean((storage(target).load() as McpOAuthState | undefined)?.tokens?.access_token); }
export function pluginOAuthNeedsRelogin(target: OAuthTarget): boolean { return Boolean(readSecrets(target.home)[reloginKey(target)]); }
export function disconnectPluginOAuth(target: OAuthTarget): void { writeSecret(target.home, targetKey(target), ""); writeSecret(target.home, reloginKey(target), ""); writeSecret(target.home, pendingKey(target), ""); }
export async function startPluginOAuth(target: OAuthTarget, redirect: string): Promise<{ authorizationUrl?: string; authorized?: boolean }> {
  const challenge = challenges.get(challengeKey(target));
  let authorizationUrl: URL | undefined;
  const client = provider(target, redirect, url => { authorizationUrl = url; });
  const result = await authorizeMcp(client, { ...flowOptions(target, challenge), skipRefresh: true });
  if (result === "AUTHORIZED") return { authorized: true };
  if (!authorizationUrl) throw new Error("OAuth 未返回授权地址");
  for (const [key, value] of Object.entries(target.config.authorizationParams ?? {})) authorizationUrl.searchParams.set(key, value);
  const state = await client.state();
  savePending(state, { ...target, redirect, challenge, expires: Date.now() + 10 * 60_000 });
  return { authorizationUrl: String(authorizationUrl) };
}
export function pendingPluginOAuthId(state: string, home: string): string | undefined { return findPending(state, home)?.id; }
export async function completePluginOAuth(state: string, code: string, home: string, iss?: string): Promise<{ home: string; id: string }> {
  const target = findPending(state, home);
  if (!target) throw new Error("找不到这次登录（可能已经完成过，或者在别处重新发起了登录），请回到插件页重新点「连接」");
  if (target.expires < Date.now()) { writeSecret(home, pendingKey(target), ""); throw new Error("这次登录超过 10 分钟没完成，已过期，请回到插件页重新点「连接」"); }
  const stored = await storage(target).load();
  if (stored?.oauthState !== state) throw new Error("OAuth 状态校验失败");
  const client = provider(target, target.redirect, () => {});
  const result = await authorizeMcp(client, { ...flowOptions(target, target.challenge), authorizationCode: code, authorizationRedirectUrl: target.redirect, ...(iss ? { iss } : {}) });
  if (result !== "AUTHORIZED") throw new Error("OAuth 授权没有完成");
  writeSecret(target.home, pendingKey(target), "");
  writeSecret(target.home, reloginKey(target), "");
  return { home: target.home, id: target.id };
}
export function pluginOAuthProvider(target: OAuthTarget): AuthProvider {
  const client = provider(target, "http://127.0.0.1/callback", () => {});
  let refreshing: Promise<void> | undefined;
  const refresh = (stale: string | undefined, fetch: McpFetch, challenge?: OAuthChallenge): Promise<void> => {
    refreshing ??= (async () => {
      const tokens = await client.tokens();
      if (stale !== undefined && tokens?.access_token !== stale) return;
      if (!tokens?.refresh_token) {
        if (tokens?.access_token) writeSecret(target.home, reloginKey(target), "1");
        throw new McpOAuthAuthorizationRequiredError();
      }
      let rejected = "";
      const recordingFetch: McpFetch = async (input, init) => {
        const response = await fetch(input, init);
        if (!response.ok) rejected = await response.clone().text();
        return response;
      };
      try {
        const result = await authorizeMcp(client, { ...flowOptions(target, challenge), fetch: recordingFetch, refreshOnly: true });
        if (result !== "AUTHORIZED") {
          const failure = new McpOAuthAuthorizationRequiredError();
          if (rejected) failure.message = rejected;
          throw failure;
        }
      } catch (error) {
        writeSecret(target.home, reloginKey(target), "1");
        if (error instanceof McpOAuthAuthorizationRequiredError) throw error;
        const failure = new McpOAuthAuthorizationRequiredError();
        failure.message = error instanceof Error ? error.message : String(error);
        throw failure;
      }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  return {
    token: async () => {
      await refreshing;
      const state = await storage(target).load();
      if (state?.tokensExpireAt && state.tokensExpireAt <= Date.now() + 30_000) await refresh(state.tokens?.access_token, globalThis.fetch);
      return (await client.tokens())?.access_token;
    },
    onUnauthorized: async context => {
      const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
      challenges.set(challengeKey(target), challenge);
      if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
      await refresh(context.token, context.fetch, challenge);
    },
  };
}
