import { describe, expect, it } from "vitest";
import { fileIcon } from "../src/file-icons.ts";
import { numericColumns } from "../src/csv-columns.ts";

describe("文件图标", () => {
  it.each([
    ["/tmp/a.PNG", "image"], ["a.csv", "table"], ["a.tsv", "table"], ["a.xlsx", "table"],
    ["a.ts", "code"], ["a.py", "code"], ["a.json", "code"], ["a.yaml", "code"],
    ["a.md", "doc"], ["a.pdf", "doc"], ["a.docx", "doc"], ["a.html", "globe"],
    ["a.svg", "globe"], ["a.tar.gz", "archive"], ["a.zip", "archive"],
    ["dir.with.dot/no-extension", "file"], [".env", "file"], ["a.unknown", "file"],
    ["C:\\dir\\file.JS", "code"],
  ])("%s → %s", (name, icon) => expect(fileIcon(name)).toBe(icon));
});

describe("数字列", () => {
  it("只对所有数据行都是有限数字的列右对齐", () => {
    expect(numericColumns([
      ["名称", "数量", "变化", "缺失", "混合"],
      ["甲", " 12 ", "-1.5e2", "1", "2"],
      ["乙", "0", ".25", "", "无"],
    ])).toEqual([false, true, true, false, false]);
  });
  it("没有数据、不完整行和非十进制数不算数字列", () => {
    expect(numericColumns([])).toEqual([]);
    expect(numericColumns([["数字"]])).toEqual([false]);
    expect(numericColumns([["甲", "乙", "丙"], ["0x10", "Infinity", "1"], ["2", "3"]])).toEqual([false, false, false]);
  });
});
