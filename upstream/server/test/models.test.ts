import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Assistant, ModelsView } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { workerTools } from "../src/jobs.ts";
import { buildSystemPrompt, buildWorkerPrompt } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { makeHob } from "./helpers.ts";

const MODELS = [
  { id: "fast", input: ["text"] as ("text" | "image")[] },
  { id: "smart", reasoning: true, input: ["text"] as ("text" | "image")[] },
  { id: "eyes", input: ["text", "image"] as ("text" | "image")[] },
];

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function roster(...refs: string[]) {
  return refs.map((ref) => ({ ref, note: "" }));
}

describe("模型名单（设置）", () => {
  it("任务思考档选择方式可保存，非法值拒绝，其他设置变更不覆盖", async () => {
    const hob = makeHob({}, { models: MODELS });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = (patch: unknown) => app.request("/api/settings", {
        method: "PUT", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ revision: hob.runtime.settings.get().revision, patch }),
      });
      expect(hob.runtime.settings.settings.models.thinkingChoice).toBeUndefined();
      expect((await put({ models: { thinkingChoice: "fixed" } })).status).toBe(200);
      expect((await put({ work: { maxJobs: 3 } })).status).toBe(200);
      expect(hob.runtime.settings.settings.models.thinkingChoice).toBe("fixed");
      for (const value of ["invalid", null, 1]) {
        expect((await put({ models: { thinkingChoice: value } })).status).toBe(400);
        expect(hob.runtime.settings.settings.models.thinkingChoice).toBe("fixed");
      }
      expect((await put({ models: { thinkingChoice: "auto" } })).status).toBe(200);
      expect(hob.runtime.settings.settings.models.thinkingChoice).toBe("auto");
    } finally { hob.close(); }
  });
  it("保存评分、补充说明和确认状态，并拒绝非法分数", async () => {
    const hob = makeHob({}, { models: MODELS });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const entry = { ref: "hob-faux/fast", note: "自定义的任务用途", scores: { smart: 60, cost: 0, speed: 100 }, scoresConfirmed: true };
      const response = await app.request("/api/settings", {
        method: "PUT", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ revision: hob.runtime.settings.get().revision, patch: { models: { roster: [entry] } } }),
      });
      expect(response.status).toBe(200);
      expect(hob.runtime.settings.get().settings.models.roster).toEqual([entry]);
      const refreshed = await (await app.request("/api/settings", { headers: { cookie } })).json();
      expect(refreshed.settings.models.roster).toEqual([entry]);
      for (const smart of [-1, 101, 1.5]) {
        const bad = await app.request("/api/settings", {
          method: "PUT", headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ revision: hob.runtime.settings.get().revision, patch: { models: { roster: [{ ...entry, scores: { ...entry.scores, smart } }] } } }),
        });
        expect(bad.status).toBe(400);
      }
      const old = { ref: "hob-faux/fast", note: "旧说明", uses: ["daily"], useConfirmed: true };
      const legacy = await app.request("/api/settings", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ revision: hob.runtime.settings.get().revision, patch: { models: { roster: [old] } } }) });
      expect(legacy.status).toBe(200);
      expect(hob.runtime.settings.settings.models.roster).toEqual([{ ref: old.ref, note: old.note }]);
    } finally { hob.close(); }
  });
  it("GET /api/models 列出可用的聊天模型，名单里没有的模型不存在", async () => {
    const hob = makeHob({}, { models: MODELS });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const view = (await (await app.request("/api/models", { headers: { cookie } })).json()) as ModelsView;
      expect(view.models.map((model) => model.ref).sort()).toEqual([
        "hob-faux/eyes",
        "hob-faux/fast",
        "hob-faux/smart",
      ]);
      const smart = view.models.find((model) => model.ref === "hob-faux/smart")!;
      expect(smart).toMatchObject({ provider: "hob-faux", id: "smart", reasoning: true, input: ["text"] });      expect(smart.contextWindow).toBe(200_000);
      // 思考档按 Hob 的默认规则：会推理的到 max，不推理的只有 off（不看引擎注册表里的映射）
      expect(smart.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
      expect(view.models.find((model) => model.ref === "hob-faux/fast")?.thinkingLevels).toEqual(["off"]);
      expect(view.roster.map((entry) => entry.ref)).toEqual(["hob-faux/fast"]);
    } finally {
      hob.close();
    }
  });

  it("名单里的模型现在不可用了（服务商删了或没有 Key）：保留、标 unavailable，不静默删", async () => {
    const hob = makeHob(
      {},
      { models: MODELS, settings: { models: { roster: roster("hob-faux/fast", "gone/model") } } },
    );
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const view = (await (await app.request("/api/models", { headers: { cookie } })).json()) as ModelsView;
      expect(view.roster).toMatchObject([
        { ref: "hob-faux/fast" },
        { ref: "gone/model", unavailable: true },
      ]);

      // 再保存别的字段也不会把它删掉
      const { revision } = hob.runtime.settings.get();
      const put = await app.request("/api/settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ revision, patch: { work: { maxJobs: 3 } } }),
      });
      expect(put.status).toBe(200);
      expect(hob.runtime.settings.settings.models.roster.map((entry) => entry.ref)).toEqual([
        "hob-faux/fast",
        "gone/model",
      ]);
    } finally {
      hob.close();
    }
  });

  it("PUT 校验：新加的模型必须现在可用，角色必须在名单里", async () => {
    const hob = makeHob({}, { models: MODELS });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = (patch: unknown) => {
        const { revision } = hob.runtime.settings.get();
        return app.request("/api/settings", {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ revision, patch }),
        });
      };

      const unknown = await put({ models: { roster: [...roster("hob-faux/fast"), { ref: "gone/model", note: "" }] } });
      expect(unknown.status).toBe(400);
      expect(await unknown.text()).toContain("gone/model");

      const notInRoster = await put({ models: { work: { ref: "hob-faux/smart", thinking: "high" } } });
      expect(notInRoster.status).toBe(400);
      expect(await notInRoster.text()).toContain("不在模型列表中");

      const ok = await put({
        models: {
          roster: roster("hob-faux/fast", "hob-faux/smart"),
          work: { ref: "hob-faux/smart", thinking: "high" },
        },
      });
      expect(ok.status).toBe(200);
      const settings = hob.runtime.settings.settings.models;
      expect(settings.work).toEqual({ ref: "hob-faux/smart", thinking: "high" });
      expect(settings.conversation.ref).toBe("hob-faux/fast");
    } finally {
      hob.close();
    }
  });

  it("把当前默认模型从名单里去掉：角色自动退到名单里的其他模型，不报错", async () => {
    const hob = makeHob({}, { models: MODELS, settings: { models: { roster: roster("hob-faux/fast", "hob-faux/eyes") } } });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const { revision } = hob.runtime.settings.get();
      const put = await app.request("/api/settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ revision, patch: { models: { roster: roster("hob-faux/eyes") } } }),
      });
      expect(put.status).toBe(200);
      expect(hob.runtime.settings.settings.models.conversation.ref).toBe("hob-faux/eyes");
      expect(hob.runtime.settings.settings.models.work.ref).toBe("hob-faux/eyes");
    } finally {
      hob.close();
    }
  });

  it("设置里填了模型没有的思考档：照存不拒，用的时候往下收", async () => {
    const hob = makeHob(
      {},
      {
        models: [
          { id: "plain", input: ["text"] },
          { id: "gpt-mini", reasoning: true, input: ["text"] },
        ],
        settings: { models: { roster: roster("hob-faux/plain", "hob-faux/gpt-mini") } },
      },
    );
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const put = (patch: unknown) => {
        const { revision } = hob.runtime.settings.get();
        return app.request("/api/settings", {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ revision, patch }),
        });
      };

      // gpt 模型默认最高只到 xhigh：存 max 不拒
      const maxOnGpt = await put({ models: { work: { ref: "hob-faux/gpt-mini", thinking: "max" } } });
      expect(maxOnGpt.status).toBe(200);
      expect(hob.runtime.settings.settings.models.work).toEqual({ ref: "hob-faux/gpt-mini", thinking: "max" });

      // 不推理的模型存 high 也不拒（用的时候会收成 off）
      const highOnPlain = await put({ models: { conversation: { ref: "hob-faux/plain", thinking: "high" } } });
      expect(highOnPlain.status).toBe(200);

      // 名单项自己的默认思考档同理
      const rosterMax = await put({ models: { roster: [{ ref: "hob-faux/gpt-mini", note: "", thinking: "max" }] } });
      expect(rosterMax.status).toBe(200);

      // 档位本身不合法才拒
      const bogus = await put({ models: { work: { ref: "hob-faux/gpt-mini", thinking: "turbo" } } });
      expect(bogus.status).toBe(400);
      expect(await bogus.text()).toContain("思考档无效：可选值为");
    } finally {
      hob.close();
    }
  });

  it("助手设置能存模型的允许范围和能力，不合法的模型被拒", async () => {
    const hob = makeHob({}, { models: MODELS, settings: { models: { roster: roster("hob-faux/fast", "hob-faux/smart") } } });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const patch = (body: unknown) =>
        app.request("/api/assistants/hob", {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const bad = await patch({ models: { allowed: ["gone/model"] } });
      expect(bad.status).toBe(400);
      expect(await bad.text()).toContain("不在模型列表中");

      // 思考档不再按模型拒：模型没有的档也存
      const oddThinking = await patch({ models: { work: { ref: "hob-faux/fast", thinking: "max" } } });
      expect(oddThinking.status).toBe(200);

      const ok = await patch({
        models: { work: { ref: "hob-faux/fast", thinking: "off" } },
        abilities: { exec: false, write: false, image: true },
      });
      expect(ok.status).toBe(200);
      const saved = hob.runtime.store.assistant("hob") as Assistant;
      expect(saved.models).toEqual({ work: { ref: "hob-faux/fast", thinking: "off" } });
      expect(saved.abilities).toEqual({ exec: false, write: false, image: true });
    } finally {
      hob.close();
    }
  });
});

