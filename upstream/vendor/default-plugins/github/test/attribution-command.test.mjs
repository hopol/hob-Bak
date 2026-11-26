import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ATTRIBUTION_LINE, HOB_BOT_CO_AUTHOR } from "../attribution.mjs";
import { startFakeGitHub } from "./fake-github.mjs";
import { startMcpTestClient } from "./mcp-client.mjs";

function makeTempKey() {
  const dir = mkdtempSync(join(tmpdir(), "hob-github-attr-test-"));
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

test("开 PR、开 issue 默认补上 Hob 署名，只补一次，不改动其他工具", async () => {
  const pat = "ghp_attr_on";
  const fake = await startFakeGitHub({ validTokens: [pat] });
  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PERSONAL_ACCESS_TOKEN: pat,
  });

  try {
    // 1. create_pull_request with body
    const pr = JSON.parse((await client.callTool("create_pull_request", {
      owner: "acme",
      repo: "web",
      title: "Fix bug",
      body: "Summary of changes",
      head: "fix",
      base: "main",
    })).content[0].text);
    assert.equal(pr.args.body, `Summary of changes\n\n${ATTRIBUTION_LINE}`);

    // 2. create_issue with empty/missing body
    const issueEmpty = JSON.parse((await client.callTool("create_issue", {
      owner: "acme",
      repo: "web",
      title: "Track task",
    })).content[0].text);
    assert.equal(issueEmpty.args.body, ATTRIBUTION_LINE);

    // 3. create_pull_request already containing attribution line -> NOT duplicated
    const existingBody = `Already signed\n\n${ATTRIBUTION_LINE}`;
    const prDup = JSON.parse((await client.callTool("create_pull_request", {
      owner: "acme",
      repo: "web",
      title: "Dup check",
      body: existingBody,
      head: "fix2",
      base: "main",
    })).content[0].text);
    assert.equal(prDup.args.body, existingBody);
    assert.equal(prDup.args.body.split(ATTRIBUTION_LINE).length - 1, 1);

    // 4. Non-creation tool untouched
    const listRes = JSON.parse((await client.callTool("list_issues", {
      owner: "acme",
      repo: "web",
    })).content[0].text);
    assert.equal(listRes.args.body, undefined);
  } finally {
    await client.close();
    await fake.close();
  }
});

test("ATTRIBUTION 关掉后，开 PR 和开 issue 不补署名", async () => {
  const pat = "ghp_attr_off";
  const fake = await startFakeGitHub({ validTokens: [pat] });
  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PERSONAL_ACCESS_TOKEN: pat,
    GITHUB_ATTRIBUTION: "false",
  });

  try {
    const pr = JSON.parse((await client.callTool("create_pull_request", {
      owner: "acme",
      repo: "web",
      title: "No attr PR",
      body: "Plain body",
      head: "feat",
      base: "main",
    })).content[0].text);
    assert.equal(pr.args.body, "Plain body");

    const issue = JSON.parse((await client.callTool("create_issue", {
      owner: "acme",
      repo: "web",
      title: "No attr issue",
      body: "Issue details",
    })).content[0].text);
    assert.equal(issue.args.body, "Issue details");
  } finally {
    await client.close();
    await fake.close();
  }
});

