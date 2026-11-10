import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { knowledgeGroup, knowledgeLink, type KnowledgeCollection, type KnowledgeChunk, type KnowledgeEntry } from "../../shared/knowledge.ts";
import type { HobRuntime } from "./runtime.ts";
import { monthDayTimeText } from "./time.ts";

export const KNOWLEDGE_INTRO = "（知识库里可能相关的内容。用得上就引用，并照抄出处链接；用不上就忽略。）";

/** 知识库读不出来时当作没绑定：对话和任务照常，不被知识库拖垮。 */
export async function boundKnowledge(runtime: HobRuntime, assistantId: string): Promise<KnowledgeCollection[]> {
  const ids = runtime.store.assistant(assistantId)?.knowledge ?? [];
  if (!ids.length) return [];
  try {
    const { collections } = await runtime.knowledge.list({ limit: 1 });
    return collections.filter((collection) => ids.includes(collection.id));
  } catch (error) {
    console.error("读取知识库失败：", error);
    return [];
  }
}

export function formatKnowledge(results: { entry: KnowledgeEntry; chunk: KnowledgeChunk }[], max: number): string {
  let remaining = max;
  const lines: string[] = [];
  for (const { entry, chunk } of results) {
    const header = `${lines.length + 1}. ${chunk.heading}（[${entry.name}](${knowledgeLink(entry.id, chunk.index)})）\n   `;
    const overhead = [...header].length + (lines.length ? 1 : 0);
    if (remaining <= overhead) break;
    const text = [...chunk.text].slice(0, remaining - overhead).join("");
    if (!text) continue;
    lines.push(header + text);
    remaining -= overhead + [...text].length;
  }
  return lines.join("\n");
}

export function searchKnowledgeTool(runtime: HobRuntime, assistantId: string): ToolDefinition<any, any> {
  return {
    name: "search_knowledge",
    label: "查知识库",
    description: "在绑定给你的知识库里查内容，返回和问题最相关的几段原文，每段带出处链接。",
    parameters: Type.Object({
      query: Type.String({ description: "要查的问题或关键词，写成完整的一句效果更好。" }),
      collection: Type.Optional(Type.String({ description: "可选，只查这个知识库，填名称。" })),
    }),
    execute: async (_id, params: { query: string; collection?: string }) => {
      try {
        const bound = await boundKnowledge(runtime, assistantId);
        const selected = bound.find((collection) => collection.name === params.collection);
        const results = await runtime.knowledge.search(params.query, selected ? [selected.id] : bound.map((collection) => collection.id), { limit: 6 });
        const prefix = runtime.settings.settings.knowledge?.embedding.source === "openai" ? "" : "（只按关键词查）\n";
        const intro = `${KNOWLEDGE_INTRO}\n`;
        const formatted = formatKnowledge(results, 6000 - [...prefix, ...intro].length);
        return { content: [{ type: "text", text: prefix + (formatted ? intro + formatted : "知识库里没有找到相关内容。") }], details: undefined };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  };
}

export function findKnowledgeTool(runtime: HobRuntime): ToolDefinition<any, any> {
  return {
    name: "find_knowledge",
    label: "找资料",
    description: "在知识库里找文件：助手产出、用户在对话里发的素材和用户建的知识库都在里面。按关键词、类型和时间找，找到后用 read 打开。",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "可选，关键词，匹配名称、说明和文字内容；不填就按时间列最近的。" })),
      type: Type.Optional(Type.Union([Type.Literal("image"), Type.Literal("document"), Type.Literal("table"), Type.Literal("page")], { description: "可选：image 图片、document 文档、table 表格、page 网页。" })),
      days: Type.Optional(Type.Number({ description: "可选，只找最近几天的。", exclusiveMinimum: 0 })),
    }),
    execute: async (_id, params: { query?: string; type?: string; days?: number }) => {
      try {
        if (params.days !== undefined && (!Number.isFinite(params.days) || params.days <= 0)) throw new Error("days 必须是大于 0 的数字。");
        const page = await runtime.knowledge.list({ q: params.query?.trim(), kind: params.type, limit: 21 });
        const since = params.days === undefined ? -Infinity : Date.now() - params.days * 86400_000;
        const entries = page.entries.filter((entry) => Date.parse(entry.updatedAt) >= since);
        const labels = { image: "图片", document: "文档", table: "表格", page: "网页", other: "其他" };
        const timezone = runtime.settings.settings.general.timezone;
        const lines = entries.slice(0, 20).map((entry) => {
          const assistant = entry.source?.assistantId;
          const name = assistant ? runtime.store.assistant(assistant)?.name ?? assistant : "用户";
          const line = `${entry.name}（${labels[knowledgeGroup(entry.kind)]}，${name}，${monthDayTimeText(timezone, new Date(entry.updatedAt))}）：${entry.path}`;
          return entry.snippet ? `${line}\n  ${entry.snippet.replace(/\s+/g, " ").trim()}` : line;
        });
        if (!lines.length) lines.push("没有找到。");
        if (entries.length > 20) lines.push("还有更多，换个关键词或缩短时间。");
        return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  };
}
