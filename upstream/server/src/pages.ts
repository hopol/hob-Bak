import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HobRuntime } from "./runtime.ts";
import { assistantFilesDir } from "./config.ts";
import { pageHtml } from "../../shared/page-shell.ts";
export { pageHtml } from "../../shared/page-shell.ts";

const MAX = 80_000;

/** 展示页面存进这个助手的 files/pages，和其他产出分开。 */
export async function renderPage(home: string, assistantId: string, title: string, summary: string, html: string): Promise<string> {
  if (!html.trim()) throw new Error("页面内容不能为空。");
  if (html.length > MAX) throw new Error(`页面内容不能超过 ${MAX} 字。`);
  if (/<\s*(!doctype|html|head|body)\b/i.test(html)) throw new Error("html 只写正文片段，不要包含 <!doctype>、<html>、<head> 或 <body>；标题和摘要由 Hob 放在页头。");
  const dir = assistantFilesDir(home, assistantId, "pages");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.html`);
  await writeFile(path, pageHtml(title, summary, html), "utf8");
  return path;
}

const description = `把内容做成一页图文页面，作为卡片发到对话里。
html 只写正文的 HTML 片段（不含 <html>、<head>、<body>），标题和摘要由 Hob 放在页头，正文从 h2 开始。页面离线显示：外部脚本、样式和字体加载不了，也不能联网取数据；图片只能用 https 或 data 地址。
已有样式（亮暗自动适配），直接用：
- 小节用 <h2>、<h3>；段落、列表、<table>、<pre><code>、<blockquote> 都已排好。
- 并列要点：<div class="cards"><div class="card"><h3>…</h3><p>…</p></div>…</div>
- 左右对比：<div class="cols"><div>…</div><div>…</div></div>
- 步骤：<ol class="steps"><li><b>步骤名</b>说明</li>…</ol>
- 关键数字：<div class="kpis"><div class="kpi"><b>42%</b><span>说明</span></div>…</div>
- 提示框：<div class="note">…</div>；标签：<span class="tag">…</span>；都可加 ok / warn / bad 变色。
- 图（流程、结构、时序、关系）用 <figure> 里的内联 <svg viewBox="…">，宽高随容器，配 <figcaption>。SVG 类：box 普通框、hl 强调框、line 连线、text 加 muted 为次要文字；文字默认 13px。颜色只用变量 --ink --muted --faint --line --soft --accent --accent-soft --ok --warn --bad，写成 style="fill:var(--accent)"。
- 先给结论再展开；能用图、表、卡片说清的，就少用长段落；强调色只点最重要的一两处。
- 需要特别的版式可以加 <style>（颜色仍用上面的变量），可以用 <script> 做交互。最多 ${MAX} 字。`;

// 只给助手：任务和助手之间用 report 的 Markdown 和文件沟通，给用户怎么展示由助手决定
export function pageTool(runtime: HobRuntime, assistantId: string): ToolDefinition<any, any> {
  return {
    name: "show_page", label: "展示页面", description,
    parameters: Type.Object({ title: Type.String(), summary: Type.String(), html: Type.String({ maxLength: MAX }) }),
    execute: async (_id, params: any) => {
      try {
        if (runtime.settings.settings.general.showPage === false) throw new Error("展示页面已关闭。");
        const title = String(params.title ?? "").trim();
        const summary = String(params.summary ?? "").trim();
        if (!title || !summary) throw new Error("标题和摘要不能为空。");
        const path = await renderPage(runtime.home, assistantId, title, summary, String(params.html ?? ""));
        await runtime.router.addItem(assistantId, { kind: "file", path, name: title, meta: summary });
        return { content: [{ type: "text" as const, text: `页面已展示：${path}` }], details: { path }, terminate: true };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  };
}
