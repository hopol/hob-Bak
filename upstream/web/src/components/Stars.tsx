import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMenu } from "./use-menu.ts";
import { t } from "../../../shared/i18n.ts";
import type { StarredMessage } from "../../../shared/types.ts";
import { copyText } from "../clipboard.ts";
import { SetNavHead } from "./SettingsParts.tsx";
import { Icon } from "../icons.tsx";
import { Avatar } from "../sprites.tsx";
import { goHome, jumpToHistory, setNotice, toggleStar, useApp } from "../store.ts";
import { fmtWhen } from "../util.ts";
import { Disclosure } from "./Disclosure.tsx";
import { Markdown } from "./Markdown.tsx";

function StarRow({ star }: { star: StarredMessage }) {
  const s = useApp();
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const menu = useMenu();
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = body.current; if (el) setLong(el.scrollHeight > 144); }, [star.text]);
  const group = star.conversation.kind === "group" ? s.groups.find((g) => g.id === star.conversation.id) : undefined;
  const assistant = s.assistants.find((a) => a.id === (star.speaker === "user" ? group?.ownerId ?? star.conversation.id : star.speaker));
  const name = group?.name ?? s.assistants.find((a) => a.id === star.conversation.id)?.name ?? star.conversation.id;
  return <div className="star-row">
    <div className="star-meta">{assistant ? <Avatar sprite={assistant.sprite} prop={assistant.prop} size={28} /> : <Icon name="user" size={22} />}<strong>{name}</strong><span>{fmtWhen(star.at)}</span></div>
    <div className={`star-body md${open ? " open" : ""}`} ref={body}><Markdown text={star.text} /></div>
    {long ? <Disclosure label={t("展开")} open={open} onToggle={() => setOpen(!open)} /> : null}
    <div className="star-actions">
      <button className="hob-icon-btn" title={t("复制")} aria-label={t("复制")} onClick={() => void copyText(star.text).then((ok) => { if (!ok) setNotice(t("复制失败：浏览器不允许写入剪贴板")); })}><Icon name="copy" /></button>
      <button className="hob-icon-btn" title={t("跳到原文")} aria-label={t("跳到原文")} onClick={() => void jumpToHistory(star.conversation, star.itemId)}><Icon name="out" /></button>
      <button className="hob-icon-btn" title={t("更多")} aria-label={t("更多")} onClick={(event) => menu.toggle("star", event.currentTarget)}><Icon name="more" /></button>
      {menu.menu ? createPortal(<div className="amenu" ref={menu.box}><button onClick={() => { menu.close(); void toggleStar(star.conversation, star.itemId); }}>{t("取消收藏")}</button></div>, document.body) : null}
    </div>
  </div>;
}

/** 收藏页：桌面照知识库，左栏是「全部」和有收藏的对话，底部「返回 Hob」；手机顶上返回 + 标题。 */
export function Stars({ narrow }: { narrow: boolean }) {
  const s = useApp();
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") goHome(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const conversationKey = (star: StarredMessage) => `${star.conversation.kind}:${star.conversation.id}`;
  const nameOf = (star: StarredMessage) => (star.conversation.kind === "group" ? s.groups.find((g) => g.id === star.conversation.id)?.name : s.assistants.find((a) => a.id === star.conversation.id)?.name) ?? star.conversation.id;
  const conversations = [...new Map(s.stars.map((star) => [conversationKey(star), star])).values()];
  const count = (key: string) => s.stars.filter((star) => conversationKey(star) === key).length;
  const words = query.trim().toLocaleLowerCase();
  const stars = s.stars.filter((star) => (!only || conversationKey(star) === only) && star.text.toLocaleLowerCase().includes(words));
  return <main className={`setpage stars-page${narrow ? " narrow" : ""}`}>
    {narrow ? <div className="sethead"><button className="hob-icon-btn" title={t("返回")} onClick={goHome}><Icon name="left" size={17} /></button><span className="t">{t("收藏")}</span></div> : (
      <nav className="setnav" aria-label={t("收藏")}>
        <SetNavHead title={t("收藏")} onBack={goHome} />
        <div className="setnav-scroll">
        <button className={`navrow${only ? "" : " sel"}`} onClick={() => setOnly(null)}><span>{t("全部")}</span><span className="knowledge-count">{s.stars.length || ""}</span></button>
        {conversations.length ? <div className="knowledge-label">{t("来自")}</div> : null}
        {conversations.map((star) => <button key={conversationKey(star)} className={`navrow${only === conversationKey(star) ? " sel" : ""}`} onClick={() => setOnly(conversationKey(star))}><span>{nameOf(star)}</span><span className="knowledge-count">{count(conversationKey(star))}</span></button>)}
        </div>
      </nav>
    )}
    <section className="stars-main">
      <label className="knowledge-search"><Icon name="search" size={16} /><input placeholder={t("搜索收藏消息")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {s.starsError ? <p className="stars-empty">{t("加载失败：{error}", { error: s.starsError })}</p> : !s.stars.length ? <p className="stars-empty">{t("还没有收藏的消息。在消息上点收藏，常用的结论、地址就能在这里找到。")}</p> : !stars.length ? <p className="stars-empty">{t("没有找到匹配的收藏消息")}</p> : <div className="stars-list">{stars.map((star) => <StarRow key={`${conversationKey(star)}:${star.itemId}`} star={star} />)}</div>}
    </section>
  </main>;
}
