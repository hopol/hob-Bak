// 中间一栏：头部 + 消息区 + 输入框。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AssistantSummary, GroupItem, GroupSummary, Item } from "../../../shared/types.ts";
import { isImagePath } from "../../../shared/media.ts";
import { localPath } from "../outbox.ts";
import { pastedFiles } from "../pasted-files.ts";
import { fileIcon } from "../file-icons.ts";
import { Icon } from "../icons.tsx";
import { fmtElapsed, fmtWhen } from "../util.ts";
import { Avatar } from "../sprites.tsx";
import { applyMention, filterMembers, mentionAt, stepPick } from "../mention.ts";
import {
  expandPanel,
  focusComposer,
  groupById,
  groupChatItems,
  groupSpeaking,
  leaveChat,
  loadOlderGroupItems,
  openSettings,
  openSheet,
  removeAttachment,
  send,
  selectGroup,
  setQuote,
  setSection,
  setText,
  stopAssistant,
  stopGroup,
  attach,
  chatItems,
  loadOlderItems,
  openFilePreview,
  photoUrl,
  useApp,
} from "../store.ts";
import { useLeave } from "../motion.ts";
import { isStreamingTail } from "../merge.ts";
import { afterScroll, expectAfterResize } from "../stick.ts";
import { GroupItemList, ItemList } from "./Items.tsx";
import { GroupCluster, membersOf } from "./Groups.tsx";
import { ClosedTopic, TopicStage } from "./Topics.tsx";
import { workflowInfo } from "../topics.ts";
import { DelayedText } from "./Empty.tsx";

export function conversationState(s: ReturnType<typeof useApp>) {
  const g = groupById(s, s.gsel);
  const a = g ? undefined : s.assistants.find((x) => x.id === s.sel);
  const items = g ? groupChatItems(s, g.id) : chatItems(s, s.sel);
  const loaded = g ? s.groupItems[g.id] !== undefined : s.sel ? s.items[s.sel] !== undefined : false;
  const busy = g ? g.busy.length > 0 : Boolean(a?.busy);
  return { g, a, items, loaded, busy, empty: Boolean((g || a) && loaded && items.length === 0 && !busy), thinking: busy && !isStreamingTail(items) };
}

/** 忙、但字还没出来时显示当前活动。 */
function Thinking({ leaving, gap, a }: { leaving: boolean; gap: boolean; a: AssistantSummary }) {
  return (
    <>
      {gap ? <div className="g" /> : null}
      <div className={`hov think${leaving ? " leaving" : ""}`}>
        <div className="activity-line" role="status">
          <Avatar sprite={a.sprite} prop={a.prop} size={46} free motion={a.activity?.state === "tool" ? "work" : "think"} />
          <span className="activity-shimmer">{a.activity?.label ?? "正在想…"}</span>
        </div>
      </div>
    </>
  );
}

/**
 * 贴底滚动：内容变高（新条目、流式文字、卡片数据晚到、字体加载）或容器变矮（手机键盘弹出）时，若原本就在底部附近就保持在底部。
 * 内容自己变高、变矮、上面掉条目都会让浏览器挪滚动位置，这些都不算离开底部；判断规则见 stick.ts。
 * 新到一条时平滑滚过去；自己刚发的那条无论在哪都滚到底；首次加载、切换助手、重新拉整批对话时瞬间到底。
 * 返回现在是否贴底（回到底部的按钮用）和一个滚到底的函数。
 */
function useStickToBottom(
  ref: React.RefObject<HTMLDivElement | null>,
  expect: React.RefObject<number>,
  resetKey: string,
  len: number,
  firstId: string | undefined,
  mineLast: boolean,
) {
  const [stuck, setStuck] = useState(true);
  const pinned = useRef(true);
  const seen = useRef<{ key: string; len: number; firstId?: string }>({ key: "", len: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = () => ({ top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight });
    const onScroll = () => {
      const next = afterScroll(pinned.current, expect.current, box());
      expect.current = next.expect;
      if (next.stuck !== pinned.current) {
        pinned.current = next.stuck;
        setStuck(next.stuck);
      }
    };
    const ro = new ResizeObserver(() => {
      expect.current = expectAfterResize(pinned.current, expect.current, box());
      if (pinned.current) el.scrollTop = expect.current;
    });
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [ref, expect]);

  // 在绘制前定位：进对话页时先画出顶部、下一帧再跳到底，就是那一下闪
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const last = seen.current;
    seen.current = { key: resetKey, len, firstId };
    if (last.key !== resetKey || len < last.len) {
      pinned.current = true;
      setStuck(true);
      el.scrollTop = el.scrollHeight;
      expect.current = el.scrollTop;
    } else if (len > last.len && last.firstId === firstId && (pinned.current || mineLast)) {
      pinned.current = true;
      setStuck(true);
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [ref, expect, resetKey, len, firstId, mineLast]);

  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setStuck(true);
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };

  return { atBottom: stuck, toBottom };
}

