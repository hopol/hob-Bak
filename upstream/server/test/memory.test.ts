import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import {
  filterMemoryExtensions,
  PiHost,
  bundledPluginEntry,
} from "../src/pi.ts";
import {
  isPlainHttpAllowedHost,
  loreConnection,
  memoryNoteText,
  memoryPromptLines,
  resolveMemoryProvider,
  saveLoreConnection,
  testLoreConnection,
} from "../src/memory.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import type { MemoryProvider } from "../../shared/types.ts";
import { call, makeHob, text } from "./helpers.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "hob-lore-test-"));
}

function loreConfigFile(home: string): string {
  return join(home, "system", "lore", "config.json");
}

describe("记忆提供者的缺省解析", () => {
  it("没配 Lore 就是本地记忆，配好了就是 Lore，显式选过的优先", () => {
    expect(resolveMemoryProvider(undefined, false)).toBe("local");
    expect(resolveMemoryProvider(undefined, true)).toBe("lore");
    expect(resolveMemoryProvider("off", true)).toBe("off");
    expect(resolveMemoryProvider("local", true)).toBe("local");
  });

  it("Lore 连接只认 Hob 自己的目录，环境变量不再生效", () => {
    const home = tempHome();
    process.env.LORE_BASE_URL = "https://api.loremem.com";
    process.env.LORE_API_TOKEN = "lm_x";
    try {
      expect(loreConnection(home)).toMatchObject({ configured: false, source: "none" });
    } finally {
      delete process.env.LORE_BASE_URL;
      delete process.env.LORE_API_TOKEN;
    }

    saveLoreConnection(home, { baseUrl: "http://127.0.0.1:18901", token: "lm_y" });
    expect(loreConnection(home)).toMatchObject({
      configured: true,
      baseUrl: "http://127.0.0.1:18901",
      source: "config",
    });
  });

  it("设置里存过的提供者才算显式；没存过时按 Lore 是否配好推", () => {
    const hob = makeHob();
    try {
      const first = hob.runtime.settings.memory();
      expect(first.provider).toBe("local");
      expect(first.providerExplicit).toBe(false);
      // 自带的 Lore 插件版本就是 vendor 里正式版的版本号
      expect(first.lorePlugin).toMatch(/^\d+\.\d+\.\d+$/);
      const next = hob.runtime.settings.setMemoryProvider(first.revision, "off");
      expect(next).toMatchObject({ provider: "off", providerExplicit: true });
      // 再读一次仍然是显式的（写进了 settings.json）
      expect(hob.runtime.settings.memory()).toMatchObject({ provider: "off", providerExplicit: true });
    } finally {
      hob.close();
    }
  });

  it("providerExplicit=false 时，配好 Lore 的机器缺省是 Lore", () => {
    const hob = makeHob();
    try {
      saveLoreConnection(hob.home, { baseUrl: "http://127.0.0.1:18901", token: "lm_z" });
      // 测试里 settings.json 没写 memory 键
      expect(hob.runtime.settings.memory()).toMatchObject({ provider: "lore", providerExplicit: false });
    } finally {
      hob.close();
    }
  });

  it("选 Lore 但没配好连接 → 报错，不回退", () => {
    const hob = makeHob();
    try {
      const revision = hob.runtime.settings.get().revision;
      expect(() => hob.runtime.settings.setMemoryProvider(revision, "lore")).toThrow(/Lore 尚未配置完成/);
      expect(hob.runtime.settings.memory().provider).toBe("local");
    } finally {
      hob.close();
    }
  });
});

