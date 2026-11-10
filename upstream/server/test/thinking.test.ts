// 思考档：默认规则、自定义档位的编辑接口（兼容接口 + 内置服务商）、运行时只读 HOB_HOME。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ModelThinkingSaved, ModelsView, ProvidersView, ThinkingLevelMapSetting } from "../../shared/types.ts";
import { thinkingPlan } from "../../shared/thinking.ts";
import { createApp } from "../src/http.ts";
import { providerKeyName } from "../src/providers.ts";
import { writeSecret } from "../src/secrets.ts";
import { makeHob } from "./helpers.ts";

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

/** 一个兼容接口服务商（DeepSeek 那种）：OpenAI 兼容协议，会推理；再带一个 gpt 的模型对比默认范围。 */
function customProvider() {
  return {
    kind: "custom" as const,
    id: "ds",
    name: "DeepSeek",
    api: "openai-responses" as const,
    baseUrl: "https://api.example/v1",
    models: [
      { id: "deepseek-chat", reasoning: true },
      { id: "gpt-x", reasoning: true },
    ],
  };
}

describe("思考档：默认规则", () => {
  it("推理模型默认 off…max：写给引擎的只有 xhigh / max 两个开启项，其它档交给协议默认", () => {
    const plan = thinkingPlan("deepseek-chat", true);
    expect(plan.levels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(plan.map).toEqual({ xhigh: "xhigh", max: "max" });
    // 没改过的档字符是空：界面显示「默认」
    expect(plan.chars).toEqual({ off: "", minimal: "", low: "", medium: "", high: "", xhigh: "", max: "" });
  });

  it("模型 id 含 gpt（不分大小写）的只到 xhigh；不推理的只有 off", () => {
    const gpt = thinkingPlan("GPT-5.6-sol", true);
    expect(gpt.levels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(gpt.map).toEqual({ xhigh: "xhigh", max: null });
    expect(thinkingPlan("my-gpt-mini", true).map.max).toBeNull();
    const plain = thinkingPlan("deepseek-chat", false);
    expect(plain.levels).toEqual(["off"]);
    expect(plain.map).toEqual({});
  });

  it("Google 那套只有 low…high：xhigh / max 按 high 开，不写会抛错的档名", () => {
    const plan = thinkingPlan("gemini-4-pro", true, undefined, "google-generative-ai");
    expect(plan.levels).toContain("max");
    expect(plan.map).toEqual({ xhigh: "high", max: "high" });
  });

  it("GET /api/models 用 Hob 的规则算档，引擎注册表里自带的映射不用", async () => {
    const hob = makeHob(
      {},
      {
        models: [{ id: "smart", reasoning: true, thinkingLevelMap: { medium: null, xhigh: null, max: null } }],
      },
    );
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const view = (await (await app.request("/api/models", { headers: { cookie } })).json()) as ModelsView;
      expect(view.models.find((model) => model.ref === "hob-faux/smart")?.thinkingLevels).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    } finally {
      hob.close();
    }
  });

  it("存了自定义档位就按自定义，不再叠加默认范围", async () => {
    const hob = makeHob(
      {},
      {
        models: [{ id: "smart", reasoning: true }],
        settings: {
          models: {
            thinking: {
              "hob-faux/smart": {
                off: "",
                minimal: null,
                low: "",
                medium: null,
                high: "",
                xhigh: null,
                max: null,
              },
            },
          },
        },
      },
    );
    try {
      const models = await hob.runtime.models.get();
      expect(models.find((model) => model.ref === "hob-faux/smart")?.thinkingLevels).toEqual(["off", "low", "high"]);
    } finally {
      hob.close();
    }
  });
});

describe("思考档：写给引擎的映射只放必要的键", () => {
  it("没改过的推理模型只有 xhigh / max；gpt 模型的 max 写 null", async () => {
    const hob = makeHob({}, { providers: [customProvider()] });
    try {
      const deep = await hob.runtime.pi.model("ds/deepseek-chat");
      expect(deep.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
      // off、minimal…high 不写：写了就会被引擎原样发出去
      for (const level of ["off", "minimal", "low", "medium", "high"] as const) {
        expect(deep.thinkingLevelMap).not.toHaveProperty(level);
      }
      expect(getSupportedThinkingLevels(deep)).toHaveLength(7);

      const gpt = await hob.runtime.pi.model("ds/gpt-x");
      expect(gpt.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: null });
      expect(getSupportedThinkingLevels(gpt)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    } finally {
      hob.close();
    }
  });

  it("用户改了 medium 才出现 medium，其它档仍然不写", async () => {
    const hob = makeHob({}, { providers: [customProvider()] });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = await app.request("/api/models/thinking", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          ref: "ds/deepseek-chat",
          levels: { off: "", minimal: "", low: "", medium: "high", high: "", xhigh: "", max: "" },
        }),
      });
      expect(put.status).toBe(200);
      const model = await hob.runtime.pi.model("ds/deepseek-chat");
      expect(model.thinkingLevelMap).toEqual({ medium: "high", xhigh: "xhigh", max: "max" });
    } finally {
      hob.close();
    }
  });

  it("Google 协议：默认的 xhigh / max 按 high 开", async () => {
    const hob = makeHob(
      {},
      {
        providers: [
          {
            kind: "custom" as const,
            id: "gem",
            name: "Gemini",
            api: "google-generative-ai" as const,
            baseUrl: "https://g.example",
            models: [{ id: "gemini-4-pro", reasoning: true }],
          },
        ],
      },
    );
    try {
      const model = await hob.runtime.pi.model("gem/gemini-4-pro");
      expect(model.thinkingLevelMap).toEqual({ xhigh: "high", max: "high" });
      expect(getSupportedThinkingLevels(model)).toHaveLength(7);
    } finally {
      hob.close();
    }
  });
});