describe("提示词", () => {
  it("固定档的模型列表和工具说明只展示实际默认档", async () => {
    const hob = makeHob({}, { models: MODELS, settings: { models: { roster: roster("hob-faux/fast", "hob-faux/smart"), work: { ref: "hob-faux/smart", thinking: "high" }, thinkingChoice: "fixed" } } });
    try {
      await hob.runtime.models.get();
      const models = [
        { name: "Smart", ref: "hob-faux/smart", note: "", thinking: "high" as const, levels: ["off", "high"] as ("off" | "high")[], isDefault: true },
        { name: "Fast", ref: "hob-faux/fast", note: "", thinking: "off" as const, isDefault: false },
      ];
      for (const list of [models, models.slice(0, 1)]) {
        const text = buildSystemPrompt(hob.runtime.store, "hob", { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off", models: list, thinkingChoice: "fixed" });
        expect(text).not.toContain("## 可以派的模型");
        expect(text).not.toContain("思考档 high");
        expect(text).not.toContain("填 thinking");
      }
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "start_job")!;
      expect(tool.parameters.properties).not.toHaveProperty("thinking");
      expect(tool.parameters.properties.model.description).toContain("hob-faux/smart（默认）");
      expect(tool.parameters.properties.model.description).toContain("思考档 high");
      hob.runtime.settings.patch(hob.runtime.settings.get().revision, { models: { thinkingChoice: "auto" } });
      const autoTool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "start_job")!;
      expect(autoTool.parameters.properties.thinking.description).toContain("可选");
    } finally { hob.close(); }
  });
  it("保存开关后重开 Router，下一轮使用新的工具参数说明", async () => {
    const hob = makeHob({}, { models: MODELS });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const before = await hob.runtime.router.ensure("hob");
      const firstSession = before.session!;
      const properties = (session: typeof firstSession) => session.agent.state.tools.find((tool) => tool.name === "start_job")!.parameters.properties;
      expect(properties(firstSession).thinking.description).toContain("可选");
      const result = await app.request("/api/settings", {
        method: "PUT", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ revision: hob.runtime.settings.get().revision, patch: { models: { thinkingChoice: "fixed" } } }),
      });
      expect(result.status).toBe(200);
      const after = await hob.runtime.router.ensure("hob");
      expect(after.session).not.toBe(firstSession);
      expect(properties(after.session!)).not.toHaveProperty("thinking");
    } finally { hob.close(); }
  });
  it("start_job 列出每个模型的评分、能力和思考档", async () => {
    const hob = makeHob({}, { models: MODELS, settings: { models: { roster: [{ ref: "hob-faux/fast", note: "轻活", scores: { smart: 40, cost: 10, speed: 95 }, scoresConfirmed: true }, { ref: "hob-faux/eyes", note: "" }] } } });
    try {
      await hob.runtime.models.get();
      const text = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "start_job")!.parameters.properties.model.description;
      expect(text).toContain("hob-faux/fast（默认） · 聪明 40% · 成本 10% · 速度 95% · 上下文 200K · 补充：轻活 · 思考档 off");
      expect(text).toContain("\nhob-faux/eyes · 聪明 50% · 成本 50% · 速度 60% · 能看图 · 上下文 200K · 思考档 off");
    } finally { hob.close(); }
  });
  it("多个模型：列名字、定位、默认标记和挑法", () => {
    const hob = makeHob({}, { models: MODELS });
    try {
      const text = buildSystemPrompt(hob.runtime.store, "hob", {
        timezone: "Asia/Shanghai",
        aboutYou: { name: "", language: "", notes: "" },
        models: [
          { name: "Fast", ref: "p/fast", note: "快，日常用", thinking: "low", isDefault: true },
          { name: "Smart", ref: "p/smart", note: "最聪明但慢，难题用", thinking: "high", isDefault: false },
        ],
      });
      expect(text).not.toContain("## 可以派的模型");
      expect(text).not.toContain("p/fast");
      expect(text).not.toContain("p/smart");
      expect(text).not.toContain("聪明、成本、速度都是 0–100");
      expect(text).not.toContain("不确定就不填，使用默认值");
    } finally {
      hob.close();
    }
  });

  it("只有一个模型：这一节只写一行，不用挑", () => {
    const hob = makeHob();
    try {
      const text = buildSystemPrompt(hob.runtime.store, "hob", {
        timezone: "Asia/Shanghai",
        aboutYou: { name: "", language: "", notes: "" },
        models: [{ name: "Only", ref: "p/only", note: "就它了", thinking: "low", isDefault: true }],
      });
      expect(text).not.toContain("## 可以派的模型");
      expect(text).not.toContain("p/only");
      expect(text).not.toContain("不用填 model");
    } finally {
      hob.close();
    }
  });

  it("Worker 提示词写明能做什么、不能做什么", () => {
    const hob = makeHob();
    try {
      const job = { id: "t-x", assistantId: "hob", status: "queued" } as never;
      hob.runtime.store.saveJob({
        ...(job as object),
        id: "t-x",
        assistantId: "hob",
        title: "写东西",
        instruction: "写一份简报",
        status: "queued",
        createdAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      } as never);
      const text = buildWorkerPrompt(hob.runtime.store, "t-x", {
        timezone: "Asia/Shanghai",
        aboutYou: { name: "", language: "", notes: "" },
        abilities: { exec: false, write: true, image: false },
      });
      expect(text).not.toContain("## 你能做什么");
      expect(text).not.toContain("- 能做：");
      expect(text).toContain("不能做：执行命令（bash）、生图");
    } finally {
      hob.close();
    }
  });
});

