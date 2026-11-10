import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveredModels, ModelsView, ProvidersView, SettingsFile } from "../../shared/types.ts";
import type { HobConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { hashPassword } from "../src/password.ts";
import { PiHost } from "../src/pi.ts";
import { createRuntime } from "../src/runtime.ts";
import { makeHob } from "./helpers.ts";

const CUSTOM = {
  kind: "custom",
  name: "我的代理",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:8080/v1/",
  models: [{ id: "gpt-x", name: "GPT X", input: ["text", "image"], reasoning: true, contextWindow: 64_000 }],
};

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

describe("服务商", () => {
  it("一开始没有服务商，内置服务商目录来自引擎；Key 只报配没配、从不回显", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const view = (await (await app.request("/api/providers", { headers: { cookie } })).json()) as ProvidersView;
      expect(view.providers).toEqual([]);
      expect(view.builtin.map((provider) => provider.id)).toContain("anthropic");
      expect(view.builtin.map((provider) => provider.id)).toContain("openai");

      // 内置服务商只填 Key：Key 落 secrets.json，响应和列表里都没有它
      const put = await app.request("/api/providers/deepseek", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ kind: "builtin", key: "sk-deepseek-secret" }),
      });
      expect(put.status).toBe(200);
      const raw = await put.text();
      expect(raw).not.toContain("sk-deepseek-secret");
      const saved = JSON.parse(raw) as ProvidersView;
      expect(saved.providers).toMatchObject([{ kind: "builtin", id: "deepseek", keyConfigured: true }]);

      const secrets = join(hob.home, "system", "secrets.json");
      expect(readFileSync(secrets, "utf8")).toContain("provider:deepseek");
      // Key 套进了引擎：这个服务商的模型现在可用
      const models = await hob.runtime.models.get();
      expect(models.some((model) => model.provider === "deepseek")).toBe(true);

      // 留空沿用已存的 Key
      const again = (await (
        await app.request("/api/providers/deepseek", {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ kind: "builtin" }),
        })
      ).json()) as ProvidersView;
      expect(again.providers[0].keyConfigured).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("兼容接口：注册进引擎，模型能进名单；删掉之后名单里的模型标不可用、名单不连带删", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = await app.request("/api/providers/my-proxy", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ...CUSTOM, key: "sk-proxy" }),
      });
      expect(put.status).toBe(200);
      const view = (await put.json()) as ProvidersView;
      expect(view.providers).toMatchObject([
        {
          kind: "custom",
          id: "my-proxy",
          name: "我的代理",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:8080/v1",
          keyConfigured: true,
        },
      ]);

      // 引擎里已经有这个服务商和它的模型
      const runtime = await hob.runtime.pi.runtime();
      expect(runtime.getModels("my-proxy").map((model) => model.id)).toEqual(["gpt-x"]);
      expect(runtime.getModel("my-proxy", "gpt-x")).toMatchObject({ name: "GPT X", reasoning: true, contextWindow: 64_000 });

      const models = (await (await app.request("/api/models", { headers: { cookie } })).json()) as ModelsView;
      expect(models.models.map((model) => model.ref)).toContain("my-proxy/gpt-x");

      // 把它加进名单
      const { revision } = hob.runtime.settings.get();
      const patch = await app.request("/api/settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          revision,
          patch: { models: { roster: [...hob.runtime.settings.settings.models.roster, { ref: "my-proxy/gpt-x", note: "" }] } },
        }),
      });
      expect(patch.status).toBe(200);

      // 删掉服务商：Key 一起没了，名单里的模型变不可用但还在
      const removed = await app.request("/api/providers/my-proxy", { method: "DELETE", headers: { cookie } });
      expect(removed.status).toBe(200);
      expect(runtime.getModels("my-proxy")).toEqual([]);
      expect(readFileSync(join(hob.home, "system", "secrets.json"), "utf8")).not.toContain("sk-proxy");

      const after = (await (await app.request("/api/models", { headers: { cookie } })).json()) as ModelsView;
      expect(after.roster.map((entry) => entry.ref)).toEqual(["hob-faux/faux-1", "my-proxy/gpt-x"]);
      expect(after.roster[1]).toMatchObject({ ref: "my-proxy/gpt-x", unavailable: true });

      // 再删一次：没有这个服务商
      expect((await app.request("/api/providers/my-proxy", { method: "DELETE", headers: { cookie } })).status).toBe(404);
    } finally {
      hob.close();
    }
  });

  it("改已有的服务商原地替换，列表顺序不变", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = (id: string, name: string) =>
        app.request(`/api/providers/${id}`, {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ ...CUSTOM, name }),
        });
      await put("a-proxy", "甲");
      await put("b-proxy", "乙");
      const view = (await (await put("a-proxy", "甲改")).json()) as ProvidersView;
      expect(view.providers.map((provider) => provider.id)).toEqual(["a-proxy", "b-proxy"]);
      expect(view.providers[0]).toMatchObject({ name: "甲改" });
    } finally {
      hob.close();
    }
  });

  it("没填 id / 地址 / 模型的服务商给出具体原因", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = async (id: string, body: unknown) =>
        (await (
          await app.request(`/api/providers/${id}`, {
            method: "PUT",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).json()) as { error?: string };

      expect((await put("Bad Id", { kind: "builtin" })).error).toContain("服务商标识无效");
      expect((await put("x", { kind: "custom", name: "", api: "openai-completions", baseUrl: "http://a/v1", models: [] })).error).toContain(
        "兼容接口名称",
      );
      expect(
        (await put("x", { kind: "custom", name: "代理", api: "nope", baseUrl: "http://a/v1", models: [{ id: "m" }] })).error,
      ).toContain("协议");
      expect(
        (await put("x", { kind: "custom", name: "代理", api: "openai-completions", baseUrl: "不是地址", models: [{ id: "m" }] }))
          .error,
      ).toContain("服务地址");
      expect(
        (await put("x", { kind: "custom", name: "代理", api: "openai-completions", baseUrl: "http://a/v1", models: [] })).error,
      ).toContain("至少需要一个模型");
      expect(hob.runtime.settings.settings.providers).toEqual([]);
    } finally {
      hob.close();
    }
  });
});

