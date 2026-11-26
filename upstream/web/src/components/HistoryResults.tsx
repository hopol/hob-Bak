import { useEffect, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import type { HistoryMatch } from "../../../shared/types.ts";
import { Avatar } from "../sprites.tsx";
import { jumpToHistory, searchHistory, useApp } from "../store.ts";
import { fmtWhen } from "../util.ts";

function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return <>{text.split(pattern).map((part, index) => words.some((word) => word.toLocaleLowerCase() === part.toLocaleLowerCase()) ? <strong key={index}>{part}</strong> : part)}</>;
}

export function HistoryResults() {
  const s = useApp();
  const query = s.query.trim();
  const [result, setResult] = useState<{ query: string; rows: HistoryMatch[]; error?: string } | null>(null);
  useEffect(() => {
    if ([...query].length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void searchHistory(query).then((data) => { if (live) setResult({ query, rows: data.results }); }).catch((error: unknown) => { if (live) setResult({ query, rows: [], error: error instanceof Error ? error.message : String(error) }); });
    }, 300);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query]);
  if ([...query].length < 2) return null;
  const current = result?.query === query ? result : null;
  const rows = current ? [...current.rows].sort((a, b) => Number(b.starred) - Number(a.starred) || b.at.localeCompare(a.at)) : [];
  return <section className="history-results"><div className="history-heading">{t("消息")}</div>
    {current?.error ? <p>{t("搜索失败：{error}", { error: current.error })}</p> : current && !rows.length ? <p>{t("没有找到包含「{query}」的消息", { query })}</p> : null}
    {rows.map((row) => {
      const group = row.conversation.kind === "group" ? s.groups.find((g) => g.id === row.conversation.id) : undefined;
      const assistant = s.assistants.find((a) => a.id === (group?.ownerId ?? row.conversation.id));
      return <button className="history-row" key={`${row.conversation.kind}:${row.conversation.id}:${row.itemId}`} onClick={() => void jumpToHistory(row.conversation, row.itemId)}>
        {assistant ? <Avatar sprite={assistant.sprite} prop={assistant.prop} size={36} /> : null}
        <span className="history-content"><span className="history-title"><strong>{row.conversationName}</strong><span>{fmtWhen(row.at)}</span></span><span className="history-snippet">{row.starred ? "★ " : ""}<Highlight text={row.snippet} query={query} /></span></span>
      </button>;
    })}
  </section>;
}
