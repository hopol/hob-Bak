import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { listProviderImports } from "../src/imports.ts";
import { PROVIDER_APIS } from "../src/providers.ts";
import type { ProviderImportView, ProvidersView } from "../../shared/types.ts";
import { makeHob } from "./helpers.ts";

/** 假的「本机配置」里用到的环境变量：值是 Key，名字写进 models.json 的 apiKey。 */
const KEY_ENV_NAME = "HOB_IMPORT_TEST_KEY";
const KEY_ENV_VALUE = "sk-env-value";

/** 假的「本机配置」：一个引擎目录 + 一个 Lore 目录，内容都是测试造的。 */
function fixture() {
  const piDir = mkdtempSync(join(tmpdir(), "hob-local-pi-"));
  const loreHome = mkdtempSync(join(tmpdir(), "hob-local-lore-"));
  writeFileSync(
    join(piDir, "models.json"),
    JSON.stringify({
      providers: {
        "my-proxy": {
          name: "我的代理",
          api: "openai-completions",
          baseUrl: "https://proxy.example/v1",
          apiKey: "sk-literal",
          compat: { supportsDeveloperRole: false },
          headers: { "x-org": "hob" },
          authHeader: true,
          models: [
            {
              id: "gpt-x",
              name: "GPT X",
              input: ["text", "image"],
              reasoning: true,
              contextWindow: 200_000,
              maxTokens: 32_000,
              compat: { supportsReasoningEffort: false },
              thinkingLevelMap: { medium: "high", xhigh: "xhigh", max: "max" },
              cost: { input: 1, output: 2 },
            },
          ],
        },
        "env-proxy": {
          api: "anthropic-messages",
          baseUrl: "http://127.0.0.1:8080",
          apiKey: `$${KEY_ENV_NAME}`,
          models: [{ id: "claude-x" }],
        },
        "cmd-proxy": {
          api: "openai-completions",
          baseUrl: "https://cmd.example/v1",
          apiKey: "!op read op://hob/key",
          models: [{ id: "m1" }],
        },
        "broken-proxy": {
          api: "openai-completions",
          baseUrl: "https://broken.example/v1",
          models: [],
        },
      },
    }),
  );
  writeFileSync(
    join(piDir, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: "sk-ant-literal" },
      openai: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: 1 },
      "not-a-provider": { type: "api_key", key: "sk-nope" },
    }),
  );
  writeFileSync(join(loreHome, "config.json"), JSON.stringify({ base_url: "http://127.0.0.1:18901", api_token: "lm_local" }));
  return { piDir, loreHome };
}

