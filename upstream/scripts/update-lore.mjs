// 把 Hob 自带的 Lore 插件换成 Lore 的某个正式版：下载 GitHub Release 里的 lore-pi.zip，原样放进 vendor/lore-pi-extension。
// vendor 里的代码只从正式版来，不手改；Lore 发了新版就跑一次这个脚本，测试通过后随 Hob 一起发布。
// 用法：npm run update-lore -- 1.12.5（需要系统里有 unzip）
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("用法：npm run update-lore -- <版本号>，例如 1.12.5");
  process.exit(1);
}

const SKIP = new Set(["__tests__", "scripts", "package-lock.json", "vitest.config.ts"]);
const url = `https://github.com/FFatTiger/lore/releases/download/v${version}/lore-pi.zip`;
const response = await fetch(url);
if (!response.ok) throw new Error(`下载失败（${response.status}）：${url}`);

const temp = mkdtempSync(join(tmpdir(), "lore-pi-"));
try {
  const zip = join(temp, "lore-pi.zip");
  const unpacked = join(temp, "pkg");
  writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  execFileSync("unzip", ["-q", zip, "-d", unpacked]);
  const pkg = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8"));
  if (pkg.version !== version) throw new Error(`包里的版本是 ${pkg.version}，不是 ${version}`);

  // 测试、开发配置和给 pi 命令行用的安装脚本不随 Hob 发布
  const target = fileURLToPath(new URL("../vendor/lore-pi-extension", import.meta.url));
  rmSync(target, { recursive: true, force: true });
  cpSync(unpacked, target, {
    recursive: true,
    filter: (source) => !source.slice(unpacked.length).split(sep).some((part) => SKIP.has(part)),
  });
  console.log(`Lore 插件已换成 ${version}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
