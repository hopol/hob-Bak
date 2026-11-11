// 文件预览：桌面右侧抽屉（可切全宽），手机全屏页。按类型选展示方式，元数据来自 /api/files/meta。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FileMeta, PageLive } from "../../../shared/types.ts";
import { livePageHtml } from "../../../shared/page-shell.ts";
import { Icon } from "../icons.tsx";
import { fileIcon } from "../file-icons.ts";
import { numericColumns } from "../csv-columns.ts";
import { useLeave } from "../motion.ts";
import { copyText } from "../clipboard.ts";
import { closeImageViewer, closePanelPages, fetchFileMeta, fileUrl, localImage, photoUrl, setNotice, togglePreviewFull, useApp, type PanelPage } from "../store.ts";
import { PanelHead } from "./PanelHead.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { DelayedText } from "./Empty.tsx";
import { fmtBytes, fmtWhen } from "../util.ts";
import { Markdown } from "./Markdown.tsx";
import { matchKnowledgeText } from "../knowledge-highlight.ts";

/** 文本预览最多显示这么多（服务端也按这个截）。 */
const MAX_TEXT = 1024 * 1024;

type Load =
  | { state: "loading" }
  | { state: "error"; outside: boolean; message: string }
  | { state: "ok"; meta: FileMeta };

export function FilePreviewOverlay({ embedded = false, page }: { embedded?: boolean; page?: PanelPage }) {
  const s = useApp();
  const top = page ?? s.panelStack.at(-1);
  const preview = top?.kind === "file" ? top : null;
  const presence = useLeave(Boolean(preview), 180);
  const last = useRef(preview);
  if (preview) last.current = preview;

  const shown = preview ?? last.current;
  if (!presence.mounted || !shown) return null;
  return (
    <div className={`${embedded ? "fp-embedded" : "fpwrap"}${presence.leaving ? " leaving" : ""}`} onClick={embedded ? undefined : closePanelPages}>
      <div className={`fp${shown.full ? " full" : ""}`} onClick={(event) => event.stopPropagation()}>
        {shown.liveId && s.livePages[shown.liveId] ? <LivePreview page={s.livePages[shown.liveId]} /> : <FilePreview path={shown.path} title={shown.title} find={shown.find} page={shown.page} />}
      </div>
    </div>
  );
}

function LivePreview({ page }: { page: PageLive }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const current = useRef(page);
  current.current = page;
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const shell = useMemo(() => livePageHtml(), []);
  const send = () => frame.current?.contentWindow?.postMessage({ type: "hob-page-live", title: current.current.title, summary: current.current.summary, html: current.current.html, dark: document.documentElement.classList.contains("dark") }, "*");
  useEffect(() => { send(); }, [page]);
  useEffect(() => {
    const observer = new MutationObserver(send);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "hob-page-link" || !navigator.userActivation?.isActive) return;
      try { const url = new URL(event.data.url); if (["http:", "https:"].includes(url.protocol)) window.open(url.href, "_blank", "noopener"); } catch { /* 无效链接 */ }
    };
    window.addEventListener("message", onMessage);
    return () => { observer.disconnect(); window.removeEventListener("message", onMessage); };
  }, []);
  useEffect(() => {
    let active = true;
    if (page.path) void fetchFileMeta(page.path).then((value) => { if (active) setMeta(value); }).catch((error: unknown) => setNotice(`无法加载文件信息：${error instanceof Error ? error.message : String(error)}`));
    return () => { active = false; };
  }, [page.path]);
  const writing = page.state !== "done";
  return <>
    <Head name={page.title || "正在写页面…"} meta={meta} path={page.path || "page.html"} liveStatus={page.state === "writing" ? "正在生成…" : page.state === "failed" ? `生成失败：${page.error}` : undefined} disabled={writing} />
    <div className="fp-body">
      {page.state === "done" && /<\s*script\b/i.test(page.html) && meta ? <HtmlBody meta={meta} /> : <>
        <div className="fp-note">网页在隔离环境中显示，不能访问 Hob 的数据。</div>
        <iframe ref={frame} className="fp-frame" sandbox="allow-scripts" srcDoc={shell} onLoad={send} title={page.title || "正在写页面"} />
      </>}
    </div>
  </>;
}

