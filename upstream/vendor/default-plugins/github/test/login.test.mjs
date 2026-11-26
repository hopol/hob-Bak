import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HOB_BOT_CLIENT_ID, HOB_BOT_INSTALL_URL } from "../auth.mjs";
import { startFakeGitHub } from "./fake-github.mjs";
import { startMcpTestClient } from "./mcp-client.mjs";

function makeTempDir(prefix = "hob-github-login-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

test("hob/login 四个工具暴露正确元数据，完整设备码登录、持久化 0600、查安装与登出", async () => {
  const tmp = makeTempDir();
  let pollCount = 0;
  const fake = await startFakeGitHub({
    usersByToken: {
      ghu_user_token_1: { id: 101, login: "octocat", name: "The Octocat" },
    },
    userInstallationsByToken: {
      ghu_user_token_1: [
        { id: 501, account: { login: "octocat" } },
        { id: 502, account: { login: "hob-org" } },
      ],
    },
    oauthTokenHandler(params) {
      assert.equal(params.client_id, HOB_BOT_CLIENT_ID);
      assert.equal(params.client_secret, undefined, "device flow must not send client_secret");
      assert.equal(params.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
      pollCount += 1;
      if (pollCount === 1) return { status: 200, body: { error: "authorization_pending" } };
      return {
        status: 200,
        body: {
          access_token: "ghu_user_token_1",
          refresh_token: "ghr_refresh_1",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
          token_type: "bearer",
        },
      };
    },
  });

  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PLUGIN_DATA: tmp.dir,
  });

  try {
    // 1. Check metadata on login tools
    const tools = await client.listTools();
    for (const role of ["status", "start", "poll", "logout"]) {
      const tool = tools.find((item) => item._meta?.["hob/login"] === role);
      assert.ok(tool, `missing hob/login=${role}`);
      assert.deepEqual(tool._meta.ui.visibility, ["app"]);
    }

    // 2. Initial status: not signed in
    const status0 = await client.callTool("hob_login_status", {});
    assert.deepEqual(status0.structuredContent, { signedIn: false });

    // 3. start -> device_code
    const started = await client.callTool("hob_login_start", {});
    assert.equal(started.isError, undefined);
    assert.equal(started.structuredContent.kind, "device_code");
    assert.equal(started.structuredContent.userCode, "HOB-1234");
    assert.ok(started.structuredContent.url.endsWith("/login/device"));
    assert.ok(started.structuredContent.expiresAt);
    assert.equal(started.structuredContent.interval, 1);

    // 4. poll -> pending -> done
    const poll1 = await client.callTool("hob_login_poll", {});
    assert.deepEqual(poll1.structuredContent, { state: "pending" });

    const poll2 = await client.callTool("hob_login_poll", {});
    assert.deepEqual(poll2.structuredContent, { state: "done" });

    // Token saved to ${hob.plugin_data}/auth.json with mode 0600
    const authFile = join(tmp.dir, "auth.json");
    assert.equal(existsSync(authFile), true);
    assert.equal(statSync(authFile).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(authFile, "utf8"));
    assert.equal(saved.accessToken, "ghu_user_token_1");
    assert.equal(saved.refreshToken, "ghr_refresh_1");

    // 5. status shows signed-in account and installed accounts/orgs
    const status1 = await client.callTool("hob_login_status", {});
    assert.equal(status1.structuredContent.signedIn, true);
    assert.equal(status1.structuredContent.account, "octocat");
    assert.match(status1.structuredContent.detail, /octocat/);
    assert.match(status1.structuredContent.detail, /hob-org/);

    // 6. Remote tools now work with user token
    const toolsAfter = await client.listTools();
    assert.ok(toolsAfter.some((t) => t.name === "list_issues"));
    const callRes = await client.callTool("list_issues", { owner: "octocat", repo: "hello" });
    assert.equal(JSON.parse(callRes.content[0].text).token, "ghu_user_token_1");

    // 7. status when hob-bot has 0 installations includes install link
    fake.state.userInstallationsByToken.ghu_user_token_1 = [];
    const statusNoInst = await client.callTool("hob_login_status", {});
    assert.equal(statusNoInst.structuredContent.signedIn, true);
    assert.ok(statusNoInst.structuredContent.detail.includes(HOB_BOT_INSTALL_URL));

    // 8. logout removes auth.json and resets status
    const out = await client.callTool("hob_login_logout", {});
    assert.equal(out.isError, undefined);
    assert.equal(existsSync(authFile), false);
    const status2 = await client.callTool("hob_login_status", {});
    assert.deepEqual(status2.structuredContent, { signedIn: false });
  } finally {
    await client.close();
    await fake.close();
    tmp.cleanup();
  }
});