/**
 * 往上翻加载更早的消息：分页拼到前面以后把滚动位置让回原来那条，看的人不会跳。
 * 让位是程序自己动的，跟着记进预期位置，不然贴底那边会把它当成用户往上翻。
 */
function useOlderMessages(
  ref: React.RefObject<HTMLDivElement | null>,
  id: string | null,
  key: string,
  firstId: string | undefined,
  expect: React.RefObject<number>,
  group = false,
) {
  const anchor = useRef<{ id: string; top: number; key: string } | null>(null);
  const lastFirst = useRef<{ key: string; id?: string }>({ key: "" });
  const capture = () => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const node = Array.from(el.querySelectorAll<HTMLElement>("[data-item-id]")).find((item) => item.getBoundingClientRect().bottom > top);
    anchor.current = node ? { id: node.dataset.itemId!, top: node.getBoundingClientRect().top, key } : null;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    const old = lastFirst.current;
    if (el && old.key === key && old.id && old.id !== firstId && anchor.current?.key === key) {
      const node = Array.from(el.querySelectorAll<HTMLElement>("[data-item-id]")).find((item) => item.dataset.itemId === anchor.current?.id);
      if (node) {
        el.scrollTop += node.getBoundingClientRect().top - anchor.current.top;
        expect.current = el.scrollTop;
      }
    }
    lastFirst.current = { key, id: firstId };
  }, [ref, key, firstId, expect]);
  return () => {
    const el = ref.current;
    if (!el || !id) return;
    capture();
    if (el.scrollTop < 120) void (group ? loadOlderGroupItems(id) : loadOlderItems(id));
  };
}

function OlderStatus({ id, group = false }: { id: string | null; group?: boolean }) {
  const s = useApp();
  const page = group ? s.groupPages[id ?? ""] : s.itemPages[id ?? ""];
  if (!page?.hasMore && !page?.loading && !page?.error) return null;
  return <div className="older-messages" role="status">{page.error ? <button onClick={() => id && void (group ? loadOlderGroupItems(id, true) : loadOlderItems(id, true))}>读取失败：{page.error} · 重试</button> : page.loading ? <DelayedText text="正在读取更早的消息…" /> : null}</div>;
}

/** 最后一条是不是自己刚发的（转自别的助手的不算）。 */
function isMine(item: Item | undefined): boolean {
  return item?.kind === "user" && !item.from;
}

/** 回到底部：离开底部时出现，助手在回复时圈里是三个点。一直留在 DOM 里，靠透明度淡入淡出。 */
function JumpToBottom({ show, busy, onClick }: { show: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      className={`jump${show ? " show" : ""}`}
      onClick={onClick}
      title="回到最新消息"
      aria-label="回到最新消息"
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
    >
      {busy ? (
        <span className="jump-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Icon name="arrowDown" size={20} />
      )}
    </button>
  );
}

/**
 * 这个对话里有任务在跑：标题栏里一颗小胶囊（标题和用时），点了滚到那张卡。
 * 任务跑完就收起来。几个任务同时跑时写个数，点了到最近的那张。
 */
function RunningJobs({ items }: { items: Item[] }) {
  const s = useApp();
  const running = [...new Set(items.flatMap((item) => (item.kind === "job" && s.jobs[item.jobId]?.status === "running" ? [item.jobId] : [])))];
  const target = running.at(-1);
  const job = target ? s.jobs[target] : undefined;
  return (
    <button
      className={`runpill${job ? " show" : ""}`}
      aria-hidden={!job}
      tabIndex={job ? 0 : -1}
      title="看任务卡"
      onClick={() => target && document.getElementById(`job-${target}`)?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })}
    >
      <Icon name="spin" size={13} w={2.2} className="spin" />
      {running.length > 1 ? <span className="t">{running.length} 个任务进行中</span> : job ? <><span className="t">{job.title}</span><small>{fmtElapsed(job.startedAt ?? job.createdAt)}</small></> : null}
    </button>
  );
}