/** 点开一个文件：先拉元数据，按 kind 选展示方式。 */
function FilePreview({ path, title, find, page }: { path: string; title?: string; find?: string; page?: number }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    void fetchFileMeta(path)
      .then((meta) => {
        if (live) setLoad({ state: "ok", meta });
      })
      .catch((e: unknown) => {
        if (!live) return;
        const message = e instanceof Error ? e.message : String(e);
        // 指出数据目录的路径（ssh 到别的机器写的文件之类）：预览不了，但可以复制路径
        const outside = message.includes("只允许读 Hob 自己的文件");
        setLoad({ state: "error", outside, message });
      });
    return () => {
      live = false;
    };
  }, [path]);

  const meta = load.state === "ok" ? load.meta : null;
  const name = title ?? meta?.name ?? path.split("/").pop() ?? path;
  return (
    <>
      <Head name={name} meta={meta} path={path} />
      <div className="fp-body">
        {load.state === "loading" ? (
          <div className="fp-center dim"><DelayedText text="正在读取文件信息…" /></div>
        ) : load.state === "error" ? (
          <div className="fp-center">
            <div className="fp-nofile">
              <Icon name="doc" size={22} />
              <div>{load.outside ? "这个文件不在 Hob 的数据目录或任务的工作目录里，无法预览" : load.message}</div>
              <button
                className="hob-btn"
                onClick={() =>
                  void copyText(path).then((ok) => setNotice(ok ? "路径已复制" : "复制失败：浏览器不允许写入剪贴板"))
                }
              >
                复制路径
              </button>
            </div>
          </div>
        ) : (
          <Body meta={load.meta} find={find} page={page} />
        )}
      </div>
    </>
  );
}

/** 顶部：文件名、大小、修改时间、下载、在新窗口打开、全宽切换。 */
function Head({ name, meta, path, liveStatus, disabled }: { name: string; meta: FileMeta | null; path: string; liveStatus?: string; disabled?: boolean }) {
  const top = useApp().panelStack.at(-1);
  const full = top?.kind === "file" && top.full;
  return (
    <PanelHead className="fphead" close>
      <Icon name={fileIcon(path)} size={18} className="fp-file-icon" />
      <div className="fpt">
        <div className="n" title={name}>
          {name}
        </div>
        {liveStatus ? <div className="m">{liveStatus}</div> : meta ? (
          <div className="m">
            {fmtBytes(meta.size)} · {fmtWhen(meta.modifiedAt)}
          </div>
        ) : null}
      </div>
      {disabled ? <button className="hob-icon-btn fp-act" title="下载" disabled><Icon name="dl" size={17} /></button> : <a className="hob-icon-btn fp-act" title="下载" href={fileUrl(path)} download={name}>
        <Icon name="dl" size={17} />
      </a>}
      <button
        className="hob-icon-btn fp-act"
        title="在新窗口打开"
        disabled={disabled}
        onClick={() => window.open(fileUrl(path, { inline: true }), "_blank", "noopener")}
      >
        <Icon name="out" size={17} />
      </button>
      <button className="hob-icon-btn fp-act fp-wide-btn" title="切换全宽" onClick={togglePreviewFull}>
        <Icon name={full ? "shrink" : "expand"} size={17} />
      </button>
    </PanelHead>
  );
}

function HtmlBody({ meta }: { meta: FileMeta }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!meta.page || event.source !== frame.current?.contentWindow || event.data?.type !== "hob-page-link" || !navigator.userActivation?.isActive) return;
      try {
        const url = new URL(event.data.url);
        if (url.protocol === "https:" || url.protocol === "http:") window.open(url.href, "_blank", "noopener");
      } catch { /* 无效链接不打开 */ }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [meta.page]);
  return <><div className="fp-note">网页在隔离环境中显示，不能访问 Hob 的数据。</div><iframe ref={frame} className="fp-frame" sandbox="allow-scripts" src={fileUrl(meta.path, { inline: true }) + (meta.page ? (document.documentElement.classList.contains("dark") ? "#dark" : "#light") : "")} title={meta.name} /></>;
}

