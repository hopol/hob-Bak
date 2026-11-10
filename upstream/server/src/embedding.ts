import type { EmbeddingSettings } from "../../shared/types.ts";
import { readSecrets } from "./secrets.ts";

export const EMBEDDING_KEY_SECRET = "embedding";

export function embeddingKey(home: string): string {
  return readSecrets(home)[EMBEDDING_KEY_SECRET]?.trim() ?? "";
}

export function checkEmbeddingSettings(raw: unknown): EmbeddingSettings {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (input.source === "off") return { source: "off" };
  if (input.source !== "openai") throw new Error("向量模型来源无效。");
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/+$/, "") : "";
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("向量服务地址无效，请填写 http:// 或 https:// 地址。"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("向量服务地址仅支持 http:// 或 https://。");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) throw new Error("请填写向量模型名称。");
  return { source: "openai", baseUrl, model };
}

export function embeddingModel(config: EmbeddingSettings): string {
  return JSON.stringify(config.source === "openai" ? { source: config.source, baseUrl: config.baseUrl, model: config.model } : config);
}

export function normalizeEmbeddingSettings(raw: unknown, fallback: EmbeddingSettings): EmbeddingSettings {
  try { return checkEmbeddingSettings(raw); } catch { return fallback; }
}

export async function embed(config: EmbeddingSettings, key: string, input: string[], fetchImpl: typeof fetch = fetch): Promise<number[][]> {
  if (config.source !== "openai") throw new Error("尚未配置向量模型。");
  if (!key.trim()) throw new Error("尚未填写向量模型 API Key。");
  const vectors: number[][] = [];
  for (let start = 0; start < input.length; start += 32) {
    const batch = input.slice(start, start + 32);
    const response = await fetchImpl(`${config.baseUrl}/embeddings`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, input: batch }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`向量接口返回 ${response.status}：${(await response.text()).slice(0, 1000)}`);
    const result = await response.json() as { data?: { index: number; embedding: unknown }[] };
    if (!Array.isArray(result.data) || result.data.length !== batch.length) throw new Error("向量接口返回的数量不正确。");
    const sorted = [...result.data].sort((a, b) => a.index - b.index);
    for (const [i, item] of sorted.entries()) {
      if (item.index !== i || !Array.isArray(item.embedding) || !item.embedding.length || !item.embedding.every((v: unknown) => typeof v === "number" && Number.isFinite(v))) throw new Error("向量接口返回的数据无效。");
      vectors.push(item.embedding as number[]);
    }
  }
  if (vectors.some((v) => v.length !== vectors[0]?.length)) throw new Error("向量接口返回的维数不一致。");
  return vectors;
}
