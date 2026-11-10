// 文件预览的种类判定：服务端给 content-type 和元数据、前端挑预览方式都用它。
// 只看扩展名（不读内容）；不认识的扩展名（含无扩展名）返回 undefined，由服务端嗅探开头几个字节。

import type { FileKind } from "./types.ts";

const KIND_BY_EXT: Record<string, FileKind> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".avif": "image",
  ".bmp": "image",
  ".ico": "image",
  ".svg": "svg",
  ".pdf": "pdf",
  ".mp3": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".m4a": "audio",
  ".flac": "audio",
  ".aac": "audio",
  ".mp4": "video",
  ".webm": "video",
  ".mov": "video",
  ".m4v": "video",
  ".md": "markdown",
  ".markdown": "markdown",
  ".json": "json",
  ".jsonl": "json",
  ".ndjson": "json",
  ".csv": "csv",
  ".tsv": "csv",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".ts": "code",
  ".tsx": "code",
  ".js": "code",
  ".jsx": "code",
  ".mjs": "code",
  ".cjs": "code",
  ".py": "code",
  ".sh": "code",
  ".bash": "code",
  ".zsh": "code",
  ".go": "code",
  ".rs": "code",
  ".java": "code",
  ".kt": "code",
  ".swift": "code",
  ".c": "code",
  ".h": "code",
  ".cc": "code",
  ".cpp": "code",
  ".hpp": "code",
  ".cs": "code",
  ".rb": "code",
  ".php": "code",
  ".scala": "code",
  ".lua": "code",
  ".pl": "code",
  ".css": "code",
  ".scss": "code",
  ".less": "code",
  ".vue": "code",
  ".svelte": "code",
  ".yaml": "code",
  ".yml": "code",
  ".toml": "code",
  ".ini": "code",
  ".conf": "code",
  ".cfg": "code",
  ".properties": "code",
  ".sql": "code",
  ".graphql": "code",
  ".proto": "code",
  ".diff": "code",
  ".patch": "code",
  ".log": "text",
  ".txt": "text",
  ".text": "text",
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".ndjson": "application/x-ndjson; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** 按扩展名判种类；不认识的扩展名（含无扩展名）返回 undefined。 */
export function fileKind(name: string): FileKind | undefined {
  return KIND_BY_EXT[extension(name)];
}

/** 按扩展名给 content-type；不认识的就是二进制。 */
export function mimeOf(name: string): string {
  return MIME_BY_EXT[extension(name)] ?? "application/octet-stream";
}

/**
 * 这种文件是不是按文本处理（预览面板要不要拉内容、超过 1 MB 要不要截）。
 * svg 不算：它按图片显示，不按文本。
 */
export function isTextKind(kind: FileKind): boolean {
  return (
    kind === "markdown" || kind === "json" || kind === "csv" || kind === "html" || kind === "xml" || kind === "code" || kind === "text"
  );
}