describe("思考档：编辑接口", () => {
  it("兼容接口：改字符、删档写 null、加档、恢复默认", async () => {
    const hob = makeHob({}, { providers: [customProvider()] });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = async (levels: ThinkingLevelMapSetting | null) =>
        app.request("/api/models/thinking", {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ ref: "ds/deepseek-chat", levels }),
        });

      // 改字符 + 删掉三档（写 null）：DeepSeek 的「中」发 high，其它没改的档留空
      const edited = await put({ off: "", low: "", medium: "high", high: "", minimal: null, xhigh: null, max: null });
      expect(edited.status).toBe(200);
      const saved = (await edited.json()) as ModelThinkingSaved;
      expect(saved.thinking).toMatchObject({ ref: "ds/deepseek-chat", reasoning: true, custom: true });
      expect(saved.thinking.levels).toEqual([
        { level: "off", text: "" },
        { level: "low", text: "" },
        { level: "medium", text: "high" },
        { level: "high", text: "" },
      ]);
      // 写进 Hob 设置（revision 往前走了）
      expect(saved.settings.settings.models.thinking?.["ds/deepseek-chat"]).toMatchObject({ medium: "high", max: null });
      // 引擎的模型配置：只写改过的字符和关掉的档（没改的 off/low/high 不写，交给协议默认）
      const model = await hob.runtime.pi.model("ds/deepseek-chat");
      expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high"]);
      expect(model.thinkingLevelMap).toEqual({ minimal: null, medium: "high", xhigh: null, max: null });

      // 加档（最低）：默认字符留空
      const added = await put({ off: "", minimal: "", low: "", medium: "high", high: "", xhigh: null, max: null });
      expect(added.status).toBe(200);
      expect(((await added.json()) as ModelThinkingSaved).thinking.levels.map((item) => item.level)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
      ]);

      // 恢复默认：只剩默认范围，custom 回到 false
      const reset = await put(null);
      expect(reset.status).toBe(200);
      const back = (await reset.json()) as ModelThinkingSaved;
      expect(back.thinking.custom).toBe(false);
      expect(back.thinking.levels.map((item) => item.level)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(back.settings.settings.models.thinking).toBeUndefined();
      const fresh = await hob.runtime.pi.model("ds/deepseek-chat");
      expect(getSupportedThinkingLevels(fresh)).toHaveLength(7);
      // 恢复默认后只有 xhigh / max 两个开启项
      expect(fresh.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
    } finally {
      hob.close();
    }
  });

  it("删掉的档不在思考强度里：/api/models 也不给这一档", async () => {
    const hob = makeHob({}, { providers: [customProvider()] });
    try {
      // 有 Key 的模型才会出现在 /api/models 里
      writeSecret(hob.home, providerKeyName("ds"), "sk-test");
      await hob.runtime.providers.apply();
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = await app.request("/api/models/thinking", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          ref: "ds/deepseek-chat",
          levels: { off: "", low: "", medium: "medium", high: "", minimal: null, xhigh: null, max: null },
        }),
      });
      expect(put.status).toBe(200);
      const view = (await (await app.request("/api/models", { headers: { cookie } })).json()) as ModelsView;
      expect(view.models.find((model) => model.ref === "ds/deepseek-chat")?.thinkingLevels).toEqual([
        "off",
        "low",
        "medium",
        "high",
      ]);
    } finally {
      hob.close();
    }
  });

  it("非法字符 400，并说清哪一档", async () => {
    const hob = makeHob({}, { providers: [customProvider()] });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = async (levels: unknown) => {
        const response = await app.request("/api/models/thinking", {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ ref: "ds/deepseek-chat", levels }),
        });
        return { status: response.status, text: await response.text() };
      };

      // 留空 = 按协议默认，不算错；只去首尾空白
      const blank = await put({ off: "  ", high: "  " });
      expect(blank.status).toBe(200);
      expect(hob.runtime.settings.settings.models.thinking?.["ds/deepseek-chat"]).toMatchObject({ off: "", high: "" });

      const tooLong = await put({ off: "", high: "x".repeat(41) });
      expect(tooLong.status).toBe(400);
      expect(tooLong.text).toContain("最多 40 个字");

      const badLevel = await put({ off: "", turbo: "turbo" });
      expect(badLevel.status).toBe(400);
      expect(badLevel.text).toContain("思考档无效");

      // off 可以改字符，但不能删
      const dropOff = await put({ off: null, high: "high" });
      expect(dropOff.status).toBe(400);
      expect(dropOff.text).toContain("「关闭」这一档不能删");

      // 不存在的模型
      const unknown = await app.request("/api/models/thinking", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ref: "gone/model", levels: { off: "none" } }),
      });
      expect(unknown.status).toBe(400);

      // 存完 trim 首尾空白
      const padded = await put({ off: " none ", high: " high " });
      expect(padded.status).toBe(200);
      expect(hob.runtime.settings.settings.models.thinking?.["ds/deepseek-chat"]).toMatchObject({
        off: "none",
        high: "high",
      });
      // 自己填了 off 才写进引擎映射（默认不写，免得发非法的 reasoning_effort）
      expect((await hob.runtime.pi.model("ds/deepseek-chat")).thinkingLevelMap).toMatchObject({ off: "none" });
    } finally {
      hob.close();
    }
  });

  it("内置服务商：写进 HOB_HOME/engine/models.json 的 modelOverrides", async () => {
    const hob = makeHob({}, { providers: [{ kind: "builtin", id: "openai" }] });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = await app.request("/api/models/thinking", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          ref: "openai/gpt-5.6-sol",
          levels: { off: "", low: "", medium: "medium", high: "", minimal: null, xhigh: "xhigh", max: null },
        }),
      });
      expect(put.status).toBe(200);
      const saved = (await put.json()) as ModelThinkingSaved;
      expect(saved.thinking.custom).toBe(true);
      expect(saved.thinking.levels.map((item) => item.level)).toEqual(["off", "low", "medium", "high", "xhigh"]);

      // 引擎的模型配置读的是 Hob 自己的 models.json（HOB_HOME/engine），只放必要的键
      const file = join(hob.home, "system", "engine", "models.json");
      const written = JSON.parse(readFileSync(file, "utf8")) as {
        providers: Record<string, { modelOverrides: Record<string, { thinkingLevelMap: ThinkingLevelMapSetting }> }>;
      };
      expect(written.providers.openai?.modelOverrides["gpt-5.6-sol"]?.thinkingLevelMap).toEqual({
        minimal: null,
        medium: "medium",
        xhigh: "xhigh",
        max: null,
      });
      const runtime = await hob.runtime.pi.runtime();
      expect(runtime.getError()).toBeUndefined();
      const model = runtime.getModel("openai", "gpt-5.6-sol")!;
      expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high", "xhigh"]);

      // 没存自定义的内置模型也按 Hob 默认规则覆盖（不是引擎注册表里的旧映射：gpt 模型只到 xhigh）
      const fresh = runtime.getModel("openai", "gpt-5.6-terra")!;
      // 引擎底表说这个模型没有「最低」（minimal: null），就不列它——引擎会把它收到别的档
      expect(getSupportedThinkingLevels(fresh)).toEqual(["off", "low", "medium", "high", "xhigh"]);
      expect(written.providers.openai?.modelOverrides["gpt-5.6-terra"]?.thinkingLevelMap).toEqual({
        xhigh: "xhigh",
        max: null,
      });
      // 服务商详情里能看到这些档
      const view = (await (await app.request("/api/providers", { headers: { cookie } })).json()) as ProvidersView;
      expect(view.models.openai?.find((item) => item.ref === "openai/gpt-5.6-sol")?.custom).toBe(true);
      expect(view.models.openai?.some((item) => item.reasoning)).toBe(true);
    } finally {
      hob.close();
    }
  });
});

