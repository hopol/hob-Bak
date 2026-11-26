// Identity resolution, GitHub App JWT, hob-bot device-code login, and GitHub API helpers.
// Priority: 1. GitHub App (JWT + installation token) > 2. hob-bot login > 3. Personal Access Token.

import { createPrivateKey, randomBytes, sign as cryptoSign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HOB_BOT_CO_AUTHOR } from "./attribution.mjs";

export const HOB_BOT_CLIENT_ID = "Iv23liZVDEIT17Ex36pI";
// A key pasted into a one-line field loses its line breaks; rebuild the PEM layout.
export function normalizePem(text) {
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!match) return text;
  const body = match[2].replace(/\s+/g, "");
  return `-----BEGIN ${match[1]}-----\n${(body.match(/.{1,64}/g) || []).join("\n")}\n-----END ${match[1]}-----\n`;
}

export const HOB_BOT_INSTALL_URL = "https://github.com/apps/hob-bot/installations/new";
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;
export const NO_AUTH_MESSAGE =
  "未配置 GitHub 身份。请在插件页面点击「登录」（hob-bot），或在配置中填写 GitHub App（App ID 和私钥），或填写个人访问令牌。";

export class AuthError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

export function parseBooleanConfig(value, defaultValue = true) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  return defaultValue;
}

export function extractScopeFromArgs(args) {
  if (!args || typeof args !== "object") return {};
  let owner = typeof args.owner === "string" && args.owner.trim() ? args.owner.trim() : undefined;
  if (!owner && typeof args.org === "string" && args.org.trim()) owner = args.org.trim();
  let repo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;

  if (!owner && repo && repo.includes("/")) {
    const parts = repo.split("/").filter(Boolean);
    if (parts.length >= 2) {
      owner = parts[0];
      repo = parts[1];
    }
  }
  if (!owner && typeof args.repository === "string" && args.repository.includes("/")) {
    const parts = args.repository.trim().split("/").filter(Boolean);
    if (parts.length >= 2) {
      owner = parts[0];
      if (!repo) repo = parts[1];
    }
  }
  return { ...(owner ? { owner } : {}), ...(repo ? { repo } : {}) };
}


function base64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

