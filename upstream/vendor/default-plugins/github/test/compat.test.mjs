import { strict as assert } from "node:assert";
import test from "node:test";
import { DEFAULT_REMOTE_TOOLS, startFakeGitHub } from "./fake-github.mjs";
import { startMcpTestClient } from "./mcp-client.mjs";

test("1.0 兼容：只填 GITHUB_PERSONAL_ACCESS_TOKEN，工具列表和调用原样转发", async () => {
  const pat = "ghp_compat_token_123";
  const fake = await startFakeGitHub({ validTokens: [pat] });
  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PERSONAL_ACCESS_TOKEN: pat,
  });

  try {
    const tools = await client.listTools();
    const visibleTools = tools.filter((t) => !(Array.isArray(t._meta?.ui?.visibility) && t._meta.ui.visibility.every((v) => v !== "model")));
    assert.deepEqual(visibleTools, DEFAULT_REMOTE_TOOLS);

    const issuesRes = await client.callTool("list_issues", { owner: "FFatTiger", repo: "hob", state: "open" });
    assert.equal(issuesRes.isError, undefined);
    const issuesBody = JSON.parse(issuesRes.content[0].text);
    assert.equal(issuesBody.tool, "list_issues");
    assert.deepEqual(issuesBody.args, { owner: "FFatTiger", repo: "hob", state: "open" });
    assert.equal(issuesBody.token, pat);

    const prsRes = await client.callTool("list_pull_requests", { owner: "FFatTiger", repo: "hob" });
    assert.equal(prsRes.isError, undefined);
    const prsBody = JSON.parse(prsRes.content[0].text);
    assert.equal(prsBody.tool, "list_pull_requests");
    assert.equal(prsBody.token, pat);
  } finally {
    await client.close();
    await fake.close();
  }
});

test("1.0 兼容：支持远程 MCP 的 SSE (text/event-stream) 响应", async () => {
  const pat = "ghp_sse_token_456";
  const fake = await startFakeGitHub({ validTokens: [pat], mcpMode: "sse" });
  const client = await startMcpTestClient({
    ...fake.env(),
    GITHUB_PERSONAL_ACCESS_TOKEN: pat,
  });

  try {
    const tools = await client.listTools();
    assert.ok(tools.some((t) => t.name === "list_issues"));
    const res = await client.callTool("get_me", {});
    assert.equal(res.isError, undefined);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.tool, "get_me");
    assert.equal(body.token, pat);
  } finally {
    await client.close();
    await fake.close();
  }
});

test("无任何身份时：服务仍可启动且 tools/list 不崩溃，调用工具给出三种配置方式说明", async () => {
  const fake = await startFakeGitHub();
  const client = await startMcpTestClient({
    ...fake.env(),
  });

  try {
    const tools = await client.listTools();
    assert.ok(Array.isArray(tools));
    const res = await client.callTool("list_issues", { owner: "acme", repo: "demo" });
    assert.equal(res.isError, true);
    const text = res.content[0].text;
    assert.match(text, /登录/);
    assert.match(text, /GitHub App/);
    assert.match(text, /个人访问令牌/);
  } finally {
    await client.close();
    await fake.close();
  }
});
