import { useEffect, useState } from "react";
import { copyText } from "../clipboard.ts";
import { iconSvg } from "../icons.tsx";
import { hasMath, loadMath, renderMarkdown } from "../markdown.ts";
import { getKnowledgeEntry, openFilePreview, setNotice } from "../store.ts";
import { ApiError } from "../api.ts";
import { parseKnowledgeLink } from "../../../shared/knowledge.ts";
import { knowledgeFind } from "../knowledge-highlight.ts";

export async function openKnowledgeCitation(entryId: string, chunk?: number) {
  try {
    const view = await getKnowledgeEntry(entryId, chunk);
    openFilePreview(view.entry.path, view.entry.name, { find: view.chunk ? knowledgeFind(view.chunk.text) : undefined, page: view.chunk?.page });
  } catch (e) {
    setNotice(e instanceof ApiError && e.status === 404 ? "这份资料已经删除" : `无法打开资料：${e instanceof Error ? e.message : String(e)}`);
  }
}

export function Markdown({ text, className, streaming, onMathRendered }: { text: string; className?: string; streaming?: boolean; onMathRendered?: () => void }) {
  const [mathVersion, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    if (hasMath(text)) void loadMath().then(() => { if (active) refresh((n) => n + 1); }).catch(() => {});
    return () => { active = false; };
  }, [text]);
  useEffect(() => { if (mathVersion) onMathRendered?.(); }, [mathVersion, onMathRendered]);
  return <div className={className} onClick={(event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a.knowledge-citation");
    const citation = link && parseKnowledgeLink(link.getAttribute("href") ?? "");
    if (citation) {
      event.preventDefault(); event.stopPropagation();
      void openKnowledgeCitation(citation.entryId, citation.chunk);
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".code-copy");
    if (!button) return;
    event.stopPropagation();
    const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    void copyText(code.endsWith("\n") ? code.slice(0, -1) : code).then((ok) => {
      if (!ok) { setNotice("复制失败：浏览器不允许写入剪贴板"); return; }
      button.innerHTML = iconSvg("check", 15);
      button.setAttribute("aria-label", "已复制");
      window.setTimeout(() => { button.innerHTML = iconSvg("copy", 15); button.setAttribute("aria-label", "复制代码"); }, 1500);
    });
  }} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) + (streaming ? '<span class="cur"></span>' : "") }} />;
}
