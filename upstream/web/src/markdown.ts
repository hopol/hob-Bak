// 对话里的 markdown 渲染；原始 HTML 不进入 DOM。
import { t } from "../../shared/i18n.ts";
import { Marked } from "marked";
import markedCjkFriendly from "marked-cjk-friendly";
import type katex from "katex";
import { iconSvg } from "./icons.tsx";
import { parseKnowledgeLink } from "../../shared/knowledge.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Katex = typeof katex;
let math: Katex | undefined;
let loading: Promise<void> | undefined;

/** 只有遇到公式定界符时加载公式引擎和本地字体。 */
export function loadMath(): Promise<void> {
  return loading ??= import("./math.ts").then((module) => { math = module.default; });
}

export function hasMath(text: string): boolean {
  let found = false;
  markdown.walkTokens(markdown.lexer(text), (token) => {
    if (token.type === "inlineMath" || token.type === "displayMath") found = true;
  });
  return found;
}

function formula(source: string, display: boolean, raw: string): string {
  if (!math) return escapeHtml(raw);
  try {
    // 写错的公式抛错 → 原样显示源码
    return math.renderToString(source, { displayMode: display, throwOnError: true, trust: false });
  } catch {
    return escapeHtml(raw);
  }
}

const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
const MATH_TEXT_CMD_RE = /\\(?:text(?:rm|bf|it|sf|tt|normal)?|math(?:rm|bf|it|sf|tt)|operatorname\*?|mbox|hbox)\s*\{/g;

/** 单 $ ... $ 里除 \text{...} 等文本命令外的裸 CJK 字符视为普通文本而非公式。 */
function hasBareCjk(source: string): boolean {
  if (!CJK_RE.test(source)) return false;
  let stripped = "";
  let i = 0;
  MATH_TEXT_CMD_RE.lastIndex = 0;
  for (let m = MATH_TEXT_CMD_RE.exec(source); m; m = MATH_TEXT_CMD_RE.exec(source)) {
    if (m.index < i) continue;
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < source.length && depth > 0) {
      if (source[j] === "\\" && j + 1 < source.length) { j += 2; continue; }
      if (source[j] === "{") depth++;
      else if (source[j] === "}") depth--;
      j++;
    }
    if (depth !== 0) continue;
    stripped += source.slice(i, m.index);
    i = j;
    MATH_TEXT_CMD_RE.lastIndex = i;
  }
  stripped += source.slice(i);
  return CJK_RE.test(stripped);
}

