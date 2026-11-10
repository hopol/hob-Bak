// 粘贴截图：把剪贴板里的图片交给输入框的附件流程，和「加文件」选出来的走同一条路 ——
// 立刻出现在输入框里（图片是缩略图），后台开始上传，点发送一起发出去。

/** 剪贴板里的图片常常没扩展名，按 MIME 补一个，不然 isImagePath 认不出来。 */
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** 浏览器给粘贴图片起的通用名（Chrome 是 image.png，个别浏览器给空名字）。 */
const GENERIC_NAME = /^(?:image|blob|clipboard|pasted|snapshot|untitled|无标题|未命名)(?:[-_ ]?\d+)?(?:\.[a-z0-9]+)?$/i;

/** 只用到 DataTransfer 的这几位，测试里给个普通对象也能跑。 */
export interface ClipboardData {
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
  files?: ArrayLike<File> | null;
  getData?(format: string): string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 20261106-161245，本地时间。 */
function clock(at: Date): string {
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

function extension(file: File): string {
  const dot = file.name.lastIndexOf(".");
  if (dot > 0) return file.name.slice(dot).toLowerCase();
  return MIME_EXT[file.type] ?? "";
}

/** 剪贴板里的文件：优先 items（顺序稳定、带 kind），没有再退回 files。 */
function clipboardFiles(data: ClipboardData | null | undefined): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (!files.length) {
    for (const file of Array.from(data.files ?? [])) if (file) files.push(file);
  }
  return files;
}

/**
 * 粘贴时应当接收的文件；不该接管就返回空数组。
 *
 * 同时带文字的复制（Excel 单元格、网页上选中一段带图的内容）仍然按文字粘贴：
 * 那种情况下用户要的是字，不是图。截图工具只往剪贴板放图片，文字是空的，照常接。
 * 图片名换成带时间的 `截图-20261106-161245.png`，一次粘贴多张加序号；
 * 有正经名字的文件（从文件管理器复制过来的）原样保留。
 */
export function pastedFiles(data: ClipboardData | null | undefined, at = new Date()): File[] {
  const files = clipboardFiles(data);
  if (!files.length) return [];
  if ((data?.getData?.("text/plain") ?? "").trim()) return [];
  const stamp = clock(at);
  const many = files.length > 1;
  return files.map((file, index) => {
    if (file.name && !GENERIC_NAME.test(file.name)) return file;
    const name = `截图-${stamp}${many ? `-${index + 1}` : ""}${extension(file)}`;
    return new File([file], name, { type: file.type, lastModified: at.getTime() });
  });
}
