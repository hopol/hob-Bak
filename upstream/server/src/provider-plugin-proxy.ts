// 仅限本机（127.0.0.1）+ 随机令牌保护的内部模型端点：
// pi-ai 按 OpenAI Completions / Responses / Anthropic Messages 发请求到这里，
// 代理再通过共享 Bun 宿主转给供应商插件的 loader.fetch，并把流式响应和取消一路传回。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ProviderApi } from "../../shared/types.ts";
import { HostRpcError, type HostFetchResponse } from "./provider-plugin-host.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

const RESPONSE_STRIP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

const NPM_DEFAULT_BASE: Record<string, string> = {
  "@ai-sdk/anthropic": "https://api.anthropic.com/v1",
  "@ai-sdk/openai": "https://api.openai.com/v1",
  "@ai-sdk/google": "https://generativelanguage.googleapis.com/v1beta",
  "@ai-sdk/github-copilot": "https://api.githubcopilot.com",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/deepseek": "https://api.deepseek.com/v1",
};

export interface ProxyRequestDispatch {
  pluginId: string;
  providerId: string;
  restPath: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  modelId: string;
  signal: AbortSignal;
}

export interface ProxyDispatchResult {
  response: HostFetchResponse;
}

export type ProxyRequestHandler = (dispatch: ProxyRequestDispatch) => Promise<HostFetchResponse>;

/** 计算插件上游实际请求 URL（照 Magpie pluginRequestBase + /v1 规则）。 */
export function computeUpstreamUrl(params: {
  loaderBaseUrl?: string;
  modelUrl?: string;
  providerApi?: string;
  modelNpm?: string;
  protocol: ProviderApi;
  restPath: string;
}): string {
  const { loaderBaseUrl, modelUrl, providerApi, modelNpm, protocol, restPath } = params;
  const first = [loaderBaseUrl, modelUrl, providerApi, modelNpm ? NPM_DEFAULT_BASE[modelNpm] : ""]
    .find((v) => typeof v === "string" && v.trim().length > 0) ?? "";
  let base = first.trim().replace(/\/+$/, "");
  if (!base) throw new Error("供应商插件未提供请求地址（baseURL）");

  // Anthropic 模型如果自身 URL 以 /v1 结尾而 loader.baseURL 没有 /v1（如 Copilot 调 Claude），补 /v1
  if (
    protocol === "anthropic-messages" &&
    loaderBaseUrl &&
    modelUrl &&
    modelUrl.trim().replace(/\/+$/, "").endsWith("/v1") &&
    !base.endsWith("/v1")
  ) {
    base += "/v1";
  }

  if (restPath.startsWith("/v1/")) {
    if (protocol === "anthropic-messages" && !base.endsWith("/v1")) {
      return `${base}${restPath}`;
    }
    return `${base}${restPath.slice("/v1".length)}`;
  }
  return `${base}${restPath.startsWith("/") ? restPath : `/${restPath}`}`;
}

function isLoopbackRemote(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function tokenEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractPresentedToken(req: IncomingMessage): { token: string; header: "authorization" | "x-api-key" | "x-hob-internal-token" } | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return { token: auth.slice(7).trim(), header: "authorization" };
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) {
    return { token: apiKey.trim(), header: "x-api-key" };
  }
  const custom = req.headers["x-hob-internal-token"];
  if (typeof custom === "string" && custom.trim()) {
    return { token: custom.trim(), header: "x-hob-internal-token" };
  }
  return null;
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify({ error: { message, type: "hob_plugin_error" } });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

/** 仅给 Hob 自己用的内部代理服务器：127.0.0.1 随机端口 + 随机令牌。 */
export class ProviderPluginProxy {
  readonly token: string;
  private server?: Server;
  private listeningPort = 0;

  constructor(private readonly handler: ProxyRequestHandler) {
    this.token = randomBytes(32).toString("hex");
  }

  get port(): number {
    return this.listeningPort;
  }

