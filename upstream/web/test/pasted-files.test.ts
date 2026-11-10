import { describe, expect, it } from "vitest";
import { pastedFiles } from "../src/pasted-files.ts";

// 截图工具往剪贴板里只放一张图，文字是空的
const AT = new Date(2026, 10, 6, 16, 12, 45);

function image(name: string, type = "image/png", body = "png"): File {
  return new File([body], name, { type, lastModified: AT.getTime() });
}

/** DataTransfer 的最小替身：items 只认 kind，files 用来兜底，getData 给纯文字。 */
function clip(files: File[], text = "", { useFiles = false } = {}) {
  const items = files.map((file) => ({ kind: "file", getAsFile: () => file }));
  return {
    items: [...items, { kind: "string", getAsFile: () => null }],
    files: useFiles ? files : [],
    getData: (format: string) => (format === "text/plain" ? text : ""),
  };
}

describe("粘贴截图", () => {
  it("图片换成带时间的名字，扩展名照抄", () => {
    const [file] = pastedFiles(clip([image("image.png")]), AT);
    expect(file.name).toBe("截图-20261106-161245.png");
  });

  it("一次粘多张加序号", () => {
    const names = pastedFiles(clip([image("image.png"), image("image.png")]), AT).map((file) => file.name);
    expect(names).toEqual(["截图-20261106-161245-1.png", "截图-20261106-161245-2.png"]);
  });

  it("没有扩展名时按 MIME 补", () => {
    const [file] = pastedFiles(clip([image("blob", "image/jpeg")]), AT);
    expect(file.name).toBe("截图-20261106-161245.jpg");
  });

  it("有正经名字的文件原样保留", () => {
    const source = image("火星日落.png");
    expect(pastedFiles(clip([source]), AT)[0]).toBe(source);
  });

  it("items 里没有文件时退回 files", () => {
    const data = { items: [], files: [image("image.png")], getData: () => "" };
    expect(pastedFiles(data, AT)[0].name).toBe("截图-20261106-161245.png");
  });

  it("同时带文字时不接管，按文字粘贴", () => {
    expect(pastedFiles(clip([image("image.png")], "单元格 A1"), AT)).toEqual([]);
  });

  it("只有空白文字仍然当图片", () => {
    expect(pastedFiles(clip([image("image.png")], " \n "), AT)).toHaveLength(1);
  });

  it("剪贴板里没有文件就不动", () => {
    expect(pastedFiles(clip([]), AT)).toEqual([]);
    expect(pastedFiles(null, AT)).toEqual([]);
    expect(pastedFiles(undefined, AT)).toEqual([]);
  });
});
