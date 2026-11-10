// 对话条目的渲染：气泡、选择题、任务卡、草稿卡、文件卡、灰字提示。
import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Approval, ApprovalOption, Delegation, Draft, Item, Job, NoteIcon, SedimentStatus } from "../../../shared/types.ts";
import { attachmentName, isImagePath } from "../../../shared/media.ts";
import { plainText as plain } from "../../../shared/plain-text.ts";
import { visibleLiveCards } from "../page-live.ts";
import { Markdown } from "./Markdown.tsx";
import { splitTables } from "../markdown.ts";
import { MediaCard } from "./MediaCard.tsx";
import { ImageGenCard } from "./ImageGen.tsx";
import { PhotoStack } from "./PhotoStack.tsx";
import { Avatar } from "../sprites.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { fileIcon } from "../file-icons.ts";
import { flashItem, isFresh, useLeave } from "../motion.ts";
import { copyText } from "../clipboard.ts";
import {
  answer,
  createDraft,
  fileUrl,
  discardPending,
  pendingOf,
  photoUrl,
  retryPending,
  focusComposer,
  jumpToDelegation,
  jumpToHandback,
  openFilePreview,
  openLivePreview,
  openJob,
  replyJob,
  retryDelegation,
  select,
  setNotice,
  setQuote,
  setText,
  stopJob,
  useApp,
} from "../store.ts";
import { fmtDuration, fmtElapsed, fmtWhen, isToday, needDivider } from "../util.ts";
import { jobReason, jobRoundView } from "../steps.ts";
import { menuPosition, messageMenu, moveSwipe, swipeReply, type SwipeState } from "../message-menu.ts";
import { DELEGATION_STATUS, JOB_STATUS, StatusTag, jobStatusIcon, sedimentText } from "./status-meta.tsx";

/* ---------------- markdown ---------------- */

/* ---------------- 单项 ---------------- */

const NOTE_ICON: Record<NoteIcon, IconName> = {
  memory: "mem",
  skill: "bulb",
  rule: "rule",
  routine: "clock",
  split: "split",
  info: "info",
};


/** 触屏没有悬停：用长按菜单代替悬停工具行。 */
function useNoHover(): boolean {
  const [no, setNo] = useState(() => window.matchMedia("(hover: none)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(hover: none)");
    const sync = () => setNo(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return no;
}

/** 气泡下方的一行工具：回复（引用摘要）/ 复制（原文）。 */
function Tools({
  text,
  itemId,
  menu = false,
  close,
}: {
  text: string;
  itemId: string;
  menu?: boolean;
  close?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    if (!(await copyText(text))) {
      setNotice("复制失败：浏览器不允许写入剪贴板");
      return;
    }
    if (menu) { close?.(); return; }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`tools${menu ? " menu" : ""}`}>
      <button
        title="回复"
        aria-label="回复"
        onClick={() => {
          setQuote({ itemId, text: plain(text).slice(0, 60) });
          focusComposer();
          close?.();
        }}
      >
        <Icon name="reply" size={16} />{menu ? "回复" : null}
      </button>
      <button
        className={copied ? "copied" : ""}
        title={copied ? "已复制" : "复制"}
        aria-label={copied ? "已复制" : "复制"}
        onClick={() => void copy()}
      >
        <Icon name={copied ? "check" : "copy"} size={16} />{menu ? "复制" : null}
      </button>
    </div>
  );
}

function MessagePopup({ anchor, text, itemId, close }: { anchor: RefObject<HTMLDivElement | null>; text: string; itemId: string; close: () => void }) {
  const [layout, setLayout] = useState<{ bubble: DOMRect; area: DOMRect } | null>(null);
  const clone = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bubble = anchor.current;
    const area = bubble?.closest(".mmsgs, .msgs");
    if (bubble && area) setLayout({ bubble: bubble.getBoundingClientRect(), area: area.getBoundingClientRect() });
  }, [anchor]);
  useLayoutEffect(() => {
    if (!layout || !clone.current || !anchor.current) return;
    clone.current.replaceChildren(anchor.current.cloneNode(true));
  }, [anchor, layout]);
  if (!layout) return null;
  const { bubble, area } = layout;
  const position = menuPosition(bubble, area);
  return createPortal(
    <div className="message-popup" onPointerDown={(event) => event.stopPropagation()}>
      <div className="message-shade" style={{ left: area.left, top: area.top, width: area.width, height: area.height }} onPointerDown={close} />
      <div ref={clone} className="message-popup-bubble" style={{ left: bubble.left, top: bubble.top, width: bubble.width }} />
      <div className="message-popup-menu" style={position}>
        <Tools text={text} itemId={itemId} menu close={close} />
      </div>
    </div>,
    document.body,
  );
}

