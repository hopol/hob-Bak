// 对话里的图片缩略图：长边 720px 的 JPEG/PNG，按（路径、大小、修改时间）缓存在 HOB_HOME/cache/thumbs。
// 对话列表只拉缩略图，点开预览才拉原图。原图本来就小、GIF（可能是动图）、缩不了的，都直接给原图。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";

const THUMB_EDGE = 720;
const RESIZABLE = new Set(["image/jpeg", "image/png", "image/webp"]);
const inflight = new Map<string, Promise<Thumb | null>>();

export interface Thumb {
  data: Uint8Array;
  mime: string;
}

export async function thumbnail(home: string, file: { path: string; size: number; modifiedAt: string; mime: string }): Promise<Thumb | null> {
  if (!RESIZABLE.has(file.mime)) return null;
  const key = createHash("sha1").update(`${file.path}\0${file.size}\0${file.modifiedAt}`).digest("hex");
  const dir = join(home, "cache", "thumbs");
  for (const [ext, mime] of [["jpg", "image/jpeg"], ["png", "image/png"]] as const) {
    const cached = join(dir, `${key}.${ext}`);
    if (existsSync(cached)) return { data: readFileSync(cached), mime };
  }
  // 原图大小就不值得缩：记一个空标记，下次直接给原图
  if (existsSync(join(dir, `${key}.orig`))) return null;
  let job = inflight.get(key);
  if (!job) {
    job = make(dir, key, file).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

async function make(dir: string, key: string, file: { path: string; mime: string }): Promise<Thumb | null> {
  const resized = await resizeImage(readFileSync(file.path), file.mime, { maxWidth: THUMB_EDGE, maxHeight: THUMB_EDGE, maxBytes: 400_000, jpegQuality: 82 }).catch(() => null);
  mkdirSync(dir, { recursive: true });
  if (!resized || !resized.wasResized) {
    writeFileSync(join(dir, `${key}.orig`), "");
    return null;
  }
  const data = Buffer.from(resized.data, "base64");
  const target = join(dir, `${key}.${resized.mimeType === "image/png" ? "png" : "jpg"}`);
  // 先写临时文件再改名：并发读到的不会是半截图
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
  return { data, mime: resized.mimeType };
}
