import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEngineEnv } from "../src/boot.ts";
import { call, makeHob, text } from "./helpers.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "hob-boot-"));
}

describe("启动时把环境指向 HOB_HOME", () => {
  it("引擎、本地记忆、Lore 都指到 HOB_HOME 下面", () => {
    const home = tempHome();
    const env: NodeJS.ProcessEnv = {};
    applyEngineEnv(env, home);
    expect(env.PI_CODING_AGENT_DIR).toBe(join(home, "system", "engine"));
    expect(env.PI_MEMORY_DIR).toBe(join(home, "system", "memory"));
    expect(env.LORE_HOME).toBe(join(home, "system", "lore"));
  });

  it("从 shell 继承的 Lore 凭据全部删掉", () => {
    const env: NodeJS.ProcessEnv = {
      LORE_BASE_URL: "https://api.loremem.com",
      LORE_API_TOKEN: "lm_inherited",
      API_TOKEN: "lm_inherited",
      LORE_CLIENT_TYPE: "claude-code",
      LORE_SKILLS_ENABLED: "1",
      PATH: "/usr/bin",
    };
    applyEngineEnv(env, tempHome());
    for (const key of ["LORE_BASE_URL", "LORE_API_TOKEN", "API_TOKEN", "LORE_CLIENT_TYPE", "LORE_SKILLS_ENABLED"]) {
      expect(env[key], key).toBeUndefined();
    }
    // 别的变量不动
    expect(env.PATH).toBe("/usr/bin");
  });

  it("从 shell 继承的模型密钥和 Claude Code 变量全部删掉", () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      ANTHROPIC_API_KEY: "sk-anthropic",
      ANTHROPIC_AUTH_TOKEN: "token",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      GEMINI_API_KEY: "gemini",
      GOOGLE_API_KEY: "google",
      DEEPSEEK_API_KEY: "deepseek",
      OPENROUTER_API_KEY: "openrouter",
      XAI_API_KEY: "xai",
      GROQ_API_KEY: "groq",
      MISTRAL_API_KEY: "mistral",
      CLAUDECODE: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_ANYTHING_ELSE: "1",
      CLAUDE_CONFIG_DIR: "/other/claude",
      PATH: "/usr/bin",
    };
    applyEngineEnv(env, tempHome());
    for (const key of Object.keys(env)) {
      expect(key === "PATH" || !/API_KEY$|BASE_URL$|AUTH_TOKEN$|^CLAUDE/.test(key), key).toBe(true);
    }
    // 和 Hob 自己无关的变量继续传下去
    expect(env.PATH).toBe("/usr/bin");
  });

  it("不碰 Hob 自己的设置和其他变量", () => {
    const env: NodeJS.ProcessEnv = { HOB_PASSWORD: "secret", HOB_HOME: "/tmp/hob", TZ: "Asia/Shanghai", OPENAI_API_KEY: "sk" };
    applyEngineEnv(env, "/tmp/hob-data");
    expect(env.HOB_PASSWORD).toBe("secret");
    expect(env.HOB_HOME).toBe("/tmp/hob");
    expect(env.TZ).toBe("Asia/Shanghai");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("记下本机配置目录：用户设过 PI_CODING_AGENT_DIR / LORE_HOME 就尊重", () => {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: "/opt/pi-agent", LORE_HOME: "/opt/lore" };
    const dirs = applyEngineEnv(env, tempHome());
    expect(dirs).toEqual({ piDir: "/opt/pi-agent", loreHome: "/opt/lore" });
    expect(env.HOB_LOCAL_PI_DIR).toBe("/opt/pi-agent");
    expect(env.HOB_LOCAL_LORE_HOME).toBe("/opt/lore");
  });

  it("没设过就用用户目录下的默认位置", () => {
    const env: NodeJS.ProcessEnv = {};
    const dirs = applyEngineEnv(env, tempHome());
    expect(dirs.piDir).toBe(join(homedir(), ".pi", "agent"));
    expect(dirs.loreHome).toBe(join(homedir(), ".lore"));
  });

  it("用户直接设了 HOB_LOCAL_* 就照着用，重复调用不会记错", () => {
    const env: NodeJS.ProcessEnv = { HOB_LOCAL_PI_DIR: "/data/pi", PI_CODING_AGENT_DIR: "/opt/pi-agent" };
    expect(applyEngineEnv(env, tempHome()).piDir).toBe("/data/pi");
    // 再调一次：原值已经指到 HOB_HOME 了，不能再把它当成用户的目录
    expect(applyEngineEnv(env, "/tmp/another").piDir).toBe("/data/pi");
  });

  it("删掉继承的密钥后，模型列表和任务照常", async () => {
    Object.assign(process.env, {
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-anthropic",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    });
    const hob = makeHob();
    try {
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

      // 模型只来自 Hob 自己的服务商配置
      const models = await hob.runtime.models.get();
      expect(models.map((model) => model.ref)).toEqual(["hob-faux/faux-1"]);

      hob.faux.setResponses([call("report", { outcome: "done", result: "跑通了" }), text("好了")]);
      const job = await hob.runtime.jobs.start("hob", { title: "试一下", instruction: "跑一下" });
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(job.id)!.status).toBe("done");
    } finally {
      hob.close();
    }
  });
});
