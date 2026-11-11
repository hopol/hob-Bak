import { Select } from "./Select.tsx";
import { Empty } from "./Empty.tsx";
import { useEffect, useRef, useState } from "react";
import { useMenu } from "./use-menu.ts";
import { createPortal } from "react-dom";
import { knowledgeGroup, type KnowledgeCollection, type KnowledgeEntry, type KnowledgeGroup } from "../../../shared/knowledge.ts";
import type { AssistantSummary } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import {
  closeKnowledge, createKnowledgeCollection, deleteKnowledgeCollection, deleteKnowledgeEntry,
  fileUrl, jumpToItem, loadKnowledge, openFilePreview, openJob, patchKnowledgeEntry,
  photoUrl, renameKnowledgeCollection, setKnowledgeFilter, uploadKnowledge, useApp, type State,
  patchAssistant, reindexKnowledge, openSettings, setSection, setNotice,
} from "../store.ts";
import { fmtBytes, fmtWhen } from "../util.ts";
import { FilePreviewOverlay } from "./FilePreview.tsx";

const groups: [KnowledgeGroup | "", string][] = [
  ["", "全部类型"], ["image", "图片"], ["document", "文档"],
  ["table", "表格"], ["page", "网页"], ["other", "其他"],
];
type KnowledgeState = State["knowledge"];
export const collectionDeleteText = (name: string) => `删除知识库「${name}」？直接上传到这里、又不在别的知识库里的文件会一起删除，其余文件只是移出。`;

function NameInput({ initial = "", label, save, cancel }: { initial?: string; label: string; save: (name: string) => Promise<boolean>; cancel: () => void }) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  return (
    <form className="knowledge-name" onSubmit={(e) => {
      e.preventDefault();
      if (!name.trim() || saving) return;
      setSaving(true);
      void save(name.trim()).then((ok) => { if (ok) cancel(); else setSaving(false); });
    }}>
      <input
        autoFocus
        aria-label={label}
        value={name}
        disabled={saving}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}
      />
    </form>
  );
}

function Categories({ collections, selected, narrow }: { collections: KnowledgeCollection[]; selected: string; narrow: boolean }) {
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const menu = useMenu();
  const current = collections.find((c) => c.id === menu.menu?.id);
  return (
    <nav className={narrow ? "knowledge-categories" : "setnav"} aria-label="知识库分类">
      {!narrow && <div className="setnavtitle">知识库</div>}
      {[["all", "全部"], ["output", "助手产出"], ["chat", "对话上传"]].map(([id, name]) => (
        <div key={id}>
          <button className={`navrow${selected === id ? " sel" : ""}`} onClick={() => setKnowledgeFilter({ category: id })}>
            {name}
          </button>
        </div>
      ))}
      {!narrow && <div className="knowledge-label">我的知识库</div>}
      {collections.map((collection) => (
        <div
          className={`knowledge-category${menu.menu?.id === collection.id ? " menu-open" : ""}${selected === collection.id ? " selected" : ""}`}
          key={collection.id}
          onContextMenu={(e) => {
            e.preventDefault();
            const button = e.currentTarget.querySelector<HTMLButtonElement>(".category-dots");
            if (button) menu.toggle(collection.id, button);
          }}
        >
          {renaming === collection.id ? (
            <NameInput initial={collection.name} label="知识库名称" save={(name) => renameKnowledgeCollection(collection.id, name)} cancel={() => setRenaming(null)} />
          ) : (
            <button className={`navrow${selected === collection.id ? " sel" : ""}`} onClick={() => setKnowledgeFilter({ category: collection.id })}>
              <span>{collection.name}</span>
              <span className="knowledge-count">{collection.count}</span>
            </button>
          )}
          <button className="knowledge-dots category-dots" aria-label={`${collection.name}的操作`} onClick={(e) => menu.toggle(collection.id, e.currentTarget)}>
            <Icon name="more" size={18} />
          </button>
        </div>
      ))}
      <div>
        {creating ? (
          <NameInput label="新知识库名称" save={async (name) => !!await createKnowledgeCollection(name)} cancel={() => setCreating(false)} />
        ) : (
          <button className="navrow knowledge-new" onClick={() => setCreating(true)}>＋ 新建</button>
        )}
      </div>
      {!narrow && <><span className="sp" /><button className="navrow" onClick={closeKnowledge}>返回 Hob</button></>}
      {current && createPortal(
        <div className="amenu knowledge-popup" ref={menu.box}>
          <button onClick={() => { menu.close(); setRenaming(current.id); }}>改名</button>
          <button onClick={() => {
            menu.close();
            if (window.confirm(collectionDeleteText(current.name))) void deleteKnowledgeCollection(current.id);
          }}>删除</button>
        </div>, document.body,
      )}
    </nav>
  );
}

