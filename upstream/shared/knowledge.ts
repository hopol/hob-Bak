// 知识库的数据契约：服务端（server/src/knowledge.ts、http.ts）和页面共用。设计见 .scratch/v2/design-knowledge.md。

import type { FileKind } from "./types.ts";

/** 怎么进来的：助手产出、对话上传（这两类自动收，不建索引），或在知识库里上传。 */
export type KnowledgeOrigin = "output" | "chat" | "upload";

/** 页面上的类型筛选；一条只属于一组，由 FileKind 决定（见 knowledgeGroup）。 */
export type KnowledgeGroup = "image" | "document" | "table" | "page" | "other";

export interface KnowledgeVersion {
  hash: string;
  path: string;
  size: number;
  at: string;
}

export interface KnowledgeEntry {
  id: string; // k-xxxx
  origin: KnowledgeOrigin;
  name: string; // 显示名：原文件名或页面标题，用户可改
  description?: string; // 页面摘要、生图提示词或任务标题
  kind: FileKind;
  path: string; // 当前版本在知识库目录里的绝对路径，经 /api/files 取
  hash: string;
  size: number;
  createdAt: string;
  updatedAt: string; // 只跟内容走（新版本时更新），改名和整理不动；列表按它排序
  versions?: KnowledgeVersion[]; // 旧版本，旧的在前
  source?: { assistantId: string; itemId?: string; jobId?: string }; // 出处
  collections: string[]; // 所在的用户知识库 id
  index?: KnowledgeIndex; // 二期：只在条目属于至少一个用户知识库时有
}

export interface KnowledgeCollection {
  id: string; // kc-xxxx
  name: string;
  createdAt: string;
  count: number; // 里面有几条
  indexed?: number; // 二期：索引已建好的条数
  failed?: number; // 二期：建索引失败的条数
  unsupported?: number; // 二期：这类文件还不能建索引的条数（不算进「已建索引 a/b」的 b）
}

/** 二期：用户知识库里文件的索引状态。queued/indexing/failed 的文件查不到；unsupported = 这类文件还不能建索引。 */
export type KnowledgeIndexState = "queued" | "indexing" | "ready" | "failed" | "unsupported";

export interface KnowledgeIndex {
  state: KnowledgeIndexState;
  chunks?: number; // ready 时有几段
  error?: string; // failed / unsupported 的原因，直接给用户看
}

/** 一段原文。出处链接 #k/<条目 id>/<index> 指到这里。 */
export interface KnowledgeChunk {
  index: number; // 在这个文件里是第几段，从 0 起
  heading: string; // 标题路径：「文件名 › 一级 › 二级」
  text: string;
  page?: number; // PDF 的页码，从 1 起
}

/** GET /api/knowledge/entries/:id[?chunk=N] 的返回。 */
export interface KnowledgeEntryView {
  entry: KnowledgeEntry;
  chunk?: KnowledgeChunk; // 带了 chunk 且这段存在时才有
}

/** 出处链接：工具和自动检索给出，助手照抄进回答，界面点开定位。 */
export function knowledgeLink(entryId: string, chunk: number): string {
  return `#k/${entryId}/${chunk}`;
}

export function parseKnowledgeLink(href: string): { entryId: string; chunk?: number } | null {
  const match = /^#k\/(k-[\w-]+)(?:\/(\d+))?$/.exec(href.trim());
  return match ? { entryId: match[1]!, ...(match[2] !== undefined ? { chunk: Number(match[2]) } : {}) } : null;
}

/** GET /api/knowledge 的返回。 */
export interface KnowledgePage {
  entries: (KnowledgeEntry & { snippet?: string })[]; // snippet：关键词命中文字时的前后片段
  hasMore: boolean;
  collections: KnowledgeCollection[];
}

/** 类型筛选的分组。 */
export function knowledgeGroup(kind: FileKind): KnowledgeGroup {
  if (kind === "image" || kind === "svg") return "image";
  if (kind === "csv" || kind === "json") return "table";
  if (kind === "html") return "page";
  if (kind === "markdown" || kind === "text" || kind === "pdf" || kind === "code" || kind === "xml") return "document";
  return "other";
}