function Body({ meta, find, page }: { meta: FileMeta; find?: string; page?: number }) {
  switch (meta.kind) {
    case "image":
      return <ImageBody key={meta.path} path={meta.path} name={meta.name} svg={false} />;
    case "svg":
      // svg 也按图片显示（<img> 里的 svg 不执行脚本），要 inline 才不会被当附件拦下
      return <ImageBody key={meta.path} path={meta.path} name={meta.name} svg />;
    case "pdf":
      return <iframe className="fp-frame" src={fileUrl(meta.path) + (page ? `#page=${page}` : "")} title={meta.name} />;
    case "audio":
      return (
        <div className="fp-center">
          <audio controls src={fileUrl(meta.path)} />
        </div>
      );
    case "video":
      return (
        <div className="fp-center">
          <video controls src={fileUrl(meta.path)} />
        </div>
      );
    case "html":
      return <HtmlBody meta={meta} />;
    case "other":
      return (
        <div className="fp-center">
          <div className="fp-nofile">
            <Icon name="doc" size={22} />
            <div>这种文件不在浏览器里预览，可以下载后打开。</div>
            <a className="hob-btn hob-btn-primary" href={fileUrl(meta.path)} download={meta.name}>
              下载
            </a>
          </div>
        </div>
      );
    default:
      return <TextBody meta={meta} find={find} />;
  }
}

/** 图片：适应宽度，点开放大（再点或 Esc 关）。 */
/** 点开图片（openFilePreview 遇到图片）时铺在最上面。 */
export function ImageViewerHost() {
  const viewer = useApp().viewer;
  if (!viewer) return null;
  // svg 没有缩略图；要 inline 才不会被当附件拦下（<img> 里的 svg 不执行脚本）
  const svg = viewer.path.toLowerCase().endsWith(".svg");
  const local = localImage(viewer.path);
  return <ImageViewer key={viewer.path} src={local ?? fileUrl(viewer.path, svg ? { inline: true } : undefined)} thumb={svg ? undefined : photoUrl(viewer.path)} download={local ? undefined : fileUrl(viewer.path)} name={viewer.name} onClose={closeImageViewer} />;
}