test("hob/command 工具元数据正确，按三种身份返回 token、author 和 coAuthor", async () => {
  const tmp = makeTempKey();
  // Seed hob-bot login
  writeFileSync(join(tmp.dir, "auth.json"), JSON.stringify({
    accessToken: "ghu_cmd_login",
    expiresAt: Date.now() + 60 * 60 * 1000,
  }), { mode: 0o600 });

  const fake = await startFakeGitHub({
    app: { id: 99, slug: "my-corp-app" },
    installations: [{ id: 8001, account: { login: "corp-org" } }],
    ownerInstallations: {
      "corp-org": { type: "org", installation: { id: 8001, account: { login: "corp-org" } } },
    },
    accessTokenHandler(id) {
      return {
        status: 201,
        body: { token: `ghs_corp_${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
      };
    },
    usersByLogin: {
      "my-corp-app[bot]": { id: 555001, login: "my-corp-app[bot]" },
      "hob-bot[bot]": { id: 361159285, login: "hob-bot[bot]" },
    },
    usersByToken: {
      ghu_cmd_login: { id: 10086, login: "alice", name: "Alice Chen" },
      ghp_cmd_pat: { id: 20042, login: "bob" },
    },
  });

  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PLUGIN_DATA: tmp.dir,
    GITHUB_APP_ID: "99",
    GITHUB_APP_PRIVATE_KEY: readFileSync(tmp.keyPath, "utf8"),
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_cmd_pat",
  });

  try {
    // Verify tool metadata
    const tools = await client.listTools();
    const cmdTool = tools.find((t) => t.name === "command_credentials");
    assert.ok(cmdTool);
    assert.deepEqual(cmdTool._meta, { ui: { visibility: ["app"] }, "hob/command": true });

    // 1. App identity (owner=corp-org)
    const appRes = await client.callTool("command_credentials", { owner: "corp-org" });
    assert.equal(appRes.isError, undefined);
    assert.deepEqual(appRes.structuredContent, {
      token: "ghs_corp_8001",
      authorName: "my-corp-app[bot]",
      authorEmail: "555001+my-corp-app[bot]@users.noreply.github.com",
      coAuthor: HOB_BOT_CO_AUTHOR,
      attribution: true,
    });

    // 2. hob-bot user login identity (App not installed on personal-owner)
    const loginRes = await client.callTool("command_credentials", { owner: "personal-owner" });
    assert.equal(loginRes.isError, undefined);
    assert.deepEqual(loginRes.structuredContent, {
      token: "ghu_cmd_login",
      authorName: "Alice Chen",
      authorEmail: "10086+alice@users.noreply.github.com",
      coAuthor: HOB_BOT_CO_AUTHOR,
      attribution: true,
    });

    // 3. PAT identity (after logout)
    await client.callTool("hob_login_logout", {});
    const patRes = await client.callTool("command_credentials", { owner: "personal-owner" });
    assert.equal(patRes.isError, undefined);
    assert.deepEqual(patRes.structuredContent, {
      token: "ghp_cmd_pat",
      authorName: "bob",
      authorEmail: "20042+bob@users.noreply.github.com",
      coAuthor: HOB_BOT_CO_AUTHOR,
      attribution: true,
    });
  } finally {
    await client.close();
    await fake.close();
    tmp.cleanup();
  }
});

test("hob/command：身份是 hob-bot 机器人本人或 ATTRIBUTION 关闭时不返回 coAuthor", async () => {
  const tmp = makeTempKey();
  const fake = await startFakeGitHub({
    app: { id: 100, slug: "hob-bot" },
    installations: [{ id: 9001, account: { login: "acme" } }],
    ownerInstallations: {
      acme: { type: "org", installation: { id: 9001 } },
    },
    accessTokenHandler(id) {
      return {
        status: 201,
        body: { token: `ghs_hob_${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
      };
    },
    usersByLogin: {
      "hob-bot[bot]": { id: 361159285, login: "hob-bot[bot]" },
    },
    usersByToken: {
      ghp_no_attr: { id: 777, login: "carol" },
    },
  });

  // Case A: App slug is hob-bot itself -> coAuthor omitted even when attribution is on
  const clientBot = await startMcpTestClient({
    ...fake.env(),
    GITHUB_APP_ID: "100",
    GITHUB_APP_PRIVATE_KEY: readFileSync(tmp.keyPath, "utf8"),
  });
  try {
    const res = await clientBot.callTool("command_credentials", { owner: "acme" });
    assert.deepEqual(res.structuredContent, {
      token: "ghs_hob_9001",
      authorName: "hob-bot[bot]",
      authorEmail: "361159285+hob-bot[bot]@users.noreply.github.com",
      attribution: true,
    });
    assert.equal("coAuthor" in res.structuredContent, false);
  } finally {
    await clientBot.close();
  }

  // Case B: PAT with GITHUB_ATTRIBUTION=false -> coAuthor omitted
  const clientNoAttr = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_no_attr",
    GITHUB_ATTRIBUTION: "false",
  });
  try {
    const res = await clientNoAttr.callTool("command_credentials", {});
    assert.deepEqual(res.structuredContent, {
      token: "ghp_no_attr",
      authorName: "carol",
      authorEmail: "777+carol@users.noreply.github.com",
      attribution: false,
    });
    assert.equal("coAuthor" in res.structuredContent, false);
  } finally {
    await clientNoAttr.close();
    await fake.close();
    tmp.cleanup();
  }
});

test("通过工具直接在 GitHub 上提交：提交说明补上 hob-bot 共同作者，只补一次；关掉署名不补", async () => {
  const pat = "ghp_commit_attr";
  const fake = await startFakeGitHub({ validTokens: [pat] });
  const on = await startMcpTestClient({ ...fake.env(), GITHUB_PERSONAL_ACCESS_TOKEN: pat });
  const off = await startMcpTestClient({ ...fake.env(), GITHUB_PERSONAL_ACCESS_TOKEN: pat, GITHUB_ATTRIBUTION: "false" });
  const trailer = `Co-authored-by: ${HOB_BOT_CO_AUTHOR}`;
  const call = async (client, name, args) => JSON.parse((await client.callTool(name, { owner: "acme", repo: "web", ...args })).content[0].text).args;
  try {
    assert.equal((await call(on, "create_or_update_file", { path: "a.md", content: "x", message: "docs: add a", branch: "main" })).message, `docs: add a\n\n${trailer}`);
    assert.equal((await call(on, "push_files", { branch: "main", files: [], message: `feat: b\n\n${trailer}` })).message, `feat: b\n\n${trailer}`);
    assert.equal((await call(on, "merge_pull_request", { pullNumber: 1, merge_method: "squash", commit_message: "squash body" })).commit_message, `squash body\n\n${trailer}`);
    assert.equal((await call(on, "merge_pull_request", { pullNumber: 1 })).commit_message, undefined);
    assert.equal((await call(off, "create_or_update_file", { path: "a.md", content: "x", message: "docs: add a", branch: "main" })).message, "docs: add a");
  } finally {
    await on.close();
    await off.close();
    await fake.close();
  }
});
