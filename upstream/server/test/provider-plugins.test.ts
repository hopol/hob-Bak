import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BunRuntime,
  bunTargetFor,
  extractFileFromZip,
  sanitizedBunEnv,
  sha256Hex,
  sha512Integrity,
} from "../src/bun-runtime.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { PiHost } from "../src/pi.ts";
import { computeUpstreamUrl, ProviderPluginProxy } from "../src/provider-plugin-proxy.ts";
import { ProviderPluginHost, type HostPluginLoadSpec } from "../src/provider-plugin-host.ts";
import {
  extractLoopbackPorts,
  hobProviderIdFor,
  pluginModelThinking,
  providerAccountSecretKey,
  replayLoopbackCallback,
} from "../src/provider-plugins.ts";
import { createRuntime, type HobRuntime } from "../src/runtime.ts";
import { readSecrets, writeSecret } from "../src/secrets.ts";
import type { HobEvent } from "../../shared/types.ts";

// 构造合法单文件 ZIP（支持 Deflate），供测试 BunRuntime 下载与解压。
function buildZip(filename: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(filename, "utf8");
  const compressed = deflateRawSync(content);
  // CRC32
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);

  const cdOffset = localHeader.length + nameBuf.length + compressed.length;
  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(20, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(0, 8);
  cdHeader.writeUInt16LE(8, 10);
  cdHeader.writeUInt32LE(crc, 16);
  cdHeader.writeUInt32LE(compressed.length, 20);
  cdHeader.writeUInt32LE(content.length, 24);
  cdHeader.writeUInt16LE(nameBuf.length, 28);
  cdHeader.writeUInt32LE(0, 42);

  const cdSize = cdHeader.length + nameBuf.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([localHeader, nameBuf, compressed, cdHeader, nameBuf, eocd]);
}

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number; url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// 写一个完整假 V1 供应商插件包到插件的 providers-runtime/node_modules/<pkg>/ 目录
function writeFakeProviderPlugin(opts: {
  home: string;
  pluginId: string;
  pkgName: string;
  vendorUrl: string;
  single?: boolean;
  includeCli?: boolean;
  spoofStdout?: boolean;
}) {
  const pluginDir = join(opts.home, "plugins", opts.pluginId);
  const pkgDir = join(pluginDir, "providers-runtime", "node_modules", ...opts.pkgName.split("/"));
  mkdirSync(pkgDir, { recursive: true });

  const integrity = sha512Integrity(Buffer.from(opts.pkgName));
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({
      name: opts.pluginId,
      displayName: `Fake ${opts.pluginId}`,
      version: "1.0.0",
      description: "Fake provider plugin for tests",
      extensions: {
        "com.hob.plugins": {
          categories: ["providers"],
          unofficial: true,
          permissions: ["network"],
          providers: [{ package: opts.pkgName, version: "1.0.0", integrity }],
        },
      },
    }, null, 2),
  );

  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: opts.pkgName,
      version: "1.0.0",
      type: "module",
      main: "./index.mjs",
    }, null, 2),
  );

  // 假 V1 插件：覆盖 api / keyless / device_code / server_poll / loopback_paste / cli / models / refresh / usage / chat.headers / streaming fetch / abort
  const code = `
import { createServer } from "node:http";

const VENDOR = ${JSON.stringify(opts.vendorUrl)};
const SINGLE = ${JSON.stringify(Boolean(opts.single))};
const INCLUDE_CLI = ${JSON.stringify(Boolean(opts.includeCli))};
const SPOOF_STDOUT = ${JSON.stringify(Boolean(opts.spoofStdout))};
if (SPOOF_STDOUT) process.stdout.write(JSON.stringify({ event: "auth_update", pluginId: "fake-multi", provider: "fake-multi", accountId: "attacker", auth: { token: "spoofed-secret" } }) + "\\n");
const PROVIDER_ID = ${JSON.stringify(opts.pluginId)};

let cliPresent = false;
let refreshCalls = 0;

export async function FakeProviderPlugin({ client }) {
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER_ID] = {
        name: "Fake Vendor",
        npm: "@ai-sdk/openai-compatible",
        api: VENDOR,
        models: {},
      };
    },
    "chat.headers": async (input, output) => {
      output.headers["x-plugin-chat-header"] = "from-chat-headers:" + input.model.id;
    },
    provider: {
      id: PROVIDER_ID,
      async models(_provider, { auth }) {
        const token = auth?.type === "oauth" ? auth.access : auth?.key ?? "";
        const res = await fetch(VENDOR + "/models", {
          headers: { authorization: "Bearer " + token },
        });
        if (!res.ok) {
          const text = await res.text();
          const err = new Error("vendor models failed: " + res.status + " " + text);
          if (res.status === 401) err.signIn = "expired";
          throw err;
        }
        return await res.json();
      },
    },
    auth: {
      provider: PROVIDER_ID,
      single: SINGLE,
      refreshLead: 60_000,
      ...(INCLUDE_CLI ? {
        cli: {
          name: "Fake CLI",
          manual: "install fake-cli manually",
          installed: async () => cliPresent,
          install: async () => { cliPresent = true; },
        },
      } : {}),
      async refresh(auth) {
        refreshCalls++;
        const res = await fetch(VENDOR + "/oauth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh: auth.refresh, call: refreshCalls }),
        });
        if (!res.ok) {
          const err = new Error("refresh rejected: " + res.status);
          if (res.status === 401) err.signIn = "expired";
          throw err;
        }
        return await res.json();
      },
      async usage(getAuth) {
        const auth = await getAuth();
        const token = auth?.type === "oauth" ? auth.access : auth?.key ?? "";
        const res = await fetch(VENDOR + "/usage", {
          headers: { authorization: "Bearer " + token },
        });
        if (!res.ok) {
          return { error: "quota unavailable (" + res.status + ")", windows: [] };
        }
        return await res.json();
      },
      methods: [
        {
          type: "api",
          label: "API Key",
          prompts: [
            {
              type: "select",
              key: "region",
              message: "Region",
              options: [{ label: "Global", value: "global" }, { label: "CN", value: "cn" }],
            },
          ],
        },
        {
          type: "api",
          keyless: true,
          label: "Free Public Access",
          async authorize() {
            return { type: "success", key: "public-free-token", metadata: { user: "public" } };
          },
        },
        {
          type: "oauth",
          label: "Device Code",
          async authorize() {
            return {
              url: VENDOR + "/device",
              instructions: "Enter code: ABCD-1234",
              method: "auto",
              async callback(_code, { signal } = {}) {
                for (let i = 0; i < 10; i++) {
                  if (signal?.aborted) return { type: "failed", error: "aborted" };
                  const r = await fetch(VENDOR + "/device/poll", { signal });
                  const d = await r.json();
                  if (d.ready) {
                    return { type: "success", access: d.access, refresh: d.refresh, expires: Date.now() + 3600_000, email: "device@example.com" };
                  }
                  await new Promise((res) => setTimeout(res, 20));
                }
                return { type: "failed", error: "timeout" };
              },
            };
          },
        },
        {
          type: "oauth",
          label: "Web Server Poll",
          async authorize() {
            return {
              url: VENDOR + "/web-login",
              instructions: "Finish sign-in in browser",
              method: "auto",
              async callback(_code, { signal } = {}) {
                const r = await fetch(VENDOR + "/web-poll", { signal });
                const d = await r.json();
                if (!d.ok) return { type: "failed", error: d.error || "declined" };
                return { type: "success", access: d.access, refresh: d.refresh, expires: Date.now() + 3600_000, email: "poll@example.com" };
              },
            };
          },
        },
        {
          type: "oauth",
          label: "Loopback Callback",
          async authorize() {
            let resolveCode;
            const codePromise = new Promise((res) => { resolveCode = res; });
            const srv = createServer((req, res) => {
              const u = new URL(req.url || "/", "http://127.0.0.1");
              const code = u.searchParams.get("code") || "";
              const redirectTo = u.searchParams.get("redirect");
              if (redirectTo) {
                res.writeHead(302, { location: redirectTo });
                res.end();
                return;
              }
              res.writeHead(200, { "content-type": "text/plain" });
              res.end("ok");
              resolveCode(code);
            });
            await new Promise((res) => srv.listen(0, "127.0.0.1", res));
            const port = srv.address().port;
            const redirectUri = "http://127.0.0.1:" + port + "/auth/callback";
            return {
              url: VENDOR + "/oauth/authorize?redirect_uri=" + encodeURIComponent(redirectUri),
              instructions: "Complete login or paste the callback URL",
              method: "auto",
              async callback(_code, { signal } = {}) {
                try {
                  const code = await Promise.race([
                    codePromise,
                    new Promise((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true })),
                  ]);
                  if (code !== "valid-loopback-code") return { type: "failed", error: "bad code" };
                  const ex = await fetch(VENDOR + "/oauth/exchange?code=" + encodeURIComponent(code));
                  const tok = await ex.json();
                  return { type: "success", access: tok.access, refresh: tok.refresh, expires: Date.now() + 3600_000, email: "loopback@example.com" };
                } finally {
                  srv.close();
                }
              },
            };
          },
        },
      ],
      async loader(getAuth) {
        return {
          baseURL: VENDOR + "/v1",
          async fetch(input, init) {
            const auth = await getAuth();
            const token = auth?.type === "oauth" ? auth.access : auth?.key ?? "";
            const headers = new Headers(init?.headers || {});
            headers.set("authorization", "Bearer " + token);
            headers.set("x-from-plugin-loader", "yes");
            return fetch(input, { ...init, headers });
          },
        };
      },
    },
  };
}
`;
  writeFileSync(join(pkgDir, "index.mjs"), code);

  // 登记到 plugins.json
  const sysDir = join(opts.home, "system");
  mkdirSync(sysDir, { recursive: true });
  const pluginsPath = join(sysDir, "plugins.json");
  const existing = existsSync(pluginsPath) ? (JSON.parse(readFileSync(pluginsPath, "utf8")) as { plugins: unknown[] }) : { plugins: [] };
  existing.plugins.push({
    id: opts.pluginId,
    version: "1.0.0",
    source: "official",
    sourceName: "Hob 官方",
    enabled: true,
    tools: {},
    config: {},
    approvedCapabilities: { providers: [opts.pkgName], permissions: ["network"], mcpServers: [] },
  });
  writeFileSync(pluginsPath, JSON.stringify(existing, null, 2));
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

