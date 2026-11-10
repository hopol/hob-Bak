// HOB_HOME 布局迁移的命令行入口：npm run layout -- --dry-run | --restore
//
// 正常情况下启动时自动迁移；这两个开关给试跑和出事后的恢复用。
// --dry-run 只打印计划，什么都不动；--restore 从 backup-v1-* 恢复成老布局。
import { resolveHome } from "./config.ts";
import { migrateHome, restoreHome } from "./layout.ts";

const args = new Set(process.argv.slice(2));
const home = resolveHome();
const usage = "用法：npm run layout -- [--dry-run | --restore]（npm 安装的用 hob layout [--dry-run | --restore]）";

if (args.has("--help") || args.has("-h")) {
  console.log(usage);
} else if (args.has("--dry-run")) {
  console.log(`数据目录：${home}`);
  const summary = migrateHome(home, { dryRun: true });
  console.log(summary.status === "dry-run" ? "（dry-run 没有改动任何文件）" : `当前状态：${summary.status}`);
} else if (args.has("--restore")) {
  console.log(`数据目录：${home}`);
  const result = restoreHome(home);
  console.log(`已恢复到老布局：${result.files} 个文件，备份在 ${result.backupDir}。下次启动会重新迁移。`);
} else {
  console.error(usage);
  process.exit(1);
}