async function withLocalConfig<T>(dirs: { piDir: string; loreHome: string }, run: () => Promise<T>): Promise<T> {
  const before = { piDir: process.env.HOB_LOCAL_PI_DIR, loreHome: process.env.HOB_LOCAL_LORE_HOME };
  process.env.HOB_LOCAL_PI_DIR = dirs.piDir;
  process.env.HOB_LOCAL_LORE_HOME = dirs.loreHome;
  process.env[KEY_ENV_NAME] = KEY_ENV_VALUE;
  try {
    return await run();
  } finally {
    for (const [key, value] of [
      ["HOB_LOCAL_PI_DIR", before.piDir],
      ["HOB_LOCAL_LORE_HOME", before.loreHome],
      [KEY_ENV_NAME, undefined],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function signedIn(hob: ReturnType<typeof makeHob>) {
  const app = createApp(hob.runtime, { home: hob.home });
  const response = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(response.status).toBe(200);
  return { app, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

describe("服务商：列出本机能导入的配置", () => {
  it("字段映射、三种 Key、oauth 不可选、引擎不认识的内置服务商不列出", async () => {
    const dirs = fixture();
    const hob = makeHob();
    try {
      const view = await withLocalConfig(dirs, async () => {
        const { app, cookie } = await signedIn(hob);
        const response = await app.request("/api/providers/import", { headers: { cookie } });
        expect(response.status).toBe(200);
        const text = await response.text();
        // 接口返回值里没有 Key 明文
        expect(text).not.toContain("sk-literal");
        expect(text).not.toContain(KEY_ENV_VALUE);
        expect(text).not.toContain("sk-ant-literal");
        return JSON.parse(text) as ProviderImportView;
      });

      expect(view.source).toBe(dirs.piDir);
      const byId = new Map(view.items.map((item) => [item.id, item]));
      expect(byId.get("my-proxy")).toMatchObject({
        kind: "custom",
        api: "openai-completions",
        baseUrl: "https://proxy.example/v1",
        models: 1,
        key: "literal",
        exists: false,
        selectable: true,
      });
      expect(byId.get("my-proxy")?.note).toBeUndefined();
      expect(byId.get("env-proxy")).toMatchObject({ kind: "custom", key: "env", selectable: true });
      // 命令不执行，导入后自己填
      expect(byId.get("cmd-proxy")).toMatchObject({ kind: "custom", key: "command", selectable: true });
      expect(byId.get("cmd-proxy")?.note).toContain("命令");
      // 没有模型列表：列出来但不可选
      expect(byId.get("broken-proxy")).toMatchObject({ models: 0, selectable: false });
      expect(byId.get("broken-proxy")?.note).toContain("模型");
      // auth.json：api_key 可以导入，oauth 列出来但不可选
      expect(byId.get("anthropic")).toMatchObject({ kind: "builtin", key: "literal", selectable: true });
      expect(byId.get("openai")).toMatchObject({ kind: "builtin", selectable: false });
      expect(byId.get("openai")?.note).toBe("登录授权类凭据无法导入。");
      // 引擎不认识的服务商 id 不列
      expect(byId.has("not-a-provider")).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("没有 models.json / auth.json 就是空列表，来源目录照给", async () => {
    const empty = mkdtempSync(join(tmpdir(), "hob-local-empty-"));
    const hob = makeHob();
    try {
      const view = await withLocalConfig({ piDir: empty, loreHome: empty }, async () => {
        const { app, cookie } = await signedIn(hob);
        return (await (await app.request("/api/providers/import", { headers: { cookie } })).json()) as ProviderImportView;
      });
      expect(view).toEqual({ source: empty, items: [] });
    } finally {
      hob.close();
    }
  });
});

describe("服务商：导入", () => {
  it("本机的思考档：写明的键原样进来，没写的不补字符串", () => {
    const piDir = mkdtempSync(join(tmpdir(), "hob-local-thinking-"));
    writeFileSync(
      join(piDir, "models.json"),
      JSON.stringify({
        providers: {
          p: {
            api: "openai-responses",
            baseUrl: "https://p.example/v1",
            models: [{ id: "gpt-x", reasoning: true, thinkingLevelMap: { minimal: null, max: "max" } }],
          },
        },
      }),
    );
    try {
      const candidates = listProviderImports({
        source: piDir,
        existing: new Set(),
        builtinIds: new Set(),
        apis: PROVIDER_APIS,
      });
      expect(candidates[0]?.thinking?.["p/gpt-x"]).toEqual({ minimal: null, max: "max" });
    } finally {
      rmSync(piDir, { recursive: true, force: true });
    }
  });

  it("服务商级和模型级字段原样透传给引擎，Key 进 secrets.json", async () => {
    const dirs = fixture();
    const hob = makeHob();
    try {
      const view = await withLocalConfig(dirs, async () => {
        const { app, cookie } = await signedIn(hob);
        const response = await app.request("/api/providers/import", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ ids: ["my-proxy", "env-proxy", "cmd-proxy", "anthropic"] }),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain("sk-literal");
        expect(text).not.toContain("sk-ant-literal");
        return JSON.parse(text) as ProvidersView;
      });

      const mine = view.providers.find((provider) => provider.id === "my-proxy");
      // 服务商用 id 作显示名（和本机那份的 name 无关）
      expect(mine).toMatchObject({ kind: "custom", name: "my-proxy", keyConfigured: true });
      if (mine?.kind !== "custom") throw new Error("导入的不是兼容接口");
      // 服务商级字段进 extra，模型级字段进模型的 extra
      expect(mine.extra).toEqual({ compat: { supportsDeveloperRole: false }, headers: { "x-org": "hob" }, authHeader: true });
      expect(mine.models[0]).toMatchObject({
        id: "gpt-x",
        name: "GPT X",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 32_000,
      });
      expect(mine.models[0]?.extra).toEqual({
        compat: { supportsReasoningEffort: false },
        cost: { input: 1, output: 2 },
      });
      // 本机那份的 thinkingLevelMap 在导入那一刻复制进 Hob 的自定义思考档，不进 extra
      // （只带本机写明的键；没写的档按 Hob 的默认规则算，不拿档名去补）
      expect(view.settings.settings.models.thinking?.["my-proxy/gpt-x"]).toEqual({
        medium: "high",
        xhigh: "xhigh",
        max: "max",
      });
      // 本机写了 max，gpt 模型这一档也就有了；没写的 off…high 按默认范围
      expect((await hob.runtime.models.get()).find((model) => model.ref === "my-proxy/gpt-x")?.thinkingLevels).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      // 引擎拿到的是稀疏映射：没改的 off…high 都不写
      expect((await hob.runtime.pi.model("my-proxy/gpt-x")).thinkingLevelMap).toEqual({
        medium: "high",
        xhigh: "xhigh",
        max: "max",
      });

      const secrets = JSON.parse(readFileSync(join(hob.home, "system", "secrets.json"), "utf8")) as Record<string, string>;
      expect(secrets["provider:my-proxy"]).toBe("sk-literal");
      expect(secrets["provider:env-proxy"]).toBe(KEY_ENV_VALUE);
      expect(secrets["provider:anthropic"]).toBe("sk-ant-literal");
      // 命令形式的 Key 不执行、也不写
      expect(secrets["provider:cmd-proxy"]).toBeUndefined();

      // 套进引擎：导入的模型能用了
      const models = await hob.runtime.models.get();
      expect(models.map((model) => model.ref)).toContain("my-proxy/gpt-x");
    } finally {
      hob.close();
    }
  });

  it("同 id 覆盖已有的服务商；来源文件的内容和时间戳不变", async () => {
    const dirs = fixture();
    const modelsPath = join(dirs.piDir, "models.json");
    const authPath = join(dirs.piDir, "auth.json");
    const modelsBefore = readFileSync(modelsPath, "utf8");
    const authBefore = readFileSync(authPath, "utf8");
    const modelsStat = statSync(modelsPath);
    const authStat = statSync(authPath);
    const hob = makeHob();
    try {
      const { app, cookie } = await signedIn(hob);
      // 先自己配一个同 id 的服务商
      const put = await app.request("/api/providers/my-proxy", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          kind: "custom",
          name: "旧代理",
          api: "openai-completions",
          baseUrl: "https://old.example/v1",
          models: [{ id: "old-model" }],
          key: "sk-old",
        }),
      });
      expect(put.status).toBe(200);

      await withLocalConfig(dirs, async () => {
        const listing = (await (
          await app.request("/api/providers/import", { headers: { cookie } })
        ).json()) as ProviderImportView;
        expect(listing.items.find((item) => item.id === "my-proxy")?.exists).toBe(true);
        const response = await app.request("/api/providers/import", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ ids: ["my-proxy"] }),
        });
        expect(response.status).toBe(200);
      });

      const settings = hob.runtime.settings.settings.providers;
      expect(settings).toHaveLength(1);
      const mine = settings[0];
      if (mine?.kind !== "custom") throw new Error("导入的不是兼容接口");
      expect(mine.name).toBe("my-proxy");
      expect(mine.baseUrl).toBe("https://proxy.example/v1");
      expect(mine.models.map((model) => model.id)).toEqual(["gpt-x"]);
      const secrets = JSON.parse(readFileSync(join(hob.home, "system", "secrets.json"), "utf8")) as Record<string, string>;
      expect(secrets["provider:my-proxy"]).toBe("sk-literal");

      // 只读来源：内容和 mtime 都没变
      expect(readFileSync(modelsPath, "utf8")).toBe(modelsBefore);
      expect(readFileSync(authPath, "utf8")).toBe(authBefore);
      expect(statSync(modelsPath).mtimeMs).toBe(modelsStat.mtimeMs);
      expect(statSync(authPath).mtimeMs).toBe(authStat.mtimeMs);
    } finally {
      hob.close();
    }
  });

  it("没选或者选中的都不可导入 → 400", async () => {
    const dirs = fixture();
    const hob = makeHob();
    try {
      const { app, cookie } = await signedIn(hob);
      const post = (body: unknown) =>
        app.request("/api/providers/import", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });
      expect((await post({ ids: [] })).status).toBe(400);
      await withLocalConfig(dirs, async () => {
        const empty = await post({ ids: [] });
        expect(empty.status).toBe(400);
        const blocked = await post({ ids: ["broken-proxy", "openai"] });
        expect(blocked.status).toBe(400);
        expect(((await blocked.json()) as { error: string }).error).toContain("没有可导入");
      });
    } finally {
      hob.close();
    }
  });
});

describe("Lore 连接：从本机导入", () => {
  it("GET 只报来源和有没有 Token；POST 写进 HOB_HOME/lore/config.json", async () => {
    const dirs = fixture();
    const localPath = join(dirs.loreHome, "config.json");
    const before = readFileSync(localPath, "utf8");
    const stat = statSync(localPath);
    const hob = makeHob();
    try {
      const { app, cookie } = await signedIn(hob);
      const listed = await withLocalConfig(dirs, async () => {
        const response = await app.request("/api/memory/lore/import", { headers: { cookie } });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain("lm_local");
        return JSON.parse(text) as Record<string, unknown>;
      });
      expect(listed).toEqual({
        source: dirs.loreHome,
        found: true,
        baseUrl: "http://127.0.0.1:18901",
        tokenPresent: true,
      });

      const saved = await withLocalConfig(dirs, async () => {
        const response = await app.request("/api/memory/lore/import", {
          method: "POST",
          headers: { cookie },
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain("lm_local");
        return JSON.parse(text) as { lore: Record<string, unknown> };
      });
      expect(saved.lore).toMatchObject({ configured: true, baseUrl: "http://127.0.0.1:18901", tokenConfigured: true });

      const own = JSON.parse(readFileSync(join(hob.home, "system", "lore", "config.json"), "utf8")) as Record<string, unknown>;
      expect(own).toEqual({ base_url: "http://127.0.0.1:18901", api_token: "lm_local" });
      expect(statSync(join(hob.home, "system", "lore", "config.json")).mode & 0o777).toBe(0o600);

      // 本机那份不动
      expect(readFileSync(localPath, "utf8")).toBe(before);
      expect(statSync(localPath).mtimeMs).toBe(stat.mtimeMs);
    } finally {
      hob.close();
    }
  });

  it("本机没有 Lore 配置 → found=false，导入 400", async () => {
    const empty = mkdtempSync(join(tmpdir(), "hob-local-empty-"));
    const hob = makeHob();
    try {
      const { app, cookie } = await signedIn(hob);
      await withLocalConfig({ piDir: empty, loreHome: empty }, async () => {
        const listed = (await (await app.request("/api/memory/lore/import", { headers: { cookie } })).json()) as Record<
          string,
          unknown
        >;
        expect(listed).toEqual({ source: empty, found: false, tokenPresent: false });
        const response = await app.request("/api/memory/lore/import", { method: "POST", headers: { cookie } });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toContain("未找到可导入的配置");
      });
    } finally {
      hob.close();
    }
  });
});
