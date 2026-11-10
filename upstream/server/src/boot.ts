// 启动入口：在加载任何引擎模块之前把环境定下来，再交给 main.ts。
//
// 引擎里有模块在加载时就算好目录（`utils/tools-manager.js` 的 TOOLS_DIR、`utils/shell.js`
// 的 PATH 前缀都来自 `getAgentDir()`），靠传参管不到，只能先改环境变量。所以这个文件
// 只能静态导入 node 内置模块和不碰引擎的小工具，main.ts 必须动态导入。
import { homedir } from "node:os";
import { join } from "node:path";
import { engineDir, loreDir, memoryDir, resolveHome } from "./config.ts";
import { prepareHome } from "./layout.ts";

/** 从本机导入时要读的目录（只记路径，不记密钥）。 */
export interface LocalConfigDirs {
  /** 原 PI_CODING_AGENT_DIR，没有就是 ~/.pi/agent */
  piDir: string;
  /** 原 LORE_HOME，没有就是 ~/.lore */
  loreHome: string;
}

/** 从 shell 继承、但必须由 Hob 自己管的变量：删掉，任务里的 bash 也读不到用户的凭据。 */
const INHERITED_CONFIG_ENV = [
  "LORE_BASE_URL",
  "LORE_API_TOKEN",
  "API_TOKEN",
  "LORE_CLIENT_TYPE",
  "LORE_SKILLS_ENABLED",
];

/**
 * 从启动终端继承的模型密钥：Hob 的服务商 Key 只从自己的 secrets.json 来，不读环境变量。
 * 留着的话，任务里的命令能直接拿到用户别的客户端的 Key。
 */
const INHERITED_MODEL_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "CLAUDECODE",
  "CLAUDE_CONFIG_DIR",
];

/** 按前缀删：CLAUDE_CODE_OAUTH_TOKEN 这类 Claude Code 自己的变量一个不留。 */
const INHERITED_ENV_PREFIXES = ["CLAUDE_CODE_"];

/**
 * 把引擎和记忆的环境变量指到 HOB_HOME，删掉从 shell 继承的 Lore 凭据、模型密钥和 Claude Code 的变量，
 * 返回本机配置的目录。纯函数：只改传进来的 env，不读 process.env。
 */
export function applyEngineEnv(env: NodeJS.ProcessEnv, home: string): LocalConfigDirs {
  const piDir = env.HOB_LOCAL_PI_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const loreHome = env.HOB_LOCAL_LORE_HOME?.trim() || env.LORE_HOME?.trim() || join(homedir(), ".lore");
  env.HOB_LOCAL_PI_DIR = piDir;
  env.HOB_LOCAL_LORE_HOME = loreHome;
  env.PI_CODING_AGENT_DIR = engineDir(home);
  env.PI_MEMORY_DIR = memoryDir(home);
  env.LORE_HOME = loreDir(home);
  for (const key of [...INHERITED_CONFIG_ENV, ...INHERITED_MODEL_ENV]) delete env[key];
  for (const key of Object.keys(env)) {
    if (INHERITED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key];
  }
  return { piDir, loreHome };
}

/** 命令行入口：`tsx server/src/boot.ts` 和 npm 包的 `hob` 命令都走这里。 */
export function boot(): void {
  const home = resolveHome();
  // 迁移要在设置引擎目录之前：engine / lore / memory 都在这次搬迁里换位置
  try {
    prepareHome(home);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  applyEngineEnv(process.env, home);
  import("./main.ts")
    .then(({ startHob }) => startHob({ home }))
    .then((server) => {
      console.log(`Hob 在 http://${server.runtime.config.host}:${server.port}（数据目录 ${server.runtime.home}）`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

const isMain = process.argv[1]?.endsWith("boot.ts") || process.argv[1]?.endsWith("boot.js");
if (isMain) boot();