/** 交给主助手的几类事，点一下填进输入框（不直接发送）。 */
const EXAMPLES = ["查看这台电脑的磁盘和内存占用", "每天早上 9 点给我一份科技新闻简报", "把附件里的会议记录整理成要点"];

/**
 * 还没有任何消息时：说明这个助手做什么。还没配模型就先引导去设置，否则发出去只会得到一行报错。
 */
function EmptyChat({ a }: { a: AssistantSummary }) {
  const s = useApp();
  const models = s.settings.settings.models;
  const ready = models.roster.length > 0 && models.conversation.ref !== "";
  return (
    <div className="hello">
      <Avatar sprite={a.sprite} prop={a.prop} size={88} free motion="home" />
      <div className="t">{`我是${sendName(a.name, false)}${a.primary ? "，你的主助手" : ""}`}</div>
      <div className="d">
        {a.primary
          ? "交给我的事，我会分派给后台任务执行，完成、受阻或需要你确认时再告诉你；也可以让我定时执行。同类工作多了，我会建议创建专属助手。"
          : `负责${a.duty}。`}
      </div>
      {ready ? (
        a.primary ? (
          <div className="ex">
            {EXAMPLES.map((text) => (
              <button
                key={text}
                className="hob-btn"
                onClick={() => {
                  setText(text);
                  focusComposer();
                }}
              >
                {text}
              </button>
            ))}
          </div>
        ) : null
      ) : (
        <div className="setup">
          <div>开始使用前，请先添加模型服务商并选择模型。</div>
          <button
            className="hob-btn hob-btn-primary"
            onClick={() => {
              openSettings();
              setSection("providers");
            }}
          >
            前往设置
          </button>
        </div>
      )}
    </div>
  );
}

