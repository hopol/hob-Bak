import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { IMAGE_KEY_SECRET } from "../src/image.ts";
import { saveLoreConnection } from "../src/memory.ts";
import { writeSecret } from "../src/secrets.ts";
import { makeHob } from "./helpers.ts";

/** 一个目录下所有文件的「内容 + 时间戳」，用来断言来源目录没有被改动。 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        out[`${relative(dir, path)}/`] = "dir";
        walk(path);
      } else {
        out[relative(dir, path)] = `${statSync(path).mtimeMs}:${readFileSync(path, "utf8")}`;
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * 本机配置只被读、不被写：HOME 指到临时目录，把整条路径跑一遍，
 * 最后断言 $HOME/.pi 和 $HOME/.lore 一个字节都没变。
 */
describe("不碰本机的 pi / lore 配置", () => {
  it("建运行时、存服务商 / 记忆 / Lore / 生图、开一次会话、两种导入之后，$HOME 下的配置没被创建或改动", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "hob-fake-home-"));
    const localPiDir = join(fakeHome, ".pi", "agent");
    const localLoreHome = join(fakeHome, ".lore");
    mkdirSync(localPiDir, { recursive: true });
    mkdirSync(localLoreHome, { recursive: true });
    writeFileSync(
      join(localPiDir, "models.json"),
      JSON.stringify({
        providers: {
          "home-proxy": {
            api: "openai-completions",
            baseUrl: "https://home.example/v1",
            apiKey: "sk-home",
            models: [{ id: "home-model" }],
          },
        },
      }),
    );
    writeFileSync(join(localPiDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-home-ant" } }));
    writeFileSync(
      join(localLoreHome, "config.json"),
      JSON.stringify({ base_url: "http://127.0.0.1:18901", api_token: "lm_home" }),
    );
    const piBefore = snapshot(localPiDir);
    const loreBefore = snapshot(localLoreHome);

    const envBefore = {
      HOME: process.env.HOME,
      HOB_LOCAL_PI_DIR: process.env.HOB_LOCAL_PI_DIR,
      HOB_LOCAL_LORE_HOME: process.env.HOB_LOCAL_LORE_HOME,
    };
    // HOME 指到临时目录；本机配置的来源明确指给这两个目录
    process.env.HOME = fakeHome;
    process.env.HOB_LOCAL_PI_DIR = localPiDir;
    process.env.HOB_LOCAL_LORE_HOME = localLoreHome;
    const hob = makeHob();
    try {
      const runtime = hob.runtime;
      // 服务商：写进 HOB_HOME，套进引擎
      await runtime.providers.put("probe", {
        kind: "custom",
        name: "探测",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: "m" }],
        key: "sk-probe",
      });
      // 记忆来源
      runtime.settings.setMemoryProvider(runtime.settings.get().revision, "local");
      // Lore 连接（Hob 自己那份）
      saveLoreConnection(hob.home, { baseUrl: "http://127.0.0.1:18902", token: "lm_own" });
      // 生图配置 + Key
      runtime.settings.setImage(runtime.settings.get().revision, {
        source: "openai",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "img",
      });
      writeSecret(hob.home, IMAGE_KEY_SECRET, "sk-image");
      // 开一次会话（本地记忆）：插件按 PI_MEMORY_DIR 找记忆目录
      const opened = await runtime.pi.open({
        file: join(hob.home, "probe.jsonl"),
        cwd: hob.home,
        model: "hob-faux/faux-1",
        thinking: "off",
        systemPrompt: () => "x",
        tools: [],
        customTools: [],
        memory: "local",
      });
      expect(opened.session.getActiveToolNames()).toContain("memory_write");

      // 两种导入
      const app = createApp(runtime, { home: hob.home });
      const login = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const imported = await app.request("/api/providers/import", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ ids: ["home-proxy"] }),
      });
      expect(imported.status).toBe(200);
      const lore = await app.request("/api/memory/lore/import", { method: "POST", headers: { cookie } });
      expect(lore.status).toBe(200);

      // 本机的两份配置一个字节都没变，也没有多出新文件
      expect(snapshot(localPiDir)).toEqual(piBefore);
      expect(snapshot(localLoreHome)).toEqual(loreBefore);
      // 数据全在 HOB_HOME
      expect(readFileSync(join(hob.home, "system", "secrets.json"), "utf8")).toContain("sk-home");
    } finally {
      hob.close();
      for (const [key, value] of Object.entries(envBefore)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
