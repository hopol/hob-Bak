// 按需下载固定版本 Bun 到 HOB_HOME/system/runtime/bun/<version>/，校验 SHA-256；
// 用 Bun 装固定版本的 OpenCode 供应商插件包并校验 sha512 integrity。
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import type { PluginInstallProgress, PluginProviderSpec } from "../../shared/types.ts";
import { systemDir } from "./config.ts";
import { proxyEnvironment, type ProxyEnvironmentSettings } from "./network-proxy.ts";

const execFileAsync = promisify(execFile);

/** 固定 Bun 版本（与 Magpie 保持一致）。 */
export const BUN_VERSION = "1.4.2";

/** Bun v1.4.2 官方 SHASUMS256.txt 哈希表。 */
export const BUN_SHA256: Record<string, string> = {
  "bun-darwin-aarch64.zip": "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f",
  "bun-darwin-x64.zip": "80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012",
  "bun-linux-aarch64.zip": "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7",
  "bun-linux-x64-baseline.zip": "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f",
  "bun-linux-aarch64-musl.zip": "71760b6c8ea30623b81a4907cb815d48e2ea266f2e73e751534a44a0607950df",
  "bun-linux-x64-musl-baseline.zip": "76e1db84e98f22f78de0a87e309bfbbf297732847f9720db36750646c85c8c18",
  "bun-windows-x64-baseline.zip": "78c221c2376f79731ccf4e4af0b3bb46d81fefa3296c5abee09ad8a1b21e68c6",
  "bun-windows-aarch64.zip": "a7a16b876a305fd1029c66dbd27007b4f6112ae896532f675878731a21e50cfd",
};

const DEFAULT_BUN_RELEASE_BASE = "https://github.com/oven-sh/bun/releases/download";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const BUN_DOWNLOAD_TIMEOUT_MS = 180_000;
const TARBALL_DOWNLOAD_TIMEOUT_MS = 90_000;
const BUN_INSTALL_TIMEOUT_MS = 120_000;
const MAX_BUN_ZIP_BYTES = 150 * 1024 * 1024;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;

export type InstallProgressCallback = (event: Omit<PluginInstallProgress, "pluginId">) => void;

export interface BunRuntimeOptions {
  home: string;
  proxy?: () => ProxyEnvironmentSettings;
  /** 测试或自定义镜像用 */
  bunBaseUrl?: string;
  bunChecksums?: Record<string, string>;
  /** 测试用：直接指定已有 bun 可执行文件，跳过下载 */
  bunPath?: string;
  npmRegistry?: string;
  fetchImpl?: typeof fetch;
}

/** 判断当前 Linux 是否使用 musl libc（如 Alpine）。 */
export function isMuslLinux(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (report?.header && !report.header.glibcVersionRuntime) return true;
  } catch { /* ignore */ }
  return existsSync("/etc/alpine-release");
}

/** 计算当前平台对应的 Bun 发行包名（不含 .zip）。 */
export function bunTargetFor(platform: string = process.platform, arch: string = process.arch, musl: boolean = isMuslLinux()): string {
  const mappedArch = arch === "arm64" ? "aarch64" : arch === "x64" ? "x64" : "";
  if (!mappedArch) throw new Error(`Bun 不支持当前架构：${platform}/${arch}`);
  if (platform === "darwin") return `bun-darwin-${mappedArch}`;
  if (platform === "win32") return mappedArch === "x64" ? "bun-windows-x64-baseline" : "bun-windows-aarch64";
  if (platform === "linux") {
    const base = `bun-linux-${mappedArch}${musl ? "-musl" : ""}`;
    return mappedArch === "x64" ? `${base}-baseline` : base;
  }
  throw new Error(`Bun 不支持当前操作系统：${platform}`);
}

export function bunExeName(platform: string = process.platform): string {
  return platform === "win32" ? "bun.exe" : "bun";
}

export function bunBinaryPath(home: string, version = BUN_VERSION): string {
  return join(systemDir(home), "runtime", "bun", version, bunExeName());
}