describe("provider plugins (issue 259)", () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it("downloads Bun on demand, verifies SHA-256, extracts binary, and rejects tampered archive", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-bun-test-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    const target = bunTargetFor();
    const archive = `${target}.zip`;
    const fakeBin = Buffer.from("#!/bin/sh\necho 1.4.2\n", "utf8");
    const zipBytes = buildZip(`${target}/bun`, fakeBin);
    const expectedHash = sha256Hex(zipBytes);

    let serveTampered = false;
    const srv = await startServer((req, res) => {
      if (req.url === `/bun-v1.4.2/${archive}`) {
        const payload = serveTampered ? Buffer.from("tampered-zip-bytes") : zipBytes;
        res.writeHead(200, { "content-type": "application/zip", "content-length": String(payload.length) });
        res.end(payload);
        return;
      }
      res.writeHead(404).end();
    });
    cleanups.push(() => srv.close());

    // 1. 哈希不匹配必须拒绝
    serveTampered = true;
    const badBun = new BunRuntime({ home, bunBaseUrl: srv.url, bunChecksums: { [archive]: expectedHash } });
    await expect(badBun.ensureBun()).rejects.toThrow(/哈希校验失败/);
    expect(badBun.installedPath()).toBeNull();

    // 2. 正确哈希：校验通过、推送进度事件、解压可执行文件
    serveTampered = false;
    const stages: string[] = [];
    const goodBun = new BunRuntime({ home, bunBaseUrl: srv.url, bunChecksums: { [archive]: expectedHash } });
    const binPath = await goodBun.ensureBun((ev) => stages.push(ev.stage));
    expect(existsSync(binPath)).toBe(true);
    expect(readFileSync(binPath).equals(fakeBin)).toBe(true);
    expect(stages).toContain("downloading_bun");
    expect(stages).toContain("verifying_bun");
    expect(stages).toContain("extracting_bun");

    // 3. 验证纯 Node extractFileFromZip 直接工作
    expect(extractFileFromZip(zipBytes, "bun").equals(fakeBin)).toBe(true);

    // 4. 校验 tarball integrity 失败时拒绝安装
    const badTgzSrv = await startServer((_req, res) => {
      res.writeHead(200).end(Buffer.from("not-matching-tgz"));
    });
    cleanups.push(() => badTgzSrv.close());
    await expect(
      goodBun.installPackages(join(home, "plugins", "demo"), [
        {
          package: "demo-pkg",
          version: "1.0.0",
          integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
          tarball: `${badTgzSrv.url}/demo.tgz`,
        },
      ]),
    ).rejects.toThrow(/完整性校验失败/);

    const preservedDir = join(home, "plugins", "preserved");
    mkdirSync(join(preservedDir, "providers-runtime"), { recursive: true });
    writeFileSync(join(preservedDir, "providers-runtime", "old.txt"), "old-runtime");
    writeFileSync(join(preservedDir, "package.json"), JSON.stringify({ dependencies: { "demo-pkg": "wrong" } }));
    writeFileSync(join(preservedDir, "bun.lock"), "{}\n");
    const validBytes = Buffer.from("valid-tgz");
    const validSrv = await startServer((_req, res) => res.writeHead(200).end(validBytes));
    cleanups.push(() => validSrv.close());
    await expect(goodBun.installPackages(preservedDir, [{ package: "demo-pkg", version: "1.0.0", integrity: sha512Integrity(validBytes), tarball: `${validSrv.url}/demo.tgz` }])).rejects.toThrow(/不一致/);
    expect(readFileSync(join(preservedDir, "providers-runtime", "old.txt"), "utf8")).toBe("old-runtime");
  });

  it("computes Anthropic and Responses upstream paths according to each base URL", () => {
    expect(computeUpstreamUrl({ loaderBaseUrl: "https://anthropic.example", protocol: "anthropic-messages", restPath: "/v1/messages" })).toBe("https://anthropic.example/v1/messages");
    expect(computeUpstreamUrl({ loaderBaseUrl: "https://anthropic.example/v1", protocol: "anthropic-messages", restPath: "/v1/messages" })).toBe("https://anthropic.example/v1/messages");
    expect(computeUpstreamUrl({ loaderBaseUrl: "https://codex.example/backend", protocol: "openai-responses", restPath: "/v1/responses" })).toBe("https://codex.example/backend/responses");
  });

  it("does not treat an arbitrary port query parameter as a loopback callback", () => {
    expect(extractLoopbackPorts("https://auth.example/authorize?export_port=5555&redirect_uri=" + encodeURIComponent("http://localhost:1455/callback"))).toEqual(["1455"]);
  });

  it("reports an upstream stream failure after headers as a failed response", async () => {
    const proxy = new ProviderPluginProxy(async () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      stream: (async function* () {
        yield Buffer.from("data: partial\\n\\n");
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("上游流中断");
      })(),
    }));
    const port = await proxy.start();
    cleanups.push(() => proxy.close());
    const response = await fetch(`http://127.0.0.1:${port}/p/p/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}` },
      body: "{}",
    });
    const reader = response.body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow();
  });

  it("uses an injective provider id separator", () => {
    expect(hobProviderIdFor("a", "b", 2)).not.toBe(hobProviderIdFor("a-b", "c", 1));
    expect(hobProviderIdFor("a", "b", 2)).toBe("plugin-a:b");
  });


  it("sanitizes child environment and maps plugin thinking levels cleanly", () => {
    const env = sanitizedBunEnv(
      { proxy: "http://127.0.0.1:7890", noProxy: "localhost" },
      {
        PATH: "/usr/bin",
        HOME: "/home/demo",
        OPENAI_API_KEY: "sk-secret-openai",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        HOB_PASSWORD: "top-secret-password",
        PI_CODING_AGENT_DIR: "/tmp/pi",
        LORE_API_TOKEN: "lore-secret",
      },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOB_PASSWORD).toBeUndefined();
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.LORE_API_TOKEN).toBeUndefined();

    // 无 reasoning 无 variants -> 不显示思考档
    const plain = pluginModelThinking({ id: "plain-chat", reasoning: false, variants: [], api: "openai-completions" });
    expect(plain.levels).toEqual(["off"]);

    // 显式声明 variants -> 只开放声明的档位，其余写 null
    const explicit = pluginModelThinking({ id: "reasoner", reasoning: true, variants: ["low", "high"], api: "openai-responses" });
    expect(explicit.levels).toEqual(["off", "low", "high"]);
    expect(explicit.map.xhigh).toBeNull();
    expect(explicit.map.max).toBeNull();
    expect(explicit.map.medium).toBeNull();
    expect(explicit.map.high).toBe("high");

    // reasoning: true 但没声明 variants -> 只给 low/medium/high，不盲发 xhigh/max
    const fallback = pluginModelThinking({ id: "thinker", reasoning: true, variants: [], api: "anthropic-messages" });
    expect(fallback.levels).toEqual(["off", "low", "medium", "high"]);
    expect(fallback.map.xhigh).toBeNull();
    expect(fallback.map.max).toBeNull();
  });

  it("validates loopback paste URLs strictly and refuses cross-host redirects", async () => {
    const authUrl = "https://auth.example.com/authorize?client_id=1&redirect_uri=" + encodeURIComponent("http://localhost:1455/auth/callback");
    expect(extractLoopbackPorts(authUrl)).toEqual(["1455"]);

    // 拒绝非 http、非 loopback、非授权端口
    await expect(replayLoopbackCallback(["1455"], "https://127.0.0.1:1455/auth/callback")).rejects.toThrow(/仅接受 http/);
    await expect(replayLoopbackCallback(["1455"], "http://example.com:1455/auth/callback")).rejects.toThrow(/只接受本机 loopback/);
    await expect(replayLoopbackCallback(["1455"], "http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/只接受本机 loopback/);
    await expect(replayLoopbackCallback(["1455"], "http://127.0.0.1:9999/auth/callback")).rejects.toThrow(/端口不属于本次登录/);

    // 本机回调返回跨主机 302 时绝不跟随
    let externalHit = false;
    const extSrv = await startServer((_req, res) => {
      externalHit = true;
      res.writeHead(200).end("external");
    });
    cleanups.push(() => extSrv.close());

    const cbSrv = await startServer((_req, res) => {
      res.writeHead(302, { location: `${extSrv.url}/steal` });
      res.end();
    });
    cleanups.push(() => cbSrv.close());

    const replayed = await replayLoopbackCallback([String(cbSrv.port)], `http://localhost:${cbSrv.port}/auth/callback?code=abc`);
    expect(replayed.status).toBe(302);
    expect(replayed.nextUrl).toBeUndefined();
    expect(externalHit).toBe(false);
  });

  it("covers all 5 login flows, multi-account, model cache fallback, 3 streaming protocols, abort, refresh, usage, idle stop, crash recovery, proxy auth, and secrets hygiene", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-prov-e2e-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    let modelsShouldFail = false;
    let devicePollCount = 0;
    let refreshCount = 0;
    let abortedSeen = false;
    let lastVendorHeaders: Record<string, string | string[] | undefined> = {};
    let usageShouldFail = false;
    let rejectNext401 = false;

    const vendor = await startServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      lastVendorHeaders = { ...req.headers };

      if (url.pathname === "/models") {
        if (modelsShouldFail) {
          res.writeHead(503, { "content-type": "text/plain" }).end("upstream down");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          "chat-mini": {
            id: "chat-mini",
            name: "Chat Mini",
            api: { id: "chat-mini", npm: "@ai-sdk/openai-compatible" },
            limit: { context: 64000, output: 4096 },
            capabilities: { reasoning: false, input: { text: true, image: false } },
          },
          "resp-pro": {
            id: "resp-pro",
            name: "Resp Pro",
            api: { id: "resp-pro", npm: "@ai-sdk/openai" },
            limit: { context: 200000, output: 16384 },
            capabilities: { reasoning: true, input: { text: true, image: true } },
            variants: { low: {}, high: {} },
          },
          "anth-sonnet": {
            id: "anth-sonnet",
            name: "Anth Sonnet",
            api: { id: "anth-sonnet", npm: "@ai-sdk/anthropic" },
            limit: { context: 200000, output: 8192 },
            capabilities: { reasoning: true, input: { text: true, image: true } },
          },
        }));
        return;
      }

      if (url.pathname === "/device/poll") {
        devicePollCount++;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify(devicePollCount >= 2 ? { ready: true, access: "dev-access-secret-111", refresh: "dev-refresh-secret-111" } : { ready: false }),
        );
        return;
      }

      if (url.pathname === "/web-poll") {
        await new Promise((r) => setTimeout(r, 30));
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ ok: true, access: "poll-access-secret-222", refresh: "poll-refresh-secret-222" }),
        );
        return;
      }

      if (url.pathname === "/oauth/exchange") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ access: "loopback-access-secret-999", refresh: "loopback-refresh-secret-999" }),
        );
        return;
      }

      if (url.pathname === "/oauth/refresh") {
        refreshCount++;
        await new Promise((r) => setTimeout(r, 40));
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access: `refreshed-access-${refreshCount}-secret`,
            refresh: `refreshed-refresh-${refreshCount}-secret`,
            expires: Date.now() + 3600_000,
          }),
        );
        return;
      }

      if (url.pathname === "/usage") {
        if (usageShouldFail) {
          res.writeHead(502).end("quota service down");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          plan: "Pro",
          user: "demo@example.com",
          windows: [{ name: "5 hours", used: 42, resetSecs: 3600 }],
        }));
        return;
      }

      if (url.pathname === "/v1/slow") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        req.on("close", () => { abortedSeen = true; });
        const timer = setTimeout(() => { if (!res.writableEnded) res.end(); }, 10_000);
        res.on("close", () => clearTimeout(timer));
        return;
      }

      if (rejectNext401) {
        rejectNext401 = false;
        res.writeHead(401, { "content-type": "application/json", "x-magpie-sign-in": "expired" }).end(JSON.stringify({ error: { message: "token expired" } }));
        return;
      }

      // 1. OpenAI Chat Completions 流式响应
      if (url.pathname === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunks = [
          { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "chat-mini", choices: [{ index: 0, delta: { role: "assistant", content: "Hello " }, finish_reason: null }] },
          { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "chat-mini", choices: [{ index: 0, delta: { content: "from chat!" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
        ];
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // 2. OpenAI Responses 流式响应
      if (url.pathname === "/v1/responses") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "response.created", response: { id: "resp_1", status: "in_progress", model: "resp-pro", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
          { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
          { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello from responses!" },
          { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hello from responses!" },
          { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "Hello from responses!", annotations: [] } },
          { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello from responses!", annotations: [] }] } },
          { type: "response.completed", response: { id: "resp_1", status: "completed", model: "resp-pro", output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello from responses!", annotations: [] }] }], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } },
        ];
        for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        res.end();
        return;
      }

      // 3. Anthropic Messages 流式响应
      if (url.pathname === "/v1/messages") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "message_start", message: { id: "msg_a1", type: "message", role: "assistant", content: [], model: "anth-sonnet", stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from anthropic!" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
          { type: "message_stop" },
        ];
        for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        res.end();
        return;
      }

      res.writeHead(404).end("not found");
    });
    cleanups.push(() => vendor.close());

    writeFakeProviderPlugin({ home, pluginId: "fake-multi", pkgName: "fake-multi-pkg", vendorUrl: vendor.url, includeCli: true });
    writeFakeProviderPlugin({ home, pluginId: "fake-single", pkgName: "fake-single-pkg", vendorUrl: vendor.url, single: true });

    const pi = new PiHost({ engineDir: join(home, "system", "engine") });
    const config = loadConfig(home, { HOB_PASSWORD: "test-password" });
    const runtime: HobRuntime = createRuntime({
      home,
      config,
      pi,
      providerPlugins: {
        // 单元测试用 Node 运行同一套 provider-host.mjs（离线、快）；真实 Bun 在真实 E2E 验证
        bunOptions: { bunPath: process.execPath },
        hostIdleMs: 350,
      },
    });
    cleanups.push(async () => {
      await runtime.providerPlugins.close();
      await runtime.plugins.close();
    });

    const events: HobEvent[] = [];
    const unsub = runtime.bus.subscribe((ev) => events.push(ev));
    cleanups.push(unsub);

    // 1. 按需启动：此时宿主必须还是 stopped
    expect(runtime.providerPlugins.hostStatus().status).toBe("stopped");

    // 2. CLI 检测与代装
    const cliBefore = await runtime.providerPlugins.checkCli("fake-multi", "fake-multi");
    expect(cliBefore.declared).toBe(true);
    expect(cliBefore.installed).toBe(false);
    const cliAfter = await runtime.providerPlugins.installCli("fake-multi", "fake-multi");
    expect(cliAfter.installed).toBe(true);
    expect(runtime.providerPlugins.hostStatus().status).toBe("running");

    // 3. 登录方式 1：API Key（带 prompt）
    const prompt1 = await runtime.providerPlugins.nextPrompt({ pluginId: "fake-multi", providerId: "fake-multi", methodIndex: 0, inputs: {} });
    expect(prompt1?.key).toBe("region");
    const apiSecret = "sk-my-very-secret-api-key-123456";
    const apiRes = await runtime.providerPlugins.signInApiKey({
      pluginId: "fake-multi",
      providerId: "fake-multi",
      methodIndex: 0,
      key: apiSecret,
      inputs: { region: "global" },
    });
    expect(apiRes.models.map((m) => m.id).sort()).toEqual(["anth-sonnet", "chat-mini", "resp-pro"]);

    // 4. 登录方式 2：Keyless（在 single 插件上测试，重复登录只保留 1 个账号）
    const k1 = await runtime.providerPlugins.signInApiKey({ pluginId: "fake-single", providerId: "fake-single", methodIndex: 1 });
    const k2 = await runtime.providerPlugins.signInApiKey({ pluginId: "fake-single", providerId: "fake-single", methodIndex: 1 });
    expect(k2.account.id).toBe(k1.account.id);
    expect(runtime.providerPlugins.pluginProvidersView("fake-single")[0].accounts.length).toBe(1);

    // 5. 登录方式 3：设备码自动轮询完成
    const devSession = await runtime.providerPlugins.startSignIn({ pluginId: "fake-multi", providerId: "fake-multi", methodIndex: 2 });
    expect(devSession.kind).toBe("device_code");
    expect(devSession.userCode).toBe("ABCD-1234");
    for (let i = 0; i < 40; i++) {
      const s = runtime.providerPlugins.getSignInSession(devSession.sessionId);
      if (s?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(runtime.providerPlugins.getSignInSession(devSession.sessionId)?.status).toBe("completed");

    // 6. 登录方式 4：服务端轮询 OAuth
    const pollSession = await runtime.providerPlugins.startSignIn({ pluginId: "fake-multi", providerId: "fake-multi", methodIndex: 3 });
    expect(pollSession.kind).toBe("server_poll");
    for (let i = 0; i < 40; i++) {
      const s = runtime.providerPlugins.getSignInSession(pollSession.sessionId);
      if (s?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(runtime.providerPlugins.getSignInSession(pollSession.sessionId)?.status).toBe("completed");

    // 7. 登录方式 5：Loopback 粘贴回放（严格校验 + 回放完成）
    const lbSession = await runtime.providerPlugins.startSignIn({ pluginId: "fake-multi", providerId: "fake-multi", methodIndex: 4 });
    expect(lbSession.kind).toBe("loopback_paste");
    expect(lbSession.loopbackPasteAllowed).toBe(true);
    const lbPort = extractLoopbackPorts(lbSession.url!)[0];
    // 拒绝错误主机/端口
    await expect(runtime.providerPlugins.pasteLoopbackCallback(lbSession.sessionId, `http://evil.com:${lbPort}/auth/callback?code=x`)).rejects.toThrow();
    await expect(runtime.providerPlugins.pasteLoopbackCallback(lbSession.sessionId, `http://127.0.0.1:1/auth/callback?code=x`)).rejects.toThrow();
    // 正确回放
    const replayed = await runtime.providerPlugins.pasteLoopbackCallback(lbSession.sessionId, `http://localhost:${lbPort}/auth/callback?code=valid-loopback-code`);
    expect(replayed.status).toBe(200);
    for (let i = 0; i < 40; i++) {
      const s = runtime.providerPlugins.getSignInSession(lbSession.sessionId);
      if (s?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const lbDone = runtime.providerPlugins.getSignInSession(lbSession.sessionId);
    expect(lbDone?.status).toBe("completed");

    // 多账号切换：切回第一个 API Key 账号再切回 loopback 账号
    const multiView = runtime.providerPlugins.pluginProvidersView("fake-multi")[0];
    expect(multiView.accounts.length).toBe(4);
    await runtime.providerPlugins.setActiveAccount("fake-multi", "fake-multi", apiRes.account.id);
    expect(runtime.providerPlugins.pluginProvidersView("fake-multi")[0].activeAccountId).toBe(apiRes.account.id);

    // 8. 模型列表拉取失败保留上次缓存并如实报错
    modelsShouldFail = true;
    await expect(runtime.providerPlugins.refreshModels("fake-multi", "fake-multi", apiRes.account.id)).rejects.toThrow(/503/);
    const afterFail = runtime.providerPlugins.pluginProvidersView("fake-multi")[0];
    expect(afterFail.models.length).toBe(3); // 保留上次缓存
    expect(afterFail.modelsFellBack).toBe(true);
    expect(afterFail.modelsError).toContain("503");
    modelsShouldFail = false;

    // 9. 用量 / 额度：正常 + 失败不画成 0
    const usageOk = await runtime.providerPlugins.fetchUsage("fake-multi", "fake-multi", apiRes.account.id);
    expect(usageOk.error).toBeUndefined();
    expect(usageOk.plan).toBe("Pro");
    expect(usageOk.windows[0].used).toBe(42);
    usageShouldFail = true;
    const usageFail = await runtime.providerPlugins.fetchUsage("fake-multi", "fake-multi", apiRes.account.id);
    expect(usageFail.error).toContain("502");
    expect(usageFail.windows).toEqual([]);
    usageShouldFail = false;

    // 10. 三种流式协议通过真实 pi ModelRuntime.streamSimple + 内部端点完成对话
    const modelRuntime = await pi.runtime();
    const available = await runtime.models.get(0);
    const chatModel = available.find((m) => m.ref === "plugin-fake-multi/chat-mini");
    const respModel = available.find((m) => m.ref === "plugin-fake-multi/resp-pro");
    const anthModel = available.find((m) => m.ref === "plugin-fake-multi/anth-sonnet");
    expect(chatModel?.thinkingLevels).toEqual(["off"]);
    expect(respModel?.thinkingLevels).toEqual(["off", "low", "high"]);
    expect(anthModel?.thinkingLevels).toEqual(["off", "low", "medium", "high"]);

    for (const [ref, expectedText] of [
      ["plugin-fake-multi/chat-mini", "Hello from chat!"],
      ["plugin-fake-multi/resp-pro", "Hello from responses!"],
      ["plugin-fake-multi/anth-sonnet", "Hello from anthropic!"],
    ] as const) {
      const m = await pi.model(ref);
      const result = await modelRuntime.completeSimple(m, {
        messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
      });
      const text = result.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");
      expect(text).toBe(expectedText);
      // 验证 chat.headers 和 loader.fetch 生效，且内部令牌未泄露给厂商
      expect(lastVendorHeaders["x-from-plugin-loader"]).toBe("yes");
      expect(String(lastVendorHeaders["x-plugin-chat-header"])).toContain("from-chat-headers:");
      expect(JSON.stringify(lastVendorHeaders)).not.toContain(runtime.providerPlugins.proxy.token);
    }

    // 11. 内部端点安全：无令牌 / 错令牌必须 401
    const proxyPort = runtime.providerPlugins.proxy.port;
    const noToken = await fetch(`http://127.0.0.1:${proxyPort}/p/fake-multi/fake-multi/v1/chat/completions`, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);
    const badToken = await fetch(`http://127.0.0.1:${proxyPort}/p/fake-multi/fake-multi/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
      body: "{}",
    });
    expect(badToken.status).toBe(401);

    // 12. 取消传播：客户端中止内部端点请求 -> 上游 vendor 收到关闭
    const abortCtl = new AbortController();
    const slowRes = await fetch(`http://127.0.0.1:${proxyPort}/p/fake-multi/fake-multi/v1/slow`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.providerPlugins.proxy.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chat-mini" }),
      signal: abortCtl.signal,
    });
    const reader = slowRes.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString("utf8")).toContain("first");
    abortCtl.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 30 && !abortedSeen; i++) await new Promise((r) => setTimeout(r, 25));
    expect(abortedSeen).toBe(true);

    // 13. 单飞刷新：把 loopback 账号设成即将过期并设为活跃，并发发起两次请求，只刷一次
    const lbAccId = lbDone!.accountId!;
    await runtime.providerPlugins.setActiveAccount("fake-multi", "fake-multi", lbAccId);
    const secKey = providerAccountSecretKey("fake-multi", "fake-multi", lbAccId);
    const storedLb = JSON.parse(readSecrets(home)[secKey]) as Record<string, unknown>;
    storedLb.expires = Date.now() + 1000; // < refreshLead (60s)
    // 通过重新写入过期时间触发刷新
    const secretsPath = join(home, "system", "secrets.json");
    const allSec = readSecrets(home);
    allSec[secKey] = JSON.stringify(storedLb);
    writeFileSync(secretsPath, JSON.stringify(allSec, null, 2), { mode: 0o600 });

    const mChat = await pi.model("plugin-fake-multi/chat-mini");
    await Promise.all([
      modelRuntime.completeSimple(mChat, { messages: [{ role: "user", content: "r1", timestamp: Date.now() }] }),
      modelRuntime.completeSimple(mChat, { messages: [{ role: "user", content: "r2", timestamp: Date.now() }] }),
    ]);
    expect(refreshCount).toBe(1);
    expect(readSecrets(home)[secKey]).toContain("refreshed-access-1-secret");

    // 14. 401 expired 标记账号过期
    rejectNext401 = true;
    await modelRuntime.completeSimple(mChat, { messages: [{ role: "user", content: "r3", timestamp: Date.now() }] });
    expect(runtime.providerPlugins.pluginProvidersView("fake-multi")[0].accounts.find((a) => a.id === lbAccId)?.status).toBe("expired");

    // 15. 闲置自动停机，下次请求自动拉起
    await new Promise((r) => setTimeout(r, 550));
    expect(runtime.providerPlugins.hostStatus().status).toBe("stopped");
    const usageAfterWake = await runtime.providerPlugins.fetchUsage("fake-multi", "fake-multi", apiRes.account.id);
    expect(usageAfterWake.plan).toBe("Pro");
    expect(runtime.providerPlugins.hostStatus().status).toBe("running");

    // 16. 宿主崩溃恢复：SIGKILL 后状态变 error，下次调用自动拉起成功
    const oldPid = runtime.providerPlugins.host.pid!;
    expect(oldPid).toBeGreaterThan(0);
    process.kill(oldPid, "SIGKILL");
    for (let i = 0; i < 40 && runtime.providerPlugins.hostStatus().status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runtime.providerPlugins.hostStatus().status).toBe("error");
    const recovered = await runtime.providerPlugins.fetchUsage("fake-multi", "fake-multi", apiRes.account.id);
    expect(recovered.plan).toBe("Pro");
    expect(runtime.providerPlugins.hostStatus().status).toBe("running");
    expect(runtime.providerPlugins.host.pid).not.toBe(oldPid);

    // 17. 服务商页视图带出 pluginProviders 且不放进 builtin
    const providersView = await runtime.providers.view();
    expect(providersView.pluginProviders?.some((p) => p.id === "plugin-fake-multi")).toBe(true);
    expect(providersView.builtin.some((b) => b.id === "plugin-fake-multi")).toBe(false);
    expect(providersView.models["plugin-fake-multi"]?.length).toBe(3);

    // 18. 凭据卫生：密钥和令牌绝不能出现在 secrets.json 以外的任何 HOB_HOME 文件或 SSE 事件里
    const sensitiveStrings = [
      apiSecret,
      "dev-access-secret-111",
      "dev-refresh-secret-111",
      "poll-access-secret-222",
      "loopback-access-secret-999",
      "refreshed-access-1-secret",
    ];
    const eventsBlob = JSON.stringify(events);
    for (const secret of sensitiveStrings) {
      expect(eventsBlob).not.toContain(secret);
    }
    for (const file of walkFiles(home)) {
      if (file.endsWith("secrets.json")) continue;
      const content = readFileSync(file, "utf8");
      for (const secret of sensitiveStrings) {
        expect(content, `${file} leaked ${secret}`).not.toContain(secret);
      }
    }

    // 19. 任意嵌套 auth 字符串都脱敏，不依赖字段名
    writeSecret(home, providerAccountSecretKey("fake-multi", "fake-multi", apiRes.account.id), JSON.stringify({ nested: { arbitrary: "nested-auth-secret" } }));
    expect(runtime.providerPlugins.redact("nested-auth-secret")).toContain("[已隐藏]");

    // 20. 删账号连带清 secrets
    await runtime.providerPlugins.removeAccount("fake-multi", "fake-multi", apiRes.account.id);
    expect(readSecrets(home)[providerAccountSecretKey("fake-multi", "fake-multi", apiRes.account.id)]).toBeUndefined();
  });

  it("requires re-approval when plugin capabilities expand on update", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-cap-test-"));
    const sourceDir = mkdtempSync(join(tmpdir(), "hob-src-test-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    cleanups.push(() => rmSync(sourceDir, { recursive: true, force: true }));

    // 构造一个本地插件源（无 mcp.json，仅带 provider 声明）
    const pDir = join(sourceDir, "cap-plugin");
    mkdirSync(pDir, { recursive: true });
    const fakeTgz = Buffer.from("fake-tgz-v1");
    const integrity = sha512Integrity(fakeTgz);
    const writeManifest = (version: string, permissions: string[]) => {
      writeFileSync(
        join(pDir, "plugin.json"),
        JSON.stringify({
          name: "cap-plugin",
          displayName: "Cap Plugin",
          version,
          extensions: {
            "com.hob.plugins": {
              categories: ["providers"],
              permissions,
              providers: [{ package: "cap-pkg", version: "1.0.0", integrity }],
            },
          },
        }),
      );
      writeFileSync(join(sourceDir, "index.json"), JSON.stringify({ name: "Test", plugins: [{ id: "cap-plugin", path: "cap-plugin", files: ["plugin.json"] }] }));
    };

    writeManifest("1.0.0", ["network"]);
    // 直接放到 cache/plugin-sources/official 下模拟已拉取的源
    const cacheDir = join(home, "cache", "plugin-sources", "official");
    mkdirSync(join(cacheDir, "cap-plugin"), { recursive: true });
    writeFileSync(join(cacheDir, "index.json"), readFileSync(join(sourceDir, "index.json")));
    writeFileSync(join(cacheDir, "cap-plugin", "plugin.json"), readFileSync(join(pDir, "plugin.json")));

    const pi = new PiHost({ engineDir: join(home, "system", "engine") });
    const config = loadConfig(home, { HOB_PASSWORD: "test-password" });
    const runtime = createRuntime({ home, config, pi });
    cleanups.push(async () => {
      await runtime.providerPlugins.close();
      await runtime.plugins.close();
    });

    const installed = runtime.plugins.store.install("cap-plugin");
    expect(installed.enabled).toBe(true);
    expect(installed.needsApproval).toBeUndefined();
    expect(() => runtime.plugins.store.approve("cap-plugin")).toThrow(/待确认/);

    // 更新到 1.1.0，新增 subprocess 权限 -> 必须停用并标记 needsApproval
    writeManifest("1.1.0", ["network", "subprocess"]);
    writeFileSync(join(cacheDir, "cap-plugin", "plugin.json"), readFileSync(join(pDir, "plugin.json")));

    const updated = runtime.plugins.store.install("cap-plugin", true);
    expect(updated.enabled).toBe(false);
    expect(updated.needsApproval).toBe(true);
    expect(updated.capabilityChanges?.some((c) => c.includes("subprocess"))).toBe(true);

    // 未确认前禁止直接启用
    expect(() => runtime.plugins.store.patch("cap-plugin", { enabled: true })).toThrow(/重新确认|请先确认/);

    // 确认后恢复启用
    const approved = runtime.plugins.store.approve("cap-plugin");
    expect(approved.enabled).toBe(true);
    expect(approved.needsApproval).toBeUndefined();
  });

  it("exposes provider plugin HTTP routes cleanly with authentication", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-http-prov-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    const pi = new PiHost({ engineDir: join(home, "system", "engine") });
    const config = loadConfig(home, { HOB_PASSWORD: "test-password" });
    const runtime = createRuntime({
      home,
      config,
      pi,
      providerPlugins: { bunOptions: { bunPath: process.execPath } },
    });
    cleanups.push(async () => {
      await runtime.providerPlugins.close();
      await runtime.plugins.close();
    });

    const vendor = await startServer((_req, res) => res.writeHead(404).end());
    cleanups.push(() => vendor.close());
    writeFakeProviderPlugin({ home, pluginId: "fake-http", pkgName: "fake-http-pkg", vendorUrl: vendor.url });
    const app = createApp(runtime, { webDir: join(home, "no-web"), home });
    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const hostRes = await app.request("/api/plugins/provider-host", { headers: { cookie } });
    expect(hostRes.status).toBe(200);
    const hostBody = await hostRes.json() as { status: string; bunVersion: string };
    expect(hostBody.status).toBe("stopped");
    expect(hostBody.bunVersion).toBe("1.4.2");

    const pluginsRes = await app.request("/api/plugins", { headers: { cookie } });
    expect(pluginsRes.status).toBe(200);
    const pluginsBody = await pluginsRes.json() as { providerHost?: { status: string } };
    expect(pluginsBody.providerHost?.status).toBe("stopped");
    const providerRes = await app.request("/api/plugins/fake-http/providers", { headers: { cookie } });
    expect(providerRes.status).toBe(200);
    expect((await providerRes.json() as { providerHost: { status: string } }).providerHost.status).toBe("stopped");
    const signIn = await runtime.providerPlugins.startSignIn({ pluginId: "fake-http", providerId: "fake-http", methodIndex: 4 });
    const wrongSessionRoute = await app.request("/api/plugins/fake-http/providers/other/auth/cancel", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: signIn.sessionId }),
    });
    expect(wrongSessionRoute.status).toBe(400);
    const cancel = await app.request("/api/plugins/fake-http/providers/fake-http/auth/cancel", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: signIn.sessionId }),
    });
    expect(cancel.status).toBe(200);
  });

  it("fills missing model limits from the public catalog and lets the user override any model's params", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-prov-override-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const pi = new PiHost({ engineDir: join(home, "system", "engine") });
    const config = loadConfig(home, { HOB_PASSWORD: "test-password" });
    const catalog: Record<string, { context: number; output: number }> = {
      "big-model": { context: 1_048_576, output: 65_536 },
      "declared-model": { context: 1, output: 1 },
    };
    const runtime = createRuntime({
      home,
      config,
      pi,
      providerPlugins: { bunOptions: { bunPath: process.execPath }, catalogLimits: (id) => catalog[id] },
    });
    cleanups.push(async () => {
      await runtime.providerPlugins.close();
      await runtime.plugins.close();
    });
    writeFakeProviderPlugin({ home, pluginId: "fake-ovr", pkgName: "fake-ovr-pkg", vendorUrl: "http://127.0.0.1:9" });
    const entry = (id: string, context: number, output: number) => ({ id, apiId: id, name: id, npm: "@ai-sdk/anthropic", url: "", context, output, reasoning: false, image: false, variants: [] });
    const now = new Date().toISOString();
    mkdirSync(join(home, "system"), { recursive: true });
    writeFileSync(join(home, "system", "provider-plugins.json"), JSON.stringify({
      plugins: {
        "fake-ovr": {
          providers: {
            "fake-ovr": {
              activeAccountId: "a1",
              accounts: {
                a1: {
                  id: "a1", providerId: "fake-ovr", displayName: "x", authType: "api", status: "connected", createdAt: now, updatedAt: now,
                  // 插件没给上限的、给了的、目录里没有的
                  rawModels: [entry("big-model", 0, 0), entry("declared-model", 64_000, 4_096), entry("unknown-model", 0, 0)],
                },
              },
            },
          },
        },
      },
    }));
    const model = (id: string) => runtime.providerPlugins.pluginProvidersView("fake-ovr")[0].models.find((m) => m.id === id)!;

    // 插件没给 → 按目录补；插件给了 → 用插件的；目录里也没有 → 默认值
    expect(model("big-model")).toMatchObject({ contextWindow: 1_048_576, maxTokens: 65_536 });
    expect(model("declared-model")).toMatchObject({ contextWindow: 64_000, maxTokens: 4_096 });
    expect(model("unknown-model")).toMatchObject({ contextWindow: 128_000, maxTokens: 8_192 });

    // 用户改的盖在最上面；每次只带改的那项，和之前改过的合在一起
    await runtime.providerPlugins.setModelOverride("fake-ovr", "fake-ovr", "big-model", { maxTokens: 32_000 });
    await runtime.providerPlugins.setModelOverride("fake-ovr", "fake-ovr", "big-model", { reasoning: true, input: ["text", "image"] });
    expect(model("big-model")).toMatchObject({ contextWindow: 1_048_576, maxTokens: 32_000, reasoning: true, input: ["text", "image"], overridden: true });
    expect(model("big-model").thinkingLevels).toEqual(["off", "low", "medium", "high"]);
    expect(model("big-model").thinking?.ref).toBe("plugin-fake-ovr/big-model");

    await expect(runtime.providerPlugins.setModelOverride("fake-ovr", "fake-ovr", "big-model", { contextWindow: -5 })).rejects.toThrow(/正整数/);
    await expect(runtime.providerPlugins.setModelOverride("fake-ovr", "fake-ovr", "nope", { maxTokens: 10 })).rejects.toThrow(/不在这个供应商的模型列表里/);

    // 走接口恢复插件给的
    const app = createApp(runtime, { webDir: join(home, "no-web"), home });
    const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const reset = await app.request("/api/plugins/fake-ovr/providers/fake-ovr/model", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ modelId: "big-model", override: null }),
    });
    expect(reset.status).toBe(200);
    const body = await reset.json() as { providers: { models: { id: string; maxTokens: number; reasoning: boolean; overridden?: boolean }[] }[] };
    expect(body.providers[0].models.find((m) => m.id === "big-model")).toMatchObject({ maxTokens: 65_536, reasoning: false });
    expect(body.providers[0].models.find((m) => m.id === "big-model")?.overridden).toBeUndefined();
  });

  it("does not mix seeded pi models into a static provider model list", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-host-static-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const dir = join(home, "providers-runtime", "node_modules", "static");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "static", version: "1.0.0", type: "module", main: "./index.mjs" }));
    writeFileSync(join(dir, "index.mjs"), `
export async function P() {
  return {
    config(cfg) {
      cfg.provider = { v: { models: { static: { id: "static", api: { npm: "@ai-sdk/openai-compatible" } } } } };
    },
    auth: { provider: "v", methods: [] },
  };
}
`);
    const host = new ProviderPluginHost({
      home,
      bun: new BunRuntime({ home, bunPath: process.execPath }),
      getPlugins: () => [{ pluginId: "p", dataDir: join(home, "data"), packages: [{ package: "static", dir }] }],
    });
    cleanups.push(() => host.close());
    await host.ensureStarted();
    const result = await host.models({ pluginId: "p", provider: "v", accountId: "a", auth: {}, seedModels: { builtin: { id: "builtin", api: { npm: "@ai-sdk/openai-compatible" } } } });
    expect(result.models.map((model) => model.id)).toEqual(["static"]);
  });

  it("ignores auth_update text written directly by a provider to stdout", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-host-stdout-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const dir = join(home, "providers-runtime", "node_modules", "spoof");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "spoof", version: "1.0.0", type: "module", main: "./index.mjs" }));
    writeFileSync(join(dir, "index.mjs"), "process.stdout.write(JSON.stringify({event:'auth_update',pluginId:'p',provider:'v',accountId:'attacker',auth:{token:'spoofed'}})+'\\n'); export async function P(){return {}};\\n");
    const authUpdate = vi.fn();
    const host = new ProviderPluginHost({
      home,
      bun: new BunRuntime({ home, bunPath: process.execPath }),
      getPlugins: () => [{ pluginId: "p", dataDir: join(home, "data"), packages: [{ package: "spoof", dir }] }],
      onAuthUpdate: authUpdate,
    });
    cleanups.push(() => host.close());
    await host.ensureStarted();
    expect(authUpdate).not.toHaveBeenCalled();
  });

  it("stops the previous shared host every time the plugin set changes, so only one host process is left", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-host-restart-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const specs: HostPluginLoadSpec[] = [];
    const host = new ProviderPluginHost({ home, bun: new BunRuntime({ home, bunPath: process.execPath }), getPlugins: () => specs });
    cleanups.push(() => host.stop());
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const pids: number[] = [];
    for (const id of ["a", "b", "c"]) {
      const dir = join(home, "plugins", id, "providers-runtime", "node_modules", `fake-${id}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `fake-${id}`, version: "1.0.0", type: "module", main: "./index.mjs" }));
      writeFileSync(join(dir, "index.mjs"), "export async function P() { return {}; }\n");
      specs.push({ pluginId: id, dataDir: join(home, "plugin-data", id), packages: [{ package: `fake-${id}`, dir }] });
      await host.syncIfRunning();
      await host.ensureStarted();
      pids.push(host.statusView().pid!);
    }
    expect(new Set(pids).size).toBe(3);
    expect(pids.map(alive)).toEqual([false, false, true]);
    expect(readlinkSync(`/proc/${pids[2]}/cwd`)).not.toContain(join(home, "system"));
    specs[2].packages[0].version = "2.0.0";
    await host.syncIfRunning();
    const versionPid = host.statusView().pid!;
    expect(versionPid).not.toBe(pids[2]);
    expect(alive(pids[2]!)).toBe(false);
    expect(alive(versionPid)).toBe(true);
    await host.stop();
    expect(alive(versionPid)).toBe(false);
  });
});