function Filters({ knowledge, assistants, uploading, upload }: { knowledge: KnowledgeState; assistants: AssistantSummary[]; uploading: boolean; upload: (files: File[]) => void }) {
  const [search, setSearch] = useState(knowledge.q);
  const [composing, setComposing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const collection = knowledge.collections.some((c) => c.id === knowledge.category);
  useEffect(() => {
    if (composing || search === knowledge.q) return;
    const timer = window.setTimeout(() => setKnowledgeFilter({ q: search }), 250);
    return () => window.clearTimeout(timer);
  }, [search, composing, knowledge.q]);
  return (
    <div className="knowledge-filters">
      <label className="knowledge-search">
        <Icon name="search" size={16} />
        <input
          placeholder="搜索知识库"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(e) => { setSearch(e.currentTarget.value); setComposing(false); }}
        />
      </label>
      <Select aria-label="类型" value={knowledge.kind} onChange={(value) => setKnowledgeFilter({ kind: value as KnowledgeGroup | "" })} options={groups.map(([value, label]) => ({ value, label }))} />
      <Select aria-label="助手" value={knowledge.assistantId} onChange={(value) => setKnowledgeFilter({ assistantId: value })} options={[{ value: "", label: "全部助手" }, ...assistants.map((assistant) => ({ value: assistant.id, label: assistant.name }))]} />
      {collection && <>
        <input ref={input} type="file" multiple hidden onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <button className="hob-btn hob-btn-upload" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? "正在上传…" : "上传"}
        </button>
      </>}
    </div>
  );
}

export function CollectionChoices({ entry, collections }: { entry: KnowledgeEntry; collections: KnowledgeCollection[] }) {
  return <>{collections.map((collection) => (
    <label key={collection.id}>
      <input
        type="checkbox"
        checked={entry.collections.includes(collection.id)}
        onChange={(e) => {
          const ids = e.target.checked ? [...entry.collections, collection.id] : entry.collections.filter((id) => id !== collection.id);
          void patchKnowledgeEntry(entry.id, { collections: ids });
        }}
      />
      {collection.name}
    </label>
  ))}</>;
}

export function EntryMenuActions({ entry, collections, category, join, rename, remove, confirm }: { entry: KnowledgeEntry; collections: KnowledgeCollection[]; category: string; join: () => void; rename: () => void; remove: () => void; confirm: () => void }) {
  return <>
    <button onClick={join}>加入知识库</button>
    <button onClick={rename}>改名</button>
    <a href={fileUrl(entry.path)} download={entry.name}>下载</a>
    {collections.some((c) => c.id === category) && <button onClick={remove}>移出这个知识库</button>}
    <button onClick={confirm}>删除</button>
  </>;
}