/** 群里正在说话的成员：底部一行一个人，头像 +「名字正在想…」。 */
function GroupThinking({ g }: { g: GroupSummary }) {
  const s = useApp();
  const speaking = groupSpeaking(s, g);
  if (!speaking.length) return null;
  return (
    <>
      <div className="g" />
      {speaking.map((id) => {
        const m = s.assistants.find((a) => a.id === id);
        if (!m) return null;
        return (
          <div className="hov think" key={id}>
            <div className="activity-line" role="status">
              <Avatar sprite={m.sprite} prop={m.prop} size={40} free motion={s.groupActivity[g.id]?.[id]?.state === "tool" ? "work" : "think"} />
              <span className="activity-shimmer">{`${sendName(m.name)}正在想…`}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** 还没说过话的群：说明这个群负责什么；话题里改成说明这件事就放在这里。 */
function EmptyGroup({ g }: { g: GroupSummary }) {
  const s = useApp();
  return (
    <div className="hello">
      <GroupCluster g={g} assistants={s.assistants} size={88} />
      <div className="t">{g.name}</div>
      <div className="d">{g.parentId ? "这件事的讨论、提问和进展都放在这个话题里。" : g.purpose}</div>
    </div>
  );
}

/** 话题顶上那行灰字：谁开的、什么时候。（服务端记的是 createdBy） */
function openLine(g: GroupSummary, assistants: AssistantSummary[]): string {
  const who = g.createdBy && g.createdBy !== "user"
    ? `${assistants.find((a) => a.id === g.createdBy)?.name ?? g.createdBy}从综合开了这个话题`
    : "你开了这个话题";
  return `${who} · ${fmtWhen(g.createdAt)}`;
}

/**
 * 名字嵌进中文句子：中文名直接连着写，英文名和前后的汉字之间留一个空格（「给 Hob 发消息」「给服务器发消息」）。
 * tail=false：后面紧跟标点或句子结束，不留后空格。
 */
export function sendName(name: string, tail = true): string {
  const latin = (c: string | undefined) => Boolean(c && /[A-Za-z0-9]/.test(c));
  return `${latin(name[0]) ? " " : ""}${name}${tail && latin(name.at(-1)) ? " " : ""}`;
}

/** 当前对话整体的版本号：换了助手或重新拉了对话就变，用来判断该不该平滑滚动。 */
function chatKey(sel: string | null, gen: number | undefined): string {
  return `${sel ?? ""}|${gen ?? 0}`;
}

function ConversationBody({ className, scrollRef, onScroll, state, scrollId, think, stick, mobile = false }: { className: string; scrollRef: React.RefObject<HTMLDivElement | null>; onScroll: React.UIEventHandler<HTMLDivElement>; state: ReturnType<typeof conversationState>; scrollId: string | null; think: ReturnType<typeof useLeave>; stick: { atBottom: boolean; toBottom: () => void }; mobile?: boolean }) {
  const { g, a, items, empty, busy } = state;
  const assistants = useApp().assistants;
  return <>
    <div className={className} ref={scrollRef} onScroll={onScroll}><div className={`col${empty ? " mid" : ""}`}>
      {g?.parentId ? <div className="topic-open-line">{openLine(g, assistants)}</div> : null}
      <OlderStatus id={scrollId} group={Boolean(g)} />
      {empty ? (g ? <EmptyGroup g={g} /> : a ? <EmptyChat a={a} /> : null) : g ? <GroupItemList g={g} items={items as GroupItem[]} /> : <ItemList items={items} />}
      {think.mounted && g ? <GroupThinking g={g} /> : think.mounted && a ? <Thinking a={a} leaving={think.leaving} gap={items.at(-1)?.kind === "user"} /> : null}
    </div></div>
    <JumpToBottom show={!stick.atBottom} busy={busy} onClick={stick.toBottom} />
  </>;
}

export function Chat() {
  const s = useApp();
  const { g, a, items, loaded, busy, empty, thinking } = conversationState(s);
  const parent = g?.parentId ? groupById(s, g.parentId) : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const key = g ? `group:${g.id}|${s.groupGen[g.id] ?? 0}` : chatKey(s.sel, s.sel ? s.itemGen[s.sel] : 0);
  const scrollId = g ? g.id : s.sel;
  const think = useLeave(thinking, 180);

  const expect = useRef(0);
  const onScroll = useOlderMessages(scrollRef, scrollId, key, items[0]?.id, expect, Boolean(g));
  const stick = useStickToBottom(scrollRef, expect, key, items.length, items[0]?.id, isMine(items.at(-1)));

  return (
    <main className="chat">
      <div className="head">
        {g && parent ? (
          <>
            <button className="crumb" title="回到综合" onClick={() => void selectGroup(parent.id)}>{parent.name}</button>
            <Icon name="chev" size={14} className="crumb-sep" />
            <span className="nm">{g.name}</span>
          </>
        ) : g ? (
          <>
            <GroupCluster g={g} assistants={s.assistants} size={26} />
            <span className="nm">{g.name}</span>
            <span className="gcount">{`综合 · ${g.members.length} 位成员`}</span>
            {g.workflow ? <span className="wftag">{workflowInfo(g.workflow).label}</span> : null}
          </>
        ) : a ? (
          <>
            <Avatar sprite={a.sprite} prop={a.prop} size={24} />
            <span className="nm">{a.name}</span>
          </>
        ) : null}
        <span className="sp" />
        <RunningJobs items={items} />
        {s.collapsed ? (
          <button className="hob-icon-btn" title="展开右栏" onClick={expandPanel}>
            <Icon name="panel" size={18} />
          </button>
        ) : null}
      </div>
      {g && parent && g.project ? <TopicStage topic={g} /> : null}
      <ConversationBody className="msgs" scrollRef={scrollRef} onScroll={onScroll} state={{ g, a, items, loaded, busy, empty, thinking }} scrollId={scrollId} think={think} stick={stick} />
      {g?.closedAt ? <ClosedTopic g={g} /> : <Composer />}
    </main>
  );
}

export function Composer({ variant = "desktop" }: { variant?: "desktop" | "mobile" }) {
  const s = useApp();
  const a = s.assistants.find((x) => x.id === s.sel);
  const g = groupById(s, s.gsel);
  const owner = g ? s.assistants.find((x) => x.id === g.ownerId) : undefined;
  const members = g ? membersOf(g, s.assistants) : [];
  const ta = useRef<HTMLTextAreaElement>(null);
  const compRef = useRef<HTMLDivElement>(null);
  // 光标位置要从当前文本的末尾算起（场景预填了「@」时也要直接弹出名单）
  const [caret, setCaret] = useState(s.text.length);
  const [pick, setPick] = useState(0);
  /** Esc 关掉的那一下：这段字不再弹，改了字再弹 */
  const [muted, setMuted] = useState<string | null>(null);
  /** 名单浮在输入框上面：挂在 body 上按屏幕坐标摆，不被输入框的模糊层裁掉 */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const has = s.text.trim().length > 0 || s.attachments.length > 0;
  const quote = useLeave(s.quote !== null, 180);
  // 群里打到 @ 就列成员：名字、职责，群主排第一
  const typing = g ? mentionAt(s.text, caret, members.map((m) => m.name)) : null;
  const options = g && typing ? filterMembers(members, g.ownerId, typing.query) : [];
  const showing = Boolean(g && typing && options.length && muted !== s.text);
  const active = options.length ? pick % options.length : 0;

  useLayoutEffect(() => {
    const rect = showing ? compRef.current?.getBoundingClientRect() : undefined;
    // 左边和输入框对齐，最宽不超过输入框
    const next = rect ? { left: rect.left, bottom: window.innerHeight - rect.top + 8, width: Math.min(rect.width, 320) } : null;
    setAnchor((prev) => (prev?.left === next?.left && prev?.bottom === next?.bottom && prev?.width === next?.width ? prev : next));
  }, [showing, s.text, s.attachments.length, variant]);

  const choose = (member: AssistantSummary | undefined) => {
    if (!typing || !member) return;
    const next = applyMention(s.text, typing, member.name);
    setText(next.text);
    setPick(0);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    const max = variant === "mobile" ? 120 : 180;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [s.text, s.nonce, variant]);

  useEffect(() => {
    if (s.nonce) ta.current?.focus();
  }, [s.nonce]);

  // 截图直接粘进输入框：和「加文件」一样进附件流程，后台开始上传
  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const files = pastedFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    attach(files);
  };

  // 输入框浮在消息上：量出它的高度写到 .chat 上，消息区底部照这个留白
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    const host = el?.closest<HTMLElement>(".chat");
    if (!el || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty("--comp-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [variant]);

  const body = (
    <div className={variant === "mobile" ? "mcomp" : "comp"} ref={compRef} onPaste={onPaste}>
      {quote.mounted ? (
        <div className={`comp-quote${quote.leaving ? " leaving" : ""}`}>
          <div className="quote">{s.quote?.text}</div>
          <button className="hob-icon-btn" style={{ width: 20, height: 20 }} onClick={() => setQuote(null)} title="取消引用">
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}
      {/* 附件：图片是带 × 的缩略图，其他文件是一张小卡（图标 + 名字），和 Telegram 一样 */}
      {s.attachments.length ? (
        <div className="comp-files">
          {s.attachments.map((att) => {
            const path = att.path ?? localPath(att);
            const state = att.status === "uploading" ? " uploading" : att.status === "failed" ? " failed" : "";
            return isImagePath(att.name) ? (
              <span className={`comp-thumb${state}`} key={att.id}>
                <img src={photoUrl(path)} alt={att.name} role="button" tabIndex={0} title="查看" onClick={() => openFilePreview(path, att.name)} onKeyDown={(e) => { if (e.key === "Enter") openFilePreview(path, att.name); }} />
                {att.status === "uploading" ? <span className="att-spin"><Icon name="spin" size={18} w={2.2} className="spin" /></span> : null}
                {att.status === "failed" ? <span className="att-bad">!</span> : null}
                <button onClick={() => removeAttachment(att.id)} title="移除" aria-label="移除">
                  <Icon name="close" size={11} w={2.2} />
                </button>
              </span>
            ) : (
              <span className={`filechip${state}`} key={att.id}>
                <span className="fi">
                  {att.status === "uploading" ? <Icon name="spin" size={16} w={2.2} className="spin" /> : <Icon name={fileIcon(att.name)} size={16} />}
                </span>
                <span className="fn">{att.name}</span>
                <button onClick={() => removeAttachment(att.id)} title="移除" aria-label="移除">
                  <Icon name="close" size={12} />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      {showing && anchor ? createPortal(
        <div className="mention-pop" style={{ left: anchor.left, bottom: anchor.bottom, width: anchor.width }} role="listbox" aria-label="成员">
          {options.map((m, i) => (
            <button
              key={m.id}
              className={`mp-row${i === active ? " on" : ""}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setPick(i)}
              onClick={() => choose(m)}
            >
              <Avatar sprite={m.sprite} prop={m.prop} size={26} />
              <strong>{m.name}</strong>
              <small>{m.id === g?.ownerId ? `群主 · ${m.duty}` : m.duty}</small>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
      <div className="comp-main">
        <label className="pl" title="加文件（也可粘贴截图）">
          <Icon name="plus" size={19} />
          <input
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) attach(files);
            }}
          />
        </label>
        <textarea
          ref={ta}
          className="ta"
          rows={1}
          value={s.text}
          placeholder={g ? (g.parentId ? `在这个话题里说，不点名由${sendName(owner?.name ?? "")}接` : `发到综合，不点名由${sendName(owner?.name ?? "")}接`) : `给${sendName(a?.name ?? "")}发消息`}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (showing) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPick((i) => stepPick(i, 1, options.length));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setPick((i) => stepPick(i, -1, options.length));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                choose(options[active]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMuted(s.text);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {/* 群里有人正在说话、输入框又是空的：发送键换成停止（有任务在跑不算，那是任务卡的事） */}
        {(g ? groupSpeaking(s, g).length > 0 : a?.busy) && !has ? (
          <button className="sendbtn stop" title="停止" onClick={() => void (g ? stopGroup(g.id) : a ? stopAssistant(a.id) : undefined)}>
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button className="sendbtn" title="发送" disabled={!has} onClick={() => void send()}>
            <Icon name="send" size={17} />
          </button>
        )}
      </div>
    </div>
  );

  if (variant === "mobile") return <div className="mcomp-wrap" ref={wrap}>{body}</div>;
  return (
    <div className="compwrap" ref={wrap}>
      <div className="col">{body}</div>
    </div>
  );
}

/** 手机上点助手行后切到对话页。 */
export function ChatPage() {
  const s = useApp();
  const { g, a, items, loaded, busy, empty, thinking } = conversationState(s);
  const parent = g?.parentId ? groupById(s, g.parentId) : undefined;
  const think = useLeave(thinking, 180);
  const scrollRef = useRef<HTMLDivElement>(null);
  const key = g ? `group:${g.id}|${s.groupGen[g.id] ?? 0}` : chatKey(s.sel, s.sel ? s.itemGen[s.sel] : 0);
  const scrollId = g ? g.id : s.sel;

  const expect = useRef(0);
  const onScroll = useOlderMessages(scrollRef, scrollId, key, items[0]?.id, expect, Boolean(g));
  const stick = useStickToBottom(scrollRef, expect, key, items.length, items[0]?.id, isMine(items.at(-1)));

  return (
    <>
      <div className="mchat-head">
        <button className="hob-icon-btn" style={{ marginLeft: -8 }} title="返回" onClick={leaveChat}>
          <Icon name="left" size={22} />
        </button>
        {g && parent ? null : g ? <GroupCluster g={g} assistants={s.assistants} size={30} /> : a ? <Avatar sprite={a.sprite} prop={a.prop} size={30} /> : null}
        {g ? (
          <span className="gname">
            <span className="nm">{g.name}</span>
            <span className="gcount">{parent ? `${parent.name} · 话题` : `综合 · ${g.members.length} 位成员`}</span>
          </span>
        ) : (
          <span className="nm">{a?.name ?? ""}</span>
        )}
        <span className="sp" />
        <RunningJobs items={items} />
        <button className="hob-icon-btn" title={g ? "群信息" : "助手信息"} onClick={openSheet}>
          <Icon name="more" size={20} />
        </button>
      </div>
      {g && parent && g.project ? <TopicStage topic={g} mobile /> : null}
      <ConversationBody className="mmsgs" scrollRef={scrollRef} onScroll={onScroll} state={{ g, a, items, loaded, busy, empty, thinking }} scrollId={scrollId} think={think} stick={stick} mobile />
      {g?.closedAt ? <ClosedTopic g={g} /> : <Composer variant="mobile" />}
    </>
  );
}
