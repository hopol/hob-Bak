import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { engineDir, loadConfig, resolveHome } from "./config.ts";
import { createApp } from "./http.ts";
import { prepareHome } from "./layout.ts";
import { attachDesktopWebSocket } from "./desktop-control.ts";
import { PiHost } from "./pi.ts";
import { createRuntime, type HobRuntime } from "./runtime.ts";
import { generalSkillsDir, syncGeneralIndex } from "./skills.ts";
import { ensurePlaywrightCli } from "./playwright-cli.ts";
import { readLegacyModels } from "./settings.ts";
import { releaseIdleTodosAtStartup } from "./todos.ts";
import { seedBuiltinVault, seedDefaultPlugins } from "./dev-team.ts";
import { retirePluginCards } from "./actions.ts";

export interface StartOptions {
  home?: string;
  port?: number;
  pi?: PiHost;
}

export interface HobServer {
  runtime: HobRuntime;
  port: number;
  close: () => Promise<void>;
}

/** 起一个 Hob 进程内全部服务（HTTP + Router + 任务 + 定时）。试跑和测试都走这里。 */
export async function startHob(options: StartOptions = {}): Promise<HobServer> {
  const home = options.home ?? resolveHome();
  // 从 boot.ts 进来时已经迁过（幂等）；直接从 main 起的路径也补上
  prepareHome(home);
  ensurePlaywrightCli(engineDir(home));
  const env = process.env;
  const pi = options.pi ?? new PiHost({ engineDir: engineDir(home) });
  // config.json 里的旧模型字段在 loadConfig 里被清掉，所以先读出来搬进设置
  const legacyModels = readLegacyModels(home);
  const config = loadConfig(home, env);
  const runtime = createRuntime({
    home,
    config,
    pi,
    ...(legacyModels ? { legacyModels } : {}),
  });

  seedBuiltinVault(runtime.plugins.store, id => retirePluginCards(runtime, id));
  seedDefaultPlugins(runtime.plugins.store);
  runtime.delegations.recovering = true;
  // 通用技能目录里可能放着从别处来的技能：启动时给没登记的补上索引，之后改、删、回退都按索引走
  syncGeneralIndex(generalSkillsDir(home));
  runtime.jobs.recover();
  runtime.delegations.recover();
  runtime.groups.recoverHandovers();
  // 重启后没有在跑的一轮，任务按中断、转交按中断处理过了：手上没活的待办这时候收起
  releaseIdleTodosAtStartup(runtime);
  void runtime.plugins.start().catch(error => console.error("插件连接启动失败：", error));
  runtime.routines.start();
  runtime.jobs.startWatchdog();
  runtime.desktopEvents.restart();
  // 消耗统计第一次要扫一遍会话文件（几百 MB）：先异步跑起来，服务不等它
  runtime.usage.warmup();
  // 版本检查只在真正启动服务时跑（启动查一次，之后每 6 小时查一次）
  runtime.update.start();

  const app = createApp(runtime, { webDir: fileURLToPath(new URL("../../dist/web", import.meta.url)), home });
  const port = options.port ?? Number(env.HOB_PORT ?? config.port);
  const server = serve({ fetch: app.fetch, port, hostname: config.host });
  const detachDesktop = attachDesktopWebSocket(server, runtime);

  return {
    runtime,
    port,
    close: async () => {
      detachDesktop();
      runtime.update.stop();
      runtime.desktopEvents.stop();
      runtime.desktopControl.dispose();
      runtime.routines.stop();
      runtime.scriptTools.close();
      runtime.jobs.disposeAll();
      runtime.router.disposeAll();
      await runtime.providerPlugins.close();
      await runtime.plugins.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (isMain) {
  startHob()
    .then((server) => {
      console.log(`Hob 在 http://${server.runtime.config.host}:${server.port}（数据目录 ${server.runtime.home}）`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
