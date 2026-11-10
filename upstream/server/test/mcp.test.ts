import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  importMcpServers,
  isMcpNameValid,
  listMcpImports,
  mcpEnabled,
  mcpView,
  MCP_SESSION_TOOLS,
  normalizeMcpName,
  patchMcpServer,
  removeMcpServer,
  saveMcpServer,
  testMcpServer,
} from "../src/mcp.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "hob-mcp-"));
}

function writeConfig(home: string, doc: unknown): void {
  mkdirSync(join(home, "system", "engine"), { recursive: true });
  writeFileSync(join(home, "system", "engine", "mcp.json"), JSON.stringify(doc, null, 2));
}

function readConfig(home: string): Record<string, any> {
  return JSON.parse(readFileSync(join(home, "system", "engine", "mcp.json"), "utf8"));
}

const FIXTURE_SERVER = { command: process.execPath, args: [FIXTURE] };

describe("mcp.json 读写", () => {
  it("新建文件是 0600，写入 autoEnableCodemode: false，重写保留其它顶层键", async () => {
    const home = tempHome();
    await saveMcpServer(home, "fx", { kind: "stdio", command: "npx", args: ["-y", "x"] });
    const path = join(home, "system", "engine", "mcp.json");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const doc = readConfig(home);
    expect(doc.autoEnableCodemode).toBe(false);
    expect(doc.mcpServers.fx).toMatchObject({ command: "npx", args: ["-y", "x"], exposure: "direct" });

    // 手工补一个顶层键，再改另一个服务：顶层键要原样保留
    doc.myNote = { keep: true };
    writeFileSync(path, JSON.stringify(doc, null, 2));
    await saveMcpServer(home, "other", { kind: "http", url: "https://example.com/mcp" });
    expect(readConfig(home).myNote).toEqual({ keep: true });
    expect(readConfig(home).mcpServers.fx).toMatchObject({ command: "npx" });
  });

  it("只改目标条目；条目里不认识的字段原样保留", async () => {
    const home = tempHome();
    writeConfig(home, {
      mcpServers: {
        fx: { command: "npx", args: ["x"], oauth: { clientId: "abc" }, timeout: 30, exposure: "direct" },
      },
    });
    await saveMcpServer(home, "fx", { kind: "stdio", command: "node", args: ["s.js"] });
    const entry = readConfig(home).mcpServers.fx;
    expect(entry.command).toBe("node");
    expect(entry.oauth).toEqual({ clientId: "abc" });
    expect(entry.timeout).toBe(30);
    expect(entry.exposure).toBe("direct");
  });

  it("并发写不同服务不会丢失修改", async () => {
    const home = tempHome();
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      saveMcpServer(home, `service-${i}`, { kind: "stdio", command: `command-${i}` }),
    ));
    const servers = readConfig(home).mcpServers;
    expect(Object.keys(servers)).toHaveLength(12);
    for (let i = 0; i < 12; i++) expect(servers[`service-${i}`].command).toBe(`command-${i}`);
  });

  it("坏文件读和写都报错，不当成空列表", async () => {
    const home = tempHome();
    mkdirSync(join(home, "system", "engine"), { recursive: true });
    writeFileSync(join(home, "system", "engine", "mcp.json"), "{ not json");
    expect(() => mcpView(home)).toThrow(/JSON/);
    await expect(saveMcpServer(home, "fx", { kind: "stdio", command: "npx" })).rejects.toThrow(/JSON/);
    expect(mcpEnabled(home)).toBe(false);
  });

  it("密钥不回传：字面值只显示已设置，整值 ${VAR} 引用原样回显", async () => {
    const home = tempHome();
    await saveMcpServer(home, "fx", {
      kind: "stdio",
      command: "npx",
      env: { TOKEN: { mode: "replace", value: "secret-value" }, REF: { mode: "replace", value: "${MY_TOKEN}" } },
    });
    const view = mcpView(home).servers.find((server) => server.name === "fx")!;
    expect(view.env?.TOKEN).toEqual({ redacted: true });
    expect(view.env?.REF).toEqual({ redacted: false, value: "${MY_TOKEN}" });
    // 文件里存的是原值
    expect(readConfig(home).mcpServers.fx.env.TOKEN).toBe("secret-value");
  });

  it("编辑密钥：保留 / 替换 / 删除", async () => {
    const home = tempHome();
    await saveMcpServer(home, "fx", {
      kind: "stdio",
      command: "npx",
      env: {
        KEEP: { mode: "replace", value: "keep-me" },
        DROP: { mode: "replace", value: "drop-me" },
        CHANGE: { mode: "replace", value: "old" },
      },
    });
    await saveMcpServer(home, "fx", {
      kind: "stdio",
      command: "npx",
      env: { KEEP: { mode: "preserve" }, DROP: { mode: "remove" }, CHANGE: { mode: "replace", value: "new" } },
    });
    const env = readConfig(home).mcpServers.fx.env;
    expect(env).toEqual({ KEEP: "keep-me", CHANGE: "new" });
    // 保留一个不存在的键要报错
    await expect(
      saveMcpServer(home, "fx", { kind: "stdio", command: "npx", env: { NOPE: { mode: "preserve" } } }),
    ).rejects.toThrow(/不存在/);
  });

  it("补丁：停用写 enabled:false，启用删字段；提供方式和关掉的工具", async () => {
    const home = tempHome();
    await saveMcpServer(home, "fx", { kind: "stdio", command: "npx" });
    let view = await patchMcpServer(home, "fx", { enabled: false });
    expect(view.servers[0]!.enabled).toBe(false);
    expect(readConfig(home).mcpServers.fx.enabled).toBe(false);
    view = await patchMcpServer(home, "fx", { enabled: true });
    expect(view.servers[0]!.enabled).toBe(true);
    expect(readConfig(home).mcpServers.fx.enabled).toBeUndefined();

    view = await patchMcpServer(home, "fx", { exposure: "deferred" });
    expect(view.servers[0]!.exposure).toBe("deferred");
    view = await patchMcpServer(home, "fx", { hiddenTools: ["echo", "fail"] });
    expect(view.servers[0]!.hiddenTools).toEqual(["echo", "fail"]);
    expect(readConfig(home).mcpServers.fx.toolExposure).toEqual({ echo: "hidden", fail: "hidden" });
    // 再开回来：全量替换
    await patchMcpServer(home, "fx", { hiddenTools: ["fail"] });
    expect(readConfig(home).mcpServers.fx.toolExposure).toEqual({ fail: "hidden" });
  });

  it("删除", async () => {
    const home = tempHome();
    await saveMcpServer(home, "fx", { kind: "stdio", command: "npx" });
    const view = await removeMcpServer(home, "fx");
    expect(view.servers).toEqual([]);
    await expect(removeMcpServer(home, "fx")).rejects.toThrow(/没有/);
  });
});