const markdown = new Marked({
  extensions: [
    {
      name: "displayMath", level: "block",
      start(src) { return src.search(/\$\$|\\\[/); },
      tokenizer(src) {
        const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(src);
        if (match) return { type: "displayMath", raw: match[0], text: match[1] ?? match[2] };
      },
      renderer(token) { return `<div class="math-display">${formula(String(token.text), true, token.raw.trimEnd())}</div>`; },
    },
    {
      name: "inlineMath", level: "inline",
      start(src) { return src.search(/\$|\\\(/); },
      tokenizer(src, tokens) {
        const paren = /^\\\((.+?)\\\)/.exec(src);
        if (paren) return { type: "inlineMath", raw: paren[0], text: paren[1] };
        const prev = tokens.at(-1)?.raw ?? "";
        // 紧跟在字母数字后面的 $ 多半不是公式（正则 /^foo$/），上下标和命令开头的除外（CO$_2$、m$^2$、90$^\\circ$）
        if (/[A-Za-z0-9_]$/.test(prev) && !/^\$[\\^_]/.test(src)) return;
        // 模板字符串 / Shell 变量展开（如 ${name}、${job.cwd}）不作为公式起点
        if (/^\$\{[A-Za-z_][A-Za-z0-9_.-]*\}(?![_^])/.test(src)) return;
        const match = /^\$(?!\$|\s)([^$`\n]*?[^$`\s])\$(?!\w|\{|\$|\\[A-Za-z])/.exec(src);
        // 夹着裸中文、又没有等号和上下标的，是两个 $ 之间的普通句子，不是公式
        if (match && (/[\\=^_]/.test(match[1]) || !hasBareCjk(match[1]))) return { type: "inlineMath", raw: match[0], text: match[1] };
      },
      renderer(token) { return formula(String(token.text), false, token.raw); },
    },
  ],
  renderer: {
    html(token) { return escapeHtml(token.text ?? ""); },
    code(token) {
      const lang = token.lang?.trim().split(/\s+/)[0] ?? "";
      const head = lang ? `<div class="code-head">${escapeHtml(lang)}</div>` : "";
      return `<div class="code-block">${head}<button type="button" class="code-copy" aria-label="${t("复制代码")}" title="${t("复制代码")}">${iconSvg("copy", 15)}</button><pre><code>${escapeHtml(token.text)}\n</code></pre></div>`;
    },
  },
});
// 「**结论。**后面的字」这种标点紧贴星号的写法，CommonMark 原规则不认作加粗
markdown.use(markedCjkFriendly());

const SAFE_HREF = /^(https?:|mailto:|\/|#|\.)/i;
// 页面路由都在 hash 里，站内没有别的路径：/ 开头（不是 //、/api/）的链接是服务器上的文件，点开走文件预览
const FILE_HREF = /^\/(?!\/|api\/)/;
export function renderMarkdown(text: string, mentions?: string[]): string {
  const html = markdown.parse(text, { async: false, gfm: true, breaks: true }) as string;
  const linked = html.replace(/<a href="([^"]*)"/g, (_m, href: string) =>
    parseKnowledgeLink(href) ? `<a class="knowledge-citation" href="${href}"` : FILE_HREF.test(href.trim()) ? `<a class="file-link" href="${href}"` : SAFE_HREF.test(href.trim()) ? `<a target="_blank" rel="noreferrer" href="${href}"` : "<a",
  ).replace(/(<a class="knowledge-citation"[^>]*>)/g, `$1${iconSvg("doc", 13)}`)
    // 模型常照着附带资料的格式把出处写在括号里；标签本身已经够醒目，括号去掉
    .replace(/[（(]\s*(<a class="knowledge-citation"[^>]*>[\s\S]*?<\/a>)\s*[）)]/g, "$1")
    // 表格套一层：比栏宽时在框里左右滑，不把列挤成一字一行
    .replace(/<table>/g, '<div class="md-table"><table>').replace(/<\/table>/g, "</table></div>");
  return mentions?.length ? markMentions(linked, mentions) : linked;
}

/**
 * 群里的点名：文本里的 @名字 包一层强调色。只在标签外面换，代码块里原样；
 * 名字按长的先算，带空格的名字也能整段认出来。
 */
function markMentions(html: string, mentions: string[]): string {
  const names = [...new Set(mentions.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!names.length) return html;
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const close = html.indexOf(">", i);
      if (close < 0) return out.join("") + html.slice(i);
      const tag = html.slice(i, close + 1);
      out.push(tag);
      i = close + 1;
      const code = /^<(code|pre)[\s>]/i.exec(tag);
      if (code) {
        const end = html.indexOf(`</${code[1]}`, i);
        const stop = end < 0 ? html.length : end;
        out.push(html.slice(i, stop));
        i = stop;
      }
      continue;
    }
    const next = html.indexOf("<", i);
    const stop = next < 0 ? html.length : next;
    out.push(markedText(html.slice(i, stop), names));
    i = stop;
  }
  return out.join("");
}

function markedText(text: string, names: string[]): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const name = text[i] === "@" ? names.find((candidate) => text.startsWith(escapeHtml(candidate), i + 1)) : undefined;
    if (name) {
      out += `<span class="at">@${escapeHtml(name)}</span>`;
      i += 1 + escapeHtml(name).length;
      continue;
    }
    out += text[i++];
  }
  return out;
}

/**
 * 把一条回复按顶层表格切开：表格单独成卡片（框内左右滑），前后的文字还是气泡。
 * 没有表格就原样一段。代码块里的 | 不算表格（marked 按顶层 token 切）。
 */
export function splitTables(text: string): { table: boolean; md: string }[] {
  const parts: { table: boolean; md: string }[] = [];
  for (const token of markdown.lexer(text, { gfm: true })) {
    const table = token.type === "table";
    const last = parts.at(-1);
    if (last && !last.table && !table) last.md += token.raw;
    else parts.push({ table, md: token.raw });
  }
  const out = parts.filter((part) => part.table || part.md.trim());
  return out.length ? out : [{ table: false, md: text }];
}
