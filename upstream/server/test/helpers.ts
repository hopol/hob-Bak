import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { MemoryProvider, ModelSettings, ProviderSettings, SettingsPatch } from "../../shared/types.ts";
import { applyEngineEnv } from "../src/boot.ts";
import type { HobConfig } from "../src/config.ts";
import type { PushSender } from "../src/push.ts";
import { PiHost } from "../src/pi.ts";
import { hashPassword } from "../src/password.ts";
import { createRuntime, type HobRuntime } from "../src/runtime.ts";
import { defaultSettings } from "../src/settings.ts";

export interface TestHob {
  runtime: HobRuntime;
  home: string;
  faux: ReturnType<typeof fauxProvider>;
  close: () => void;
}

export interface MakeHobOptions {
  /** 测试要改的设置（按节合并进 settings.json） */
  settings?: SettingsPatch;
  tokensPerSecond?: number;
  /** 假模型注册表里的模型（第一个是默认）；thinkingLevelMap 模拟引擎注册表里自带的映射（Hob 不读它） */
  models?: { id: string; input?: ("text" | "image")[]; reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap }[];
  /** 不去写 settings.json（测迁移用） */
  keepSettings?: boolean;
  /** 记忆提供者：写进 settings.json 的 memory 键（不写就按有没有配好 Lore 推） */
  memory?: MemoryProvider;
  /** 一开始就配好的服务商（写进 settings.json，Key 由测试自己写 secrets.json） */
  providers?: ProviderSettings[];
  /** 测试注入的推送发送器（不碰网络） */
  pushSender?: PushSender;
  /** 测试注入假的服务商接口（拉模型列表用） */
  fetchImpl?: typeof fetch;
}

/**
 * 本地记忆插件在模块加载时就把记忆目录定下来，Lore 的目录也一样：
 * 测试里每个实例都指到自己的临时目录（见 applyEngineEnv），不碰真的数据目录。
 */
export function memoryDir(): string {
  return process.env.PI_MEMORY_DIR!;
}

/** Lore 连接目录：HOB_HOME/lore（由 applyEngineEnv 指过来，测试不读机器上的 ~/.lore）。 */
export function loreHome(): string {
  return process.env.LORE_HOME!;
}

/** 假模型 + 临时 HOB_HOME 的一整套服务，测试不碰真实模型。 */
export function makeHob(overrides: Partial<HobConfig> = {}, options: MakeHobOptions = {}): TestHob {
  const home = mkdtempSync(join(tmpdir(), "hob-test-"));
  // 和启动入口一样：引擎、本地记忆、Lore 的目录都指到这个临时目录，
  // 进程里继承的 LORE_* 也删掉（那台机器上可能已经配好了 Lore）
  applyEngineEnv(process.env, home);
  const definitions = options.models ?? [{ id: "faux-1" }];
  const faux = fauxProvider({
    provider: "hob-faux",
    models: definitions.map((model) => ({ contextWindow: 200_000, ...model })),
    tokensPerSecond: options.tokensPerSecond ?? 200_000,
  });
  // 假模型本身没有思考档映射，按测试给的定义补上（引擎注册表里是同一批对象）
  definitions.forEach((definition, index) => {
    if (definition.thinkingLevelMap) faux.models[index].thinkingLevelMap = definition.thinkingLevelMap;
  });
  const config: HobConfig = {
    passwordHash: hashPassword("test"),
    cookieSecret: "cookie-secret",
    host: "127.0.0.1",
    port: 30148,
    ...overrides,
  };
  // 测试固定用一个非系统时区（Asia/Shanghai），这样时区相关的断言不依赖机器；
  // 模型默认给假模型，思考档 off（假模型不会推理，这样也不会被 clamp）
  const settings = defaultSettings("Asia/Shanghai");
  const defaultModel = `hob-faux/${definitions[0].id}`;
  const seedModels: ModelSettings = {
    roster: [{ ref: defaultModel, note: "" }],
    conversation: { ref: defaultModel, thinking: "off" },
    work: { ref: defaultModel, thinking: "off" },
  };
  const merged = {
    general: { ...settings.general, ...(options.settings?.general ?? {}) },
    providers: options.providers ?? [],
    models: options.settings?.models ? { ...seedModels, ...options.settings.models } : seedModels,
    work: { ...settings.work, ...(options.settings?.work ?? {}) },
  };
  mkdirSync(join(home, "system"), { recursive: true });
  writeFileSync(join(home, "system", "config.json"), JSON.stringify(config));
  if (!options.keepSettings) {
    writeFileSync(
      join(home, "system", "settings.json"),
      JSON.stringify({
        revision: 1,
        settings: merged,
        ...(options.memory ? { memory: { provider: options.memory } } : {}),
      }),
    );
  }
  const pi = new PiHost({
    engineDir: join(home, "system", "engine"),
    nativeProviders: [faux.provider],
  });
  const runtime = createRuntime({
    home,
    config,
    pi,
    ...(options.pushSender ? { pushSender: options.pushSender } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return {
    runtime,
    home,
    faux,
    close: () => {
      runtime.desktopEvents.stop();
      runtime.desktopControl.dispose();
      runtime.jobs.disposeAll();
      runtime.router.disposeAll();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function text(value: string) {
  return fauxAssistantMessage(value);
}

export function call(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

export async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等到超时");
}