function EntryRow({ entry, collections, assistants, selected, category }: { entry: KnowledgeEntry & { snippet?: string }; collections: KnowledgeCollection[]; assistants: AssistantSummary[]; selected: boolean; category: string }) {
  const menu = useMenu();
  const [joining, setJoining] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const group = knowledgeGroup(entry.kind);
  const assistant = assistants.find((item) => item.id === entry.source?.assistantId);
  const source = entry.source;
  const index = entry.index?.state === "queued" || entry.index?.state === "indexing" ? "正在建索引…" : entry.index?.state === "failed" ? `未能建索引：${entry.index.error || "未知原因"}` : entry.index?.state === "unsupported" ? "这类文件还不能建索引" : "";
  const meta = [entry.origin === "upload" ? "上传" : assistant?.name, fmtWhen(entry.updatedAt), fmtBytes(entry.size), entry.versions?.length ? `第 ${entry.versions.length + 1} 版` : "", index].filter(Boolean).join(" · ");
  return (
    <div className={`knowledge-row${selected ? " selected" : ""}`}>
      <div
        className="knowledge-open"
        role="button"
        tabIndex={0}
        onClick={() => { if (!renaming) openFilePreview(entry.path, entry.name); }}
        onKeyDown={(e) => {
          if (!renaming && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openFilePreview(entry.path, entry.name); }
        }}
      >
        <span className="knowledge-thumb">
          {group === "image" ? <img src={photoUrl(entry.path)} alt="" /> : <Icon name={group === "table" ? "table" : group === "page" ? "globe" : "doc"} size={24} />}
        </span>
        <div className="knowledge-info">
          {renaming ? (
            <NameInput initial={entry.name} label="文件名称" save={(name) => patchKnowledgeEntry(entry.id, { name })} cancel={() => setRenaming(false)} />
          ) : <strong>{entry.name}</strong>}
          {entry.snippet || entry.description ? <span className="knowledge-description">{entry.snippet || entry.description}</span> : null}
          <span className="knowledge-meta">
            <span className="knowledge-meta-text">{meta}</span>
            <span className="knowledge-tags">
              {entry.collections.map((id) => {
                const collection = collections.find((item) => item.id === id);
                return collection ? <span key={id}>{collection.name}</span> : null;
              })}
            </span>
          </span>
        </div>
      </div>
      {source && (source.itemId || source.jobId) ? (
        <button className="knowledge-source" onClick={() => {
          if (source.itemId) void jumpToItem(source.assistantId, source.itemId);
          else if (source.jobId) { closeKnowledge(); openJob(source.jobId); }
        }}>出处</button>
      ) : null}
      <div className="knowledge-actions">
        <button className="knowledge-dots" aria-label={`${entry.name}的操作`} onClick={(e) => { menu.toggle(entry.id, e.currentTarget); setJoining(false); }}>
          <Icon name="more" size={18} />
        </button>
      </div>
      {menu.menu && createPortal(
        <div className="amenu knowledge-popup" ref={menu.box}>
          {joining ? <>
            <div className="knowledge-menu-title">加入知识库</div>
            <CollectionChoices entry={entry} collections={collections} />
            {creating ? (
              <NameInput label="新知识库名称" save={async (name) => {
                const c = await createKnowledgeCollection(name, false);
                return !!c && await patchKnowledgeEntry(entry.id, { collections: [...entry.collections, c.id] });
              }} cancel={() => setCreating(false)} />
            ) : <button onClick={() => setCreating(true)}>＋ 新建知识库</button>}
          </> : (
            <EntryMenuActions
              entry={entry}
              collections={collections}
              category={category}
              join={() => setJoining(true)}
              rename={() => { menu.close(); setRenaming(true); }}
              remove={() => { menu.close(); void patchKnowledgeEntry(entry.id, { collections: entry.collections.filter((id) => id !== category) }); }}
              confirm={() => {
                menu.close();
                if (window.confirm(`删除「${entry.name}」？会从所有知识库里移除，不能恢复。`)) void deleteKnowledgeEntry(entry.id);
              }}
            />
          )}
        </div>, document.body,
      )}
    </div>
  );
}

function EntryList({ knowledge, assistants, previewPath, upload }: { knowledge: KnowledgeState; assistants: AssistantSummary[]; previewPath?: string; upload: (files: File[]) => void }) {
  const collection = knowledge.collections.some((c) => c.id === knowledge.category);
  const empty = knowledge.category === "output" && !knowledge.q
    ? "还没有助手产出。助手交给你的文件、图片和页面会自动收在这里。"
    : knowledge.category === "chat" && !knowledge.q ? "还没有对话上传的文件。"
      : knowledge.q ? "没有找到匹配的资料。" : "这里还没有资料。";
  return (
    <div
      className="knowledge-list"
      onDragOver={(e) => { if (collection) e.preventDefault(); }}
      onDrop={(e) => { if (collection) { e.preventDefault(); upload(Array.from(e.dataTransfer.files)); } }}
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) void loadKnowledge(true);
      }}
    >
      {knowledge.error ? (
        <Empty large action={{ label: "重试", onClick: () => void loadKnowledge() }}>加载失败：{knowledge.error}</Empty>
      ) : !knowledge.entries.length && !knowledge.loading ? <Empty large>{empty}</Empty> : null}
      {knowledge.entries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} collections={knowledge.collections} assistants={assistants} selected={entry.path === previewPath} category={knowledge.category} />
      ))}
      {knowledge.loading ? <Empty large>正在加载…</Empty> : null}
      {knowledge.hasMore && !knowledge.loading ? <button className="knowledge-more" onClick={() => void loadKnowledge(true)}>加载更多</button> : null}
    </div>
  );
}

