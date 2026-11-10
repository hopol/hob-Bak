#!/usr/bin/env node
// npm 包的 `hob` 命令：用 tsx 直接跑 TypeScript 源码，和 `npm start` 是同一个入口。
import { register } from "tsx/esm/api";

register();
// `hob layout --dry-run | --restore`：数据目录布局的试跑和恢复，和 `npm run layout` 一样
if (process.argv[2] === "layout") {
  process.argv.splice(2, 1);
  await import("../server/src/layout-cli.ts");
} else {
  const { boot } = await import("../server/src/boot.ts");
  boot();
}