describe("运行时只读 HOB_HOME", () => {
  it("本机 pi 目录里的模型和思考档不进运行时，只在导入候选里出现", async () => {
    const local = mkdtempSync(join(tmpdir(), "hob-local-pi-"));
    writeFileSync(
      join(local, "models.json"),
      JSON.stringify({
        providers: {
          "local-only": {
            api: "openai-responses",
            baseUrl: "https://local.example/v1",
            apiKey: "sk-local",
            models: [{ id: "gpt-9", reasoning: true, thinkingLevelMap: { max: null } }],
          },
        },
      }),
    );
    const before = process.env.HOB_LOCAL_PI_DIR;
    process.env.HOB_LOCAL_PI_DIR = local;
    const hob = makeHob({}, { models: [{ id: "smart", reasoning: true }] });
    try {
      // 引擎目录和模型配置都在 HOB_HOME 里
      expect(hob.runtime.pi.engineDir).toBe(join(hob.home, "system", "engine"));
      expect(hob.runtime.pi.modelsPath).toBe(join(hob.home, "system", "engine", "models.json"));
      // 本机那份没有进运行时：模型、思考档都还是 Hob 自己的
      const refs = (await hob.runtime.models.get()).map((model) => model.ref);
      expect(refs).toEqual(["hob-faux/smart"]);
      expect(hob.runtime.settings.settings.models.thinking).toBeUndefined();
      expect((await hob.runtime.models.get())[0]?.thinkingLevels).toHaveLength(7);
      // 唯一读本机目录的地方是导入候选
      const imports = await hob.runtime.providers.importView();
      expect(imports.items.map((item) => item.id)).toContain("local-only");
    } finally {
      hob.close();
      if (before === undefined) delete process.env.HOB_LOCAL_PI_DIR;
      else process.env.HOB_LOCAL_PI_DIR = before;
      rmSync(local, { recursive: true, force: true });
    }
  });
});