export function AssistantChoices({ collectionId, collections, assistants, busy, setBusy }: { collectionId: string; collections: KnowledgeCollection[]; assistants: AssistantSummary[]; busy: boolean; setBusy: (busy: boolean) => void }) {
  return <>{assistants.map((a) => <label key={a.id}><input type="checkbox" checked={a.knowledge?.includes(collectionId) ?? false} disabled={busy} onChange={() => { const ids = (a.knowledge ?? []).filter((id) => collections.some((c) => c.id === id)); setBusy(true); void patchAssistant(a.id, { knowledge: ids.includes(collectionId) ? ids.filter((id) => id !== collectionId) : [...ids, collectionId] }).finally(() => setBusy(false)); }} />{a.name}</label>)}</>;
}

export function IndexRetry({ id, busy, setBusy }: { id: string; busy: boolean; setBusy: (busy: boolean) => void }) {
  return <button disabled={busy} onClick={() => { setBusy(true); void reindexKnowledge(id).then(() => loadKnowledge(false, true)).catch((e: unknown) => setNotice(`重试失败：${e instanceof Error ? e.message : String(e)}`)).finally(() => setBusy(false)); }}>重试</button>;
}

export function CollectionStatus({ collection, collections, assistants, embedding }: { collection: KnowledgeCollection; collections: KnowledgeCollection[]; assistants: AssistantSummary[]; embedding: boolean }) {
  const menu = useMenu("left");
  const bound = assistants.filter((a) => a.knowledge?.includes(collection.id));
  const [busy, setBusy] = useState(false);
  return <div className="knowledge-status">
    <div>{bound.length ? `给 ${bound.map((a) => a.name).join("、")} 用` : <strong>还没有助手用这个库</strong>} · <button onClick={(e) => menu.toggle(collection.id, e.currentTarget)}>{bound.length ? "修改" : "选择助手"}</button></div>
    {menu.menu && createPortal(<div className="amenu knowledge-popup" ref={menu.box}><AssistantChoices collectionId={collection.id} collections={collections} assistants={assistants} busy={busy} setBusy={setBusy} /></div>, document.body)}
    <div>已建索引 {collection.indexed ?? 0}/{collection.count - (collection.unsupported ?? 0)}{(collection.failed ?? 0) > 0 ? <> · {collection.failed} 个失败 · <IndexRetry id={collection.id} busy={busy} setBusy={setBusy} /></> : null}{!embedding ? <> · 只按关键词查 · <button onClick={() => { openSettings(); setSection("knowledge"); }}>去设置向量模型</button></> : null}</div>
  </div>;
}

export function Knowledge({ narrow, leaving }: { narrow: boolean; leaving: boolean }) {
  const s = useApp();
  const knowledge = s.knowledge;
  const top = s.panelStack.at(-1);
  const preview = top?.kind === "file" ? top : null;
  const [uploading, setUploading] = useState(false);
  const upload = (files: File[]) => {
    if (!files.length || uploading) return;
    setUploading(true);
    void uploadKnowledge(knowledge.category, files).finally(() => setUploading(false));
  };
  useEffect(() => {
    if (s.page !== "knowledge" || preview) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeKnowledge(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.page, preview]);
  return (
    <main className={`setpage knowledge${narrow ? " narrow" : ""}${preview && !narrow ? " has-preview" : ""}${preview?.full && !narrow ? " preview-full" : ""}${leaving ? " leaving" : ""}`}>
      {narrow ? (
        <div className="sethead">
          <button className="hob-icon-btn" title="返回" onClick={closeKnowledge}><Icon name="left" size={17} /></button>
          <span className="t">知识库</span>
        </div>
      ) : null}
      <Categories collections={knowledge.collections} selected={knowledge.category} narrow={narrow} />
      <section className="knowledge-main">
        <Filters knowledge={knowledge} assistants={s.assistants} uploading={uploading} upload={upload} />
        {knowledge.collections.find((c) => c.id === knowledge.category) ? <CollectionStatus collection={knowledge.collections.find((c) => c.id === knowledge.category)!} collections={knowledge.collections} assistants={s.assistants} embedding={s.settings.settings.knowledge?.embedding.source === "openai"} /> : null}
        <EntryList knowledge={knowledge} assistants={s.assistants} previewPath={preview?.path} upload={upload} />
      </section>
      {!narrow && preview ? <aside className="knowledge-preview"><FilePreviewOverlay embedded /></aside> : null}
    </main>
  );
}