function jumpToQuote(event: React.MouseEvent<HTMLElement>, itemId: string) {
  const list = event.currentTarget.closest(".col");
  const target = [...(list?.querySelectorAll<HTMLElement>(".message-row[data-item-id]") ?? [])].find((row) => row.dataset.itemId === itemId);
  if (target) flashItem(target);
}

/** 每条消息工具行的状态。 */
type ToolsState = { open: boolean; start?: (event: React.PointerEvent) => void; close: () => void; touch: boolean; distance: number; ready: boolean };

/** 结束了的任务用了多久；没开始跑就结束的（排队时被停）不显示。 */
function took(job: Job): string | undefined {
  const ms = job.durationMs ?? (job.startedAt && job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined);
  return ms === undefined ? undefined : fmtDuration(ms);
}

function JobCard({ job: current, round, fresh, itemId }: { job: Job; round?: number; fresh: boolean; itemId: string }) {
  const s = useApp(); // 活动流／状态在 store 里更新，这里跟着重渲染
  const job = jobRoundView(current, round);
  const past = job !== current; // 续做之前的那几轮：停在那一轮结束时，没有按钮
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [swapped, setSwapped] = useState(false); // 状态刚变过：图标播淡出／弹一下
  const reply = useLeave(replying, 200);
  const running = job.status === "running";
  const canReply = !past && (running || job.status === "waiting");
  const bad = job.status === "stuck" || job.status === "failed";
  const reason = jobReason(job);
  const owner = s.assistants.find((a) => a.id === job.assistantId);

  // 沉淀状态：没沉淀出东西（empty）不在卡片上说，转圈那一行淡出就结束
  const latest = past ? undefined : job.sediment;
  const reached = latest && latest.status !== "empty" ? latest : undefined;
  const kept = useRef<SedimentStatus | undefined>(undefined);
  if (reached) kept.current = reached;
  const sedimentLeave = useLeave(!!reached, 200);
  const sediment = sedimentLeave.mounted ? (reached ?? kept.current) : undefined;

  // 状态变了才播，历史里的卡片不播
  const before = useRef(job.status);
  useEffect(() => {
    if (before.current === job.status) return;
    before.current = job.status;
    setSwapped(true);
    const timer = window.setTimeout(() => setSwapped(false), 400);
    return () => window.clearTimeout(timer);
  }, [job.status]);

  return (
    <div className={`hov${fresh ? " enter" : ""}`} id={past ? undefined : `job-${job.id}`} data-item-id={itemId}>
      <div
        className="b jobcard"
        role="button"
        tabIndex={0}
        onClick={() => openJob(job.id, round ?? 0)}
        onKeyDown={(event) => {
          if (event.key === "Enter") openJob(job.id, round ?? 0);
        }}
      >
        <div className="tt">
          {owner ? <span className="jav"><Avatar sprite={owner.sprite} prop={owner.prop} size={40} /></span> : null}
          <span className="jt">{job.routineId ? <Icon name="clock" size={14} /> : null}{job.title}</span>
          <span className="stline">
            <StatusTag meta={JOB_STATUS[job.status]} card animated swapped={swapped}>
              {running ? ` · ${fmtElapsed(job.startedAt ?? job.createdAt)}` : took(job) ? ` · 用时 ${took(job)}` : null}
            </StatusTag>
          </span>
        </div>
        {/* 说明块：状态原因和沉淀状态放进标题下面的浅底块；都没有就不出现 */}
        {reason || sediment ? <div className={`jnote${!reason && sedimentLeave.leaving ? " leaving" : ""}`}>
          {reason ? <div className={`jnote-row${bad ? " bad" : ""}`}><span className="clamp">{reason}</span></div> : null}
          {sediment ? <div className={`jnote-row${sediment.status === "failed" ? " bad" : ""}`}>
            <Icon name={sediment.status === "running" ? "spin" : "mem"} size={13} className={sediment.status === "running" ? "spin" : undefined} />
            <span>{sedimentText(sediment)}</span>
          </div> : null}
        </div> : null}
        {canReply || running ? (
          <div className="acts">
            {canReply ? (
              <button
                className={`hob-btn job-reply${replying ? " selected" : ""}`}
                aria-pressed={replying}
                onClick={(event) => {
                  event.stopPropagation();
                  setReplying((value) => !value);
                }}
              >
                <Icon name="edit" size={14} />
                补充要求
              </button>
            ) : null}
            {running ? (
              <button
                className="hob-btn hob-btn-danger job-stop"
                onClick={(event) => {
                  event.stopPropagation();
                  void stopJob(job.id);
                }}
              >
                <Icon name="stop" size={14} />
                停止
              </button>
            ) : null}
          </div>
        ) : null}
        {reply.mounted ? (
          <div className={`replywrap${reply.leaving ? " leaving" : ""}`} onClick={(event) => event.stopPropagation()}>
            <div className="replyclip">
              <div className="replybox">
                <input
                  autoFocus
                  value={text}
                  placeholder="补充说明或更正方向"
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && text.trim()) {
                      void replyJob(job.id, text.trim());
                      setText("");
                      setReplying(false);
                    }
                    if (event.key === "Escape") setReplying(false);
                  }}
                />
                <button
                  className="hob-btn hob-btn-primary"
                  onClick={() => {
                    if (text.trim()) void replyJob(job.id, text.trim());
                    setText("");
                    setReplying(false);
                  }}
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DraftCard({ draft }: { draft: Draft }) {
  const s = useApp();
  const created = draft.status === "created" && draft.createdAssistantId;
  // 建好以后：头像跟着新助手走（可能是自画的道具），细节收起来，留职责和「查看」
  const made = created ? s.assistants.find((a) => a.id === draft.createdAssistantId) : undefined;
  const prop = made?.prop ?? draft.prop;
  // 建出来的助手归档了：点过去也没这人了，就说明一下
  const archived = Boolean(created) && !made;
  return (
    <div className="draft">
        <div className="top">
          <Avatar sprite={made?.sprite ?? draft.sprite} prop={prop} size={46} />
          <div>
            <div className="dn">{draft.name}</div>
            <div className="ds">{draft.status === "created" ? "新助手 · 已创建" : "新助手 · 草稿"}</div>
          </div>
        </div>
        <div className="kv">
          <span className="k">职责</span>
          <span>{draft.dutyLong}</span>
        </div>
        <div className={`expand${created ? "" : " open"}`} inert={Boolean(created)}>
          <div>
            <div className="kv">
              <span className="k">定时任务</span>
              <span className={draft.routinesText ? undefined : "none"}>{draft.routinesText || "没有"}</span>
            </div>
            <div className="kv">
              <span className="k">执行前确认</span>
              <span className={draft.askFirst.length ? undefined : "none"}>{draft.askFirst.join(" · ") || "没有"}</span>
            </div>
            <div className="kv">
              <span className="k">补充说明</span>
              {draft.instructions.length ? (
                // 每条一行：条目自己带句号，再用「；」接起来会变成「。；」
                <span>
                  {draft.instructions.map((line, i) => (
                    <span className="line" key={i}>
                      {line}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="none">没有</span>
              )}
            </div>
            <div className="kv">
              <span className="k">迁移</span>
              <span>{draft.carry.conversations} 段对话</span>
            </div>
          </div>
        </div>
        <div className="acts swap" style={{ marginTop: 12 }}>
          <div className={created ? "off" : undefined}>
            <button className="hob-btn hob-btn-primary" onClick={() => void createDraft(draft.id)}>
              创建
            </button>
            <button
              className="hob-btn"
              onClick={() => {
                setText("请修改草稿：");
                focusComposer();
              }}
            >
              修改草稿
            </button>
          </div>
          <div className={created ? undefined : "off"}>
            <button className="hob-btn hob-btn-primary" disabled={archived} onClick={() => void select(draft.createdAssistantId!)}>
              {archived ? "已归档" : "已创建 · 查看"}
            </button>
          </div>
        </div>
    </div>
  );
}

function DelegationCard({ delegation, fresh }: { delegation: Delegation; fresh: boolean }) {
  const s = useApp();
  const [expanded, setExpanded] = useState(false);
  const previousStatus = useRef(delegation.status);
  const changed = previousStatus.current !== delegation.status;
  useEffect(() => { previousStatus.current = delegation.status; }, [delegation.status]);
  const target = s.assistants.find((a) => a.id === delegation.to);
  const name = target?.name ?? delegation.to;
  const approvals = Object.values(s.approvals).filter((approval) => approval.status === "pending" && ((delegation.approvalIds ?? []).includes(approval.id) || Boolean(approval.jobId && delegation.jobIds.includes(approval.jobId))));
  return (
    <div className={`hov${fresh ? " enter" : ""}`} id={`delegation-${delegation.id}`}>
      <div className="b jobcard delegation-card">
        <div className="tt">
          {target ? <span className="jav"><Avatar sprite={target.sprite} prop={target.prop} size={40} /></span> : null}
          <span className="jt">交给「{name}」</span>
          <span key={delegation.status} className={changed ? "status-fade" : undefined}><StatusTag meta={DELEGATION_STATUS[delegation.status]} card /></span>
        </div>
        <button className={`delegation-text${expanded ? " expanded" : ""}`} onClick={() => setExpanded(!expanded)} title={expanded ? "收起" : "查看全文"}>{delegation.text}</button>
        {delegation.status === "returned" && delegation.reply ? <div className="note">{delegation.reply}</div> : null}
        {delegation.jobIds.map((id) => {
          const job = s.jobs[id];
          // 卡头已经写了总状态，这里每个任务只给图标（悬停看文字），不再重复「待确认」这类字
          return job ? (
            <button className={`delegation-job ${job.status}`} key={id} onClick={() => openJob(id)} title={JOB_STATUS[job.status].text}>
              {jobStatusIcon(job.status, 14, 2)}
              <span>{job.title}</span>
              <Icon name="chev" size={14} className="go" />
            </button>
          ) : null;
        })}
        {approvals.map((approval) => <QuestionCard key={approval.id} approval={approval} fresh={false} />)}
        <div className="delegation-actions">
          <button onClick={() => void jumpToDelegation(delegation.to, delegation.id, true)}>去「{name}」看看 →</button>
          {delegation.status === "interrupted" ? <button onClick={() => void retryDelegation(delegation.id)}>重新转交</button> : null}
        </div>
      </div>
    </div>
  );
}

function QuestionCard({ approval, fresh }: { approval: Approval; fresh: boolean }) {
  const previousStatus = useRef(approval.status);
  const changed = previousStatus.current !== approval.status;
  useEffect(() => { previousStatus.current = approval.status; }, [approval.status]);
  const chosen = approval.options.find((o) => o.key === approval.chosen);
  const done = approval.status === "answered" && chosen ? approval.chosen : undefined;
  // 刚点的那个选项：先亮一下，其余收起来，再出勾
  const [picked, setPicked] = useState<ApprovalOption["key"] | null>(null);
  const [text, setText] = useState("");
  const active = picked ?? done;
  const animated = picked !== null;
  // 用户没选选项、自己写的那句：和选了选项一样，卡片就到这里
  const reply = approval.status === "answered" ? approval.answerText : undefined;
  const typed = text.trim();
  const send = () => {
    if (typed) void answer(approval.id, { text: typed });
  };

  return (
    <div className={`b q${fresh ? " enter" : ""}`}>
      <div className="qt">{approval.title}</div>
      {approval.detail ? <div className="qs">{approval.detail}</div> : null}
      <div className="opts">
        {approval.status === "expired" ? (
          <div className={`opt${changed ? " status-fade" : ""}`}>已结束</div>
        ) : reply ? (
          <div className="opt chosen">
            <span className="key">
              <Icon name="user" size={12} />
            </span>
            {reply}
            <span className={`ck${changed ? " check-enter" : ""}`}>
              <Icon name="check" size={16} />
            </span>
          </div>
        ) : active && !animated ? (
          <div className="opt chosen">
            <span className="key">{active}</span>
            {approval.options.find((o) => o.key === active)?.label}
            <span className="ck">
              <Icon name="check" size={16} />
            </span>
          </div>
        ) : (
          approval.options.map((o) => {
            const sel = o.key === active;
            return (
              <div className={`optrow${animated && !sel ? " away" : ""}`} key={o.key}>
                <div className="optclip">
                  <button
                    className={`opt${sel ? " chosen" : ""}`}
                    disabled={animated}
                    onClick={() => {
                      setPicked(o.key);
                      void answer(approval.id, { key: o.key });
                    }}
                  >
                    <span className="key">{o.key}</span>
                    {o.label}
                    {sel && animated ? (
                      <span className="ck">
                        <Icon name="check" size={16} />
                      </span>
                    ) : null}
                  </button>
                </div>
              </div>
            );
          })
        )}
        {approval.status === "expired" || reply || animated || active ? null : (
          <div className="other">
            <input
              value={text}
              placeholder="其他想法…"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) send();
              }}
            />
            {typed ? (
              <button className="hob-icon-btn other-send" title="发送" onClick={send}>
                <Icon name="send" size={16} />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function FileCard({ name, path, meta, fresh, itemId }: { name: string; path: string; meta?: string; fresh: boolean; itemId: string }) {
  return (
    <button className={`att filecard${fresh ? " enter" : ""}`} data-item-id={itemId} onClick={() => openFilePreview(path, name)}>
      <span className="ico">
        <Icon name={fileIcon(path)} size={18} />
      </span>
      <span>
        <span className="n" style={{ display: "block" }}>
          {name}
        </span>
        {meta ? <span className="m">{meta}</span> : null}
      </span>
    </button>
  );
}

/** 图片条目：缩略图，点开文件预览（预览里再点可以放大）。 */
function ImageCard({ name, path, fresh, itemId }: { name: string; path: string; fresh: boolean; itemId: string }) {
  return (
    <button className={`imgcard${fresh ? " enter" : ""}`} data-item-id={itemId} onClick={() => openFilePreview(path)} title={name}>
      <img src={photoUrl(path)} alt={name} loading="lazy" />
    </button>
  );
}

/**
 * 折行的气泡收到最长那一行：浏览器按最大宽度折行，折完盒子还是最大宽度，右边会空出一截。
 * 量出每行文字的最右端，把 max-width 收到那里；每行都放得下，折行位置不变，变了就退回去。
 * 行内元素按元素框量（带上 code 的内边距）。字体晚到会改字宽，到了再量一次。key 为空不收（流式中、带卡片）。
 */
function useFit<T extends HTMLElement>(key: string | undefined) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.maxWidth = "";
    if (key === undefined) return;
    let live = true;
    const fit = () => {
      if (!live) return;
      el.style.maxWidth = "";
      const box = el.getBoundingClientRect();
      if (!box.width) return;
      let right = 0;
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        let rects: DOMRectList;
        if (node instanceof Element) {
          if (getComputedStyle(node).display !== "inline") continue;
          rects = node.getClientRects();
        } else {
          range.selectNodeContents(node);
          rects = range.getClientRects();
        }
        for (const rect of rects) right = Math.max(right, rect.right);
      }
      if (!right) return;
      const width = Math.ceil(right - box.left + parseFloat(getComputedStyle(el).paddingRight));
      if (width >= box.width - 1) return;
      el.style.maxWidth = `${width}px`;
      if (el.getBoundingClientRect().height > box.height + 0.5) el.style.maxWidth = "";
    };
    fit();
    void document.fonts.ready.then(fit);
    return () => {
      live = false;
    };
  }, [key]);
  return ref;
}

function ItemView({
  item,
  inlineDraft,
  fresh,
  tools,
}: {
  item: Item;
  inlineDraft?: Draft;
  fresh: boolean;
  tools: ToolsState;
}) {
  const s = useApp();
  const enter = fresh ? " enter" : "";
  // 只收用户气泡：助手这边折行的气泡要和任务卡、提问卡一样宽，右边缘才齐
  // 几张图片的消息：叠成一摞，点「展开」才一张张排开（微信的做法）
  const [albumOpen, setAlbumOpen] = useState(false);
  // 带附件的不收：照片是定宽的，按文字收会把照片裁掉
  const bubble = useFit<HTMLDivElement>(item.kind === "user" && !item.files?.length ? item.text : undefined);
  const preventMenu = tools.touch ? (event: React.MouseEvent) => event.preventDefault() : undefined;
  const swipeStyle = tools.distance ? { transform: `translateX(-${Math.min(64, tools.distance * 0.8)}px)`, transition: "none" } : undefined;
  const progress = Math.min(1, tools.distance / 48);
  const swipeIcon = tools.distance > 0 ? <span className={`swipe-reply${tools.ready ? " ready" : ""}`} style={{ opacity: progress, transform: `scale(${progress})` }}><span className="swipe-reply-inner"><Icon name="reply" size={18} /></span></span> : null;

  if (item.kind === "user") {
    const photos = item.files?.filter(isImagePath) ?? [];
    const others = item.files?.filter((f) => !isImagePath(f)) ?? [];
    const single = photos.length === 1;
    const album = photos.length > 1;
    // 照片单独成块（一张就是一张圆角图，几张是一摞），文字另起一个气泡放在下面，不挤在一起
    const hasBubble = Boolean(item.from || item.quote || item.text || others.length);
    // 还在发件箱里的（刚点了发送）：附件可能还没传完，传完前点不开
    const pend = pendingOf(s, s.sel, item.id);
    const open = (f: string) => {
      if (!f.startsWith("pending/")) openFilePreview(f, attachmentName(f));
    };
    const photo = (f: string, cls: string) => (
      <button key={f} className={cls} onClick={() => open(f)} title={attachmentName(f)}>
        <img src={photoUrl(f)} alt={attachmentName(f)} loading="lazy" />
      </button>
    );
    const fileRow = (f: string) => <button className="ufile" onClick={() => open(f)}><span className="fi"><Icon name={fileIcon(f)} size={16} /></span><span className="fn">{attachmentName(f)}</span></button>;
    return (
      <div className="message-row right" id={item.from ? `forward-${item.from.delegationId}` : undefined} data-item-id={item.id} onPointerDown={tools.start} onContextMenu={preventMenu}>
        {swipeIcon}
        {/* iMessage：没发出去时气泡左边一个红色感叹号，点了重试；有附件在传时那里转圈 */}
        {pend?.status === "failed" ? (
          <button className="send-failed" title="重试" aria-label="未送达，重试" onClick={() => retryPending(pend.assistantId, pend.localId)}>!</button>
        ) : pend && item.files?.length ? (
          <span className="send-progress" aria-label="正在发送"><Icon name="spin" size={16} w={2.2} className="spin" /></span>
        ) : null}
        <div className={`hov right msg${fresh ? " enter-right" : ""}${pend ? " pending" : ""}`}>
        {album ? (
          <div className={`u-album${albumOpen ? " open" : ""}`} ref={hasBubble ? undefined : bubble} style={hasBubble ? undefined : swipeStyle}>
            <button className="album-pill" onClick={() => setAlbumOpen(!albumOpen)}>{albumOpen ? "收起" : `展开 ${photos.length}`}</button>
            {albumOpen ? (
              <div className="album-list">{photos.map((f) => photo(f, "u-photo album-item"))}</div>
            ) : (
              <PhotoStack photos={photos} onOpen={open} />
            )}
          </div>
        ) : null}
        {single ? (
          <div className="u-solo" ref={hasBubble ? undefined : bubble} style={hasBubble ? undefined : swipeStyle}>
            {photo(photos[0], "u-photo album-item")}
          </div>
        ) : null}
        {hasBubble ? (
        <div className="u" ref={bubble} style={swipeStyle}>
          {item.from ? <button className="forward-label" onClick={() => void (item.from!.assistantId === "hob" ? jumpToDelegation(item.from!.assistantId, item.from!.delegationId, false) : jumpToHandback(item.from!.assistantId, item.from!.delegationId, false))}>{(() => { const sender = s.assistants.find((a) => a.id === item.from!.assistantId); return sender ? <Avatar sprite={sender.sprite} prop={sender.prop} size={16} /> : null; })()}转自 {item.from.assistantId === "hob" ? item.from.name : `「${item.from.name}」`}</button> : null}
          {item.quote ? <button className="quote" onClick={(event) => jumpToQuote(event, item.quote!.itemId)}>{item.quote.text}</button> : null}
          {/* 其他附件是气泡里的一行文件卡 */}
          {item.text ? <span className="u-text">{item.text}</span> : null}
          {others.map((f) => (f.startsWith("pending/") ? <Fragment key={f}>{fileRow(f)}</Fragment> : <MediaCard key={f} path={f} name={attachmentName(f)} fallback={fileRow(f)} />))}
        </div>
        ) : null}
        {pend?.status === "failed" ? (
          <div className="send-status">
            未送达
            <button onClick={() => retryPending(pend.assistantId, pend.localId)}>重试</button>
            <button onClick={() => discardPending(pend.assistantId, pend.localId)}>删除</button>
          </div>
        ) : null}
        {pend ? null : <Tools text={item.text} itemId={item.id} />}
        </div>
        {tools.open ? <MessagePopup anchor={bubble} text={item.text} itemId={item.id} close={tools.close} /> : null}
      </div>
    );
  }

  if (item.kind === "assistant") {
    return (
      <>
        {item.routine ? (
          <div className={`tag${fresh ? " enter-fade" : ""}`}>
            {item.routine.jobId ? (
              <button onClick={() => openJob(item.routine!.jobId!)}><Icon name="clock" size={13} />{item.routine.name}</button>
            ) : <><Icon name="clock" size={13} />{item.routine.name}</>}
          </div>
        ) : null}
        <div className="message-row" data-item-id={item.id} onPointerDown={tools.start} onContextMenu={preventMenu}>
          {swipeIcon}
          <div className={`hov msg${enter}`}>
          {/* 表格单独成卡片（框内左右滑），前后的文字照旧是气泡；第一块接住滑动回复和菜单定位 */}
          {splitTables(item.text).map((part, i, parts) =>
            part.table ? (
              <div key={i} className="tablecard" ref={i === 0 ? bubble : undefined} style={i === 0 ? swipeStyle : undefined}>
                <Markdown text={part.md} />
              </div>
            ) : (
              <div key={i} className={`b${inlineDraft && i === parts.length - 1 ? " wide" : ""}`} ref={i === 0 ? bubble : undefined} style={i === 0 ? swipeStyle : undefined}>
                <Markdown text={part.md} streaming={item.streaming && i === parts.length - 1} />
                {inlineDraft && i === parts.length - 1 ? <DraftCard draft={inlineDraft} /> : null}
              </div>
            ),
          )}
          <Tools text={item.text} itemId={item.id} />
          </div>
          {tools.open ? <MessagePopup anchor={bubble} text={item.text} itemId={item.id} close={tools.close} /> : null}
        </div>
      </>
    );
  }

  if (item.kind === "note") {
    return (
      <div className={`sys${fresh ? " enter-fade" : ""}`} id={item.handbackId ? `handback-${item.handbackId}` : undefined}>
        {item.icon !== "split" ? <Icon name={NOTE_ICON[item.icon]} size={14} /> : null}
        {item.handbackId ? <button onClick={() => void jumpToHandback("hob", item.handbackId!, true)}>{item.text}</button> : item.icon === "skill" && item.path ? <button onClick={() => openFilePreview(item.path!)}>{item.text}</button> : item.icon === "memory" ? <span className="sys-memory" title={item.text}>{item.text.replace(/[:：,，;；、]+\s*$/u, "")}</span> : item.text}
      </div>
    );
  }

  if (item.kind === "question") {
    const ap = s.approvals[item.approvalId];
    return ap ? <QuestionCard approval={ap} fresh={fresh} /> : null;
  }

  if (item.kind === "job") {
    const job = s.jobs[item.jobId];
    return job ? <JobCard job={job} round={item.round} fresh={fresh} itemId={item.id} /> : null;
  }

  if (item.kind === "draft") {
    const draft = s.drafts[item.draftId];
    return draft ? (
      <div className={`b wide${enter}`}>
        <DraftCard draft={draft} />
      </div>
    ) : null;
  }

  if (item.kind === "delegation") {
    const delegation = s.delegations[item.delegationId];
    return delegation ? <DelegationCard delegation={delegation} fresh={fresh} /> : null;
  }

  if (item.kind === "image") return <ImageGenCard {...item} fresh={fresh} itemId={item.id} />;

  // 老数据里可能有一条没存 path 的文件条目：只显示名字，不进预览，避免 path.lastIndexOf 抛异常把整页带白。
  if (!item.path) {
    return (
      <div className={`att filecard${fresh ? " enter" : ""}`} data-item-id={item.id} title="文件路径缺失，无法预览">
        <span className="ico">
          <Icon name="file" size={18} />
        </span>
        <span>
          <span className="n" style={{ display: "block" }}>
            {item.name || "文件"}
          </span>
          {item.meta ? <span className="m">{item.meta}</span> : null}
        </span>
      </div>
    );
  }

  return isImagePath(item.path) ? (
    <ImageCard path={item.path} name={item.name} fresh={fresh} itemId={item.id} />
  ) : (
    <MediaCard path={item.path} name={item.name} itemId={item.id} fallback={<FileCard path={item.path} name={item.name} meta={item.meta} fresh={fresh} itemId={item.id} />} />
  );
}

/** 同一次回复里的几条贴着（只有气泡自己的 4px），换一方说话或开新的一组（lead）才拉开。 */
function opensGroup(prev: Item | undefined, cur: Item): boolean {
  if (!prev) return false;
  return (prev.kind === "user") !== (cur.kind === "user") || Boolean(cur.lead);
}

export function ItemList({ items }: { items: Item[] }) {
  const s = useApp();
  const touch = useNoHover();
  const [openId, dispatchMenu] = useReducer(messageMenu, null);
  const press = useRef<{ timer: number; pointerId: number; id: string; text: string; swipe: SwipeState; ready: boolean } | null>(null);
  const [swipe, setSwipe] = useState<{ id: string; distance: number; ready: boolean } | null>(null);
  useEffect(() => {
    const cancel = () => {
      if (press.current) window.clearTimeout(press.current.timer);
      press.current = null;
      setSwipe(null);
    };
    const down = (event: PointerEvent) => {
      dispatchMenu({ type: "outside", inside: event.target instanceof Element && Boolean(event.target.closest(".tools.menu")) });
    };
    const move = (event: PointerEvent) => {
      const p = press.current;
      if (!p || p.pointerId !== event.pointerId) return;
      p.swipe = moveSwipe(p.swipe, event.clientX, event.clientY);
      if (Math.hypot(event.clientX - p.swipe.x, event.clientY - p.swipe.y) > 10) window.clearTimeout(p.timer);
      if (p.swipe.direction === "vertical") { cancel(); return; }
      if (p.swipe.direction !== "horizontal") return;
      window.clearTimeout(p.timer);
      const ready = swipeReply(p.swipe);
      if (ready && !p.ready) navigator.vibrate?.(10);
      p.ready = ready;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        if (ready) {
          setQuote({ itemId: p.id, text: plain(p.text).slice(0, 60) });
          focusComposer();
          cancel();
        }
        return;
      }
      setSwipe({ id: p.id, distance: p.swipe.distance, ready });
    };
    const up = (event: PointerEvent) => {
      const p = press.current;
      if (!p || p.pointerId !== event.pointerId) return;
      if (swipeReply(p.swipe)) {
        setQuote({ itemId: p.id, text: plain(p.text).slice(0, 60) });
        focusComposer();
      }
      cancel();
    };
    const scroll = () => { cancel(); dispatchMenu({ type: "close" }); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("scroll", scroll, true);
    return () => {
      cancel();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("scroll", scroll, true);
    };
  }, []);
  const rows: ReactNode[] = [];
  if (items.length && !isToday(items[0].at) && items[0].kind !== "note") {
    rows.push(
      <div className="div" key="first-div">
        {fmtWhen(items[0].at)}
      </div>,
    );
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const prev = items[i - 1];
    const next = items[i + 1];
    const fresh = isFresh(item.id);
    const inline = item.kind === "assistant" && next?.kind === "draft" ? s.drafts[next.draftId] : undefined;
    const tools: ToolsState = {
      open: touch && openId === item.id,
      touch,
      distance: swipe?.id === item.id ? swipe.distance : 0,
      ready: swipe?.id === item.id && swipe.ready,
      close: () => dispatchMenu({ type: "close" }),
      start: touch ? (event) => {
        if (event.pointerType !== "touch" || (item.kind !== "user" && item.kind !== "assistant") || (event.target as Element).closest("a,button,input,textarea,select,[contenteditable],.draft,.album-stack")) return;
        if (press.current) window.clearTimeout(press.current.timer);
        const { clientX: x, clientY: y, pointerId } = event;
        const timer = window.setTimeout(() => {
          press.current = null;
          dispatchMenu({ type: "open", id: item.id });
        }, 500);
        press.current = { timer, pointerId, id: item.id, text: item.text, swipe: { x, y, direction: "pending", distance: 0 }, ready: false };
      } : undefined,
    };
    if (inline) i++;
    rows.push(
      <Fragment key={item.id}>
        {needDivider(prev?.at, item.at) ? (
          <div className={`div${fresh ? " enter-fade" : ""}`}>{fmtWhen(item.at)}</div>
        ) : opensGroup(prev, item) ? (
          <div className="g" />
        ) : null}
        <ItemView item={item} inlineDraft={inline} fresh={fresh} tools={tools} />
      </Fragment>,
    );
  }
  for (const page of visibleLiveCards(Object.values(s.livePages), s.sel)) {
    rows.push(<button key={page.callId} className={`att filecard${page.state === "failed" ? " bad" : ""}`} onClick={() => openLivePreview(page.callId)}>
      <span className="ico"><Icon name={page.state === "writing" ? "spin" : "close"} className={page.state === "writing" ? "spin" : ""} size={18} /></span>
      <span><span className="n" style={{ display: "block" }}>{page.title || "正在写页面…"}</span><span className="m">{page.state === "failed" ? `生成失败：${page.error}` : "生成中"}</span></span>
    </button>);
  }
  return <>{rows}</>;
}
