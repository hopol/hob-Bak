import { strict as assert } from "node:assert";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signAppJwt } from "../auth.mjs";
import { startFakeGitHub } from "./fake-github.mjs";
import { startMcpTestClient } from "./mcp-client.mjs";

function makeTempKeyPair() {
  const dir = mkdtempSync(join(tmpdir(), "hob-github-app-test-"));
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const keyPath = join(dir, "app.pem");
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  return {
    dir,
    keyPath,
    publicKey,
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function verifyJwt(token, publicKeyPem, expectedAppId) {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "JWT must have 3 segments");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");
  assert.equal(payload.iss, String(expectedAppId));
  assert.ok(payload.exp > payload.iat);
  const ok = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
    publicKeyPem,
    Buffer.from(parts[2], "base64url"),
  );
  assert.equal(ok, true, "JWT RS256 signature must verify");
  return payload;
}

test("signAppJwt 生成有效的 RS256 JWT", () => {
  const kp = makeTempKeyPair();
  try {
    const jwt = signAppJwt("12345", kp.keyPath ? undefined : "");
    assert.fail("should not reach");
  } catch {
    // Expected when passing empty key
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  try {
    const nowSec = 1700000000;
    const jwt = signAppJwt("98765", privateKey, nowSec);
    const payload = verifyJwt(jwt, publicKey, "98765");
    assert.equal(payload.iat, nowSec - 60);
    assert.equal(payload.exp, nowSec + 9 * 60);
  } finally {
    kp.cleanup();
  }
});

test("App 身份：按 owner/repo、仅 owner（user/org）、无 owner 选到正确安装，且优先于 PAT", async () => {
  const kp = makeTempKeyPair();
  let tokenSeq = 0;
  const fake = await startFakeGitHub({
    app: { id: 42, slug: "my-corp-bot", name: "My Corp Bot" },
    installations: [{ id: 1001, account: { login: "acme-org" } }],
    repoInstallations: {
      "acme-org/web": { id: 1001, account: { login: "acme-org" } },
      "beta-user/app": { id: 1002, account: { login: "beta-user" } },
    },
    ownerInstallations: {
      "beta-user": { type: "user", installation: { id: 1002, account: { login: "beta-user" } } },
      "gamma-org": { type: "org", installation: { id: 1003, account: { login: "gamma-org" } } },
    },
    accessTokenHandler(installationId, jwtToken) {
      verifyJwt(jwtToken, kp.publicKey, "42");
      tokenSeq += 1;
      return {
        status: 201,
        body: {
          token: `ghs_inst_${installationId}_v${tokenSeq}`,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      };
    },
  });

  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_APP_ID: "42",
    // Pasted into a one-line field: line breaks are gone
    GITHUB_APP_PRIVATE_KEY: readFileSync(kp.keyPath, "utf8").replace(/\n/g, ""),
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_fallback_pat",
  });

  try {
    // 1. No owner (tools/list + get_me) -> picks first installation (1001)
    const tools = await client.listTools();
    assert.ok(tools.some((t) => t.name === "list_issues"));
    const meRes = await client.callTool("get_me", {});
    assert.match(JSON.parse(meRes.content[0].text).token, /^ghs_inst_1001_/);

    // 2. owner + repo -> /repos/beta-user/app/installation -> 1002
    const betaRes = await client.callTool("list_issues", { owner: "beta-user", repo: "app" });
    assert.match(JSON.parse(betaRes.content[0].text).token, /^ghs_inst_1002_/);

    // 3. owner only (org) -> tries /users/gamma-org/installation (404), then /orgs/gamma-org/installation -> 1003
    const gammaRes = await client.callTool("list_issues", { owner: "gamma-org" });
    assert.match(JSON.parse(gammaRes.content[0].text).token, /^ghs_inst_1003_/);

    // 4. App not installed on "other-org" -> falls back to PAT!
    const fallbackRes = await client.callTool("list_issues", { owner: "other-org", repo: "repo" });
    assert.equal(fallbackRes.isError, undefined);
    assert.equal(JSON.parse(fallbackRes.content[0].text).token, "ghp_fallback_pat");
  } finally {
    await client.close();
    await fake.close();
    kp.cleanup();
  }
});

test("App 身份：安装令牌在过期前 5 分钟内缓存，临近过期后自动换新", async () => {
  const kp = makeTempKeyPair();
  let issuedCount = 0;
  const fake = await startFakeGitHub({
    app: { id: 77, slug: "cache-bot" },
    installations: [{ id: 2001, account: { login: "acme" } }],
    repoInstallations: { "acme/repo": { id: 2001, account: { login: "acme" } } },
    accessTokenHandler(installationId) {
      issuedCount += 1;
      // 1st token expires in 5m + 180ms (valid for ~180ms before hitting the 5-minute refresh buffer)
      // 2nd token expires in 1h
      const ttlMs = issuedCount === 1 ? (5 * 60 * 1000 + 180) : (60 * 60 * 1000);
      return {
        status: 201,
        body: {
          token: `ghs_cache_${installationId}_${issuedCount}`,
          expires_at: new Date(Date.now() + ttlMs).toISOString(),
        },
      };
    },
  });

  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_APP_ID: "77",
    GITHUB_APP_PRIVATE_KEY: readFileSync(kp.keyPath, "utf8"),
  });

  try {
    const r1 = JSON.parse((await client.callTool("list_issues", { owner: "acme", repo: "repo" })).content[0].text);
    const r2 = JSON.parse((await client.callTool("list_issues", { owner: "acme", repo: "repo" })).content[0].text);
    assert.equal(r1.token, "ghs_cache_2001_1");
    assert.equal(r2.token, "ghs_cache_2001_1");
    assert.equal(issuedCount, 1, "Second call should hit the cached installation token");

    // Wait past the 180ms window so the token enters the 5-minute pre-expiry refresh window
    await new Promise((resolve) => setTimeout(resolve, 250));

    const r3 = JSON.parse((await client.callTool("list_issues", { owner: "acme", repo: "repo" })).content[0].text);
    assert.equal(r3.token, "ghs_cache_2001_2");
    assert.equal(issuedCount, 2, "Call within 5 minutes of expiry should exchange a fresh token");
  } finally {
    await client.close();
    await fake.close();
    kp.cleanup();
  }
});

test("App 身份：未装在目标 owner 上且无登录和 PAT 时报错并给出安装链接", async () => {
  const kp = makeTempKeyPair();
  const fake = await startFakeGitHub({
    app: { id: 88, slug: "my-custom-app" },
    installations: [{ id: 3001, account: { login: "installed-org" } }],
    repoInstallations: { "installed-org/repo": { id: 3001 } },
  });

  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_APP_ID: "88",
    GITHUB_APP_PRIVATE_KEY: readFileSync(kp.keyPath, "utf8"),
  });

  try {
    const res = await client.callTool("list_issues", { owner: "missing-org", repo: "secret" });
    assert.equal(res.isError, true);
    const text = res.content[0].text;
    assert.match(text, /没有装在 missing-org 上/);
    assert.match(text, /\/apps\/my-custom-app\/installations\/new/);
  } finally {
    await client.close();
    await fake.close();
    kp.cleanup();
  }
});

test("GitHub App 私钥粘贴错了：报错说清怎么改", async () => {
  const fake = await startFakeGitHub({});
  const client = await startMcpTestClient({ ...fake.env(), GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: "not a key" });
  try {
    const res = await client.callTool("list_issues", { owner: "a", repo: "b" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /私钥不对.*-----BEGIN/);
  } finally {
    await client.close();
    await fake.close();
  }
});