  /** 启动监听（幂等）。 */
  async start(): Promise<number> {
    if (this.server && this.listeningPort > 0) return this.listeningPort;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const addr = server.address() as AddressInfo | null;
    if (!addr || typeof addr.port !== "number") throw new Error("内部模型端点监听失败");
    this.listeningPort = addr.port;
    return this.listeningPort;
  }

  /** 为给定插件供应商和协议生成注册给 pi 的 baseUrl。 */
  baseUrlFor(pluginId: string, providerId: string, api: ProviderApi): string {
    if (!this.listeningPort) throw new Error("内部模型端点尚未启动");
    const prefix = `http://127.0.0.1:${this.listeningPort}/p/${encodeURIComponent(pluginId)}/${encodeURIComponent(providerId)}`;
    // OpenAI SDK 会拼 /chat/completions 或 /responses；Anthropic SDK 会拼 /v1/messages
    return api === "anthropic-messages" ? prefix : `${prefix}/v1`;
  }

  async close(): Promise<void> {
    const srv = this.server;
    this.server = undefined;
    this.listeningPort = 0;
    if (!srv) return;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackRemote(req.socket.remoteAddress)) {
      jsonError(res, 403, "只允许本机访问");
      return;
    }

    const presented = extractPresentedToken(req);
    if (!presented || !tokenEquals(this.token, presented.token)) {
      jsonError(res, 401, "缺少或无效的内部令牌");
      return;
    }

    const rawUrl = req.url ?? "/";
    const match = /^\/p\/([^/]+)\/([^/]+)(\/.*)$/.exec(rawUrl);
    if (!match) {
      jsonError(res, 404, "无效的插件模型路径");
      return;
    }
    let pluginId: string;
    let providerId: string;
    try {
      pluginId = decodeURIComponent(match[1]);
      providerId = decodeURIComponent(match[2]);
    } catch {
      jsonError(res, 400, "路径编码无效");
      return;
    }
    const restPath = match[3];

    let body: Buffer;
    try {
      body = await readRequestBody(req);
    } catch (error) {
      jsonError(res, 400, error instanceof Error ? error.message : "读取请求体失败");
      return;
    }

    let modelId = "";
    if (body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString("utf8")) as { model?: unknown };
        if (typeof parsed.model === "string") modelId = parsed.model;
      } catch { /* 非 JSON 请求体保持空 modelId */ }
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      if (lower === presented.header) continue;
      if (lower === "x-hob-internal-token") continue;
      if (typeof v === "string") headers[lower] = v;
      else if (Array.isArray(v)) headers[lower] = v.join(", ");
    }

    const ctl = new AbortController();
    const abort = () => {
      if (!res.writableEnded) ctl.abort();
    };
    req.on("aborted", abort);
    res.on("close", abort);

    try {
      const upstream = await this.handler({
        pluginId,
        providerId,
        restPath,
        method: req.method ?? "POST",
        headers,
        body,
        modelId,
        signal: ctl.signal,
      });

      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (RESPONSE_STRIP.has(k.toLowerCase())) continue;
        outHeaders[k] = v;
      }
      res.writeHead(upstream.status, outHeaders);

      for await (const chunk of upstream.stream) {
        if (ctl.signal.aborted || res.writableEnded || res.destroyed) break;
        if (!res.write(chunk)) {
          await new Promise<void>((resolve) => {
            const onDone = () => {
              res.off("drain", onDone);
              res.off("close", onDone);
              resolve();
            };
            res.once("drain", onDone);
            res.once("close", onDone);
          });
        }
      }
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (ctl.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof HostRpcError && error.signIn === "expired" ? 401 : 502;
      if (!res.headersSent) {
        jsonError(res, status, message);
      } else if (!res.writableEnded && !res.destroyed) {
        const reason = error instanceof Error ? error : new Error(String(error));
        res.destroy(reason);
      }
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
  }
}