function ImageBody({ path, name, svg }: { path: string; name: string; svg: boolean }) {
  const [open, setOpen] = useState(false);
  const src = fileUrl(path, svg ? { inline: true } : undefined);
  // 先铺对话里已经加载过的缩略图，原图到了再盖上去：点开不用对着空白等
  // svg 没有缩略图，直接显示原图
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(svg ? "loaded" : "loading");
  const loading = status === "loading";
  const thumb = photoUrl(path);

  return (
    <>
      <div className="fp-img">
        <button onClick={() => setOpen(true)} title="放大" className={loading ? "fp-img-loading" : undefined}>
          {loading ? <img className="fp-img-thumb" src={thumb} alt="" aria-hidden="true" /> : null}
          <img src={src} alt={name} onLoad={() => setStatus("loaded")} onError={() => setStatus("error")} style={loading ? { position: "absolute", opacity: 0 } : undefined} />
          {loading ? <span className="fp-img-spin" aria-label="图片加载中"><Icon name="spin" size={18} w={2.2} className="spin" /></span> : null}
          {status === "error" ? <span>图片加载失败</span> : null}
        </button>
      </div>
      {open ? <ImageViewer src={src} thumb={svg ? undefined : thumb} name={name} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** 文本类（markdown / json / csv / 代码 / 纯文本）：先拉内容再按格式渲染。 */
function TextBody({ meta, find }: { meta: FileMeta; find?: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mathVersion, setMathVersion] = useState(0);
  const mathRendered = useCallback(() => setMathVersion((version) => version + 1), []);

  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(fileUrl(meta.path, { truncate: true }));
        if (!res.ok) throw new Error(`读取失败（${res.status}）`);
        if (live) setText(await res.text());
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [meta.path]);

  if (error) return <div className="fp-center fp-nofile">{error}</div>;
  if (text === null) return <div className="fp-center dim"><DelayedText text="正在读取内容…" /></div>;

  const notice =
    meta.size > MAX_TEXT ? (
      <div className="fp-note">文件有 {fmtBytes(meta.size)}，只显示前 1 MB，完整内容请下载。</div>
    ) : null;

  if (meta.kind === "markdown") {
    return (
      <>
        {notice}
        <HighlightText find={find} text={text} mathVersion={mathVersion}><Markdown className="fp-md markdown-body" text={text} onMathRendered={mathRendered} /></HighlightText>
      </>
    );
  }
  if (meta.kind === "json") {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* 解析失败按纯文本显示 */
    }
    return (
      <>
        {notice}
        <HighlightText find={find} text={text}><CodeView text={pretty} /></HighlightText>
      </>
    );
  }
  if (meta.kind === "csv") {
    return (
      <>
        {notice}
        <HighlightText find={find} text={text}><CsvView text={text} tsv={meta.mime.includes("tab-separated")} /></HighlightText>
      </>
    );
  }
  return (
    <>
      {notice}
      <HighlightText find={find} text={text}><CodeView text={text} /></HighlightText>
    </>
  );
}

function HighlightText({ find, text, mathVersion, children }: { find?: string; text: string; mathVersion?: number; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const registry = CSS.highlights;
    if (!root.current || !find || !registry || typeof Highlight === "undefined") return;
    const walker = document.createTreeWalker(root.current, NodeFilter.SHOW_TEXT, { acceptNode(node) { return node.parentElement?.closest(".ln, .code-copy, .fp-codebar, .katex-mathml") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const match = matchKnowledgeText(nodes, find);
    if (!match) return;
    const { start, end } = match;
    const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    registry.set("knowledge-source", new Highlight(range));
    start.node.parentElement?.scrollIntoView({ block: "center" });
    return () => { registry.delete("knowledge-source"); };
  }, [find, text, mathVersion]);
  return <div ref={root}>{children}</div>;
}

/** 代码 / 纯文本：等宽、行号、自动换行开关。 */
function CodeView({ text }: { text: string }) {
  const [wrap, setWrap] = useState(true);
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <>
      <div className="fp-codebar">
        <span className="dim">{lines.length} 行</span>
        <button className="hob-btn" onClick={() => setWrap(!wrap)}>
          {wrap ? "不自动换行" : "自动换行"}
        </button>
      </div>
      <div className={`fp-code mono${wrap ? " wrap" : ""}`}>
        {lines.map((line, index) => (
          <div className="cl" key={index}>
            <span className="ln">{index + 1}</span>
            <span className="ct">{line || " "}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** CSV / TSV：前 1000 行，表头固定，横向滚动。 */
export function CsvView({ text, tsv }: { text: string; tsv: boolean }) {
  const rows = useMemo(() => parseDelimited(text, tsv ? "\t" : ","), [text, tsv]);
  const numbers = useMemo(() => numericColumns(rows), [rows]);
  const shown = rows.slice(0, 1000);
  const [header, ...body] = shown;
  return (
    <>
      <div className="fp-codebar">
        <span className="dim">
          {rows.length} 行{rows.length > 1000 ? "（只显示前 1000 行）" : ""}
        </span>
      </div>
      <div className="fp-table-wrap">
        <table className="fp-table">
          {header ? (
            <thead>
              <tr>
                {header.map((cell, index) => (
                  <th key={index} className={numbers[index] ? "numeric" : undefined}>{cell}</th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {row.map((cell, index) => (
                  <td key={index} className={numbers[index] ? "numeric" : undefined}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** 带引号的 CSV 单元格也能拆对：几行手写，不引依赖。 */
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