/** 构造发给 Bun 子进程的干净环境变量：只保留系统运行必需项与 Hob 代理，清掉 Hob 与模型密钥。 */
export function sanitizedBunEnv(
  proxySettings: ProxyEnvironmentSettings = { proxy: "", noProxy: "" },
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  const allowExact = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TEMP", "TMP",
    "TERM", "COLORTERM", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  ]);
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (allowExact.has(key) || key.startsWith("LC_") || key.startsWith("XDG_")) {
      safe[key] = value;
    }
  }
  const proxied = proxyEnvironment(safe, proxySettings);
  for (const [key, value] of Object.entries(proxied)) {
    if (value !== undefined) safe[key] = value;
  }
  // 禁止 Bun 遥测与自动更新提示
  safe.DO_NOT_TRACK = "1";
  safe.BUN_INSTALL_CACHE_DIR = join(safe.TMPDIR || safe.TEMP || "/tmp", "hob-bun-cache");
  return safe;
}

/**
 * 纯 Node 读取 ZIP 中指定文件名（按 basename 匹配，忽略目录层级）的内容。
 * 解析 EOCD 与 Central Directory，兼容 data descriptor（bit 3）和 Store/Deflate。
 */
export function extractFileFromZip(zip: Buffer, targetName: string): Buffer {
  // 从末尾向前查找 End of Central Directory (0x06054b50)
  const minOffset = Math.max(0, zip.length - 65_557);
  let eocd = -1;
  for (let i = zip.length - 22; i >= minOffset; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      const commentLen = zip.readUInt16LE(i + 20);
      if (i + 22 + commentLen === zip.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) throw new Error("Bun 压缩包损坏：找不到 ZIP 目录结束标记");

  const entryCount = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  let pos = cdOffset;
  const wanted = targetName.toLowerCase();

  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > zip.length || zip.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error("Bun 压缩包损坏：ZIP 目录项无效");
    }
    const method = zip.readUInt16LE(pos + 10);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const uncompressedSize = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;

    if (basename(name).toLowerCase() !== wanted) continue;
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("Bun 压缩包损坏：本地文件头无效");
    }
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) throw new Error("Bun 压缩包损坏：文件数据越界");
    const compressed = zip.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : (() => {
      throw new Error(`Bun 压缩包使用了不支持的压缩方式：${method}`);
    })();
    if (data.length !== uncompressedSize) {
      throw new Error(`Bun 解压大小不匹配：期望 ${uncompressedSize}，实际 ${data.length}`);
    }
    return data;
  }
  throw new Error(`Bun 压缩包里找不到 ${targetName}`);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha512Integrity(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function providerRuntimeDir(pluginDir: string): string {
  return join(pluginDir, "providers-runtime");
}

export function resolveProviderPackageDir(pluginDir: string, pkgName: string): string {
  return join(providerRuntimeDir(pluginDir), "node_modules", ...pkgName.split("/"));
}

async function downloadBuffer(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void,
): Promise<Buffer> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）：${url}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
  if (totalBytes && totalBytes > maxBytes) {
    throw new Error(`下载文件过大（${Math.round(totalBytes / 1024 / 1024)} MB）：${url}`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`下载文件过大：${url}`);
    onProgress?.(buf.length, totalBytes ?? buf.length);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  let lastReported = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.length;
      if (downloaded > maxBytes) {
        throw new Error(`下载文件超过大小限制：${url}`);
      }
      chunks.push(value);
      if (downloaded - lastReported >= 256 * 1024 || (totalBytes && downloaded >= totalBytes)) {
        lastReported = downloaded;
        onProgress?.(downloaded, totalBytes);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  onProgress?.(downloaded, totalBytes ?? downloaded);
  return Buffer.concat(chunks);
}

/** 管理 Hob 私有 Bun 运行时与供应商插件包安装（串行化 bun 命令，单飞下载 Bun）。 */
export class BunRuntime {
  private downloading?: Promise<string>;
  private installQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: BunRuntimeOptions) {}

  get version(): string {
    return BUN_VERSION;
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private get proxySettings(): ProxyEnvironmentSettings {
    return this.options.proxy?.() ?? { proxy: "", noProxy: "" };
  }

  /** 返回当前可用的 Bun 路径（已安装或显式指定），未安装返回 null。 */
  installedPath(): string | null {
    const override = this.options.bunPath || process.env.HOB_BUN_PATH;
    if (override && existsSync(override)) return override;
    const local = bunBinaryPath(this.options.home, BUN_VERSION);
    return existsSync(local) ? local : null;
  }

  /** 确保固定版本 Bun 存在：已存在直接返回，否则按需下载、校验 SHA-256 并解压。 */
  async ensureBun(onProgress?: InstallProgressCallback): Promise<string> {
    const existing = this.installedPath();
    if (existing) return existing;
    if (this.downloading) return this.downloading;
    this.downloading = this.downloadBun(onProgress).finally(() => {
      this.downloading = undefined;
    });
    return this.downloading;
  }

  private async downloadBun(onProgress?: InstallProgressCallback): Promise<string> {
    const target = bunTargetFor();
    const archive = `${target}.zip`;
    const checksums = this.options.bunChecksums ?? BUN_SHA256;
    const expectedHash = checksums[archive];
    if (!expectedHash) throw new Error(`没有找到 ${archive} 的校验哈希`);

    const base = (this.options.bunBaseUrl ?? process.env.HOB_BUN_BASE_URL ?? DEFAULT_BUN_RELEASE_BASE).replace(/\/+$/, "");
    const url = `${base}/bun-v${BUN_VERSION}/${archive}`;

    onProgress?.({ stage: "downloading_bun", downloadedBytes: 0, message: `正在下载运行环境 Bun ${BUN_VERSION}…` });
    const zipBytes = await downloadBuffer(url, this.fetchImpl, BUN_DOWNLOAD_TIMEOUT_MS, MAX_BUN_ZIP_BYTES, (downloadedBytes, totalBytes) => {
      const percent = totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : undefined;
      onProgress?.({
        stage: "downloading_bun",
        downloadedBytes,
        ...(totalBytes ? { totalBytes } : {}),
        ...(percent !== undefined ? { percent } : {}),
        message: `正在下载运行环境 Bun ${BUN_VERSION}…`,
      });
    });

    onProgress?.({ stage: "verifying_bun", message: "正在校验运行环境哈希…" });
    const actualHash = sha256Hex(zipBytes);
    if (actualHash !== expectedHash.toLowerCase()) {
      throw new Error(`Bun 运行环境哈希校验失败：期望 ${expectedHash}，实际 ${actualHash}`);
    }

    onProgress?.({ stage: "extracting_bun", message: "正在解压运行环境…" });
    const exeName = bunExeName();
    const binary = extractFileFromZip(zipBytes, exeName);
    const dest = bunBinaryPath(this.options.home, BUN_VERSION);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, binary, { mode: 0o755 });
      if (process.platform !== "win32") chmodSync(tmp, 0o755);
      renameSync(tmp, dest);
    } finally {
      rmSync(tmp, { force: true });
    }
    return dest;
  }

  /** 解析包的 tarball 下载地址：清单直接给了 tarball 就用它，否则从 npm 精确版本元数据读取。 */
  private async resolveTarballUrl(spec: PluginProviderSpec): Promise<string> {
    if (spec.tarball) return spec.tarball;
    const registry = (this.options.npmRegistry ?? process.env.HOB_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
    const metaUrl = `${registry}/${encodeURIComponent(spec.package)}/${encodeURIComponent(spec.version)}`;
    const response = await this.fetchImpl(metaUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`无法从 npm 获取 ${spec.package}@${spec.version}（HTTP ${response.status}）`);
    }
    const meta = await response.json() as { dist?: { tarball?: string; integrity?: string } };
    const tarball = meta?.dist?.tarball;
    if (typeof tarball !== "string" || !tarball) {
      throw new Error(`npm 元数据缺少 ${spec.package}@${spec.version} 的安装包地址`);
    }
    return tarball;
  }

  /**
   * 用 Bun 安装一个插件声明的全部供应商包到插件目录下的 providers-runtime/。
   * 下载精确版本 tarball → 校验 sha512 integrity → 按插件目录中的 Bun 锁文件冻结安装并核对版本号。
   */
  async installPackages(
    pluginDir: string,
    specs: PluginProviderSpec[],
    onProgress?: InstallProgressCallback,
  ): Promise<void> {
    if (!specs.length) return;
    const bun = await this.ensureBun(onProgress);

    // 串行化 bun 安装，避免共享缓存冲突
    const run = async () => {
      const tempWork = join(pluginDir, `.providers-tmp-${randomUUID()}`);
      const staging = join(pluginDir, `providers-runtime.${randomUUID()}.tmp`);
      const target = providerRuntimeDir(pluginDir);
      const backup = `${target}.${randomUUID()}.bak`;
      const manifestPath = join(pluginDir, "package.json");
      const lockPath = join(pluginDir, "bun.lock");
      mkdirSync(tempWork, { recursive: true });
      mkdirSync(staging, { recursive: true });

      try {
        const localTarballs: { spec: PluginProviderSpec; file: string }[] = [];
        for (const spec of specs) {
          onProgress?.({ stage: "installing_package", package: spec.package, message: `正在下载 ${spec.package}@${spec.version}…` });
          const tarballUrl = await this.resolveTarballUrl(spec);
          const bytes = await downloadBuffer(tarballUrl, this.fetchImpl, TARBALL_DOWNLOAD_TIMEOUT_MS, MAX_TARBALL_BYTES);

          onProgress?.({ stage: "verifying_package", package: spec.package, message: `正在校验 ${spec.package}@${spec.version}…` });
          const actual = sha512Integrity(bytes);
          if (actual !== spec.integrity) {
            throw new Error(`包 ${spec.package}@${spec.version} 完整性校验失败：期望 ${spec.integrity}，实际 ${actual}`);
          }
          const safeFile = `${spec.package.replace(/[^a-zA-Z0-9._-]/g, "_")}-${spec.version}.tgz`;
          const tgzPath = join(tempWork, safeFile);
          writeFileSync(tgzPath, bytes);
          localTarballs.push({ spec, file: tgzPath });
        }

        if (!existsSync(manifestPath) || !existsSync(lockPath)) {
          throw new Error("带模型插件缺少 package.json 或 bun.lock，拒绝安装");
        }
        const packageManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, unknown> };
        const dependencies = packageManifest.dependencies;
        if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
          throw new Error("带模型插件的 package.json 缺少 dependencies");
        }
        const expected = new Map(specs.map((spec) => [spec.package, spec.tarball ?? spec.version]));
        const actualKeys = Object.keys(dependencies).sort();
        const expectedKeys = [...expected.keys()].sort();
        if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) || actualKeys.some((name) => dependencies[name] !== expected.get(name))) {
          throw new Error("package.json 的供应商清单与 plugin.json 不一致，拒绝安装");
        }
        writeFileSync(join(staging, "package.json"), readFileSync(manifestPath));
        writeFileSync(join(staging, "bun.lock"), readFileSync(lockPath));

        const env = sanitizedBunEnv(this.proxySettings);
        // 优先让 bun cache 留在 HOB_HOME/cache/bun 里，不污染用户全局缓存
        env.BUN_INSTALL_CACHE_DIR = join(this.options.home, "cache", "bun");
        mkdirSync(env.BUN_INSTALL_CACHE_DIR, { recursive: true });

        for (const { spec } of localTarballs) {
          onProgress?.({ stage: "installing_package", package: spec.package, message: `正在安装 ${spec.package}@${spec.version}…` });
        }
        try {
          await execFileAsync(bun, ["install", "--frozen-lockfile", "--ignore-scripts", "--no-progress"], {
            cwd: staging,
            env,
            timeout: BUN_INSTALL_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
          });
        } catch (error) {
          const err = error as { stderr?: string; message?: string };
          const detail = err.stderr?.trim() || err.message || String(error);
          throw new Error(`按锁文件安装供应商包失败：${detail.slice(0, 600)}`);
        }

        for (const { spec } of localTarballs) {
          const pkgJsonPath = join(staging, "node_modules", ...spec.package.split("/"), "package.json");
          if (!existsSync(pkgJsonPath)) {
            throw new Error(`安装 ${spec.package}@${spec.version} 后找不到 package.json`);
          }
          const installed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string; version?: string };
          if (installed.name !== spec.package || installed.version !== spec.version) {
            throw new Error(`安装的包版本不匹配：期望 ${spec.package}@${spec.version}，实际 ${installed.name ?? "?"}@${installed.version ?? "?"}`);
          }
        }

        let movedOld = false;
        if (existsSync(target)) {
          renameSync(target, backup);
          movedOld = true;
        }
        try {
          renameSync(staging, target);
        } catch (error) {
          if (movedOld) renameSync(backup, target);
          throw error;
        }
        rmSync(backup, { recursive: true, force: true });
        onProgress?.({ stage: "done", message: "安装完成" });
      } finally {
        rmSync(tempWork, { recursive: true, force: true });
        rmSync(staging, { recursive: true, force: true });
      }
    };

    const next = this.installQueue.catch(() => {}).then(run);
    this.installQueue = next.catch(() => {});
    await next;
  }
}
