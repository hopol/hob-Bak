import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ATTRIBUTION_LINE, HOB_BOT_CO_AUTHOR } from "../attribution.mjs";
import { createGitHubServer } from "../server.mjs";
import { startFakeGitHub } from "./fake-github.mjs";

const GITHUB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(GITHUB_DIR, "bin");

async function startHobToolsBridge(serverEnv) {
  const mcpServer = createGitHubServer({ env: serverEnv });
  const expectedToken = "hob-tools-test-secret";
  let calls = 0;
  const httpServer = createServer((req, res) => {
    calls++;
    void (async () => {
      if (req.headers.authorization !== `Bearer ${expectedToken}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { name, args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (name !== "github_command_credentials") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown tool: ${name}` }));
        return;
      }
      const result = await mcpServer.callTool("command_credentials", args || {});
      if (result.isError) {
        const text = (result.content || []).map((c) => c.text || "").join("\n");
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: text }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: result.structuredContent }));
    })();
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = httpServer.address();
  return {
    env: {
      HOB_TOOLS_URL: `http://127.0.0.1:${port}/`,
      HOB_TOOLS_TOKEN: expectedToken,
    },
    get calls() { return calls; },
    close() {
      return new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function initTempGitRepo(remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), "hob-git-repo-"));
  const cleanEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  execFileSync("git", ["init", "-q"], { cwd: dir, env: cleanEnv });
  execFileSync("git", ["config", "user.name", "Local User"], { cwd: dir, env: cleanEnv });
  execFileSync("git", ["config", "user.email", "local@example.com"], { cwd: dir, env: cleanEnv });
  if (remoteUrl) {
    execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir, env: cleanEnv });
  }
  return {
    dir,
    cleanEnv,
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function makeTempKeyPair() {
  const dir = mkdtempSync(join(tmpdir(), "hob-cli-key-"));
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const keyPath = join(dir, "app.pem");
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  return {
    dir,
    keyPath,
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function runCommand(command, args, { cwd, env, input } = {}) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        PATH: `${BIN_DIR}${delimiter}${process.env.PATH}`,
        HOME: cwd || tmpdir(),
        GIT_CONFIG_NOSYSTEM: "1",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolveExit({ status, signal, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runBin(binName, args, options = {}) {
  return runCommand(join(BIN_DIR, binName), args, options);
}

test("bin/git：三种身份下的作者和 trailer、关闭署名、无身份、--author 与 -C/-c 写法", async () => {
  const keyTmp = makeTempKeyPair();
  const dataDir = mkdtempSync(join(tmpdir(), "hob-cli-data-"));
  writeFileSync(join(dataDir, "auth.json"), JSON.stringify({
    accessToken: "ghu_git_login",
    expiresAt: Date.now() + 60 * 60 * 1000,
  }), { mode: 0o600 });

  const fake = await startFakeGitHub({
    app: { id: 300, slug: "my-bot" },
    installations: [{ id: 5001, account: { login: "corp-org" } }],
    repoInstallations: {
      "corp-org/web": { id: 5001, account: { login: "corp-org" } },
    },
    accessTokenHandler(id) {
      return { status: 201, body: { token: `ghs_git_${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() } };
    },
    usersByLogin: {
      "my-bot[bot]": { id: 444001, login: "my-bot[bot]" },
    },
    usersByToken: {
      ghu_git_login: { id: 10086, login: "alice", name: "Alice Chen" },
      ghp_git_pat: { id: 20042, login: "bob" },
    },
  });

  // Bridge 1: App + Login + PAT (attribution ON)
  const bridgeAll = await startHobToolsBridge({
    ...fake.env(),
    GITHUB_PLUGIN_DATA: dataDir,
    GITHUB_APP_ID: "300",
    GITHUB_APP_PRIVATE_KEY: readFileSync(keyTmp.keyPath, "utf8"),
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_git_pat",
  });
  // Bridge 2: PAT only (attribution ON)
  const bridgePat = await startHobToolsBridge({
    ...fake.env(),
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_git_pat",
  });
  // Bridge 3: Login with attribution OFF
  const bridgeNoAttr = await startHobToolsBridge({
    ...fake.env(),
    GITHUB_PLUGIN_DATA: dataDir,
    GITHUB_ATTRIBUTION: "false",
  });
  // Bridge 4: No identity at all
  const bridgeNone = await startHobToolsBridge({
    ...fake.env(),
  });

  const corpRepo = initTempGitRepo("https://github.com/corp-org/web.git");
  const userRepo = initTempGitRepo("git@github.com:alice/demo.git");
  const otherRepo = initTempGitRepo("https://git.example.org/team/app.git");

  try {
    // 1. App identity commit (also exercises -c and -C from another cwd!)
    writeFileSync(join(corpRepo.dir, "a.txt"), "1\n");
    execFileSync("git", ["add", "a.txt"], { cwd: corpRepo.dir, env: corpRepo.cleanEnv });
    const appCommit = await runBin("git", ["-c", "core.autocrlf=false", "-C", corpRepo.dir, "commit", "-m", "feat: app commit"], {
      cwd: tmpdir(),
      env: bridgeAll.env,
    });
    assert.equal(appCommit.status, 0, appCommit.stderr);
    const appLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%cn|%ce|%B"], { cwd: corpRepo.dir, encoding: "utf8" });
    assert.ok(appLog.startsWith("my-bot[bot]|444001+my-bot[bot]@users.noreply.github.com|my-bot[bot]|444001+my-bot[bot]@users.noreply.github.com|"));
    assert.ok(appLog.includes(`Co-authored-by: ${HOB_BOT_CO_AUTHOR}`));

    // 2. hob-bot login identity commit (App not installed on alice/demo -> falls back to login)
    writeFileSync(join(userRepo.dir, "b.txt"), "2\n");
    execFileSync("git", ["add", "b.txt"], { cwd: userRepo.dir, env: userRepo.cleanEnv });
    const loginCommit = await runBin("git", ["commit", "-m", "feat: login commit"], {
      cwd: userRepo.dir,
      env: bridgeAll.env,
    });
    assert.equal(loginCommit.status, 0, loginCommit.stderr);
    const loginLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%B"], { cwd: userRepo.dir, encoding: "utf8" });
    assert.ok(loginLog.startsWith("Alice Chen|10086+alice@users.noreply.github.com|"));
    assert.ok(loginLog.includes(`Co-authored-by: ${HOB_BOT_CO_AUTHOR}`));

    // 3. PAT identity commit
    writeFileSync(join(userRepo.dir, "c.txt"), "3\n");
    execFileSync("git", ["add", "c.txt"], { cwd: userRepo.dir, env: userRepo.cleanEnv });
    const patCommit = await runBin("git", ["commit", "-m", "feat: pat commit"], {
      cwd: userRepo.dir,
      env: bridgePat.env,
    });
    assert.equal(patCommit.status, 0, patCommit.stderr);
    const patLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%B"], { cwd: userRepo.dir, encoding: "utf8" });
    assert.ok(patLog.startsWith("bob|20042+bob@users.noreply.github.com|"));
    assert.ok(patLog.includes(`Co-authored-by: ${HOB_BOT_CO_AUTHOR}`));

    // 4. ATTRIBUTION=false -> no Co-authored-by trailer
    writeFileSync(join(userRepo.dir, "d.txt"), "4\n");
    execFileSync("git", ["add", "d.txt"], { cwd: userRepo.dir, env: userRepo.cleanEnv });
    const noAttrCommit = await runBin("git", ["commit", "-m", "feat: no attr"], {
      cwd: userRepo.dir,
      env: bridgeNoAttr.env,
    });
    assert.equal(noAttrCommit.status, 0, noAttrCommit.stderr);
    const noAttrLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%B"], { cwd: userRepo.dir, encoding: "utf8" });
    assert.ok(noAttrLog.startsWith("Alice Chen|10086+alice@users.noreply.github.com|"));
    assert.equal(noAttrLog.includes("Co-authored-by:"), false);

    // 5. Explicit --author is NOT overridden
    writeFileSync(join(userRepo.dir, "e.txt"), "5\n");
    execFileSync("git", ["add", "e.txt"], { cwd: userRepo.dir, env: userRepo.cleanEnv });
    const customAuthorCommit = await runBin("git", ["commit", "--author", "External Dev <ext@example.org>", "-m", "feat: keep author"], {
      cwd: userRepo.dir,
      env: bridgeAll.env,
    });
    assert.equal(customAuthorCommit.status, 0, customAuthorCommit.stderr);
    const customAuthorLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%B"], { cwd: userRepo.dir, encoding: "utf8" });
    assert.ok(customAuthorLog.startsWith("External Dev|ext@example.org|"));
    assert.ok(customAuthorLog.includes(`Co-authored-by: ${HOB_BOT_CO_AUTHOR}`));

    // 6. No identity -> behaves identically to plain git (local user, no trailer, no credential helper)
    writeFileSync(join(userRepo.dir, "f.txt"), "6\n");
    execFileSync("git", ["add", "f.txt"], { cwd: userRepo.dir, env: userRepo.cleanEnv });
    const noAuthCommit = await runBin("git", ["commit", "-m", "feat: plain git"], {
      cwd: userRepo.dir,
      env: bridgeNone.env,
    });
    assert.equal(noAuthCommit.status, 0, noAuthCommit.stderr);
    const noAuthLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%B"], { cwd: userRepo.dir, encoding: "utf8" });
    assert.ok(noAuthLog.startsWith("Local User|local@example.com|"));
    assert.equal(noAuthLog.includes("Co-authored-by:"), false);

    // 7. Credential helper is attached to commands that talk to a remote, only with an identity.
    //    A stand-in "real git" after the wrapper on PATH prints the arguments it receives.
    const fakeGitDir = mkdtempSync(join(tmpdir(), "hob-fake-git-"));
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(fakeGitDir, "git"), `#!/bin/sh\nfor a; do [ "$a" = remote ] && exec ${realGit} "$@"; done\necho "ARGS $*"\n`);
    chmodSync(join(fakeGitDir, "git"), 0o755);
    const fakePath = { PATH: `${BIN_DIR}${delimiter}${fakeGitDir}${delimiter}${process.env.PATH}` };
    const pushOn = await runBin("git", ["push", "origin", "main"], { cwd: corpRepo.dir, env: { ...bridgeAll.env, ...fakePath } });
    assert.equal(pushOn.status, 0, pushOn.stderr);
    assert.ok(pushOn.stdout.includes("credential.https://github.com.helper="), pushOn.stdout);
    assert.ok(pushOn.stdout.includes("git-credential-hob"));
    assert.ok(pushOn.stdout.includes("credential.https://github.com.useHttpPath=true"));
    const pushOff = await runBin("git", ["push", "origin", "main"], { cwd: corpRepo.dir, env: { ...bridgeNone.env, ...fakePath } });
    assert.equal(pushOff.stdout.trim(), "ARGS push origin main");
    rmSync(fakeGitDir, { recursive: true, force: true });

    // 8. Local-only subcommands skip the plugin entirely (no credentials round trip)
    const before = bridgeAll.calls;
    const status = await runBin("git", ["status", "--short"], { cwd: corpRepo.dir, env: bridgeAll.env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(bridgeAll.calls, before);

    // 9. A repo whose remotes are all off github.com keeps its own author and gets no trailer
    writeFileSync(join(otherRepo.dir, "g.txt"), "7\n");
    execFileSync("git", ["add", "g.txt"], { cwd: otherRepo.dir, env: otherRepo.cleanEnv });
    const otherCommit = await runBin("git", ["commit", "-m", "feat: elsewhere"], { cwd: otherRepo.dir, env: bridgeAll.env });
    assert.equal(otherCommit.status, 0, otherCommit.stderr);
    const otherLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%B"], { cwd: otherRepo.dir, encoding: "utf8" });
    assert.ok(otherLog.startsWith("Local User|local@example.com|"));
    assert.equal(otherLog.includes("Co-authored-by:"), false);
  } finally {
    await bridgeAll.close();
    await bridgePat.close();
    await bridgeNoAttr.close();
    await bridgeNone.close();
    await fake.close();
    corpRepo.cleanup();
    userRepo.cleanup();
    otherRepo.cleanup();
    keyTmp.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("bin/git-credential-hob：仅对 github.com 的 get 返回令牌，对其他 host 和非 get 不返回", async () => {
  const keyTmp = makeTempKeyPair();
  const fake = await startFakeGitHub({
    app: { id: 301, slug: "cred-bot" },
    installations: [{ id: 6001, account: { login: "acme" } }],
    repoInstallations: { "acme/repo": { id: 6001 } },
    accessTokenHandler(id) {
      return { status: 201, body: { token: `ghs_cred_${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() } };
    },
  });
  const bridge = await startHobToolsBridge({
    ...fake.env(),
    GITHUB_APP_ID: "301",
    GITHUB_APP_PRIVATE_KEY: readFileSync(keyTmp.keyPath, "utf8"),
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_fallback_cred",
  });

  try {
    // 1. github.com + installed repo -> returns App token
    const ghGet = await runBin("git-credential-hob", ["get"], {
      env: bridge.env,
      input: "protocol=https\nhost=github.com\npath=acme/repo.git\n\n",
    });
    assert.equal(ghGet.status, 0);
    assert.equal(ghGet.stdout, "username=x-access-token\npassword=ghs_cred_6001\n");

    // 2. github.com + non-installed repo -> falls back to PAT
    const ghFallback = await runBin("git-credential-hob", ["get"], {
      env: bridge.env,
      input: "protocol=https\nhost=github.com\npath=other/repo.git\n\n",
    });
    assert.equal(ghFallback.status, 0);
    assert.equal(ghFallback.stdout, "username=x-access-token\npassword=ghp_fallback_cred\n");

    // 3. Non-github.com host -> empty stdout
    const gitlabGet = await runBin("git-credential-hob", ["get"], {
      env: bridge.env,
      input: "protocol=https\nhost=gitlab.com\npath=acme/repo.git\n\n",
    });
    assert.equal(gitlabGet.status, 0);
    assert.equal(gitlabGet.stdout, "");

    // 4. store / erase actions -> empty stdout
    const storeRes = await runBin("git-credential-hob", ["store"], {
      env: bridge.env,
      input: "protocol=https\nhost=github.com\nusername=x\npassword=y\n\n",
    });
    assert.equal(storeRes.status, 0);
    assert.equal(storeRes.stdout, "");
  } finally {
    await bridge.close();
    await fake.close();
    keyTmp.cleanup();
  }
});

test("bin/gh：注入 GH_TOKEN、pr/issue create 补署名、尊重已有 GH_TOKEN、找不到 gh 返回 127", async () => {
  const keyTmp = makeTempKeyPair();
  const fakeBinDir = mkdtempSync(join(tmpdir(), "hob-fake-gh-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
let bodyFileContent = null;
for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--body-file" || args[i] === "-F") && args[i + 1]) {
    bodyFileContent = readFileSync(args[i + 1], "utf8");
  } else if (args[i].startsWith("--body-file=")) {
    bodyFileContent = readFileSync(args[i].slice("--body-file=".length), "utf8");
  }
}
process.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN || null, args, bodyFileContent }));
`,
    { mode: 0o755 },
  );
  chmodSync(fakeGhPath, 0o755);

  const fake = await startFakeGitHub({
    app: { id: 302, slug: "gh-bot" },
    installations: [{ id: 7001, account: { login: "org-a" } }],
    repoInstallations: { "org-a/api": { id: 7001 } },
    accessTokenHandler(id) {
      return { status: 201, body: { token: `ghs_gh_${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() } };
    },
  });

  const bridgeOn = await startHobToolsBridge({
    ...fake.env(),
    GITHUB_APP_ID: "302",
    GITHUB_APP_PRIVATE_KEY: readFileSync(keyTmp.keyPath, "utf8"),
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_gh_pat",
  });
  const bridgeOff = await startHobToolsBridge({
    ...fake.env(),
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_gh_pat",
    GITHUB_ATTRIBUTION: "false",
  });

  const repo = initTempGitRepo("https://github.com/org-a/api.git");
  const bodyFile = join(repo.dir, "issue-body.md");
  writeFileSync(bodyFile, "Original issue text\n", "utf8");

  const pathWithFakeGh = `${BIN_DIR}${delimiter}${fakeBinDir}${delimiter}${process.env.PATH}`;

  try {
    // 1. pr create with --body and -R -> App token + attribution appended
    const prRes = await runBin("gh", ["pr", "create", "-R", "org-a/api", "--title", "T", "--body", "PR body"], {
      cwd: tmpdir(),
      env: { ...bridgeOn.env, PATH: pathWithFakeGh },
    });
    assert.equal(prRes.status, 0, prRes.stderr);
    const prOut = JSON.parse(prRes.stdout);
    assert.equal(prOut.token, "ghs_gh_7001");
    const bodyIdx = prOut.args.indexOf("--body");
    assert.equal(prOut.args[bodyIdx + 1], `PR body\n\n${ATTRIBUTION_LINE}`);

    // 2. issue create with --body-file and git remote detection (no -R) -> App token + temp body file with attribution
    const issueRes = await runBin("gh", ["issue", "create", "--title", "Bug", "--body-file", bodyFile], {
      cwd: repo.dir,
      env: { ...bridgeOn.env, PATH: pathWithFakeGh },
    });
    assert.equal(issueRes.status, 0, issueRes.stderr);
    const issueOut = JSON.parse(issueRes.stdout);
    assert.equal(issueOut.token, "ghs_gh_7001");
    assert.equal(issueOut.bodyFileContent, `Original issue text\n\n${ATTRIBUTION_LINE}`);
    // Original file on disk must NOT be modified
    assert.equal(readFileSync(bodyFile, "utf8"), "Original issue text\n");

    // 3. ATTRIBUTION=false -> no attribution appended
    const noAttrRes = await runBin("gh", ["pr", "create", "--title", "T", "--body", "Plain PR"], {
      cwd: repo.dir,
      env: { ...bridgeOff.env, PATH: pathWithFakeGh },
    });
    assert.equal(noAttrRes.status, 0, noAttrRes.stderr);
    const noAttrOut = JSON.parse(noAttrRes.stdout);
    assert.equal(noAttrOut.token, "ghp_gh_pat");
    assert.equal(noAttrOut.args[noAttrOut.args.indexOf("--body") + 1], "Plain PR");

    // 4. Existing GH_TOKEN in environment is preserved
    const presetRes = await runBin("gh", ["pr", "list"], {
      cwd: repo.dir,
      env: { ...bridgeOn.env, GH_TOKEN: "ghp_user_explicit", PATH: pathWithFakeGh },
    });
    assert.equal(presetRes.status, 0, presetRes.stderr);
    assert.equal(JSON.parse(presetRes.stdout).token, "ghp_user_explicit");

    // 5. Missing gh binary on PATH -> exit 127 with clear message
    const emptyDir = mkdtempSync(join(tmpdir(), "hob-no-gh-"));
    try {
      const missingRes = await runCommand(process.execPath, [join(BIN_DIR, "gh"), "pr", "list"], {
        env: { ...bridgeOn.env, PATH: `${BIN_DIR}${delimiter}${emptyDir}` },
      });
      assert.equal(missingRes.status, 127);
      assert.match(missingRes.stderr, /没有安装 gh/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    await bridgeOn.close();
    await bridgeOff.close();
    await fake.close();
    repo.cleanup();
    keyTmp.cleanup();
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});