describe("拉模型列表", () => {
  it("OpenAI 系打 /models，Anthropic 系打 /v1/models；没带 Key 就用已存的", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const body = url.includes("/v1/v1/models")
        ? { data: [{ id: "claude-x", display_name: "Claude X" }] }
        : { data: [{ id: "gpt-x" }, { id: "gpt-y", name: "GPT Y" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const hob = makeHob({}, { fetchImpl });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      await app.request("/api/providers/my-proxy", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ...CUSTOM, key: "sk-proxy" }),
      });
      const discover = async (body: unknown) => {
        const response = await app.request("/api/providers/discover", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as DiscoveredModels & { error?: string } };
      };

      const openai = await discover({ api: "openai-completions", baseUrl: "http://127.0.0.1:8080/v1", id: "my-proxy" });
      expect(openai.status).toBe(200);
      expect(openai.body.models).toEqual([{ id: "gpt-x" }, { id: "gpt-y", name: "GPT Y" }]);
      expect(calls[0].url).toBe("http://127.0.0.1:8080/v1/models");
      expect(calls[0].headers.authorization).toBe("Bearer sk-proxy");

      const anthropic = await discover({
        api: "anthropic-messages",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "sk-ant",
      });
      expect(anthropic.body.models).toEqual([{ id: "claude-x", name: "Claude X" }]);
      expect(calls[1].url).toBe("http://127.0.0.1:8080/v1/v1/models");
      expect(calls[1].headers["x-api-key"]).toBe("sk-ant");
    } finally {
      hob.close();
    }
  });

  it("连不上 / Key 被拒 / 不支持获取模型列表：各给具体原因", async () => {
    const statuses: Record<string, number> = {
      "http://127.0.0.1:1/v1": 0,
      "http://deny.test/v1": 401,
      "http://old.test/v1": 404,
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const status = statuses[`${url.protocol}//${url.host}${url.pathname.replace(/\/models$/, "")}`] ?? 500;
      if (status === 0) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status });
    }) as typeof fetch;
    const hob = makeHob({}, { fetchImpl });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const discover = async (body: unknown) =>
        (await (
          await app.request("/api/providers/discover", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).json()) as { error?: string };

      expect(
        (await discover({ api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk" })).error,
      ).toContain("无法连接 http://127.0.0.1:1/v1");
      expect(
        (await discover({ api: "openai-completions", baseUrl: "http://deny.test/v1", apiKey: "sk" })).error,
      ).toContain("拒绝该 API Key（401）：invalid api key");
      expect((await discover({ api: "openai-completions", baseUrl: "http://old.test/v1", apiKey: "sk" })).error).toContain(
        "未提供模型列表接口（404）",
      );
      // 未填写 API Key
      expect((await discover({ api: "openai-completions", baseUrl: "http://g.test/v1" })).error).toContain(
        "尚未填写 API Key",
      );
    } finally {
      hob.close();
    }
  });
});