describe("插件加载", () => {
  it("本地记忆只加载 pi-memory，memory_search 被过滤掉", async () => {
    const hob = makeHob();
    try {
      const opened = await hob.runtime.pi.open({
        file: join(hob.home, "probe.jsonl"),
        cwd: hob.home,
        model: "hob-faux/faux-1",
        thinking: "off",
        systemPrompt: () => "x",
        tools: [],
        customTools: [],
        memory: "local",
      });
      const active = opened.session.getActiveToolNames();
      expect(active).toContain("memory_write");
      expect(active).toContain("memory_read");
      expect(active).not.toContain("memory_search");
      expect(active.some((name) => name.startsWith("lore_"))).toBe(false);
      // 本地记忆强制关掉退出总结
      expect(process.env.PI_MEMORY_EXIT_SUMMARY).toBe("0");
    } finally {
      hob.close();
    }
  });

  it("Lore 只加载 lore 插件，本地记忆的工具一个都没有", async () => {
    const hob = makeHob();
    try {
      const opened = await hob.runtime.pi.open({
        file: join(hob.home, "probe-lore.jsonl"),
        cwd: hob.home,
        model: "hob-faux/faux-1",
        thinking: "off",
        systemPrompt: () => "x",
        tools: [],
        customTools: [],
        memory: "lore",
      });
      const active = opened.session.getActiveToolNames();
      expect(active).toContain("lore_search");
      expect(active).toContain("lore_create_node");
      expect(active.some((name) => name.startsWith("memory_") || name === "scratchpad")).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("关闭时两个插件都不加载", async () => {
    const hob = makeHob();
    try {
      const opened = await hob.runtime.pi.open({
        file: join(hob.home, "probe-off.jsonl"),
        cwd: hob.home,
        model: "hob-faux/faux-1",
        thinking: "off",
        systemPrompt: () => "x",
        tools: [],
        customTools: [],
        memory: "off",
      });
      const active = opened.session.getActiveToolNames();
      expect(active).toEqual([]);
    } finally {
      hob.close();
    }
  });

  it("两个插件同时出现就直接报错（互斥断言）", () => {
    const result = {
      extensions: [
        { path: "/x/pi-memory", tools: new Map([["memory_write", {}]]) },
        { path: "/x/lore", tools: new Map([["lore_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    } as unknown as Parameters<typeof filterMemoryExtensions>[0];
    expect(() => filterMemoryExtensions(result, "local")).toThrow(/互斥/);
    // 加载到的插件和当前提供者不一致也报错
    const single = {
      extensions: [{ path: "/x/lore", tools: new Map([["lore_search", {}]]) }],
      errors: [],
      runtime: {},
    } as unknown as Parameters<typeof filterMemoryExtensions>[0];
    expect(() => filterMemoryExtensions(single, "local")).toThrow(/不一致/);
  });

  it("捆绑插件的入口来自包 manifest", () => {
    expect(bundledPluginEntry("pi-memory")).toMatch(/node_modules\/pi-memory\/index\.ts$/);
    expect(bundledPluginEntry("@local/lore-pi-extension")).toMatch(/lore-pi-extension\/index\.ts$/);
  });
});

describe("Lore 连接配置", () => {
  it("0600 原子写，返回里没有明文 Token，换地址清掉旧 Token", () => {
    const home = tempHome();
    const saved = saveLoreConnection(home, { baseUrl: "http://192.168.1.10:18901/", token: "lm_secret" });
    expect(saved).toMatchObject({ configured: true, baseUrl: "http://192.168.1.10:18901", tokenConfigured: true });
    expect(JSON.stringify(saved)).not.toContain("lm_secret");
    expect(statSync(loreConfigFile(home)).mode & 0o777).toBe(0o600);

    // 同地址不填 Token：保留旧的
    saveLoreConnection(home, { baseUrl: "http://192.168.1.10:18901" });
    expect(JSON.parse(readFileSync(loreConfigFile(home), "utf8"))).toMatchObject({ api_token: "lm_secret" });

    // 换地址不填 Token：旧 Token 清掉
    saveLoreConnection(home, { baseUrl: "https://api.loremem.com" });
    const document = JSON.parse(readFileSync(loreConfigFile(home), "utf8")) as Record<string, unknown>;
    expect(document.base_url).toBe("https://api.loremem.com");
    expect(document.api_token).toBeUndefined();
    expect(loreConnection(home)).toMatchObject({ configured: false, tokenConfigured: false });
  });

  it("保留文件里不认识的兄弟键", () => {
    const home = tempHome();
    mkdirSync(join(home, "system", "lore"), { recursive: true });
    writeFileSync(loreConfigFile(home), JSON.stringify({ installed_version: "1.0.0", base_url: "http://127.0.0.1:18901" }));
    saveLoreConnection(home, { baseUrl: "http://127.0.0.1:18901", token: "lm_k" });
    expect(JSON.parse(readFileSync(loreConfigFile(home), "utf8"))).toMatchObject({ installed_version: "1.0.0" });
  });

  it("地址不合法、公网用了 http → 拒绝保存", () => {
    const home = tempHome();
    expect(() => saveLoreConnection(home, { baseUrl: "不是地址", token: "t" })).toThrow(/不是合法的 URL/);
    expect(() => saveLoreConnection(home, { baseUrl: "http://loremem.com", token: "t" })).toThrow(/https/);
    expect(() => saveLoreConnection(home, { baseUrl: "ftp://x", token: "t" })).toThrow(/http\(s\)/);
  });

  it("http/https 判断：本机、局域网、Tailscale、.local 可以明文，公网必须 https", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.10",
      "169.254.1.1",
      "100.101.102.103",
      "[fd7a:115c:a1e0::1]",
      "[fe80::1]",
      "nas.local",
      "box.tail.ts.net",
    ]) {
      expect(isPlainHttpAllowedHost(host), host).toBe(true);
    }
    for (const host of ["api.loremem.com", "8.8.8.8", "[2001:db8::1]", "evil.example"]) {
      expect(isPlainHttpAllowedHost(host), host).toBe(false);
    }
  });
});

describe("测试连接", () => {
  const home = () => tempHome();

  it("原因分类照参考产品：地址无效 / 公网 http / 缺 Token / Token 被拒 / 连不上", async () => {
    const dir = home();
    expect(await testLoreConnection(dir, {})).toEqual({ ok: false, reason: "invalid_url" });
    expect(await testLoreConnection(dir, { baseUrl: "http://api.loremem.com", token: "t" })).toEqual({
      ok: false,
      reason: "insecure_http",
    });
    expect(await testLoreConnection(dir, { baseUrl: "https://api.loremem.com" })).toEqual({
      ok: false,
      reason: "missing_token",
    });

    const unauthorized = async () => new Response("nope", { status: 401 });
    expect(
      await testLoreConnection(
        dir,
        { baseUrl: "https://api.loremem.com", token: "lm_bad" },
        { fetchImpl: unauthorized as unknown as typeof fetch },
      ),
    ).toEqual({ ok: false, reason: "unauthorized" });

    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(
      await testLoreConnection(
        dir,
        { baseUrl: "http://127.0.0.1:18901", token: "lm_x" },
        { fetchImpl: down as unknown as typeof fetch },
      ),
    ).toEqual({ ok: false, reason: "unreachable" });
  });

  it("成功时带 Bearer 打 /api/health?client_type=pi", async () => {
    let called: { url: string; auth?: string } | undefined;
    const ok = async (url: string, init?: RequestInit) => {
      called = { url, auth: (init?.headers as Record<string, string> | undefined)?.authorization };
      return new Response("{}", { status: 200 });
    };
    const result = await testLoreConnection(
      home(),
      { baseUrl: "http://127.0.0.1:18901", token: "lm_x" },
      { fetchImpl: ok as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: true, baseUrl: "http://127.0.0.1:18901" });
    expect(called?.url).toBe("http://127.0.0.1:18901/api/health?client_type=pi");
    expect(called?.auth).toBe("Bearer lm_x");
  });

  it("保存的 Token 只发给当前地址：测别的地址必须自带 Token", async () => {
    const dir = home();
    saveLoreConnection(dir, { baseUrl: "http://127.0.0.1:18901", token: "lm_saved" });
    let auth: string | undefined;
    const probe = async (_url: string, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return new Response("{}", { status: 200 });
    };
    expect(
      await testLoreConnection(dir, { baseUrl: "https://other.example" }, { fetchImpl: probe as unknown as typeof fetch }),
    ).toEqual({ ok: false, reason: "missing_token" });
    expect(auth).toBeUndefined();
  });
});

describe("提示词的「记忆」一节", () => {
  it("本地 / Lore / 关闭三种提供者", () => {
    expect(memoryPromptLines("local")).toEqual([
      "## 记忆",
      "你和用户是长期合作。用户过去的偏好、决定和约定，先用 memory_read 查，免得让用户再说一遍；新出现的、以后还用得上的事实，用 memory_write 记下来。记忆写短一些，过时的及时改掉或删掉。",
    ]);
    expect(memoryPromptLines("lore")[1]).toContain("用户过去的偏好、决定和约定，先去 Lore 查");
    expect(memoryPromptLines("off")).toEqual([]);
  });

  it("关闭时提示词里不出这一节；补充说明单独一节", () => {
    const hob = makeHob();
    try {
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, instructions: "标题不超过 20 字\n少用感叹号" });
      const promptOf = (memory: MemoryProvider) =>
        buildSystemPrompt(hob.runtime.store, "hob", { timezone, aboutYou, memory });
      expect(promptOf("local")).toContain("## 记忆");
      expect(promptOf("off")).not.toContain("## 记忆");
      expect(promptOf("off")).toContain("## 补充说明");
      expect(promptOf("off")).toContain("标题不超过 20 字");
    } finally {
      hob.close();
    }
  });
});

describe("memories.json 迁移", () => {
  it("启动时把每条记忆追加成补充说明的一行，然后删掉文件", async () => {
    const { createRuntime } = await import("../src/runtime.ts");
    const home = mkdtempSync(join(tmpdir(), "hob-migrate-"));
    const dir = join(home, "assistants", "hob");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "profile.json"),
      JSON.stringify({
        id: "hob",
        name: "Hob",
        duty: "主助手",
        sprite: "hob",
        primary: true,
        pinned: true,
        hidden: false,
        notify: true,
        createdAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(dir, "memories.json"),
      JSON.stringify([
        { id: "m-1", text: "标题不超过 20 字", createdAt: new Date().toISOString() },
        { id: "m-2", text: "不看融资新闻", createdAt: new Date().toISOString() },
      ]),
    );
    // 老草稿：memories 字段（前端按 instructions 渲染，不迁移会白屏）
    mkdirSync(join(home, "assistants", "hob"), { recursive: true });
    writeFileSync(
      join(home, "assistants", "hob", "drafts.json"),
      JSON.stringify([
        { id: "d-1", name: "写作", askFirst: [], memories: ["口语、短句"], carry: { conversations: 3, memories: 1 } },
      ]),
    );
    const pi = new PiHost({ engineDir: join(home, "system", "engine"), modelsPath: null, nativeProviders: [] });
    const runtime = createRuntime({
      home,
      config: {
        passwordHash: "x",
        cookieSecret: "y",
        host: "127.0.0.1",
        port: 0,
      },
      pi,
    });
    try {
      expect(runtime.store.assistant("hob")?.instructions).toBe("标题不超过 20 字\n不看融资新闻");
      expect(() => statSync(join(dir, "memories.json"))).toThrow();
      const draft = runtime.store.draft("d-1") as unknown as Record<string, unknown>;
      expect(draft.instructions).toEqual(["口语、短句"]);
      expect(draft.memories).toBeUndefined();
      expect(draft.carry).toEqual({ conversations: 3 });
    } finally {
      runtime.router.disposeAll();
    }
  });
});

describe("note 文案", () => {
  it("取首个非空行，去掉末尾冒号，超过 80 个字符截断", () => {
    expect(memoryNoteText({ content: "\n  不看融资新闻： \n第二行" })).toBe("不看融资新闻");
    expect(memoryNoteText({ content: "标题:，" })).toBe("标题");
    expect(memoryNoteText({ content: "🙂".repeat(81) })).toBe(`${"🙂".repeat(80)}…`);
    expect(memoryNoteText({ uri: "core://x" })).toBeUndefined();
  });
});

describe("切换提供者", () => {
  it("空闲的 Router 立刻释放，下一轮按新提供者打开", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([text("在。")]);
      await hob.runtime.router.send("hob", { text: "在吗" });
      await hob.runtime.router.waitIdle("hob");
      const routers = (hob.runtime.router as unknown as { routers: Map<string, { session?: unknown }> }).routers;
      expect(routers.get("hob")?.session).toBeDefined();

      hob.runtime.settings.setMemoryProvider(hob.runtime.settings.get().revision, "off");
      hob.runtime.router.releaseSessions();
      expect(routers.get("hob")?.session).toBeUndefined();

      hob.faux.setResponses([text("还在。")]);
      await hob.runtime.router.send("hob", { text: "还在吗" });
      await hob.runtime.router.waitIdle("hob");
      expect(routers.get("hob")?.session).toBeDefined();
    } finally {
      hob.close();
    }
  });

  it("正在回复的等这一轮跑完再释放", async () => {
    const hob = makeHob();
    try {
      const slow = async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return text("慢回复");
      };
      hob.faux.setResponses([slow]);
      await hob.runtime.router.send("hob", { text: "说句话" });
      const routers = (hob.runtime.router as unknown as { routers: Map<string, { session?: unknown }> }).routers;
      hob.runtime.settings.setMemoryProvider(hob.runtime.settings.get().revision, "off");
      hob.runtime.router.releaseSessions();
      expect(routers.get("hob")?.session).toBeDefined();
      await hob.runtime.router.waitIdle("hob", 20_000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((routers.get("hob") as { session?: unknown } | undefined)?.session).toBeUndefined();
    } finally {
      hob.close();
    }
  });
});

describe("HTTP 接口", () => {
  async function signedIn(hob: ReturnType<typeof makeHob>) {
    const app = createApp(hob.runtime, { home: hob.home });
    const response = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test" }),
    });
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { app, cookie };
  }

  it("GET /api/memory 给提供者、是否显式、Lore 连接（不带 Token）", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await signedIn(hob);
      const got = (await (await app.request("/api/memory", { headers: { cookie } })).json()) as Record<string, unknown>;
      expect(got).toMatchObject({ provider: "local", providerExplicit: false });
      expect(got.lore).toMatchObject({ configured: false, baseUrl: null, source: "none" });
    } finally {
      hob.close();
    }
  });

  it("PUT /api/memory：选 Lore 但没配好 → 400；revision 不对 → 409；正常切换 → 200", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await signedIn(hob);
      const put = (body: unknown) =>
        app.request("/api/memory", {
          method: "PUT",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });
      const revision = hob.runtime.settings.get().revision;
      const failClosed = await put({ revision, provider: "lore" });
      expect(failClosed.status).toBe(400);
      expect(((await failClosed.json()) as { error: string }).error).toContain("Lore 尚未配置完成");

      const ok = await put({ revision, provider: "off" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ provider: "off", providerExplicit: true });

      const stale = await put({ revision, provider: "local" });
      expect(stale.status).toBe(409);
    } finally {
      hob.close();
    }
  });

  it("PUT /api/memory/lore 写 0600 的文件，返回里不回显 Token", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await signedIn(hob);
      const saved = await app.request("/api/memory/lore", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ baseUrl: "http://127.0.0.1:18901", token: "lm_top" }),
      });
      expect(saved.status).toBe(200);
      const body = (await saved.json()) as { lore: { configured: boolean } };
      expect(body.lore.configured).toBe(true);
      expect(JSON.stringify(body)).not.toContain("lm_top");
      expect(JSON.parse(readFileSync(loreConfigFile(hob.home), "utf8"))).toMatchObject({ api_token: "lm_top" });
    } finally {
      hob.close();
    }
  });

  it("POST /api/memory/lore-test 失败也是 200，带原因", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await signedIn(hob);
      const response = await app.request("/api/memory/lore-test", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ baseUrl: "http://api.loremem.com", token: "lm_x" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false, reason: "insecure_http" });
    } finally {
      hob.close();
    }
  });
});
