// 从官方插件源拉取随 Hob 默认自带的插件，原样放进 vendor/default-plugins/。
// 用法：
//   npm run update-default-plugins
//   npm run update-default-plugins -- --source /path/to/hob-plugins
//   npm run update-default-plugins -- --source https://github.com/FFatTiger/hob-plugins
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PLUGINS = ["github"];
const OFFICIAL_URL = "https://github.com/FFatTiger/hob-plugins";

let source = OFFICIAL_URL;
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--source" && process.argv[i + 1]) {
    source = process.argv[++i];
  } else if (!process.argv[i].startsWith("-")) {
    source = process.argv[i];
  }
}

function checkNoSymlinks(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`插件目录不能包含符号链接：${full}`);
    if (stat.isDirectory()) checkNoSymlinks(full);
  }
}

let repoDir = "";
let tempDir = "";
try {
  if (existsSync(source) && lstatSync(source).isDirectory()) {
    repoDir = resolve(source);
  } else {
    tempDir = mkdtempSync(join(tmpdir(), "hob-default-plugins-"));
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--", source, tempDir],
      { stdio: "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    repoDir = tempDir;
  }

  const indexPath = join(repoDir, "index.json");
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : null;
  const entries = Array.isArray(index?.plugins) ? index.plugins : [];

  const targetRoot = fileURLToPath(new URL("../vendor/default-plugins", import.meta.url));
  mkdirSync(targetRoot, { recursive: true });

  for (const id of DEFAULT_PLUGINS) {
    const entry = entries.find((item) => item && typeof item === "object" && item.id === id);
    const rel = typeof entry?.path === "string" ? entry.path : id;
    if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
      throw new Error(`插件 ${id} 的路径无效：${rel}`);
    }
    const srcDir = resolve(repoDir, rel);
    if (!srcDir.startsWith(repoDir + sep) || !existsSync(join(srcDir, "plugin.json"))) {
      throw new Error(`源里找不到插件 ${id}：${srcDir}`);
    }
    checkNoSymlinks(srcDir);
    const manifest = JSON.parse(readFileSync(join(srcDir, "plugin.json"), "utf8"));
    const destDir = join(targetRoot, id);
    rmSync(destDir, { recursive: true, force: true });
    cpSync(srcDir, destDir, {
      recursive: true,
      filter: (p) => !p.slice(srcDir.length).split(sep).includes(".git"),
    });
    console.log(`已更新默认插件 ${id}（版本 ${manifest.version ?? "未知"}）→ ${destDir}`);
  }
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}
