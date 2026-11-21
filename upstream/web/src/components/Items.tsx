// 对话条目的渲染：气泡、选择题、任务卡、草稿卡、文件卡、灰字提示。
import { t } from "../../../shared/i18n.ts";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Approval, ApprovalOption, Delegation, Draft, GroupItem, GroupSummary, Item, Job, NoteIcon, SedimentStatus } from "../../../shared/types.ts";
import { attachmentName, isImagePath } from "../../../shared/media.ts";
import { plainText as plain } from "../../../shared/plain-text.ts";
import { isRoutineDueNote } from "../../../shared/routine-note.ts";
import { visibleLiveCards } from "../page-live.ts";
import { Markdown } from "./Markdown.tsx";
import { splitTables } from "../markdown.ts";
import { MediaCard } from "./MediaCard.tsx";
import { ImageGenCard } from "./ImageGen.tsx";
import { Brief } from "./Brief.tsx";
import { spokenPreview, topicFace } from "../topics.ts";
import { PhotoStack } from "./PhotoStack.tsx";
import { ReplyInput } from "./ReplyInput.tsx";
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
  pendingKeyOf,
  pendingOf,
  photoUrl,
  retryPending,
  focusComposer,
  jumpToDelegation,
  jumpToHandback,
  openFilePreview,
  openLoginDesktop,
  openLivePreview,
  openNoteGroup,
  openJob,
  replyJob,
  retryDelegation,
  select,
  selectGroup,
  setNotice,
  setQuote,
  setText,
  stopJob,
  useApp,
} from "../store.ts";
import { fmtDuration, fmtElapsed, fmtList, fmtWhen, isToday, needDivider } from "../util.ts";
import { jobReason, jobRoundView } from "../steps.ts";
import { actionsFor, menuPosition, moveSwipe, swipeReply, type SwipeState } from "../message-menu.ts";
import { DELEGATION_STATUS, JOB_STATUS, StatusTag, jobStatusIcon, jobStatusMeta, sedimentText } from "./status-meta.tsx";
import { membersOf } from "./Groups.tsx";

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
      setNotice(t("复制失败：浏览器不允许写入剪贴板"));
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
        title={t("回复")}
        aria-label={t("回复")}
        onClick={() => {
          setQuote({ itemId, text: plain(text).slice(0, 60) });
          focusComposer();
          close?.();
        }}
      >
        <Icon name="reply" size={16} />{menu ? t("回复") : null}
      </button>
      <button
        className={copied ? "copied" : ""}
        title={copied ? t("已复制") : t("复制")}
        aria-label={copied ? t("已复制") : t("复制")}
        onClick={() => void copy()}
      >
        <Icon name={copied ? "check" : "copy"} size={16} />{menu ? t("复制") : null}
      </button>
    </div>
  );
}

type Popup = { anchor: HTMLElement; item: Item; text: string; right: boolean };

function MessagePopup({ popup, close, selectText, closing }: { popup: Popup; close: () => void; selectText: () => void; closing: boolean }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; above: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = popup.anchor;
    const oldStyle = el.getAttribute("style");
    el.classList.remove("message-press");
    el.style.transition = "none";
    el.style.transform = "none";
    const box = el.getBoundingClientRect();
    const pos = menuPosition(box, { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight }, popup.right, actionsFor(popup.item.kind).length);
    const placeholder = document.createElement("div");
    const computed = getComputedStyle(el);
    const { padding, backgroundColor, border } = computed;
    placeholder.style.cssText = `width:${box.width}px;height:${box.height}px;flex:none;box-sizing:border-box;margin:${computed.margin};align-self:${computed.alignSelf}`;
    el.before(placeholder);
    el.classList.add("message-lifted");
    el.setAttribute("popover", "manual");
    Object.assign(el.style, { position: "fixed", left: `${box.left}px`, top: `${pos.bubbleTop}px`, width: `${box.width}px`, maxWidth: `${box.width}px`, margin: "0", padding, backgroundColor, border, maxHeight: pos.maxHeight === undefined ? "none" : `${pos.maxHeight}px`, overflow: pos.maxHeight === undefined ? "visible" : "hidden" });
    if (pos.maxHeight !== undefined) el.classList.add("message-clipped");
    el.showPopover();
    el.style.removeProperty("transform");
    el.style.removeProperty("transition");
    setPosition({ top: pos.top, left: pos.left, above: pos.top < pos.bubbleTop });
    const backdrop = (event: PointerEvent) => {
      if (event.target !== el) return;
      const r = el.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) { event.stopPropagation(); close(); }
    };
    el.addEventListener("pointerdown", backdrop);
    return () => {
      el.removeEventListener("pointerdown", backdrop);
      if (el.matches(":popover-open")) el.hidePopover();
      el.removeAttribute("popover");
      el.classList.remove("message-lifted", "message-clipped", "message-closing");
      if (oldStyle === null) el.removeAttribute("style"); else el.setAttribute("style", oldStyle);
      placeholder.remove();
    };
  }, [popup, close]);
  useLayoutEffect(() => { popup.anchor.classList.toggle("message-closing", closing); }, [popup, closing]);
  useLayoutEffect(() => { if (position) menu.current?.showPopover(); }, [position]);
  if (!position) return null;
  const run = (action: string) => {
    if (action === "reply") { setQuote({ itemId: popup.item.id, text: plain(popup.text).slice(0, 60) }); focusComposer(); close(); }
    if (action === "copy") void copyText(popup.text).then((ok) => { if (!ok) setNotice(t("复制失败：浏览器不允许写入剪贴板")); close(); });
    if (action === "select") selectText();
    if (action === "job" && popup.item.kind === "job") { openJob(popup.item.jobId); close(); }
  };
  return createPortal(<div ref={menu} popover="manual" className={`message-popup-menu${popup.right ? " right" : ""}${position.above ? " above" : ""}${closing ? " closing" : ""}`} style={{ top: position.top, left: position.left }} onPointerDown={(event) => {
    if (event.target !== event.currentTarget) return;
    const r = event.currentTarget.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
  }}>
    {actionsFor(popup.item.kind).map((action) => <button key={action} onClick={() => run(action)}>
      <span>{action === "reply" ? t("回复") : action === "copy" ? t("复制") : action === "select" ? t("选择文字") : t("查看任务详情")}</span>
      <Icon name={action === "reply" ? "reply" : action === "copy" ? "copy" : action === "select" ? "textSelect" : "chev"} size={17} />
    </button>)}
  </div>, document.body);
}

