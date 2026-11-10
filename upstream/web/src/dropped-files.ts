// 拖文件进浏览器窗口：松手就进附件流程，和「加文件」走同一条上传路 ——
// 立刻出现在输入框里（图片是缩略图），后台开始上传，点发送一起发出去。

/** 只用到 DataTransfer 的这几位，测试里给个普通对象也能跑。 */
export interface DragItem {
  kind: string;
  getAsFile?(): File | null;
  /** 拖文件夹时靠它认出这是目录；不是所有浏览器都给，没有就当普通文件。 */
  webkitGetAsEntry?(): { isDirectory: boolean } | null;
}

export interface DragData {
  types?: ArrayLike<string> | null;
  files?: ArrayLike<File> | null;
  items?: ArrayLike<DragItem> | null;
}

/**
 * 拖的是文件，而不是选中的文字、链接或页面里的元素 —— 后几种不归这里管，照旧交给页面自己处理。
 * dragenter / dragover 阶段浏览器不给 files（安全限制，只有 drop 时才放出来），所以先看 types 里有没有 `Files`。
 */
export function isFileDrag(data: DragData | null | undefined): boolean {
  if (!data) return false;
  for (const type of Array.from(data.types ?? [])) if (type.toLowerCase() === "files") return true;
  return (data.files?.length ?? 0) > 0;
}

/**
 * 拖进来的文件，由调用方决定拿去做什么；拖的是文件夹就跳过。
 * 浏览器只给文件夹一个名字，里面的文件读不到，硬塞进附件流程只会得到一个 0 字节的空壳。
 * 有 items 时按 items 取（顺序稳定、能认出目录），没有就退回 files。
 */
export function droppedFiles(data: DragData | null | undefined): File[] {
  const items = Array.from(data?.items ?? []).filter((item) => item.kind === "file");
  if (items.length) {
    return items.flatMap((item) => {
      if (item.webkitGetAsEntry?.()?.isDirectory) return [];
      const file = item.getAsFile?.();
      return file ? [file] : [];
    });
  }
  return Array.from(data?.files ?? []).filter((file): file is File => Boolean(file));
}