describe("助手对话模型", () => {
  it("换了对话模型以后下一轮就用新的，会话不重建（上下文还在）", async () => {
    const hob = makeHob(
      {},
      { models: MODELS, settings: { models: { roster: roster("hob-faux/fast", "hob-faux/smart") } } },
    );
    try {
      const seen: string[] = [];
      // 假 provider 的响应工厂第四个参数是这次请求用的 model
      const reply = (text: string) => (_context: any, _options: any, _state: any, model: any) => {
        seen.push(model.id);
        return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as never;
      };
      hob.faux.setResponses([reply("在。"), reply("换了模型我还在。")]);

      await hob.runtime.router.send("hob", { text: "在吗" });
      await hob.runtime.router.waitIdle("hob");
      expect(seen).toEqual(["fast"]);

      const { revision } = hob.runtime.settings.get();
      hob.runtime.settings.patch(revision, { models: { conversation: { ref: "hob-faux/smart", thinking: "off" } } });

      await hob.runtime.router.send("hob", { text: "再问一句" });
      await hob.runtime.router.waitIdle("hob");
      expect(seen).toEqual(["fast", "smart"]);
      // 同一个会话：两轮都在同一份 transcript 里，上下文没丢
      const items = hob.runtime.router.items("hob").items;
      expect(items.filter((item) => item.kind === "assistant").map((item) => (item as { text: string }).text)).toEqual([
        "在。",
        "换了模型我还在。",
      ]);
    } finally {
      hob.close();
    }
  });
});


