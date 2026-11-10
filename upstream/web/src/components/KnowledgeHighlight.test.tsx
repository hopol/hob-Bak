import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../markdown.ts";
import { knowledgeFind, matchKnowledgeText } from "../knowledge-highlight.ts";

vi.mock("../store.ts", () => ({}));
import { CsvView } from "./FilePreview.tsx";

// 用渲染结果的各个文本节点检验跨节点匹配和位置映射。
function nodes(html: string): Text[] {
  return html.split(/<[^>]*>/).filter(Boolean).map((data) => ({ data } as Text));
}

describe("知识库出处定位", () => {
  it("Markdown 标题、粗体和链接跨渲染节点定位", () => {
    const chunk = "## 巡检标题\n**重要结论** [操作指南](https://example.com/docs) 已完成。";
    const textNodes = nodes(renderMarkdown(chunk));
    const find = knowledgeFind(chunk);
    expect(find).toBe("巡检标题重要结论操作指南已完成");
    const result = matchKnowledgeText(textNodes, find);
    expect(result).not.toBeNull();
    expect(result?.start.node.data.slice(result.start.offset)).toBe("巡检标题");
    expect(result?.end.node.data.slice(0, result.end.offset)).toContain("已完成");
  });
  it("CSV 段落在真实渲染的表格里跨单元格定位", () => {
    const csv = "项目,状态\n巡检,已完成\n";
    const html = renderToStaticMarkup(<CsvView text={csv} tsv={false} />);
    const result = matchKnowledgeText(nodes(html), knowledgeFind(csv));
    expect(result?.start.node.data).toBe("项目");
    expect(result?.end.node.data.slice(0, result.end.offset)).toBe("已完成");
  });
  it("整段对不上时用开头和结尾定两头", () => {
    const chunk = `${"甲".repeat(45)}\n\n![示意图](a.png)\n\n${"乙".repeat(45)}`;
    const textNodes = nodes(renderMarkdown(chunk));
    const result = matchKnowledgeText(textNodes, knowledgeFind(chunk));
    expect(result?.start.node.data.slice(result.start.offset)).toBe("甲".repeat(45));
    expect(result?.end.node.data.slice(0, result.end.offset)).toBe("乙".repeat(45));
  });
  it("只留字母和数字，不包含链接地址或符号", () => {
    expect(knowledgeFind(`> [文件](https://example.com) **${"字".repeat(50)}**`)).toBe(`文件${"字".repeat(50)}`);
    expect(knowledgeFind("# 符号😀 -- Ａ𠀀12")).toBe("符号Ａ𠀀12");
  });
});