describe("连接测试", () => {
  it("Google 使用专用认证获取模型，失败不保存凭据", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-test", displayName: "Gemini" }] }), { status: 200 });
    }) as typeof fetch;
    const hob = makeHob({}, { fetchImpl });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const response = await app.request("/api/providers/test", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ kind: "custom", api: "google-generative-ai", baseUrl: "https://example.test/v1beta", apiKey: "secret" }) });
      expect(response.status).toBe(200);
      expect(calls[0]).toEqual({ url: "https://example.test/v1beta/models", headers: { "x-goog-api-key": "secret" } });
      expect(hob.runtime.settings.settings.providers).toEqual([]);
      expect(await response.text()).not.toContain("secret");
    } finally { hob.close(); }
  });
  it("内置服务商发起模型测试并隐藏失败中的密钥", async () => {
    const hob = makeHob();
    try {
      const runtime = await hob.runtime.pi.runtime();
      const complete = vi.spyOn(runtime, "completeSimple")
        .mockRejectedValueOnce(new Error("拒绝 sk-private"))
        .mockResolvedValueOnce({ stopReason: "stop" } as never);
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const response = await app.request("/api/providers/test", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ kind: "builtin", id: "openai", apiKey: "sk-private" }) });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("sk-private");
      expect(complete).toHaveBeenCalledOnce();
      const success = await app.request("/api/providers/test", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ kind: "builtin", id: "openai", apiKey: "sk-private" }) });
      expect(success.status).toBe(200);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(hob.runtime.settings.settings.providers).toEqual([]);
    } finally { hob.close(); }
  });
});

describe("没有服务商", () => {
  it("没有服务商时列表为空，助手回复时给出一条配置指引，不报错", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-nomodel-"));
    try {
      const config: HobConfig = { passwordHash: hashPassword("test"), cookieSecret: "y", host: "127.0.0.1", port: 0 };
      const runtime = createRuntime({ home, config, pi: new PiHost({ engineDir: join(home, "system", "engine") }) });
      try {
        const app = createApp(runtime, { home });
        const cookie = await signIn(app);
        const models = (await (await app.request("/api/models", { headers: { cookie } })).json()) as ModelsView;
        expect(models.models).toEqual([]);
        expect(models.roster).toEqual([]);

        const send = await app.request("/api/assistants/hob/messages", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ text: "在吗" }),
        });
        expect(send.status).toBe(202);
        const items = runtime.router.items("hob").items;
        expect(items.map((item) => item.kind)).toEqual(["user", "note"]);
        expect(items[1]).toMatchObject({
          kind: "note",
          icon: "info",
          text: "尚未配置模型。请在「设置 → 服务商」中添加服务商，再到「设置 → 模型」选择模型",
        });
      } finally {
        runtime.router.disposeAll();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("引擎目录", () => {
  it("凭据和资源放 HOB_HOME/engine，本地记忆在 HOB_HOME/memory", () => {
    const home = mkdtempSync(join(tmpdir(), "hob-engine-"));
    const saved = process.env.PI_MEMORY_DIR;
    delete process.env.PI_MEMORY_DIR;
    try {
      const config: HobConfig = { passwordHash: hashPassword("test"), cookieSecret: "y", host: "127.0.0.1", port: 0 };
      const pi = new PiHost({ engineDir: join(home, "system", "engine") });
      const runtime = createRuntime({ home, config, pi });
      expect(pi.engineDir).toBe(join(home, "system", "engine"));
      expect(process.env.PI_MEMORY_DIR).toBe(join(home, "system", "memory"));
      runtime.router.disposeAll();
      // 设置里的服务商套进引擎之后凭据也写在 engine 里
      expect(runtime.settings.get() as SettingsFile).toBeTruthy();
    } finally {
      if (saved === undefined) delete process.env.PI_MEMORY_DIR;
      else process.env.PI_MEMORY_DIR = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
