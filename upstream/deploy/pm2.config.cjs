// 线上 Hob：pm2 start deploy/pm2.config.cjs（数据 ~/.hob，端口 30148）
// 入口是 server/src/boot.ts：它在加载引擎之前把环境指到 HOB_HOME，不读也不写别的工具的配置。
module.exports = {
  apps: [
    {
      name: "hob",
      cwd: __dirname + "/..",
      script: "node_modules/.bin/tsx",
      args: "server/src/boot.ts",
      env: { HOB_PORT: "30148", NODE_ENV: "production" },
      max_memory_restart: "800M",
      kill_timeout: 10000,
    },
  ],
};