export function signAppJwt(appId, privateKeyPem, nowSec = Math.floor(Date.now() / 1000)) {
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({
    iat: nowSec - 60,
    exp: nowSec + 9 * 60,
    iss: String(appId),
  });
  const signingInput = `${header}.${payload}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

function formatOAuthError(data, fallback) {
  const parts = [];
  if (typeof data?.error === "string" && data.error.trim()) parts.push(data.error.trim());
  if (typeof data?.error_description === "string" && data.error_description.trim()) {
    parts.push(data.error_description.trim());
  }
  const base = parts.join(": ") || fallback;
  if (data?.error === "device_flow_disabled" || base.includes("device_flow_disabled")) {
    return `${base}（也可以在插件配置中改用个人访问令牌 GITHUB_PERSONAL_ACCESS_TOKEN）`;
  }
  return base;
}

function writeSecretJson(filePath, value) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, filePath);
  chmodSync(filePath, 0o600);
}

export function createAuthManager(env = process.env, options = {}) {
  const pat = (env.GITHUB_PERSONAL_ACCESS_TOKEN || "").trim();
  const appId = (env.GITHUB_APP_ID || "").trim();
  const privateKeyText = (env.GITHUB_APP_PRIVATE_KEY || "").trim();
  const pluginDataDir = (env.GITHUB_PLUGIN_DATA || "").trim();
  const attribution = parseBooleanConfig(env.GITHUB_ATTRIBUTION, true);
  const apiBase = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const webBase = (env.GITHUB_WEB_URL || "https://github.com").replace(/\/+$/, "");
  const mcpUrl = (env.GITHUB_MCP_URL || "https://api.githubcopilot.com/mcp/").trim();
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const onAuthChanged = options.onAuthChanged || null;

  const appConfigured = Boolean(appId && privateKeyText);
  let cachedPrivateKey = null;
  let cachedAppInfo = null;
  const installationTokenCache = new Map(); // installationId -> { token, expiresAtMs }
  const botUserCache = new Map(); // slug -> { id, login }
  const userByTokenCache = new Map(); // token -> { id, login, name }

  // hob-bot device-code login state
  let storedAuth = undefined; // undefined = not loaded from disk yet; null = no file
  let pendingDevice = null; // { deviceCode, expiresAt, interval }
  let refreshPromise = null;

  function authFilePath() {
    if (!pluginDataDir) {
      throw new AuthError("未配置插件数据目录（GITHUB_PLUGIN_DATA），无法保存登录状态", { code: "no_data_dir" });
    }
    return join(pluginDataDir, "auth.json");
  }

  function loadStoredAuth() {
    if (storedAuth !== undefined) return storedAuth;
    if (!pluginDataDir) {
      storedAuth = null;
      return null;
    }
    const file = join(pluginDataDir, "auth.json");
    if (!existsSync(file)) {
      storedAuth = null;
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      storedAuth = parsed && typeof parsed === "object" && typeof parsed.accessToken === "string" ? parsed : null;
    } catch {
      storedAuth = null;
    }
    return storedAuth;
  }

  function saveStoredAuth(record) {
    const file = authFilePath();
    writeSecretJson(file, record);
    storedAuth = record;
  }

  function clearStoredAuth() {
    storedAuth = null;
    pendingDevice = null;
    if (!pluginDataDir) return;
    rmSync(join(pluginDataDir, "auth.json"), { force: true });
  }

  function loadPrivateKey() {
    if (cachedPrivateKey) return cachedPrivateKey;
    const pem = normalizePem(privateKeyText);
    try {
      createPrivateKey(pem);
    } catch {
      throw new AuthError("GitHub App 私钥不对：用文本编辑器打开从 GitHub 下载的 .pem 文件，全部复制粘贴进来，包括开头的 -----BEGIN 和结尾的 -----END 两行。", { code: "app_key_error" });
    }
    cachedPrivateKey = pem;
    return pem;
  }

  function createJwt() {
    const pem = loadPrivateKey();
    return signAppJwt(appId, pem, Math.floor(now() / 1000));
  }

  async function githubApi(path, { method = "GET", token, allow404 = false } = {}) {
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "hob-github-plugin/2.0.0",
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetchImpl(`${apiBase}${path}`, { method, headers });
    if (allow404 && response.status === 404) {
      await response.body?.cancel?.().catch(() => {});
      return null;
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!response.ok) {
      const detail = data?.message || text.trim() || `HTTP ${response.status}`;
      throw new AuthError(`GitHub API ${method} ${path} 失败（HTTP ${response.status}）：${detail}`, {
        code: "api_error",
        status: response.status,
      });
    }
    return data;
  }

  async function postOAuth(path, formParams) {
    const body = new URLSearchParams(formParams).toString();
    const response = await fetchImpl(`${webBase}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "hob-github-plugin/2.0.0",
      },
      body,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { ok: response.ok, status: response.status, data, text };
  }

  async function getAppInfo() {
    if (!appConfigured) return null;
    if (cachedAppInfo) return cachedAppInfo;
    try {
      const jwt = createJwt();
      const info = await githubApi("/app", { token: jwt, allow404: true });
      if (info && typeof info === "object") cachedAppInfo = info;
    } catch {
      // Best effort: fall back to generic install URL if /app cannot be read.
    }
    return cachedAppInfo;
  }

  async function getAppInstallUrl() {
    const info = await getAppInfo();
    if (info?.slug) return `${webBase}/apps/${encodeURIComponent(info.slug)}/installations/new`;
    if (typeof info?.html_url === "string" && info.html_url) {
      return `${info.html_url.replace(/\/+$/, "")}/installations/new`;
    }
    return `${webBase}/settings/apps`;
  }

  // Every tool call and git push looks up the installation; remember answers (found or not) for
  // a few minutes so a newly installed App is picked up soon without a lookup per call.
  const installationCache = new Map();
  async function findAppInstallation(scope = {}) {
    const key = `${scope.owner || ""}/${scope.repo || ""}`;
    const hit = installationCache.get(key);
    if (hit && now() < hit.until) return hit.value;
    const value = await lookupAppInstallation(scope);
    installationCache.set(key, { value, until: now() + 5 * 60 * 1000 });
    return value;
  }

  async function lookupAppInstallation(scope) {
    const jwt = createJwt();
    const { owner, repo } = scope;
    if (owner && repo) {
      return await githubApi(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
        { token: jwt, allow404: true },
      );
    }
    if (owner) {
      const userInst = await githubApi(`/users/${encodeURIComponent(owner)}/installation`, { token: jwt, allow404: true });
      if (userInst) return userInst;
      return await githubApi(`/orgs/${encodeURIComponent(owner)}/installation`, { token: jwt, allow404: true });
    }
    const list = await githubApi("/app/installations", { token: jwt });
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
  }

  async function getInstallationToken(installationId) {
    const key = String(installationId);
    const cached = installationTokenCache.get(key);
    if (cached && now() < cached.expiresAtMs - REFRESH_BUFFER_MS) {
      return cached.token;
    }
    const jwt = createJwt();
    const data = await githubApi(`/app/installations/${encodeURIComponent(key)}/access_tokens`, {
      method: "POST",
      token: jwt,
    });
    if (!data?.token) {
      throw new AuthError("GitHub 未返回 App 安装令牌", { code: "app_token_error" });
    }
    const parsedExpiry = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
    const expiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : now() + 60 * 60 * 1000;
    installationTokenCache.set(key, { token: data.token, expiresAtMs });
    return data.token;
  }

  async function refreshLoginToken(record) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const res = await postOAuth("/login/oauth/access_token", {
        client_id: HOB_BOT_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: record.refreshToken,
      });
      if (!res.ok || !res.data?.access_token) {
        const message = formatOAuthError(res.data, res.text.trim() || `HTTP ${res.status}`);
        throw new AuthError(`刷新 GitHub 登录令牌失败：${message}`, { code: "refresh_failed" });
      }
      const expiresIn = Number(res.data.expires_in);
      const refreshExpiresIn = Number(res.data.refresh_token_expires_in);
      const updated = {
        ...record,
        accessToken: res.data.access_token,
        refreshToken: res.data.refresh_token || record.refreshToken,
        ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now() + expiresIn * 1000 } : {}),
        ...(Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
          ? { refreshTokenExpiresAt: now() + refreshExpiresIn * 1000 }
          : {}),
      };
      saveStoredAuth(updated);
      return updated.accessToken;
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function getLoginToken() {
    const record = loadStoredAuth();
    if (!record?.accessToken) return null;
    const needsRefresh = typeof record.expiresAt === "number" && now() >= record.expiresAt - REFRESH_BUFFER_MS;
    if (!needsRefresh) return record.accessToken;

    if (record.refreshToken) {
      try {
        return await refreshLoginToken(record);
      } catch (error) {
        // If the current access token has not actually expired yet, keep using it; otherwise treat as unauthenticated.
        if (now() < record.expiresAt) return record.accessToken;
        console.error(`[github-mcp] ${error?.message || error}`);
        return null;
      }
    }

    return now() < record.expiresAt ? record.accessToken : null;
  }

  async function loginStart() {
    const res = await postOAuth("/login/device/code", {
      client_id: HOB_BOT_CLIENT_ID,
    });
    if (!res.ok || res.data?.error || !res.data?.device_code || !res.data?.user_code || !res.data?.verification_uri) {
      const msg = formatOAuthError(res.data, res.text.trim() || `GitHub 设备码请求失败（HTTP ${res.status}）`);
      throw new AuthError(msg, { code: res.data?.error || "device_code_failed" });
    }
    const expiresIn = Number(res.data.expires_in) || 900;
    const interval = Number(res.data.interval) || 5;
    const expiresAt = now() + expiresIn * 1000;
    pendingDevice = {
      deviceCode: res.data.device_code,
      expiresAt,
      interval,
    };
    return {
      kind: "device_code",
      url: res.data.verification_uri,
      userCode: res.data.user_code,
      expiresAt: new Date(expiresAt).toISOString(),
      interval,
    };
  }

  async function loginPoll() {
    if (!pendingDevice) {
      return { state: "error", message: "没有进行中的登录流程，请重新点击登录" };
    }
    if (now() > pendingDevice.expiresAt) {
      pendingDevice = null;
      return { state: "error", message: "expired_token: 设备验证码已过期，请重新登录" };
    }

    const res = await postOAuth("/login/oauth/access_token", {
      client_id: HOB_BOT_CLIENT_ID,
      device_code: pendingDevice.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    const data = res.data || {};
    if (data.error === "authorization_pending") {
      return { state: "pending" };
    }
    if (data.error === "slow_down") {
      if (Number.isFinite(Number(data.interval)) && Number(data.interval) > 0) {
        pendingDevice.interval = Number(data.interval);
      }
      return { state: "pending" };
    }
    if (data.error || !res.ok || !data.access_token) {
      pendingDevice = null;
      const msg = formatOAuthError(data, res.text.trim() || `GitHub 登录失败（HTTP ${res.status}）`);
      return { state: "error", message: msg };
    }

    const expiresIn = Number(data.expires_in);
    const refreshExpiresIn = Number(data.refresh_token_expires_in);
    let user = null;
    try {
      const me = await githubApi("/user", { token: data.access_token });
      if (me?.login) user = { id: me.id, login: me.login, ...(me.name ? { name: me.name } : {}) };
    } catch {
      // Best effort; /user will be queried again by status or command_credentials.
    }

    const record = {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now() + expiresIn * 1000 } : {}),
      ...(Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
        ? { refreshTokenExpiresAt: now() + refreshExpiresIn * 1000 }
        : {}),
      ...(user ? { user } : {}),
    };
    saveStoredAuth(record);
    pendingDevice = null;
    onAuthChanged?.();
    return { state: "done" };
  }

  // Not signed in to hob-bot: if an App or a token is configured the plugin already works,
  // so sign-in is only an add-on and Hob should not report the plugin as signed out.
  async function signedOutStatus() {
    if (appConfigured) {
      const slug = (await getAppInfo().catch(() => null))?.slug;
      return { signedIn: false, optional: true, detail: `正在用 GitHub App${slug ? `（${slug}）` : ""}，不用再登录。App 没装的仓库，可以再用 hob-bot 登录补上。`, startLabel: "用 hob-bot 登录" };
    }
    if (pat) {
      const login = (await getUserForToken(pat))?.login;
      return { signedIn: false, optional: true, detail: `正在用个人访问令牌${login ? `（${login}）` : ""}，不用再登录。`, startLabel: "改用 hob-bot 登录" };
    }
    return { signedIn: false };
  }

  async function loginStatus() {
    const token = await getLoginToken();
    if (!token) return await signedOutStatus();

    let user;
    try {
      user = await githubApi("/user", { token });
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) {
        return await signedOutStatus();
      }
      throw error;
    }

    const login = user?.login || loadStoredAuth()?.user?.login || "";
    let accounts = [];
    try {
      const inst = await githubApi("/user/installations", { token });
      const list = Array.isArray(inst?.installations) ? inst.installations : [];
      accounts = [...new Set(list.map((entry) => entry?.account?.login).filter(Boolean))];
    } catch {
      // Best effort: still report signed-in user if /user/installations fails.
    }

    const detail = accounts.length > 0
      ? `已登录 ${login} · hob-bot 已装在 ${accounts.join("、")}（[管理安装](${HOB_BOT_INSTALL_URL})）`
      : `已登录 ${login} · hob-bot 尚未安装到任何账号或组织，[去安装 hob-bot](${HOB_BOT_INSTALL_URL})`;

    return {
      signedIn: true,
      ...(login ? { account: login } : {}),
      detail,
    };
  }

  async function loginLogout() {
    clearStoredAuth();
    onAuthChanged?.();
    return { ok: true };
  }

  async function resolveToken(scope = {}) {
    let appNotInstalled = false;

    // 1. GitHub App identity
    if (appConfigured) {
      const installation = await findAppInstallation(scope);
      if (installation?.id !== undefined) {
        const token = await getInstallationToken(installation.id);
        return { token, source: "app", installationId: installation.id };
      }
      appNotInstalled = true;
    }

    // 2. hob-bot login identity
    const loginToken = await getLoginToken();
    if (loginToken) {
      return { token: loginToken, source: "login" };
    }

    // 3. Personal access token
    if (pat) {
      return { token: pat, source: "pat" };
    }

    if (appNotInstalled) {
      const installUrl = await getAppInstallUrl();
      const target = scope.owner || "";
      const msg = target
        ? `这个 App 没有装在 ${target} 上，也没有登录或令牌。安装链接：${installUrl}`
        : `这个 App 没有装在任何账号或组织上，也没有登录或令牌。安装链接：${installUrl}`;
      throw new AuthError(msg, { code: "app_not_installed" });
    }

    throw new AuthError(NO_AUTH_MESSAGE, { code: "no_auth" });
  }

  async function getBotUser(slug, token) {
    if (!slug) return null;
    if (botUserCache.has(slug)) return botUserCache.get(slug);
    const botLogin = `${slug}[bot]`;
    try {
      const user = await githubApi(`/users/${encodeURIComponent(botLogin)}`, { token, allow404: true });
      if (user?.id !== undefined) {
        const info = { id: user.id, login: botLogin };
        botUserCache.set(slug, info);
        return info;
      }
    } catch {
      // Best effort: omit authorEmail if bot user lookup fails.
    }
    return null;
  }

  async function getUserForToken(token) {
    if (userByTokenCache.has(token)) return userByTokenCache.get(token);
    try {
      const user = await githubApi("/user", { token });
      if (user?.id !== undefined && user?.login) {
        const info = { id: user.id, login: user.login, ...(user.name ? { name: user.name } : {}) };
        if (userByTokenCache.size > 16) {
          userByTokenCache.delete(userByTokenCache.keys().next().value);
        }
        userByTokenCache.set(token, info);
        return info;
      }
    } catch {
      // Best effort: still return token if /user lookup fails.
    }
    return null;
  }

  async function resolveCommandCredentials(scope = {}) {
    const resolved = await resolveToken(scope);
    let authorName;
    let authorEmail;
    let isHobBotSelf = false;

    if (resolved.source === "app") {
      const appInfo = await getAppInfo();
      const slug = appInfo?.slug;
      if (slug) {
        isHobBotSelf = slug === "hob-bot";
        authorName = `${slug}[bot]`;
        const botUser = await getBotUser(slug, resolved.token);
        if (botUser?.id !== undefined) {
          authorEmail = `${botUser.id}+${slug}[bot]@users.noreply.github.com`;
        }
      }
    } else {
      const user = await getUserForToken(resolved.token);
      if (user) {
        authorName = user.name || user.login;
        authorEmail = `${user.id}+${user.login}@users.noreply.github.com`;
      }
    }

    const coAuthor = attribution && !isHobBotSelf ? HOB_BOT_CO_AUTHOR : undefined;

    return {
      token: resolved.token,
      ...(authorName ? { authorName } : {}),
      ...(authorEmail ? { authorEmail } : {}),
      ...(coAuthor ? { coAuthor } : {}),
      attribution,
    };
  }

  return {
    config: {
      pat,
      appId,
      appConfigured,
      pluginDataDir,
      attribution,
      apiBase,
      webBase,
      mcpUrl,
    },
    fetchImpl,
    githubApi,
    getAppInfo,
    getAppInstallUrl,
    getLoginToken,
    loginStatus,
    loginStart,
    loginPoll,
    loginLogout,
    resolveToken,
    resolveCommandCredentials,
  };
}