describe("名称校验", () => {
  it("只收字母数字和 _ -；- 和 _ 视为同名", async () => {
    expect(isMcpNameValid("a-B_9")).toBe(true);
    expect(isMcpNameValid("a.b")).toBe(false);
    expect(isMcpNameValid("")).toBe(false);
    expect(normalizeMcpName("a-b")).toBe(normalizeMcpName("a_b"));

    const home = tempHome();
    await saveMcpServer(home, "my-srv", { kind: "stdio", command: "npx" });
    await expect(saveMcpServer(home, "my_srv", { kind: "stdio", command: "npx" })).rejects.toThrow(/重名/);
    await expect(saveMcpServer(home, "bad name", { kind: "stdio", command: "npx" })).rejects.toThrow(/名称/);
  });

  it("SSE 地址给出明确提示", async () => {
    const home = tempHome();
    await expect(saveMcpServer(home, "docs", { kind: "http", url: "https://example.com/sse" })).rejects.toThrow(/SSE/);
    writeConfig(home, { mcpServers: { docs: { url: "https://example.com/sse" } } });
    const view = mcpView(home).servers[0]!;
    expect(view.valid).toBe(false);
    expect(view.invalidReason).toContain("SSE");
  });
});

describe("测试连接", () => {
  it("连接本地假服务，列出工具；缓存住 30 秒内的重复探测", async () => {
    const home = tempHome();
    await saveMcpServer(home, "fx", { kind: "stdio", ...FIXTURE_SERVER });
    const result = await testMcpServer(home, "fx", true);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.tools.map((tool) => tool.name)).toEqual(["echo", "fail"]);
    // 不刷新时直接用缓存（换个 refresh=false 也拿到同样结果）
    const cached = await testMcpServer(home, "fx", false);
    expect(cached).toEqual(result);
  });

  it("失败给原因和 stderr 尾部；密钥不漏进错误信息", async () => {
    const home = tempHome();
    await saveMcpServer(home, "bad", {
      kind: "stdio",
      command: process.execPath,
      args: ["-e", "console.error('boom-log'); process.exit(1)"],
    });
    const result = await testMcpServer(home, "bad", true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("failed");
    expect(result.stderrTail.join("\n")).toContain("boom-log");

    await saveMcpServer(home, "leak", {
      kind: "stdio",
      command: process.execPath,
      args: ["-e", `console.error(process.env.SECRET_LEAKED ?? "none"); process.exit(1)`],
      env: { SECRET_LEAKED: { mode: "replace", value: "super-secret-123" } },
    });
    const leaking = await testMcpServer(home, "leak", true);
    expect(leaking.ok).toBe(false);
    if (leaking.ok) return;
    expect(JSON.stringify(leaking)).not.toContain("super-secret-123");
  });

  it("探测结果脱敏展开的引用、命令输出和短密钥", async () => {
    const home = tempHome();
    process.env.HOB_MCP_PRIVATE = "reference-secret";
    try {
      await saveMcpServer(home, "leak-ref", {
        kind: "stdio", command: process.execPath,
        args: ["-e", "console.error(process.env.SECRET); process.exit(1)"],
        env: { SECRET: { mode: "replace", value: "${HOB_MCP_PRIVATE}" } },
      });
      expect(JSON.stringify(await testMcpServer(home, "leak-ref", true))).not.toContain("reference-secret");
      await saveMcpServer(home, "leak-short", {
        kind: "stdio", command: process.execPath,
        args: ["-e", "console.error(process.env.SECRET); process.exit(1)"],
        env: { SECRET: { mode: "replace", value: "xyz" } },
      });
      expect(JSON.stringify(await testMcpServer(home, "leak-short", true))).not.toContain("xyz");
      await saveMcpServer(home, "leak-tool", {
        kind: "stdio", ...FIXTURE_SERVER,
        env: { HOB_MCP_DESCRIPTION: { mode: "replace", value: "!printf command-secret" } },
      });
      const result = await testMcpServer(home, "leak-tool", true);
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain("command-secret");
      await saveMcpServer(home, "leak-command-error", {
        kind: "stdio", ...FIXTURE_SERVER,
        env: { TOKEN: { mode: "replace", value: "!printf failed-secret >&2; exit 1" } },
      });
      expect(JSON.stringify(await testMcpServer(home, "leak-command-error", true))).not.toContain("failed-secret");
    } finally {
      delete process.env.HOB_MCP_PRIVATE;
    }
  });

  it("环境变量引用在探测时展开；缺失的变量报清名字", async () => {
    const home = tempHome();
    process.env.HOB_MCP_TEST_VAR = "expanded";
    try {
      await saveMcpServer(home, "fx", {
        kind: "stdio",
        ...FIXTURE_SERVER,
        env: { MSG: { mode: "replace", value: "${HOB_MCP_TEST_VAR}" } },
      });
      const ok = await testMcpServer(home, "fx", true);
      expect(ok.ok).toBe(true);
      delete process.env.HOB_MCP_TEST_VAR;
      const missing = await testMcpServer(home, "fx", true);
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.error).toContain("HOB_MCP_TEST_VAR");
    } finally {
      delete process.env.HOB_MCP_TEST_VAR;
    }
  });
});

