import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { engineDir, loadConfig, resolveHome } from "./config.ts";
import { createApp } from "./http.ts";
import { prepareHome } from "./layout.ts";
import { attachDesktopWebSocket } from "./desktop-control.ts";
import { PiHost } from "./pi.ts";
import { createRuntime, type HobRuntime } from "./runtime.ts";
import { readLegacyModels } from "./settings.ts";

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

  runtime.delegations.recovering = true;
  runtime.jobs.recover();
  runtime.projects.recover();
  runtime.delegations.recover();
  runtime.routines.start();
  runtime.jobs.startWatchdog();
  runtime.desktopEvents.restart();
  // 消耗统计第一次要扫一遍会话文件（几百 MB）：先异步跑起来，服务不等它
  runtime.usage.warmup();

  const app = createApp(runtime, { webDir: fileURLToPath(new URL("../../dist/web", import.meta.url)), home });
  const port = options.port ?? Number(env.HOB_PORT ?? config.port);
  const server = serve({ fetch: app.fetch, port, hostname: config.host });
  const detachDesktop = attachDesktopWebSocket(server, runtime);

  return {
    runtime,
    port,
    close: async () => {
      detachDesktop();
      runtime.desktopEvents.stop();
      runtime.desktopControl.dispose();
      runtime.routines.stop();
      runtime.jobs.disposeAll();
      runtime.router.disposeAll();
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