describe("start_job 的模型", () => {
  it("自动档采纳请求；固定档使用角色或所选模型默认档并向下收", async () => {
    const hob = makeHob({}, { models: [{ id: "smart", reasoning: true }, { id: "gpt-x", reasoning: true }], settings: { models: {
      roster: [{ ref: "hob-faux/smart", note: "", thinking: "low" }, { ref: "hob-faux/gpt-x", note: "", thinking: "max" }],
      work: { ref: "hob-faux/smart", thinking: "medium" },
    } } });
    try {
      const auto = await hob.runtime.jobs.start("hob", { title: "自动", instruction: "测试", thinking: "high" });
      expect(auto.thinking).toBe("high");
      hob.runtime.settings.patch(hob.runtime.settings.get().revision, { models: { thinkingChoice: "fixed" } });
      const fixed = await hob.runtime.jobs.start("hob", { title: "固定", instruction: "测试", thinking: "low" });
      expect(fixed.thinking).toBe("medium");
      const capped = await hob.runtime.jobs.start("hob", { title: "另选模型", instruction: "测试", model: "hob-faux/gpt-x", thinking: "off" });
      expect(capped.model).toBe("hob-faux/gpt-x");
      expect(capped.thinking).toBe("xhigh");
      const invalid = await hob.runtime.jobs.start("hob", { title: "忽略参数", instruction: "测试", thinking: "invalid" });
      expect(invalid.thinking).toBe("medium");
      await hob.runtime.jobs.waitIdle();
    } finally { hob.close(); }
  });
  it("不在允许范围就报错并列出可选项", async () => {
    const hob = makeHob(
      {},
      { models: MODELS, settings: { models: { roster: roster("hob-faux/fast", "hob-faux/smart") } } },
    );
    try {
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, models: { allowed: ["hob-faux/fast"] } });
      await expect(
        hob.runtime.jobs.start("hob", { title: "难题", instruction: "算一下", model: "hob-faux/smart" }),
      ).rejects.toThrow(/无法分派 hob-faux\/smart.*hob-faux\/fast/);
    } finally {
      hob.close();
    }
  });

  it("不填就用助手的默认干活模型，助手的默认在上面就覆盖全局", async () => {
    const hob = makeHob(
      {},
      {
        models: MODELS,
        settings: {
          models: { roster: roster("hob-faux/fast", "hob-faux/smart"), work: { ref: "hob-faux/fast", thinking: "off" } },
        },
      },
    );
    try {
      const first = await hob.runtime.jobs.start("hob", { title: "一", instruction: "干" });
      expect(first.model).toBe("hob-faux/fast");
      await hob.runtime.jobs.waitIdle();

      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({
        ...assistant,
        models: { work: { ref: "hob-faux/smart", thinking: "high" } },
      });
      const second = await hob.runtime.jobs.start("hob", { title: "二", instruction: "干" });
      expect(second.model).toBe("hob-faux/smart");
      expect(second.thinking).toBe("high");
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("任务包含图片而所选模型不支持图片输入：自动更换并记录原因", async () => {
    const hob = makeHob(
      {},
      {
        models: MODELS,
        settings: { models: { roster: roster("hob-faux/fast", "hob-faux/eyes") } },
      },
    );
    try {
      const work = mkdtempSync(join(tmpdir(), "hob-img-"));
      const image = join(work, "shot.png");
      writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      try {
        const job = await hob.runtime.jobs.start("hob", {
          title: "看截图",
          instruction: "看看这个截图",
          files: [image],
          model: "hob-faux/fast",
        });
        expect(job.model).toBe("hob-faux/eyes");
        expect(job.modelReason).toBe("任务包含图片，已更换为 eyes");
        expect(job.inputs).toEqual([image]);
        await hob.runtime.jobs.waitIdle();
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    } finally {
      hob.close();
    }
  });

  it("可分派的模型均不支持图片输入时报错说明原因", async () => {
    const hob = makeHob({}, { models: MODELS, settings: { models: { roster: roster("hob-faux/fast") } } });
    try {
      const work = mkdtempSync(join(tmpdir(), "hob-img-"));
      const image = join(work, "shot.jpg");
      writeFileSync(image, Buffer.from([0xff, 0xd8]));
      try {
        await expect(
          hob.runtime.jobs.start("hob", { title: "看图片", instruction: "看图", files: [image] }),
        ).rejects.toThrow(/均不支持图片输入/);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    } finally {
      hob.close();
    }
  });

  it("start_job 填了模型没有的档：不报错，往下取最近的一档", async () => {
    const hob = makeHob(
      {},
      {
        models: [
          { id: "fast", input: ["text"] },
          { id: "gpt-x", reasoning: true, input: ["text"] },
        ],
        settings: { models: { roster: roster("hob-faux/fast", "hob-faux/gpt-x") } },
      },
    );
    try {
      // 不推理的模型只有 off：填 high 收成 off
      const plain = await hob.runtime.jobs.start("hob", {
        title: "想一会",
        instruction: "想",
        model: "hob-faux/fast",
        thinking: "high",
      });
      expect(plain.thinking).toBe("off");
      // gpt 模型最高只到 xhigh：填 max 收成 xhigh
      const capped = await hob.runtime.jobs.start("hob", {
        title: "再想",
        instruction: "想",
        model: "hob-faux/gpt-x",
        thinking: "max",
      });
      expect(capped.thinking).toBe("xhigh");
      const explicit = await hob.runtime.jobs.start("hob", {
        title: "接着想",
        instruction: "想",
        model: "hob-faux/gpt-x",
        thinking: "low",
      });
      expect(explicit.thinking).toBe("low");
      // 档位本身不合法才报错
      await expect(
        hob.runtime.jobs.start("hob", { title: "乱填", instruction: "想", model: "hob-faux/gpt-x", thinking: "turbo" }),
      ).rejects.toThrow(/思考档无效：可选值为/);
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("没存自定义档位的推理模型默认到 max，引擎注册表里自带别的映射也不用", async () => {
    const hob = makeHob(
      {},
      {
        models: [{ id: "smart", reasoning: true, input: ["text"], thinkingLevelMap: { medium: null, xhigh: null, max: null } }],
        settings: {
          models: {
            roster: [{ ref: "hob-faux/smart", note: "" }],
            conversation: { ref: "hob-faux/smart", thinking: "max" },
            work: { ref: "hob-faux/smart", thinking: "max" },
          },
        },
      },
    );
    try {
      const job = await hob.runtime.jobs.start("hob", { title: "一", instruction: "干", model: "hob-faux/smart" });
      expect(job.thinking).toBe("max");
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("id 含 gpt 的默认只到 xhigh：默认 max 往下收成 xhigh", async () => {
    const hob = makeHob(
      {},
      {
        models: [{ id: "GPT-5.6", reasoning: true, input: ["text"] }],
        settings: {
          models: {
            roster: [{ ref: "hob-faux/GPT-5.6", note: "" }],
            conversation: { ref: "hob-faux/GPT-5.6", thinking: "max" },
            work: { ref: "hob-faux/GPT-5.6", thinking: "max" },
          },
        },
      },
    );
    try {
      const job = await hob.runtime.jobs.start("hob", { title: "一", instruction: "干" });
      expect(job.thinking).toBe("xhigh");
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("存了自定义档位就按自定义：删掉的档不在可选范围，填了也往下收", async () => {
    const hob = makeHob(
      {},
      {
        models: [{ id: "capped", reasoning: true, input: ["text"] }],
        settings: {
          models: {
            roster: [{ ref: "hob-faux/capped", note: "" }],
            conversation: { ref: "hob-faux/capped", thinking: "medium" },
            work: { ref: "hob-faux/capped", thinking: "medium" },
            thinking: {
              "hob-faux/capped": { off: "", minimal: "", low: "", medium: null, high: "", xhigh: null, max: null },
            },
          },
        },
      },
    );
    try {
      const levels = (await hob.runtime.models.get()).find((model) => model.ref === "hob-faux/capped")?.thinkingLevels;
      expect(levels).toEqual(["off", "minimal", "low", "high"]);
      // 显式要删掉的档：不拒绝，往下收成 low
      const asked = await hob.runtime.jobs.start("hob", {
        title: "一",
        instruction: "干",
        model: "hob-faux/capped",
        thinking: "medium",
      });
      expect(asked.thinking).toBe("low");
      // 默认档是 medium 也一样往下收
      const job = await hob.runtime.jobs.start("hob", { title: "二", instruction: "干", model: "hob-faux/capped" });
      expect(job.thinking).toBe("low");
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("思考档：角色指定的模型用角色的档，另选的模型用它自己的默认档", async () => {
    const hob = makeHob(
      {},
      {
        models: [
          { id: "fast", input: ["text"] },
          { id: "smart", reasoning: true, input: ["text"] },
          { id: "deep", reasoning: true, input: ["text"], thinkingLevelMap: { xhigh: "xhigh" } },
        ],
        settings: {
          models: {
            roster: [
              { ref: "hob-faux/smart", note: "", thinking: "low" },
              { ref: "hob-faux/deep", note: "", thinking: "xhigh" },
            ],
            conversation: { ref: "hob-faux/fast", thinking: "low" },
            work: { ref: "hob-faux/smart", thinking: "medium" },
          },
        },
      },
    );
    try {
      const byRole = await hob.runtime.jobs.start("hob", { title: "一", instruction: "干" });
      expect(byRole.model).toBe("hob-faux/smart");
      expect(byRole.thinking).toBe("medium");
      await hob.runtime.jobs.waitIdle();

      const picked = await hob.runtime.jobs.start("hob", { title: "二", instruction: "干", model: "hob-faux/deep" });
      expect(picked.thinking).toBe("xhigh");
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });
});

describe("助手能力", () => {
  it("按能力过滤 Worker 的工具：读总是有，bash / edit / write 跟着开关", () => {
    expect(workerTools({ exec: true, write: true, image: true })).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
    expect(workerTools({ exec: false, write: false, image: true })).toEqual(["read", "grep", "find", "ls"]);
    expect(workerTools({ exec: true, write: false, image: false })).toEqual(["read", "bash", "grep", "find", "ls"]);
  });

  it("开任务时按助手的能力给工具，提示词里也写明能做什么", async () => {
    const hob = makeHob();
    try {
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, abilities: { exec: false, write: false, image: true } });
      const opened: { tools: string[]; prompt?: string }[] = [];
      const original = hob.runtime.pi.open.bind(hob.runtime.pi);
      hob.runtime.pi.open = async (options) => {
        const result = await original(options);
        opened.push({ tools: options.tools, prompt: options.systemPrompt() });
        return result;
      };
      hob.faux.setResponses([
        () => ({
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "report", arguments: { outcome: "done", result: "好了" } }],
          stopReason: "toolUse",
        }) as never,
        () => ({ role: "assistant", content: [{ type: "text", text: "好" }], stopReason: "stop" }) as never,
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "写东西", instruction: "写一份简报" });
      await hob.runtime.jobs.waitIdle();

      const worker = opened.find((entry) => entry.tools.includes("report"))!;
      expect(worker.tools).not.toContain("bash");
      expect(worker.tools).not.toContain("edit");
      expect(worker.tools).not.toContain("write");
      expect(worker.tools).toContain("read");
      expect(worker.prompt).toContain("不能做：执行命令（bash）、改文件（edit、write）");
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
    } finally {
      hob.close();
    }
  });
});