describe("从本机导入", () => {
  function tempSources(): { pi: string; claude: string; cursor: string } {
    const dir = mkdtempSync(join(tmpdir(), "hob-mcp-src-"));
    const pi = join(dir, "mcp.json");
    const claude = join(dir, ".claude.json");
    const cursor = join(dir, "cursor-mcp.json");
    writeFileSync(pi, JSON.stringify({ mcpServers: { fx: { command: "node", args: ["a.js"] } } }));
    writeFileSync(claude, JSON.stringify({ mcpServers: { "claude-srv": { url: "https://example.com/mcp" }, broken: "not-object" } }));
    writeFileSync(cursor, JSON.stringify({ mcpServers: {} }));
    return { pi, claude, cursor };
  }

  it("列出三个来源（只读），无效条目标原因", () => {
    const home = tempHome();
    const dirs = tempSources();
    const view = listMcpImports(home, dirs);
    expect(view.sources.length).toBe(3);
    const fx = view.items.find((item) => item.id === "pi:fx")!;
    expect(fx.selectable).toBe(true);
    expect(fx.kind).toBe("stdio");
    const claude = view.items.find((item) => item.id === "claude:claude-srv")!;
    expect(claude.kind).toBe("http");
    const broken = view.items.find((item) => item.id === "claude:broken")!;
    expect(broken.selectable).toBe(false);
    expect(broken.note).toBeTruthy();
  });

  it("导入补 direct，同名（含 -/_ 等价）跳过并说明", async () => {
    const home = tempHome();
    await saveMcpServer(home, "fx", { kind: "stdio", command: "npx" });
    const dirs = tempSources();
    // pi:fx 已存在（同名），claude:claude-srv 可导入
    const result = await importMcpServers(home, ["pi:fx", "claude:claude-srv"], dirs);
    expect(result.imported).toEqual(["claude-srv"]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]).toContain("fx");
    const doc = readConfig(home);
    expect(doc.mcpServers["claude-srv"]).toMatchObject({ url: "https://example.com/mcp", exposure: "direct" });
    // 已有的 fx 没被覆盖
    expect(doc.mcpServers.fx.command).toBe("npx");
    // 导入后列表里标出同名
    const view = listMcpImports(home, dirs);
    expect(view.items.find((item) => item.id === "claude:claude-srv")!.exists).toBe(true);
  });
});

