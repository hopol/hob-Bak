import { describe, expect, it } from "vitest";
import { droppedFiles, isFileDrag } from "../src/dropped-files.ts";

function file(name: string, type = "image/png"): File {
  return new File(["x"], name, { type });
}

/** DataTransfer 的最小替身：types 判断是不是拖文件，items 带目录信息，files 用来兜底。 */
function dt(
  files: File[],
  { types = ["Files"], items = true, dirs = [] as string[] } = {},
) {
  const entries = files.map((f) => ({ kind: "file", name: f.name, getAsFile: () => f }));
  const folders = dirs.map((name) => ({
    kind: "file",
    name,
    getAsFile: () => null,
    webkitGetAsEntry: () => ({ isDirectory: true }),
  }));
  return {
    types,
    files,
    items: items ? [...entries, ...folders, { kind: "string" }] : undefined,
  };
}

describe("拖动文件进浏览器", () => {
  it("types 里有 Files 就算拖文件", () => {
    expect(isFileDrag({ types: ["Files"] })).toBe(true);
    expect(isFileDrag({ types: ["files"] })).toBe(true);
  });

  it("拖选中的文字、链接不归这里管", () => {
    expect(isFileDrag({ types: ["text/plain"] })).toBe(false);
    expect(isFileDrag({ types: ["text/plain", "text/html"] })).toBe(false);
    expect(isFileDrag({ types: [] })).toBe(false);
    expect(isFileDrag(null)).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });

  it("只有 files 没有 types 时也认（少数环境不给 types）", () => {
    expect(isFileDrag({ types: [], files: [file("a.png")] })).toBe(true);
  });

  it("按拖进来的顺序交出文件，名字一个都不改", () => {
    const files = [file("报告.pdf", "application/pdf"), file("火星日落.png")];
    expect(droppedFiles(dt(files)).map((f) => f.name)).toEqual(["报告.pdf", "火星日落.png"]);
  });

  it("拖文件夹跳过：浏览器只给目录名，读不到里面的文件", () => {
    const files = [file("a.png")];
    expect(droppedFiles(dt(files, { dirs: ["截图文件夹"] })).map((f) => f.name)).toEqual(["a.png"]);
  });

  it("只拖了文件夹就当没有文件", () => {
    expect(droppedFiles(dt([], { dirs: ["截图文件夹"] }))).toEqual([]);
  });

  it("没有 items 时退回 files", () => {
    const files = [file("a.png"), file("b.txt", "text/plain")];
    expect(droppedFiles(dt(files, { items: false })).map((f) => f.name)).toEqual(["a.png", "b.txt"]);
  });

  it("什么都没拖进来时是空的", () => {
    expect(droppedFiles(null)).toEqual([]);
    expect(droppedFiles(undefined)).toEqual([]);
    expect(droppedFiles({ types: ["Files"] })).toEqual([]);
  });
});