function jumpToQuote(event: React.MouseEvent<HTMLElement>, itemId: string) {
  const list = event.currentTarget.closest(".col");
  const target = [...(list?.querySelectorAll<HTMLElement>(".message-row[data-item-id]") ?? [])].find((row) => row.dataset.itemId === itemId);
  if (target) flashItem(target.classList.contains("message-card-gesture") ? target.querySelector<HTMLElement>(".jobcard, .q, .igen, .filecard, .imgcard, .media-audio, .media-video") ?? target : target);
}

/** 每条消息工具行的状态。 */
type ToolsState = { start?: (event: React.PointerEvent) => void; touch: boolean; distance: number; ready: boolean };

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
  const [sending, setSending] = useState(false);
  const sendReply = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    const ok = await replyJob(job.id, value);
    setSending(false);
    if (ok) { setText(""); setReplying(false); }
  };
  const [swapped, setSwapped] = useState(false); // 状态刚变过：图标播淡出／弹一下
  const reply = useLeave(replying, 200);
  const running = job.status === "running";
  const canReply = !past && (running || job.status === "waiting");
  const bad = job.status === "stuck" || job.status === "failed";
  const reason = jobReason(job);
  const owner = s.assistants.find((a) => a.id === job.assistantId);

  // 沉淀状态：每一轮显示自己那一份；沉淀被接着说停下时这一行淡出
  const kept = useRef<SedimentStatus | undefined>(undefined);
  if (job.sediment) kept.current = job.sediment;
  const sedimentLeave = useLeave(!!job.sediment, 200);
  const sediment = sedimentLeave.mounted ? (job.sediment ?? kept.current) : undefined;

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
            <StatusTag meta={jobStatusMeta(job, s.jobs)} card animated swapped={swapped}>
              {running ? ` · ${fmtElapsed(job.startedAt ?? job.createdAt)}` : took(job) ? ` · ${t("用时 {duration}", { duration: took(job)! })}` : null}
            </StatusTag>
          </span>
        </div>
        {/* 任务在跑、有待办时：标题下面一块浅底，写做到哪儿了 */}
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
                {t("补充要求")}
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
                {t("停止")}
              </button>
            ) : null}
          </div>
        ) : null}
        {reply.mounted ? (
          <div className={`replywrap${reply.leaving ? " leaving" : ""}`} onClick={(event) => event.stopPropagation()}>
            <div className="replyclip">
              <ReplyInput value={text} onChange={setText} sending={sending} placeholder={t("补充说明或更正方向")} onSend={sendReply} onCancel={() => setReplying(false)} autoFocus />
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
            <div className="ds">{draft.status === "created" ? t("新助手 · 已创建") : t("新助手 · 草稿")}</div>
          </div>
        </div>
        <div className="kv">
          <span className="k">{t("职责")}</span>
          <span>{draft.dutyLong}</span>
        </div>
        <div className={`expand${created ? "" : " open"}`} inert={Boolean(created)}>
          <div>
            <div className="kv">
              <span className="k">{t("定时任务")}</span>
              <span className={draft.routinesText ? undefined : "none"}>{draft.routinesText || t("没有")}</span>
            </div>
            <div className="kv">
              <span className="k">{t("执行前确认")}</span>
              <span className={draft.askFirst.length ? undefined : "none"}>{draft.askFirst.join(" · ") || t("没有")}</span>
            </div>
          </div>
        </div>
        <div className="acts swap" style={{ marginTop: 12 }}>
          <div className={created ? "off" : undefined}>
            <button className="hob-btn hob-btn-primary" onClick={() => void createDraft(draft.id)}>
              {t("创建")}
            </button>
            <button
              className="hob-btn"
              onClick={() => {
                setText(t("请修改草稿："));
                focusComposer();
              }}
            >
              {t("修改草稿")}
            </button>
          </div>
          <div className={created ? undefined : "off"}>
            <button className="hob-btn hob-btn-primary" disabled={archived} onClick={() => void select(draft.createdAssistantId!)}>
              {archived ? t("已归档") : t("已创建 · 查看")}
            </button>
          </div>
        </div>
    </div>
  );
}