describe("任务会话里的 MCP", () => {
  it("有启用服务时任务能调用 MCP 工具，过程显示「服务 · 工具」", async () => {
    const hob = makeHob();
    try {
      writeConfig(hob.home, { mcpServers: { fx: { ...FIXTURE_SERVER, exposure: "direct" } } });
      expect(mcpEnabled(hob.home)).toBe(true);
      hob.faux.setResponses([
        call("mcp__fx__echo", { message: "你好" }),
        call("report", { outcome: "done", result: "echo 完成" }),
      ]);
      hob.faux.appendResponses([text("完成了。")]);
      const job = await hob.runtime.jobs.start("hob", { title: "测 MCP", instruction: "调用 echo" });
      await hob.runtime.jobs.waitIdle(30_000);
      const done = hob.runtime.store.job(job.id)!;
      expect(done.status).toBe("done");
      const steps = hob.runtime.jobs.transcript(job.id);
      const echoStep = steps.find((step) => step.kind === "tool" && step.name === "fx · echo");
      expect(echoStep).toBeTruthy();
      expect(echoStep?.title).toContain("fx · echo");
      expect(echoStep?.output).toContain("echo: 你好");
    } finally {
      hob.close();
    }
  }, 60_000);

  it("停用的服务不加载；不加载 MCP 的会话（对话层）没有 MCP 工具", async () => {
    const hob = makeHob();
    try {
      writeConfig(hob.home, { mcpServers: { fx: { ...FIXTURE_SERVER, enabled: false, exposure: "direct" } } });
      expect(mcpEnabled(hob.home)).toBe(false);
      const opened = await hob.runtime.pi.open({
        file: join(hob.home, "assistants", "hob", "jobs", "t-mcp", "worker.jsonl"),
        cwd: hob.home,
        model: "hob-faux/faux-1",
        thinking: "off",
        systemPrompt: () => "测试",
        tools: ["read"],
      });
      try {
        // 没传 mcp 就不该有任何 MCP 工具（Router 的打开方式）
        expect(opened.session.getActiveToolNames().some((name) => name.startsWith("mcp__"))).toBe(false);
      } finally {
        opened.session.dispose();
      }
    } finally {
      hob.close();
    }
  });

  it("关掉的单个工具拿不到，其余工具可用", async () => {
    const hob = makeHob();
    try {
      writeConfig(hob.home, {
        mcpServers: { fx: { ...FIXTURE_SERVER, exposure: "direct", toolExposure: { echo: "hidden" } } },
      });
      expect(mcpEnabled(hob.home)).toBe(true);
      const opened = await hob.runtime.pi.open({
        file: join(hob.home, "assistants", "hob", "jobs", "t-mcp2", "worker.jsonl"),
        cwd: hob.home,
        model: "hob-faux/faux-1",
        thinking: "off",
        systemPrompt: () => "测试",
        tools: ["read", ...MCP_SESSION_TOOLS],
        mcp: true,
      });
      try {
        await waitFor(() => opened.session.getActiveToolNames().includes("mcp__fx__fail"), 15_000);
        const names = opened.session.getActiveToolNames();
        expect(names).not.toContain("mcp__fx__echo");
        expect(names).toContain("tool_search");
      } finally {
        opened.session.dispose();
      }
    } finally {
      hob.close();
    }
  }, 60_000);
});

describe("会话工具白名单", () => {
  it("包含 MCP 全体工具和按需搜索", () => {
    expect(MCP_SESSION_TOOLS).toEqual(["mcp__*", "tool_search"]);
  });
});
