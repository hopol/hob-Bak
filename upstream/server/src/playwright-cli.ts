import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLAYWRIGHT_CLI_MODULE = fileURLToPath(new URL("../../node_modules/playwright-core/lib/tools/cli-client/program.js", import.meta.url));

/**
 * Hob's engine prepends its bin directory to every shell's PATH. Keep one
 * launcher there so commands in the assistant, a job, or a script all use the
 * same Playwright CLI implementation.
 */
export function ensurePlaywrightCli(engineDir: string): void {
  const binDir = join(engineDir, "bin");
  const target = join(binDir, "playwright-cli");
  const moduleUrl = pathToFileURL(PLAYWRIGHT_CLI_MODULE).href;
  const parserUrl = pathToFileURL(join(dirname(PLAYWRIGHT_CLI_MODULE), "minimist.js")).href;
  const helpPath = join(dirname(PLAYWRIGHT_CLI_MODULE), "help.json");
  const source = `#!/usr/bin/env node
const command = process.argv[2];
const metadataOnly = ["--version", "-v", "--help", "-h"].includes(command);
const endpoint = process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;
const headers = process.env.PLAYWRIGHT_MCP_CDP_HEADERS;
if (process.env.HOB_PLAYWRIGHT_CACHE_HOME) process.env.XDG_CACHE_HOME = process.env.HOB_PLAYWRIGHT_CACHE_HOME;
delete process.env.PWTEST_DAEMON_SESSION_DIR;
if (!metadataOnly && (!endpoint || !headers)) {
  console.error("云桌面没有开启。");
  process.exit(1);
}
const [{ minimist }, { readFileSync, readdirSync, statSync, writeFileSync }, { join }] = await Promise.all([import(${JSON.stringify(parserUrl)}), import("node:fs"), import("node:path")]);
const help = JSON.parse(readFileSync(${JSON.stringify(helpPath)}, "utf8"));
const args = minimist(process.argv.slice(2), { boolean: [...help.booleanOptions, "all", "g", "help", "json", "raw", "version"], string: ["_"] });
if (args._?.[0] === "kill-all" && !args.help && !args.h && !args.version && !args.v) {
  console.error("kill-all 会终止其他浏览器会话；关闭本会话请用 close 或 close-all。");
  process.exit(1);
}
if (!metadataOnly) {
  let relay;
  try {
    const url = new URL(endpoint);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const colon = headers.indexOf(":");
    relay = { url, headers: { [headers.slice(0, colon).trim()]: headers.slice(colon + 1).trim() } };
    const response = await fetch(url, { headers: relay.headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(await response.text());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  // Hob 填进页面的密码只留在 Hob 进程里：命令的输出和它写进 .playwright-cli 的快照文件先送回 Hob 抹掉密码，再给模型
  const startedAt = Date.now();
  const chunks = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)); return true; };
  const exit = process.exit.bind(process);
  let flushed = false;
  const flush = async () => {
    if (flushed) return;
    flushed = true;
    process.stdout.write = write;
    let text = chunks.join("");
    try {
      const dir = join(process.cwd(), ".playwright-cli");
      const files = readdirSync(dir).filter((name) => /\\.(ya?ml|md|json)$/.test(name)).map((name) => join(dir, name)).filter((path) => statSync(path).mtimeMs >= startedAt);
      const contents = files.map((path) => readFileSync(path, "utf8"));
      if (!text && !contents.length) return;
      const response = await fetch(relay.url, { method: "POST", headers: { ...relay.headers, "content-type": "application/json" }, body: JSON.stringify({ texts: [text, ...contents] }), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()).texts ?? [];
      if (typeof result[0] === "string") text = result[0];
      files.forEach((path, index) => { if (typeof result[index + 1] === "string" && result[index + 1] !== contents[index]) writeFileSync(path, result[index + 1]); });
    } catch {
      // 转发入口不在了（会话已结束）：照原样输出
    }
    if (text) write(text);
  };
  process.exit = (code) => { void flush().finally(() => exit(code)); };
  process.on("beforeExit", () => { if (!flushed) void flush(); });
}
const { program } = await import(${JSON.stringify(moduleUrl)});
await program();
`;
  mkdirSync(binDir, { recursive: true });
  if (!existsSync(target) || readFileSync(target, "utf8") !== source) writeFileSync(target, source, { mode: 0o755 });
  chmodSync(target, 0o755);
}

export const playwrightCliModulePath = PLAYWRIGHT_CLI_MODULE;

/** Close only this Hob session's CLI daemons, including named sessions from other working directories. */
export async function closePlaywrightSessions(cacheDir: string): Promise<void> {
  if (!existsSync(join(cacheDir, "ms-playwright", "daemon"))) return;
  const registry = join(dirname(PLAYWRIGHT_CLI_MODULE), "registry.js");
  const session = join(dirname(PLAYWRIGHT_CLI_MODULE), "session.js");
  const source = `const { Registry } = require(${JSON.stringify(registry)}); const { Session } = require(${JSON.stringify(session)}); (async () => { for (const entries of (await Registry.load()).entryMap().values()) for (const entry of entries) await new Session(entry).stop(); })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cacheDir };
  for (const key of ["HOB_DESKTOP_TOKEN", "HOB_DESKTOP_TOKEN_FILE", "HOB_DESKTOP_URL", "PWTEST_DAEMON_SESSION_DIR"]) delete env[key];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], { env, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => { error += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(error.trim() || `浏览器命令会话退出：${signal ?? code}`));
    });
  });
  rmSync(cacheDir, { recursive: true, force: true });
}
