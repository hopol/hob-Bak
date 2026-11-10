import { readFile } from "node:fs/promises";
import type { KnowledgeChunk, KnowledgeEntry } from "../../shared/knowledge.ts";

export type IndexedChunk = KnowledgeChunk & { start: number; end: number };
export class UnsupportedIndex extends Error {}
const MAX_TEXT = 5 * 1024 * 1024;
// 中文 PDF 的文字层常把「手」「见」存成康熙部首、部首补充（Chrome、Word 导出都这样），查不到；
// NFKC 能还原康熙部首，部首补充和「⼾」（NFKC 给的是繁体「戶」）按简体补上。
const RADICALS: Record<string, string> = Object.fromEntries([..."⼾户⻅见⻆角⻓长⻔门⻚页⻛风⻜飞⻢马⻥鱼⻦鸟⻬齐⻮齿⻰龙⻳龟⻉贝⻋车⻘青⻙韦⻝食⻨麦⻩黄⻤鬼"].flatMap((c, i, all) => i % 2 ? [] : [[c, all[i + 1]!]]));

/** PDF 抽出的文字：部首还原成汉字，去掉汉字之间的折行（不然跨行的词查不到）。PDF 只按页定位，位置变了不影响。 */
export function cleanPdfText(text: string): string {
  return text.replace(/[\u2E80-\u2FDF\uF900-\uFAFF]/g, (c) => RADICALS[c] ?? c.normalize("NFKC")).replace(/([\u3400-\u9fff])\n(?=[\u3400-\u9fff])/g, "$1");
}

/** 位置针对抽出的文字；PDF 每页独立计算。 */
export async function extractChunks(entry: KnowledgeEntry): Promise<IndexedChunk[]> {
  if (!["markdown", "text", "code", "csv", "json", "html", "xml", "pdf"].includes(entry.kind)) throw new UnsupportedIndex("这类文件还不能建索引");
  const data = await readFile(entry.path);
  const chunks: IndexedChunk[] = [];
  let bytes = 0;
  const add = (text: string, heading: string, start: number, page?: number) => {
    const clean = text.trim();
    if (!clean) return;
    const offset = text.indexOf(clean);
    chunks.push({ index: chunks.length, heading, text: clean, start: start + offset, end: start + offset + clean.length, ...(page ? { page } : {}) });
  };
  const split = (text: string, heading: string, start = 0, page?: number, prefix = "") => {
    let pos = 0;
    while (pos < text.length) {
      let end = Math.min(pos + Math.max(1, 800 - prefix.length), text.length);
      if (end < text.length) {
        const part = text.slice(pos, end);
        const boundary = Math.max(part.lastIndexOf("\n\n"), part.lastIndexOf("\n"), part.lastIndexOf("。"));
        if (boundary >= 300) end = pos + boundary + 1;
      }
      add(prefix + text.slice(pos, end), heading, start + pos, page);
      pos = end;
    }
  };
  const sections = (text: string, page?: number) => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_TEXT) throw new Error("文件太大：抽出的文字超过 5 MB");
    const headings: string[] = [];
    const pattern = entry.kind === "html" ? /^[ \t]{0,3}(#{1,6})[ \t]*(.+?)[ \t]*#*[ \t]*$/gm : /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
    let sectionStart = 0;
    const base = page ? [entry.name, `第 ${page} 页`] : [entry.name];
    let heading = base.join(" › ");
    for (const match of text.matchAll(pattern)) {
      const at = match.index;
      split(text.slice(sectionStart, at), heading, sectionStart, page);
      const level = match[1]!.length;
      headings.length = level - 1;
      headings[level - 1] = match[2]!.trim();
      heading = [...base, ...headings.filter(Boolean)].join(" › ");
      sectionStart = at + match[0].length;
    }
    split(text.slice(sectionStart), heading, sectionStart, page);
  };
  if (entry.kind === "pdf") {
    const { extractText } = await import("unpdf");
    const result = await extractText(new Uint8Array(data), { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    if (!pages.some((p) => p.trim())) throw new UnsupportedIndex("没有文字层，三期识字");
    pages.forEach((page, i) => sections(cleanPdfText(page), i + 1));
  } else {
    let text = data.toString("utf8");
    if (Buffer.byteLength(text) > MAX_TEXT) throw new Error("文件太大：抽出的文字超过 5 MB");
    if (entry.kind === "html") {
      const blank = (value: string) => value.replace(/[^\n]/g, " ");
      text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blank)
        .replace(/<h([1-3])\b[^>]*>/gi, (tag, level: string) => `\n${"#".repeat(Number(level))}${" ".repeat(Math.max(0, tag.length - Number(level) - 1))}`)
        .replace(/<\/h[1-3]\s*>/gi, (tag) => `\n${" ".repeat(tag.length - 1)}`)
        .replace(/<[^>]*>/g, blank);
      sections(text);
    } else if (entry.kind === "markdown") sections(text);
    else if (entry.kind === "csv") {
      const ends: number[] = [];
      let quoted = false;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '"') {
          if (quoted && text[i + 1] === '"') i++;
          else quoted = !quoted;
        } else if (text[i] === "\n" && !quoted) ends.push(i + 1);
      }
      if (ends.at(-1) !== text.length) ends.push(text.length);
      const first = ends.shift() ?? text.length;
      const header = text.slice(0, first).trimEnd();
      let start = first;
      let end = first;
      for (const rowEnd of ends) {
        if (end > start && rowEnd - start + header.length + 1 > 800) {
          chunks.push({ index: chunks.length, heading: entry.name, text: `${header}\n${text.slice(start, end).trimEnd()}`, start, end });
          start = end;
        }
        end = rowEnd;
      }
      if (end > start) chunks.push({ index: chunks.length, heading: entry.name, text: `${header}\n${text.slice(start, end).trimEnd()}`, start, end });
      else if (!chunks.length && header) add(header, entry.name, 0);
    } else if (entry.kind === "json") {
      JSON.parse(text);
      const open = text.search(/\S/);
      if (text[open] !== "{" && text[open] !== "[") split(text, entry.name);
      else {
        let start = open + 1, depth = 0, quoted = false, escaped = false;
        for (let i = start; i < text.length; i++) {
          const char = text[i]!;
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === "{" || char === "[") depth++;
          else if (char === "}" || char === "]") {
            if (depth) depth--;
            else { split(text.slice(start, i), entry.name, start); break; }
          } else if (char === "," && depth === 0) { split(text.slice(start, i), entry.name, start); start = i + 1; }
        }
      }
    } else split(text, entry.name);
  }
  return chunks;
}