function DelegationCard({ delegation, fresh }: { delegation: Delegation; fresh: boolean }) {
  const s = useApp();
  const previousStatus = useRef(delegation.status);
  const changed = previousStatus.current !== delegation.status;
  useEffect(() => { previousStatus.current = delegation.status; }, [delegation.status]);
  const target = s.assistants.find((a) => a.id === delegation.to);
  const name = target?.name ?? delegation.to;
  const approvals = Object.values(s.approvals).filter((approval) => approval.status === "pending" && (delegation.approvalIds ?? []).includes(approval.id) && approval.source !== "job");
  return (
    <div className={`hov${fresh ? " enter" : ""}`} id={`delegation-${delegation.id}`}>
      {/* 整张卡点进接手的助手（和任务卡一样整张可点、悬停整张变底色）；里面的任务行、提问、按钮各管各的 */}
      <div
        className="b jobcard delegation-card"
        role="button"
        tabIndex={0}
        title={t("打开「{name}」", { name })}
        onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input, textarea, a, .b.q")) void jumpToDelegation(delegation.to, delegation.id, true); }}
        onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); void jumpToDelegation(delegation.to, delegation.id, true); } }}
      >
        <div className="tt">
          {target ? <span className="jav"><Avatar sprite={target.sprite} prop={target.prop} size={40} /></span> : null}
          <span className="jt">{t("交给「{name}」", { name })}</span>
          <span key={delegation.status} className={changed ? "status-fade" : undefined}><StatusTag meta={DELEGATION_STATUS[delegation.status]} card /></span>
        </div>
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
        {delegation.status === "interrupted" ? (
          <div className="delegation-actions">
            <button onClick={() => void retryDelegation(delegation.id)}>{t("重新转交")}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QuestionCard({ approval, fresh }: { approval: Approval; fresh: boolean }) {
  return approval.login ? <LoginCard approval={approval} fresh={fresh} /> : approval.questions?.length ? <MultiQuestionCard approval={approval} fresh={fresh} /> : <SingleQuestionCard approval={approval} fresh={fresh} />;
}

function LoginCard({ approval, fresh }: { approval: Approval; fresh: boolean }) {
  const login = approval.login!;
  const done = approval.status === "answered";
  return (
    <div className={`b q qlogin${fresh ? " enter" : ""}`}>
      <div className="qt">{approval.title}</div>
      <div className="qs">{t("网站：{site}", { site: login.site })}</div>
      <div className="qs">{login.reason}</div>
      {approval.status === "expired" ? <div className="opts"><div className="opt">{t("已结束")}</div></div> : done ? <div className="opts"><div className="opt chosen"><Icon name="check" size={15} />{t("已完成")}</div></div> : (
        <div className="qfoot qacts">
          <button className="hob-btn hob-btn-primary" onClick={() => openLoginDesktop(approval.id, approval.assistantId)}>
            <Icon name="pointer" size={14} />{t("去登录")}
          </button>
        </div>
      )}
    </div>
  );
}

/** 一张卡问几个问题：每个问题选一项或自己写一句，一次提交。要补充的写进那个问题的「自己写」，卡上不另设补充框。 */
function MultiQuestionCard({ approval, fresh }: { approval: Approval; fresh: boolean }) {
  const questions = approval.questions ?? [];
  const previousStatus = useRef(approval.status);
  const changed = previousStatus.current !== approval.status;
  useEffect(() => { previousStatus.current = approval.status; }, [approval.status]);
  // 推荐的那项默认选中；自己写了字就不算选项
  const [picks, setPicks] = useState<(ApprovalOption["key"] | null)[]>(() => questions.map((question) => question.recommended ?? null));
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ""));
  const [writing, setWriting] = useState<boolean[]>(() => questions.map(() => false));
  const done = approval.status === "answered";
  const answers = approval.answers ?? [];
  const filled = questions.every((_, index) => Boolean(typed[index]?.trim() || picks[index]));
  const submit = () => {
    if (!filled) return;
    void answer(approval.id, {
      answers: questions.map((_, index) => (typed[index].trim() ? { text: typed[index].trim() } : { key: picks[index]! })),
    });
  };
  const pickAt = (index: number, key: ApprovalOption["key"]) =>
    setPicks((current) => current.map((item, i) => (i === index ? key : item)));
  const typeAt = (index: number, text: string) =>
    setTyped((current) => current.map((item, i) => (i === index ? text : item)));
  const writeAt = (index: number) =>
    setWriting((current) => current.map((item, i) => (i === index ? true : item)));
  return (
    <div className={`b q qmulti${fresh ? " enter" : ""}`}>
      <div className="qt">{approval.title}</div>
      {approval.detail ? <div className="qs">{approval.detail}</div> : null}
      {approval.status === "expired" ? (
        <div className="opts">
          <div className={`opt${changed ? " status-fade" : ""}`}>{t("已结束")}</div>
        </div>
      ) : null}
      {approval.status === "expired" ? null : questions.map((question, index) => {
        const reply = answers[index];
        const picked = reply?.key ? question.options.find((option) => option.key === reply.key) : undefined;
        const missRecommended = Boolean(picked && question.recommended && question.recommended !== picked.key);
        return (
          <div className="qitem" key={index}>
            <div className="qt qmt">
              <span className="qnum">{index + 1}</span>
              <span>{question.title}</span>
            </div>
            {question.why ? <div className="qs">{question.why}</div> : null}
            {done ? (
              reply ? (
                <div className="opts">
                  <div className="opt chosen">
                    <span className="key">{picked ? picked.key : <Icon name="user" size={12} />}</span>
                    <span className="olabel">{picked ? picked.label : reply.text}</span>
                    <span className={`ck${changed ? " check-enter" : ""}`}>
                      <Icon name="check" size={16} />
                    </span>
                  </div>
                </div>
              ) : null
            ) : (
              <div className="opts">
                {question.options.map((option) => {
                  const sel = !typed[index].trim() && picks[index] === option.key;
                  return (
                    <button
                      className={`opt${sel ? " chosen" : ""}`}
                      key={option.key}
                      onClick={() => pickAt(index, option.key)}
                    >
                      <span className="key">{option.key}</span>
                      <span className="olabel">{option.label}</span>
                      {option.key === question.recommended ? <span className="rec">{t("推荐")}</span> : null}
                      {sel ? (
                        <span className="ck">
                          <Icon name="check" size={16} />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {writing[index] ? (
                  <div className="other">
                    <input
                      value={typed[index]}
                      placeholder={t("自己写这个问题的答案")}
                      autoFocus
                      onChange={(event) => typeAt(index, event.target.value)}
                    />
                  </div>
                ) : (
                  <button className="opt qwrite" onClick={() => writeAt(index)}>
                    <span className="key">
                      <Icon name="edit" size={12} />
                    </span>
                    {t("自己写")}
                  </button>
                )}
              </div>
            )}
            {missRecommended
              ? <div className="qs qrec">{t("推荐的是 {key}：{label}", { key: question.recommended!, label: question.options.find((option) => option.key === question.recommended)?.label ?? "" })}</div>
              : null}
          </div>
        );
      })}
      {done ? (
        approval.answerText ? <div className="qs qnote">{t("补充：{text}", { text: approval.answerText })}</div> : null
      ) : null}
      {done || approval.status === "expired" ? null : (
        <div className="qfoot qacts">
          <button className="hob-btn hob-btn-primary" disabled={!filled} onClick={submit}>
            {t("提交")}
          </button>
        </div>
      )}
    </div>
  );
}

function SingleQuestionCard({ approval, fresh }: { approval: Approval; fresh: boolean }) {
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
          <div className={`opt${changed ? " status-fade" : ""}`}>{t("已结束")}</div>
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
                      void answer(approval.id, { key: o.key }).then((ok) => { if (!ok) setPicked(null); });
                    }}
                  >
                    <span className="key">{o.key}</span>
                    <span className="olabel">{o.label}</span>
                    {o.key === approval.recommended ? <span className="rec">{t("推荐")}</span> : null}
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
              placeholder={t("其他想法…")}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) send();
              }}
            />
            {typed ? (
              <button className="hob-icon-btn other-send" title={t("发送")} onClick={send}>
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

/** 综合时间线里的话题卡：内容从群列表里这条话题的摘要实时取，话题有变化卡片原地更新。 */
export function TopicCard({ topicId, fresh, itemId }: { topicId: string; fresh: boolean; itemId: string }) {
  const s = useApp();
  const g = s.groups.find((item) => item.id === topicId);
  if (!g) {
    return (
      <div className={`hov${fresh ? " enter" : ""}`} data-item-id={itemId}>
        <div className="b topiccard gone">{t("话题已不存在")}</div>
      </div>
    );
  }
  const face = s.assistants.find((a) => a.id === topicFace(g));
  const open = () => void selectGroup(g.id);
  return (
    <div className={`hov${fresh ? " enter" : ""}`} data-item-id={itemId}>
      <div className="b topiccard" role="button" tabIndex={0} onClick={open} onKeyDown={(event) => { if (event.key === "Enter") open(); }}>
        <div className="tt">
          {face ? <span className="jav"><Avatar sprite={face.sprite} prop={face.prop} size={40} /></span> : null}
          <span className="jt">{g.name}</span>
          {g.closedAt ? <StatusTag meta={{ text: t("已关闭"), icon: "archive", color: "", spin: false }} card /> : <button className="topic-enter" onClick={(event) => { event.stopPropagation(); open(); }}>{t("进入话题")} <Icon name="chev" size={13} /></button>}
        </div>
        {/* 关了的：右上角已经标了「已关闭」，这里只写关闭时留的话 */}
        {g.closedAt
          ? g.closeNote ? <div className="topic-line"><span>{g.closeNote}</span></div> : null
          : <div className="topic-line"><span>{spokenPreview(g, s.assistants)}</span></div>}
      </div>
    </div>
  );
}

function ItemView({
  item,
  inlineDraft,
  fresh,
  tools,
  mentions,
  quoteWho,
  forwarded,
}: {
  item: Item;
  inlineDraft?: Draft;
  fresh: boolean;
  tools: ToolsState;
  /** 群里的成员名字：消息里的 @名字 标成强调色 */
  mentions?: string[];
  /** 群里的引用：被引用的那句是谁说的 */
  quoteWho?: (itemId: string) => string | undefined;
  /** 从综合转进话题的用户消息：气泡上方加一行小字 */
  forwarded?: GroupItem["forwardedFrom"];
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
    const pend = pendingOf(s, pendingKeyOf(s), item.id);
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
          <button className="send-failed" title={t("重试")} aria-label={t("未送达，重试")} onClick={() => retryPending(pend)}>!</button>
        ) : pend && item.files?.length ? (
          <span className="send-progress" aria-label={t("正在发送")}><Icon name="spin" size={16} w={2.2} className="spin" /></span>
        ) : null}
        <div className={`hov right msg${fresh ? " enter-right" : ""}${pend ? " pending" : ""}`}>
        {forwarded ? <div className="forwarded-line">{forwarded && "assistantId" in forwarded ? (() => { const sender = s.assistants.find((a) => a.id === forwarded.assistantId); return t("从和「{name}」的对话转来", { name: sender?.name ?? forwarded.assistantId }); })() : t("从综合转来")}</div> : null}
        {album ? (
          <div className={`u-album${albumOpen ? " open" : ""}`} ref={hasBubble ? undefined : bubble} style={hasBubble ? undefined : swipeStyle}>
            <button className="album-pill" onClick={() => setAlbumOpen(!albumOpen)}>{albumOpen ? t("收起") : t("展开 {n}", { n: photos.length })}</button>
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
          {item.from ? <button className="forward-label" onClick={() => void (item.from!.delegationId.startsWith("dg-") ? jumpToDelegation(item.from!.assistantId, item.from!.delegationId, false) : jumpToHandback(item.from!.assistantId, item.from!.delegationId, false))}>{(() => { const sender = s.assistants.find((a) => a.id === item.from!.assistantId); return sender ? <Avatar sprite={sender.sprite} prop={sender.prop} size={16} /> : null; })()}{t("转自 {name}", { name: item.from.name })}</button> : null}
          {item.quote ? <button className={`quote${quoteWho?.(item.quote.itemId) ? " named" : ""}`} onClick={(event) => jumpToQuote(event, item.quote!.itemId)}>{quoteWho?.(item.quote.itemId) ? t("{name}：", { name: quoteWho(item.quote.itemId)! }) : ""}{item.quote.text}</button> : null}
          {/* 其他附件是气泡里的一行文件卡 */}
          {item.text ? <span className={`u-text${item.from ? " u-brief" : ""}`}>{item.from ? <Brief text={item.text} /> : item.text}</span> : null}
          {others.map((f) => (f.startsWith("pending/") ? <Fragment key={f}>{fileRow(f)}</Fragment> : <MediaCard key={f} path={f} name={attachmentName(f)} fallback={fileRow(f)} />))}
        </div>
        ) : null}
        {pend?.status === "failed" ? (
          <div className="send-status">
            {t("未送达")}
            <button onClick={() => retryPending(pend)}>{t("重试")}</button>
            <button onClick={() => discardPending(pend)}>{t("删除")}</button>
          </div>
        ) : null}
        {pend ? null : <Tools text={item.text} itemId={item.id} />}
        </div>
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
                {i === 0 && item.quote ? <button className={`quote${quoteWho?.(item.quote.itemId) ? " named" : ""}`} onClick={(event) => jumpToQuote(event, item.quote!.itemId)}>{quoteWho?.(item.quote.itemId) ? t("{name}：", { name: quoteWho(item.quote.itemId)! }) : ""}{item.quote.text}</button> : null}
                <Markdown text={part.md} streaming={item.streaming && i === parts.length - 1} mentions={mentions} />
                {inlineDraft && i === parts.length - 1 ? <DraftCard draft={inlineDraft} /> : null}
              </div>
            ),
          )}
          <Tools text={item.text} itemId={item.id} />
          </div>
        </div>
      </>
    );
  }

  if (item.kind === "note") {
    // 定时任务到执行时间：只写一行。老记录里带着检查到的原始内容，那是给群主的材料，不显示
    if (item.icon === "routine" && isRoutineDueNote(item.text, item.routineId)) {
      return <div className={`sys routine-note${fresh ? " enter-fade" : ""}`}><Icon name="clock" size={14} /><span>{item.text.replace(/，检查到：[\s\S]*$/u, "")}</span></div>;
    }
    // 带原因的（工具没办成）：点开看工具报错的原文
    if (item.detail) {
      return (
        <div className={`sys sys-why${fresh ? " enter-fade" : ""}`}>
          {item.icon !== "split" ? <Icon name={NOTE_ICON[item.icon]} size={14} /> : null}
          <details>
            <summary>{item.text}</summary>
            <div className="why">{item.detail}</div>
          </details>
        </div>
      );
    }
    return (
      <div className={`sys${fresh ? " enter-fade" : ""}`} id={item.handbackId ? `handback-${item.handbackId}` : undefined}>
        {item.targetGroupId && !item.handbackId && !(item.icon === "skill" && item.path) ? <button className="sys-group" onClick={() => void openNoteGroup(item.targetGroupId!)}>{item.icon !== "split" ? <Icon name={NOTE_ICON[item.icon]} size={14} /> : null}{item.text}</button> : <>
          {item.icon !== "split" ? <Icon name={NOTE_ICON[item.icon]} size={14} /> : null}
          {item.handbackId ? <button onClick={() => void jumpToHandback("hob", item.handbackId!, true)}>{item.text}</button> : item.icon === "skill" && item.path ? <button onClick={() => openFilePreview(item.path!)}>{item.text}</button> : item.icon === "memory" ? <span className="sys-memory" title={item.text}>{item.text.replace(/[:：,，;；、]+\s*$/u, "")}</span> : item.text}
        </>}
      </div>
    );
  }

  // 老数据里收起的那几条待办：对话里只放用户需要看的，这些不再显示
  if (item.kind === "todos") return null;

  if (item.kind === "question") {
    const ap = s.approvals[item.approvalId];
    return ap ? <div id={`approval-${ap.id}`} data-item-id={item.id}><QuestionCard approval={ap} fresh={fresh} /></div> : null;
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

  if (item.kind === "topic") return <TopicCard topicId={item.topicId} fresh={fresh} itemId={item.id} />;

  if (item.kind === "image") return <ImageGenCard {...item} fresh={fresh} itemId={item.id} />;

  if (item.kind !== "file") return null;
  // 老数据里可能有一条没存 path 的文件条目：只显示名字，不进预览，避免 path.lastIndexOf 抛异常把整页带白。
  if (!item.path) {
    return (
      <div className={`att filecard${fresh ? " enter" : ""}`} data-item-id={item.id} title={t("文件路径缺失，无法预览")}>
        <span className="ico">
          <Icon name="file" size={18} />
        </span>
        <span>
          <span className="n" style={{ display: "block" }}>
            {item.name || t("文件")}
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

function GestureCard({ item, tools, children }: { item: Item; tools: ToolsState; children: ReactNode }) {
  if (!tools.touch || !["job", "question", "image", "file"].includes(item.kind)) return children;
  return <div className="message-row message-card-gesture" data-item-id={item.id} onPointerDown={tools.start} onContextMenu={(event) => event.preventDefault()}>{children}</div>;
}

/** 同一次回复里的几条贴着（只有气泡自己的 4px），换一方说话或开新的一组（lead）才拉开。 */
function opensGroup(prev: Item | undefined, cur: Item): boolean {
  if (!prev) return false;
  return (prev.kind === "user") !== (cur.kind === "user") || Boolean(cur.lead);
}

/**
 * 消息上的指针手势：触屏长按出菜单、左滑回复（桌面上没有这两样，悬停就有工具行）。
 * 单聊的列表和群里的时间线共用这一份。
 */
function useItemGestures() {
  const touch = useNoHover();
  const s = useApp();
  const [popup, setPopup] = useState<Popup | null>(null);
  const popupRef = useRef(popup);
  popupRef.current = popup;
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef(0);
  const [selected, setSelected] = useState<HTMLElement | null>(null);
  const press = useRef<{ timer: number; pointerId: number; item: Item; text: string; anchor: HTMLElement; swipe: SwipeState; ready: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [swipe, setSwipe] = useState<{ id: string; distance: number; ready: boolean } | null>(null);
  const close = useCallback(() => {
    setClosing(true);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => { setPopup(null); setClosing(false); }, 180);
  }, []);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  useEffect(() => {
    const cancel = () => {
      if (press.current) { window.clearTimeout(press.current.timer); press.current.anchor.classList.remove("message-press"); }
      press.current = null;
      setSwipe(null);
    };
    const down = (event: PointerEvent) => {
      if (popupRef.current && event.target instanceof Element && !event.target.closest(".message-popup-menu") && !popupRef.current.anchor.contains(event.target)) {
        suppressClick.current = true;
        window.setTimeout(() => { suppressClick.current = false; }, 1000);
        close();
      }
      if (selected && event.target instanceof Node && !selected.contains(event.target)) { selected.classList.remove("message-selecting"); window.getSelection()?.removeAllRanges(); setSelected(null); }
    };
    const move = (event: PointerEvent) => {
      const p = press.current;
      if (!p || p.pointerId !== event.pointerId) return;
      p.swipe = moveSwipe(p.swipe, event.clientX, event.clientY);
      if (Math.hypot(event.clientX - p.swipe.x, event.clientY - p.swipe.y) > 10) { window.clearTimeout(p.timer); p.anchor.classList.remove("message-press"); }
      if (p.swipe.direction === "vertical") { cancel(); return; }
      if (p.swipe.direction !== "horizontal") return;
      window.clearTimeout(p.timer);
      const ready = swipeReply(p.swipe);
      if (ready && !p.ready) navigator.vibrate?.(10);
      p.ready = ready;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        if (ready) { setQuote({ itemId: p.item.id, text: plain(p.text).slice(0, 60) }); focusComposer(); cancel(); }
        return;
      }
      setSwipe({ id: p.item.id, distance: p.swipe.distance, ready });
    };
    const up = (event: PointerEvent) => {
      const p = press.current;
      if (!p || p.pointerId !== event.pointerId) return;
      if (swipeReply(p.swipe)) { setQuote({ itemId: p.item.id, text: plain(p.text).slice(0, 60) }); focusComposer(); }
      cancel();
    };
    const scroll = () => { cancel(); if (popupRef.current) close(); if (selected) { selected.classList.remove("message-selecting"); window.getSelection()?.removeAllRanges(); setSelected(null); } };
    const click = (event: MouseEvent) => { if (suppressClick.current && event.target instanceof Element && !event.target.closest(".message-popup-menu")) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("click", click, true);
    return () => {
      cancel();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("click", click, true);
    };
  }, [close, selected]);
  const toolsFor = (item: Item | GroupItem): ToolsState => {
    const text = item.kind === "job" ? s.jobs[item.jobId]?.title ?? "" : item.kind === "question" ? s.approvals[item.approvalId]?.title ?? "" : item.kind === "image" ? t("图片") : item.kind === "file" ? item.name : "text" in item ? item.text : "";
    return {
      touch,
      distance: swipe?.id === item.id ? swipe.distance : 0,
      ready: swipe?.id === item.id && swipe.ready,
      start: touch ? (event) => {
        if (event.pointerType !== "touch" || !actionsFor(item.kind).length) return;
        const target = event.target as Element;
        const interactive = target.closest("a,button,input,textarea,select,[contenteditable],.draft,.album-stack");
        const cardRoot = interactive && (interactive.matches(".filecard,.imgcard,.igen-img") && (item.kind === "file" || item.kind === "image"));
        if (interactive && !cardRoot) return;
        const row = event.currentTarget as HTMLElement;
        const anchor = target.closest<HTMLElement>(".u,.b,.tablecard,.igen,.filecard,.imgcard,.media-audio,.media-video") ?? row.querySelector<HTMLElement>(".u,.b,.tablecard,.igen,.filecard,.imgcard,.media-audio,.media-video");
        if (!anchor || selected === anchor) return;
        if (press.current) { window.clearTimeout(press.current.timer); press.current.anchor.classList.remove("message-press"); }
        anchor.classList.add("message-press");
        const { clientX: x, clientY: y, pointerId } = event;
        const timer = window.setTimeout(() => {
          press.current = null;
          suppressClick.current = true;
          window.setTimeout(() => { suppressClick.current = false; }, 1000);
          navigator.vibrate?.(10);
          window.clearTimeout(closeTimer.current);
          setClosing(false);
          setPopup({ anchor, item, text, right: item.kind === "user" });
        }, 400);
        press.current = { timer, pointerId, item, text, anchor, swipe: { x, y, direction: "pending", distance: 0 }, ready: false };
      } : undefined,
    };
  };
  const selectText = () => {
    if (!popup) return;
    const el = popup.anchor;
    close();
    window.setTimeout(() => {
      el.classList.add("message-selecting");
      const range = document.createRange();
      range.selectNodeContents(el.querySelector(".u-text, .markdown") ?? el);
      const selection = window.getSelection();
      selection?.removeAllRanges(); selection?.addRange(range);
      setSelected(el);
    }, 200);
  };
  return { toolsFor, popup: popup ? <MessagePopup popup={popup} close={close} selectText={selectText} closing={closing} /> : null };
}

/**
 * 对话里只放用户要看的：记忆写入、技能沉淀和改版这类记录只给模型和设置页（老数据里还有，这里滤掉）；
 * 同一个任务续做了几轮，只留最新一轮那张卡，前几轮在任务详情里切换着看。
 */
export function visibleItems<T extends Item>(items: T[]): T[] {
  const latest = new Map<string, number>();
  for (const item of items) if (item.kind === "job") latest.set(item.jobId, Math.max(latest.get(item.jobId) ?? 0, item.round ?? 0));
  return items.filter((item) => {
    if (item.kind === "note") return item.icon !== "memory" && !(item.icon === "skill" && item.path);
    if (item.kind === "job") return (item.round ?? 0) === latest.get(item.jobId);
    return true;
  });
}

export function ItemList({ items: all }: { items: Item[] }) {
  const s = useApp();
  const items = visibleItems(all);
  const { toolsFor, popup } = useItemGestures();
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
    if (inline) i++;
    rows.push(
      <Fragment key={item.id}>
        {needDivider(prev?.at, item.at) ? (
          <div className={`div${fresh ? " enter-fade" : ""}`}>{fmtWhen(item.at)}</div>
        ) : opensGroup(prev, item) ? (
          <div className="g" />
        ) : null}
        <GestureCard item={item} tools={toolsFor(item)}><ItemView item={item} inlineDraft={inline} fresh={fresh} tools={toolsFor(item)} /></GestureCard>
      </Fragment>,
    );
  }
  for (const page of visibleLiveCards(Object.values(s.livePages), s.sel)) {
    rows.push(<button key={page.callId} className={`att filecard${page.state === "failed" ? " bad" : ""}`} onClick={() => openLivePreview(page.callId)}>
      <span className="ico"><Icon name={page.state === "writing" ? "spin" : "close"} className={page.state === "writing" ? "spin" : ""} size={18} /></span>
      <span><span className="n" style={{ display: "block" }}>{page.title || t("正在生成页面…")}</span><span className="m">{page.state === "failed" ? t("生成失败：{error}", { error: page.error ?? "" }) : t("生成中")}</span></span>
    </button>);
  }
  return <>{rows}{popup}</>;
}

/**
 * 群里的时间线：同一个成员连着说的合成一段（左边头像，上面一行名字、群主标签和时间，内容缩进）。
 * 你的消息照旧在右边，系统条目居中。
 */
export function GroupItemList({ g, items: all }: { g: GroupSummary; items: GroupItem[] }) {
  const s = useApp();
  const items = visibleItems(all);
  const { toolsFor, popup } = useItemGestures();
  const members = membersOf(g, s.assistants);
  const names = members.map((m) => m.name);
  const nameOf = (speaker: string | "user") =>
    speaker === "user" ? t("你") : (s.assistants.find((a) => a.id === speaker)?.name ?? speaker);
  /** 引用的是谁说的：气泡上写成「名字：内容」 */
  const quoteWho = (itemId: string) => {
    const quoted = items.find((entry) => entry.id === itemId);
    return quoted ? nameOf(quoted.speaker) : undefined;
  };
  const rows: ReactNode[] = [];
  if (items.length && !isToday(items[0].at)) rows.push(<div className="div" key="first-div">{fmtWhen(items[0].at)}</div>);
  let previous: GroupItem | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const fresh = isFresh(item.id);
    const divider = needDivider(previous?.at, item.at) ? <div className={`div${fresh ? " enter-fade" : ""}`}>{fmtWhen(item.at)}</div> : null;
    // 你的消息、系统条目各自一行，不参与分段
    if (item.kind === "user" || item.kind === "note" || item.speaker === "user") {
      previous = item;
      rows.push(
        <Fragment key={item.id}>
          {divider}
          <GestureCard item={item} tools={toolsFor(item)}><ItemView item={item} fresh={fresh} tools={toolsFor(item)} mentions={names} quoteWho={quoteWho} forwarded={item.forwardedFrom} /></GestureCard>
        </Fragment>,
      );
      continue;
    }
    const run: GroupItem[] = [item];
    while (items[i + 1] && items[i + 1].speaker === item.speaker && items[i + 1].kind !== "note" && items[i + 1].kind !== "user") run.push(items[++i]);
    previous = run[run.length - 1];
    const speaker = members.find((m) => m.id === item.speaker);
    rows.push(
      <Fragment key={item.id}>
        {divider}
        <div className="gblock">
          <div className="gblock-av">{speaker ? <Avatar sprite={speaker.sprite} prop={speaker.prop} size={30} /> : null}</div>
          <div className="gblock-main">
            <div className="gblock-name">
              {speaker?.name ?? item.speaker}
              {item.speaker === g.ownerId ? <span className="owner">{t("群主")}</span> : null}
              <small>{fmtList(item.at)}</small>
            </div>
            {run.map((entry) => (
              <GestureCard key={entry.id} item={entry} tools={toolsFor(entry)}><ItemView item={entry} fresh={isFresh(entry.id)} tools={toolsFor(entry)} mentions={names} quoteWho={quoteWho} /></GestureCard>
            ))}
          </div>
        </div>
      </Fragment>,
    );
  }
  return <>{rows}{popup}</>;
}
