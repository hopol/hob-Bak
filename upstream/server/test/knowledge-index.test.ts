import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../../shared/knowledge.ts";
import { cleanPdfText, extractChunks } from "../src/knowledge-index.ts";

function entry(kind: KnowledgeEntry["kind"], path: string): KnowledgeEntry {
  return { id: "k-test", origin: "upload", name: "文件", kind, path, hash: "h", size: 0, createdAt: "", updatedAt: "", collections: ["kc"] };
}

describe("知识库切块", () => {
  it("处理标题、长节、表头、JSON 和网页", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hob-chunks-"));
    const path = join(dir, "input");
    try {
      writeFileSync(path, `# 一级\n## 二级\n${"测试段落。".repeat(300)}`);
      const md = await extractChunks(entry("markdown", path));
      expect(md.length).toBeGreaterThan(1);
      expect(md.every((c) => c.heading === "文件 › 一级 › 二级" && c.text.length <= 800)).toBe(true);
      writeFileSync(path, `姓名,内容\n${"张三,测试内容\n".repeat(200)}`);
      const csv = await extractChunks(entry("csv", path));
      expect(csv.every((c) => c.text.startsWith("姓名,内容\n") && c.text.endsWith("测试内容"))).toBe(true);
      writeFileSync(path, '{"测试":1,"另一项":2}');
      const json = await extractChunks(entry("json", path));
      expect(json).toHaveLength(2);
      expect(json.map((c) => '{"测试":1,"另一项":2}'.slice(c.start, c.end))).toEqual(json.map((c) => c.text));
      writeFileSync(path, "<h1>标题</h1><script>secret</script><style>bad</style><p>正文</p>");
      const html = await extractChunks(entry("html", path));
      expect(html[0]?.heading).toBe("文件 › 标题");
      expect(JSON.stringify(html)).not.toContain("secret");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("PDF 文字里的部首还原、汉字间折行去掉", () => {
    expect(cleanPdfText("⽤⼾和助⼿\n⻅⾯，标\n签 Hob\n不变")).toBe("用户和助手见面，标签 Hob\n不变");
  });
  it("逐页提取 PDF，扫描件标不支持", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hob-pdf-"));
    const path = join(dir, "test.pdf");
    const pdf = (content: string) => {
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ];
      let out = "%PDF-1.4\n"; const offsets = [0];
      objects.forEach((object, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${object}\nendobj\n`; });
      const xref = Buffer.byteLength(out);
      out += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return out;
    };
    try {
      writeFileSync(path, pdf("BT /F1 12 Tf 40 200 Td (Hello Hob) Tj ET"));
      expect(await extractChunks(entry("pdf", path))).toMatchObject([{ page: 1, heading: "文件 › 第 1 页", text: expect.stringContaining("Hello Hob") }]);
      writeFileSync(path, pdf(""));
      await expect(extractChunks(entry("pdf", path))).rejects.toThrow("没有文字层");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