test("hob-bot 登录令牌过期后自动使用 refresh_token 续期（不带 client_secret）", async () => {
  const tmp = makeTempDir();
  const authFile = join(tmp.dir, "auth.json");
  // Pre-seed an already-expired access token with a valid refresh token
  writeFileSync(authFile, JSON.stringify({
    accessToken: "ghu_expired_token",
    refreshToken: "ghr_valid_refresh",
    expiresAt: Date.now() - 10_000,
    user: { id: 101, login: "octocat" },
  }), { mode: 0o600 });

  let refreshCalled = 0;
  const fake = await startFakeGitHub({
    validTokens: ["ghu_refreshed_token"],
    usersByToken: { ghu_refreshed_token: { id: 101, login: "octocat" } },
    userInstallationsByToken: { ghu_refreshed_token: [] },
    oauthTokenHandler(params) {
      assert.equal(params.client_id, HOB_BOT_CLIENT_ID);
      assert.equal(params.client_secret, undefined, "refresh must not send client_secret");
      assert.equal(params.grant_type, "refresh_token");
      assert.equal(params.refresh_token, "ghr_valid_refresh");
      refreshCalled += 1;
      return {
        status: 200,
        body: {
          access_token: "ghu_refreshed_token",
          refresh_token: "ghr_new_refresh",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
        },
      };
    },
  });

  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PLUGIN_DATA: tmp.dir,
  });

  try {
    const res = await client.callTool("list_issues", { owner: "octocat", repo: "demo" });
    assert.equal(res.isError, undefined);
    assert.equal(JSON.parse(res.content[0].text).token, "ghu_refreshed_token");
    assert.equal(refreshCalled, 1);

    // Persisted file updated with new tokens and still 0600
    assert.equal(statSync(authFile).mode & 0o777, 0o600);
    const updated = JSON.parse(readFileSync(authFile, "utf8"));
    assert.equal(updated.accessToken, "ghu_refreshed_token");
    assert.equal(updated.refreshToken, "ghr_new_refresh");
  } finally {
    await client.close();
    await fake.close();
    tmp.cleanup();
  }
});

test("device_flow_disabled 错误原样报给用户并提示可改用个人访问令牌", async () => {
  const tmp = makeTempDir();
  const fake = await startFakeGitHub({
    deviceCodeHandler() {
      return {
        status: 400,
        body: {
          error: "device_flow_disabled",
          error_description: "Device flow is not enabled for this app.",
        },
      };
    },
  });

  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PLUGIN_DATA: tmp.dir,
  });

  try {
    const started = await client.callTool("hob_login_start", {});
    assert.equal(started.isError, true);
    const text = started.content[0].text;
    assert.match(text, /device_flow_disabled/);
    assert.match(text, /Device flow is not enabled for this app/);
    assert.match(text, /个人访问令牌/);
  } finally {
    await client.close();
    await fake.close();
    tmp.cleanup();
  }
});

test("三种身份优先级：App > hob-bot 登录 > 个人访问令牌", async () => {
  const tmp = makeTempDir();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const keyPath = join(tmp.dir, "app.pem");
  writeFileSync(keyPath, privateKey, { mode: 0o600 });

  // Pre-seed hob-bot login
  writeFileSync(join(tmp.dir, "auth.json"), JSON.stringify({
    accessToken: "ghu_priority_login",
    expiresAt: Date.now() + 60 * 60 * 1000,
    user: { id: 101, login: "octocat" },
  }), { mode: 0o600 });

  const fake = await startFakeGitHub({
    app: { id: 55, slug: "priority-bot" },
    installations: [{ id: 7001, account: { login: "app-org" } }],
    repoInstallations: {
      "app-org/repo": { id: 7001, account: { login: "app-org" } },
    },
    accessTokenHandler(id) {
      return {
        status: 201,
        body: { token: `ghs_app_${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
      };
    },
  });

  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PLUGIN_DATA: tmp.dir,
    GITHUB_APP_ID: "55",
    GITHUB_APP_PRIVATE_KEY: readFileSync(keyPath, "utf8"),
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_priority_pat",
  });

  try {
    // 1. App installed on app-org -> App wins over Login and PAT
    const rApp = JSON.parse((await client.callTool("list_issues", { owner: "app-org", repo: "repo" })).content[0].text);
    assert.equal(rApp.token, "ghs_app_7001");

    // 2. App NOT installed on user-org -> falls back to hob-bot Login (wins over PAT)
    const rLogin = JSON.parse((await client.callTool("list_issues", { owner: "user-org", repo: "repo" })).content[0].text);
    assert.equal(rLogin.token, "ghu_priority_login");

    // 3. After logging out of hob-bot -> falls back to PAT
    await client.callTool("hob_login_logout", {});
    const rPat = JSON.parse((await client.callTool("list_issues", { owner: "user-org", repo: "repo" })).content[0].text);
    assert.equal(rPat.token, "ghp_priority_pat");
  } finally {
    await client.close();
    await fake.close();
    tmp.cleanup();
  }
});

test("没登录 hob-bot 但填了个人令牌：登录只是附加选项，状态带 optional 和当前身份", async () => {
  const fake = await startFakeGitHub({
    usersByToken: { ghp_existing_pat: { id: 7, login: "octocat" } },
  });
  const tmp = makeTempDir();
  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PLUGIN_DATA: tmp.dir,
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_existing_pat",
  });
  try {
    const status = await client.callTool("hob_login_status", {});
    assert.equal(status.structuredContent.signedIn, false);
    assert.equal(status.structuredContent.optional, true);
    assert.match(status.structuredContent.detail, /个人访问令牌（octocat）/);
    assert.equal(status.structuredContent.startLabel, "改用 hob-bot 登录");
  } finally {
    await client.close();
    await fake.close();
    tmp.cleanup();
  }
});
