// 图像生成：OpenAI 兼容接口（Key 存 secrets.json，只写不读回界面）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ImageSettings } from "../../shared/types.ts";
import { IMAGE_TYPES } from "../../shared/media.ts";
import { newId } from "./ids.ts";
import { readSecrets } from "./secrets.ts";

/** secrets.json 里 OpenAI 兼容接口的 Key。 */
export const IMAGE_KEY_SECRET = "imageApiKey";

/** 生成图像可能很慢（一张图几十秒），别让它挂死一个任务。 */
const TIMEOUT_MS = 180_000;

const MIME_BY_EXT = IMAGE_TYPES;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** 配置不合法就抛错，界面把原因原样显示。 */
export function checkImageSettings(raw: unknown): ImageSettings {
  const input = (raw ?? {}) as Record<string, unknown>;
  const source = input.source;
  if (source === "off") return { source: "off" };
  if (source === "openai") {
    const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/+$/, "") : "";
    if (!baseUrl) throw new Error("请填写服务地址，如 http://127.0.0.1:8080/v1。");
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("服务地址无效：需以 http:// 或 https:// 开头，如 http://127.0.0.1:8080/v1。");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("服务地址协议无效：仅支持 http:// 或 https://。");
    }
    const model = typeof input.model === "string" ? input.model.trim() : "";
    if (!model) throw new Error("请填写图像模型名称，如 gpt-image-1。");
    const size = typeof input.size === "string" ? input.size.trim() : "";
    return { source: "openai", baseUrl, model, ...(size ? { size } : {}) };
  }
  throw new Error("图片来源无效：可选值为关闭或 OpenAI 兼容接口。");
}

/** 读存盘的配置：坏的就退回上一次的值，不因为一个字段把整份设置弄坏。 */
export function normalizeImageSettings(raw: unknown, fallback: ImageSettings): ImageSettings {
  try {
    return checkImageSettings(raw);
  } catch {
    return fallback;
  }
}

export function imageConfigured(image: ImageSettings): boolean {
  return image.source !== "off";
}

/** OpenAI 兼容接口的 Key（没配就是空字符串）。 */
export function imageKey(home: string): string {
  return readSecrets(home)[IMAGE_KEY_SECRET]?.trim() ?? "";
}

/** 生成图片的上下文。 */
export interface ImageContext {
  /** HOB_HOME：OpenAI 兼容接口的 Key 从 secrets.json 读 */
  home: string;
  /** 生成的图片存这个目录 */
  dir: string;
  config: ImageSettings;
  /** 给了就用它，不给从 secrets.json 读 */
  apiKey?: string;
  /** 测试注入假服务器 */
  fetchImpl?: typeof fetch;
}

export interface GenerateImageInput {
  prompt: string;
  size?: string;
  refs?: string[]; // 参考图（绝对路径）
}

interface ImageBytes {
  data: Buffer;
  mimeType: string;
}

function mimeOfPath(path: string): string {
  const mime = MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mime) throw new Error(`参考图格式不支持：仅支持 png、jpg、jpeg、gif、webp，当前文件为 ${path}。`);
  return mime;
}

/** 生成一张图，存进目录，返回绝对路径。失败抛错，原因直接给用户看。 */
export async function generateImage(ctx: ImageContext, input: GenerateImageInput): Promise<string> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("生成失败：提示词为空。");
  if (ctx.config.source !== "openai") {
    throw new Error("尚未配置图像生成：请在「设置 → 图像生成」中选择 OpenAI 兼容接口。");
  }
  const bytes: ImageBytes = await openAIImage(ctx, ctx.config, prompt, input);
  if (!bytes.data.length) throw new Error("生成失败：接口返回了空图片。");
  mkdirSync(ctx.dir, { recursive: true });
  const ext = EXT_BY_MIME[bytes.mimeType.toLowerCase()] ?? "png";
  const path = join(ctx.dir, `${newId("img-")}.${ext}`);
  writeFileSync(path, bytes.data);
  return path;
}


async function openAIImage(
  ctx: ImageContext,
  config: Extract<ImageSettings, { source: "openai" }>,
  prompt: string,
  input: GenerateImageInput,
): Promise<ImageBytes> {
  const key = ctx.apiKey?.trim() || imageKey(ctx.home);
  if (!key) throw new Error("尚未填写 API Key：请在「设置 → 图像生成」中填写后重试。");
  const size = input.size?.trim() || config.size?.trim() || "";
  const refs = input.refs ?? [];
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const endpoint = `${config.baseUrl}${refs.length ? "/images/edits" : "/images/generations"}`;

  let request: RequestInit;
  if (refs.length) {
    // 有参考图：multipart 打到 /images/edits
    const form = new FormData();
    form.append("model", config.model);
    form.append("prompt", prompt);
    if (size) form.append("size", size);
    for (const ref of refs) {
      const mimeType = mimeOfPath(ref);
      form.append(refs.length > 1 ? "image[]" : "image", new Blob([readFileSync(ref)], { type: mimeType }), basename(ref));
    }
    request = { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form };
  } else {
    request = {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      // 不传 response_format：有的服务只给 URL，两种都支持，别逼它
      body: JSON.stringify({ model: config.model, prompt, ...(size ? { size } : {}), n: 1 }),
    };
  }

  const response = await send(fetchImpl, endpoint, request, config.baseUrl);
  const body = (await response.json().catch(() => undefined)) as unknown;
  const first = firstImage(body);
  if (!first) throw new Error(`生成失败：接口未返回图片：${snippet(body)}`);
  if (first.b64_json) return { data: Buffer.from(first.b64_json, "base64"), mimeType: "image/png" };
  const fetched = await send(fetchImpl, first.url!, { method: "GET" }, first.url!);
  const mimeType = fetched.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  return { data: Buffer.from(await fetched.arrayBuffer()), mimeType };
}

/** OpenAI 兼容接口的返回里挑第一张图（base64 或 URL 都行）。 */
export function firstImage(body: unknown): { b64_json?: string; url?: string } | undefined {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data) || !data.length) return undefined;
  const first = data[0] as { b64_json?: unknown; url?: unknown } | undefined;
  if (!first || typeof first !== "object") return undefined;
  const b64 = typeof first.b64_json === "string" && first.b64_json ? first.b64_json : undefined;
  const url = typeof first.url === "string" && first.url ? first.url : undefined;
  return b64 || url ? { ...(b64 ? { b64_json: b64 } : {}), ...(url ? { url } : {}) } : undefined;
}

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, label: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/timeout|timed out|abort/i.test(reason)) throw new Error(`${label} 请求超时：${TIMEOUT_MS / 1000} 秒内未响应。`);
    throw new Error(`无法连接 ${label}：${reason}`);
  }
  if (!response.ok) throw new Error(await describeFailure(response, label));
  return response;
}

async function describeFailure(response: Response, label: string): Promise<string> {
  const detail = errorText(await response.text().catch(() => ""));
  const suffix = detail ? `：${detail}` : "";
  if (response.status === 401 || response.status === 403) {
    return `${label} 拒绝该 API Key（${response.status}）${suffix}`;
  }
  if (response.status === 404) {
    return `${label} 未提供该接口或模型（404）${suffix}。请检查服务地址是否需要包含 /v1，以及模型名称是否正确。`;
  }
  return `${label} 返回状态码 ${response.status}${suffix}`;
}

/** 从错误体里抠出人能看懂的一句话。 */
function errorText(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // 不是 JSON：原样给一小段
  }
  return snippet(text);
}

function snippet(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "（空）";
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}
