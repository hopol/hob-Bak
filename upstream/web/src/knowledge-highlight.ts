const word = /[\p{L}\p{N}]/u;

/** 出处段落的可见文字：丢掉 Markdown 链接地址和行首标记，只留字母和数字。 */
export function knowledgeFind(chunk: string): string {
  const visible = chunk.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s*[#>\-*]+\s*/gm, "");
  return Array.from(visible).filter((ch) => word.test(ch)).join("");
}

/**
 * 在渲染后的文本节点里定位整段，保留 UTF-16 偏移供 Range 使用。
 * 整段对不上（图片、代码块语言名这类渲染后看不见的字）就用开头和结尾各 40 个字定两头。
 */
export function matchKnowledgeText(nodes: Iterable<Text>, find: string): { start: { node: Text; offset: number }; end: { node: Text; offset: number } } | null {
  const chars: { node: Text; offset: number; end: number }[] = [];
  let normalized = "";
  for (const node of nodes) {
    for (let offset = 0; offset < node.data.length;) {
      const ch = String.fromCodePoint(node.data.codePointAt(offset)!);
      if (word.test(ch)) {
        normalized += ch;
        for (let i = 0; i < ch.length; i++) chars.push({ node, offset, end: offset + ch.length });
      }
      offset += ch.length;
    }
  }
  const needle = Array.from(find).filter((ch) => word.test(ch)).join("");
  if (!needle) return null;
  let at = normalized.indexOf(needle);
  let to = at + needle.length;
  if (at < 0) {
    const points = Array.from(needle);
    const head = points.slice(0, 40).join("");
    const tail = points.slice(-40).join("");
    at = normalized.indexOf(head);
    if (at < 0) return null;
    // 结尾在开头之后、两倍段长以内才算同一段，否则只标开头
    const tailAt = normalized.lastIndexOf(tail, at + needle.length * 2 - tail.length);
    to = tailAt >= at + head.length ? tailAt + tail.length : at + head.length;
  }
  const start = chars[at]!;
  const end = chars[to - 1]!;
  return { start: { node: start.node, offset: start.offset }, end: { node: end.node, offset: end.end } };
}
