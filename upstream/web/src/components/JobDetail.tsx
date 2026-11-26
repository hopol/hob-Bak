// 任务详情（桌面右侧宽抽屉 / 手机全屏）和任务记录（全部任务）。
import { t } from "../../../shared/i18n.ts";
import { Select } from "./Select.tsx";
import { DelayedText, Empty } from "./Empty.tsx";
import { Suspense, lazy, memo, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Job, JobFilesView, JobStatus, JobStep, ModelInfo } from "../../../shared/types.ts";
import { Icon, type IconName } from "../icons.tsx";
import { fileIcon } from "../file-icons.ts";
import { Avatar } from "../sprites.tsx";
import { useLeave } from "../motion.ts";
import { diffLines, groupThinking, jobDetailRounds, jobReason, titleParts, visibleSteps, type StepRow } from "../steps.ts";
import {
  closePanelPages,
  fetchFileMeta,
  loadJobFiles,
  loadModels,
  loadWorklog,
  moreWorklog,
  openFilePreview,
  openJob,
  replyJob,
  select,
  selectGroup,
  sedimentJob,
  togglePreviewFull,
  stopJob,
  useApp,
  type PanelPage,
} from "../store.ts";
import { fmtBytes, fmtDuration, fmtElapsed, fmtTokens, fmtWhen } from "../util.ts";
import { Markdown } from "./Markdown.tsx";
import { PanelHead } from "./PanelHead.tsx";
import { Brief } from "./Brief.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { useDesktopScreens } from "../desktop-screens.ts";
import { JOB_STATUS, StatusTag, jobStatusIcon, jobStatusMeta, sedimentText } from "./status-meta.tsx";
const DesktopScreen = lazy(() => import("./DesktopView.tsx").then((module) => ({ default: module.DesktopView })));


function thinkingLabel(level: string): string {
  const labels: Record<string, string> = {
    off: t("关"),
    minimal: t("最低"),
    low: t("低"),
    medium: t("中"),
    high: t("高"),
    xhigh: t("很高"),
    max: t("最高"),
  };
  return labels[level] ?? level;
}

const FILTER_STATUS: JobStatus[] = ["running", "waiting", "queued", "done", "stuck", "failed", "stopped"];

/** 工具图标：每一步都有，时间线的文字才排得齐；不认识的工具用省略号。 */
const TOOL_ICON: Record<string, IconName> = {
  bash: "term",
  overview: "clock",
  generate_image: "image",
  read: "doc",
  write: "edit",
  edit: "edit",
  ls: "doc",
  grep: "search",
  find: "search",
  report: "rule",
  ask_user: "info",
};

/** 是不是还在跑（详情里的“补充/停止”只在这时给）。 */
function active(job: Job): boolean {
  return job.status === "running" || job.status === "queued" || job.status === "waiting";
}

/** 桌面主界面嵌入右栏；手机和设置页保留全屏 / 覆盖层。 */
export function JobOverlay({ embedded = false, page }: { embedded?: boolean; page?: PanelPage }) {
  const s = useApp();
  const top = page ?? s.panelStack.at(-1);
  const detail = top?.kind === "job" || top?.kind === "jobs" ? top : null;
  const presence = useLeave(Boolean(detail), 180);
  const last = useRef(detail);
  if (detail) last.current = detail;

  const shown = detail ?? last.current;
  if (!presence.mounted || !shown) return null;
  return (
    <div className={`${embedded ? "jd-embedded" : "jd-overlay"}${presence.leaving ? " leaving" : ""}`} onClick={embedded ? undefined : closePanelPages}>
      <div className="jd" onClick={(event) => event.stopPropagation()}>
        {shown.kind === "jobs" ? <><PanelHead className="jdhead" title={<span className="t">{t("任务记录")}</span>} close /><WorklogPage /></> : <JobDetail key={`${shown.id}-${shown.round ?? "default"}`} id={shown.id} round={shown.round} jumpApprovalId={shown.jumpApprovalId} />}
      </div>
    </div>
  );
}

function JobDetail({ id, round, jumpApprovalId }: { id: string; round?: number; jumpApprovalId?: string }) {
  const s = useApp();
  const job = s.jobs[id];
  const steps = s.steps[id];
  const body = useRef<HTMLDivElement>(null);
  // 在跑的任务打开时停在最新一步；已结束的从头看（结果排在最前）
  const pinned = useRef(round === undefined && (job ? active(job) : true));
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [showDesktop, setShowDesktop] = useState(false);
  // 查看桌面看的是这个任务所属助手的那块屏幕，不是默认的主助手
  const desktop = useDesktopScreens();
  // 续做过的任务：看第几轮。没点过就跟着最新一轮；从对话里的卡点进来，就是那张卡那一轮
  const [picked, setPicked] = useState(round);

  useEffect(() => {
    void loadModels().then((view) => setModels(view?.models ?? null));
  }, []);

  // 在跑时自动跟到底部；往上翻过就不强拉
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = body.current;
    // 刚补了一句（最后一行是等待读取的补充）：不管翻到哪都拉到底，让人看到它发出去了
    const sent = steps?.[steps.length - 1]?.queued;
    if (el && (pinned.current || sent)) {
      el.scrollTop = el.scrollHeight;
      pinned.current = true;
    }
  }, [steps?.length, steps?.[steps.length - 1]?.id]);

  useEffect(() => {
    if ((!jumpApprovalId && job?.status !== "waiting") || !steps?.length) return;
    const timer = window.setTimeout(() => {
      const target = body.current?.querySelector<HTMLElement>('[data-job-approval="true"]');
      if (target) target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [jumpApprovalId, job?.status, steps?.length]);

  if (!job) {
    return (
      <div className="jdbody">
        <PanelHead className="jdhead" title={<span className="t">{t("任务")}</span>} close />
        <Empty>{t("无法读取这个任务。")}</Empty>
      </div>
    );
  }

  const owner = s.assistants.find((a) => a.id === job.assistantId);
  const group = job.groupId ? s.groups.find((g) => g.id === job.groupId) : undefined;
  const modelName = job.model ? (models?.find((model) => model.ref === job.model)?.name ?? job.model) : "";
  const started = job.startedAt ?? job.createdAt;
  const elapsed = job.durationMs ?? (active(job) ? Date.now() - new Date(started).getTime() : undefined);
  const usage = job.usage;
  const reason = jobReason(job);
  const top = s.panelStack.at(-1);
  const full = top?.kind === "job" && Boolean(top.full);

  return (
    <>
      <PanelHead className="jdhead" title={<span className="t">{t("任务")}</span>} close>
        {job.status === "done" ? <button className="hob-btn hob-btn-compact" disabled={job.sediment?.status === "running"} onClick={() => { void sedimentJob(job.id); }}><Icon name="book" size={14} />{job.sediment?.status === "running" ? t("正在沉淀…") : t("沉淀成技能")}</button> : null}
        {steps?.some((step) => step.name?.startsWith("browser_") || step.name?.startsWith("desktop_")) ? <button className="hob-btn hob-btn-compact" onClick={() => setShowDesktop(true)}><Icon name="pointer" size={14} />{t("查看桌面")}</button> : null}
        <button className="hob-icon-btn fp-act fp-wide-btn" title={t("切换全宽")} onClick={togglePreviewFull}>
          <Icon name={full ? "shrink" : "expand"} size={17} />
        </button>
      </PanelHead>
      <div className="jdbody" ref={body}>
        <div className="jd-title">{job.title}</div>
        <div className="jd-meta">
          <StatusTag meta={jobStatusMeta(job, s.jobs)} />
          {owner || job.assistantName ? (
            <span className="jd-owner">
              {owner ? <Avatar sprite={owner.sprite} prop={owner.prop} size={16} /> : null}
              {owner?.name ?? job.assistantName}
            </span>
          ) : null}
          {job.groupId ? <span>{group ? t("来自「{name}」", { name: group.name }) : t("来自已结束的群")}</span> : null}
          <span>{fmtWhen(started)}</span>
          {elapsed !== undefined ? <span>{t("用时 {duration}", { duration: fmtDuration(elapsed) })}</span> : null}
        </div>
        {job.model || usage ? (
          <div className="jd-meta dim">
            {job.model ? (
              <span className={modelName === job.model ? "mono" : undefined} title={job.model}>
                {modelName}
              </span>
            ) : null}
            {job.thinking ? <span>{t("思考 {level}", { level: thinkingLabel(job.thinking) })}</span> : null}
            {job.modelReason ? <span>{job.modelReason}</span> : null}
            {usage ? (
              <span>
                {t("输入 {input} · 输出 {output}", { input: fmtTokens(usage.input), output: fmtTokens(usage.output) })}
                {usage.cost > 0 ? ` · $${usage.cost.toFixed(4)}` : ""}
              </span>
            ) : null}
          </div>
        ) : null}
        {reason ? <div className="jd-reason">{reason}</div> : null}
        {job.after?.length ? <AfterList ids={job.after} /> : null}
        {job.rounds?.length ? (() => {
          const parts = jobDetailRounds(job, steps);
          const current = Math.min(picked ?? parts.length - 1, parts.length - 1);
          // 轮次多了「第 N 轮」一排放不下：超过 4 轮只写数字，上面一行写「轮次」
          const compact = parts.length > 4;
          return <>
            {compact ? <div className="lbl">{t("轮次")}</div> : null}
            <div className={`seg jd-rounds${compact ? " compact" : ""}`} role="tablist" style={{ "--seg-count": parts.length, "--seg-index": current } as CSSProperties}>
              {parts.map((_, index) => (
                <button key={index} role="tab" aria-selected={index === current} aria-label={t("第 {n} 轮", { n: index + 1 })} className={index === current ? "on" : undefined} onClick={() => setPicked(index)}>
                  {compact ? index + 1 : t("第 {n} 轮", { n: index + 1 })}
                </button>
              ))}
            </div>
            {/* 点了别的轮次才淡入；刚打开这一页时只有整页滑进来 */}
            <div key={current} className={picked !== round ? "jd-round-content" : undefined}><RoundBody part={parts[current]!} last={current === parts.length - 1} index={current} locale={s.locale} /></div>
          </>;
        })() : <>
          <RoundBody part={{ job, instruction: job.instruction, steps }} last index={0} locale={s.locale} />
        </>}
      </div>

      <ReplyBox job={job} />
      {showDesktop ? <Suspense fallback={<div>{t("正在打开云桌面…")}</div>}><DesktopScreen initialScreen={desktop.profiles[job.assistantId] ?? job.assistantId} onClose={() => setShowDesktop(false)} /></Suspense> : null}
    </>
  );
}

/** 要等的任务：等谁做完才开始，点了打开那一个。 */
function AfterList({ ids }: { ids: string[] }) {
  const s = useApp();
  return <>
    <div className="lbl">{t("等待的任务")}</div>
    <div className="jd-files">
      {ids.map((id) => {
        const before = s.jobs[id];
        return <button className="jd-file-row" key={id} onClick={() => openJob(id)}>
          {before ? jobStatusIcon(before.status, 14) : <Icon name="doc" size={14} />}
          <span>{before?.title ?? id}</span>
          <small>{before ? JOB_STATUS[before.status].text : t("找不到")}</small>
        </button>;
      })}
    </div>
  </>;
}

/** 一轮的内容：前面几轮写明那一轮的状态和用时（最后一轮就是头部那个状态）；工作目录只跟在最后一轮下面。 */
type RoundProps = { part: { job: Job; instruction?: string; steps?: JobStep[] }; last: boolean; index: number; locale: string };
const sameSteps = (a?: JobStep[], b?: JobStep[]) => a === b || (!!a && !!b && a.length === b.length && a.every((step, i) => step === b[i]));
/** 长任务有几百步：别处一改状态（回首页、别的任务推进度）整页都会重画，这一轮的任务和步骤没变就不重画 */
const RoundBody = memo(RoundBodyView, (a: RoundProps, b: RoundProps) =>
  a.part.job === b.part.job && a.part.instruction === b.part.instruction && sameSteps(a.part.steps, b.part.steps) && a.last === b.last && a.index === b.index && a.locale === b.locale);

function RoundBodyView({ part, last, index }: RoundProps) {
  const [expanded, setExpanded] = useState(false);
  const sedimentIndex = part.steps?.findIndex((step) => step.from === "user" && step.text === "沉淀技能") ?? -1;
  const timeline = part.steps === undefined ? undefined : groupThinking(sedimentIndex < 0 ? part.steps : part.steps.slice(0, sedimentIndex));
  const sediment = sedimentIndex < 0 ? undefined : groupThinking(part.steps!.slice(sedimentIndex + 1));
  const reason = jobReason(part.job);
  const ended = !active(part.job);
  // 折起来时露出的前几步固定不变；「其余步骤」展开后接在下面，不能随展开状态重算（重算后剩余为 0，这一行和里面的步骤就一起没了）
  const collapsed = timeline ? visibleSteps(timeline.rows, ended) : undefined;
  return (
    <>
      {last ? null : (
        <div className="jd-meta">
          <StatusTag meta={JOB_STATUS[part.job.status]} />
          {part.job.durationMs !== undefined ? <span>{t("用时 {duration}", { duration: fmtDuration(part.job.durationMs) })}</span> : null}
        </div>
      )}
      {reason && !last ? <div className="jd-reason">{reason}</div> : null}
      {ended ? <><Report job={part.job} /><Outputs job={part.job} /></> : null}
      {part.instruction ? <><div className="lbl">{index === 0 ? t("任务内容") : t("这一轮的要求")}</div><div className="jd-instruction"><Brief text={part.instruction} /></div></> : null}
      <div className="lbl">{t("执行过程")}</div>
      <div className="jd-timeline">
        {timeline === undefined ? <Empty><DelayedText text={t("正在读取执行过程…")} /></Empty> : timeline.rows.length || timeline.thinking ? <>
          {collapsed!.rows.map((step) => <Step key={step.id} step={step} cwd={part.job.cwd} />)}
          {collapsed!.remaining ? (
            <Disclosure
              className="jd-more-steps"
              label={t("其余步骤")}
              count={collapsed!.remaining}
              open={expanded}
              onToggle={() => setExpanded((value) => !value)}
            >
              {timeline.rows.slice(collapsed!.rows.length).map((step) => <Step key={step.id} step={step} cwd={part.job.cwd} />)}
            </Disclosure>
          ) : null}
          {timeline.thinking ? <ThinkingLive text={timeline.thinking} /> : null}
        </> : <Empty>{t("还没有执行步骤。")}</Empty>}
      </div>
      {sediment || part.job.sediment ? <><div className="lbl">{t("沉淀技能")}{part.job.sediment ? ` · ${sedimentText(part.job.sediment)}` : ""}</div><div className="jd-timeline">{sediment?.rows.map((step) => <Step key={step.id} step={step} cwd={part.job.cwd} />)}{sediment?.thinking ? <ThinkingLive text={sediment.thinking} /> : null}</div></> : null}
      {last ? <Directory jobId={part.job.id} /> : null}
    </>
  );
}

function ReplyBox({ job }: { job: Job }) {
  const [text, setText] = useState("");
  const sendable = text.trim().length > 0;
  const submit = () => {
    if (!sendable) return;
    const value = text.trim();
    setText("");
    // 发不出去就把字还回输入框，不让它悄悄丢掉
    void replyJob(job.id, value).then((ok) => { if (!ok) setText((current) => current || value); });
  };
  // 和对话的输入框一个样子：一颗胶囊，右边一个圆钮。有字时是发送；没字、任务还在跑时是停止
  const stop = !sendable && job.status === "running";
  return (
    <div className="jd-foot">
      <div className="jd-comp">
        <input
          value={text}
          placeholder={active(job) ? t("补充说明或更正方向") : t("继续输入…")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
          }}
        />
        {stop ? (
          <button className="sendbtn stop" title={t("停止")} aria-label={t("停止")} onClick={() => void stopJob(job.id)}>
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button className="sendbtn" title={t("发送")} aria-label={t("发送")} disabled={!sendable} onClick={submit}>
            <Icon name="send" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function Step({ step, cwd }: { step: StepRow; cwd?: string }) {
  const [open, setOpen] = useState(false);

  if (step.kind === "text") {
    if (step.from === "hob") {
      const minutes = step.args?.minutes;
      return (
        <div className="jd-reminder">
          {typeof minutes === "number" ? t("已运行 {minutes} 分钟，超过预计的 {expect} 分钟，已提醒任务整理结果", { minutes, expect: String(step.args?.expect ?? "") }) : step.text}
        </div>
      );
    }
    if (step.from === "user") {
      return (
        <div className={`jd-mine${step.queued ? " queued" : ""}`}>
          {step.text}
          {step.queued ? <div className="jd-mine-note">{t("已送达，当前步骤完成后读取")}</div> : null}
        </div>
      );
    }
    return (
      <div className="jd-textrow">
        {step.thinking ? <ThinkingBlock text={step.thinking} open={false} /> : null}
        <Markdown className="jd-text" text={step.text ?? ""} />
      </div>
    );
  }

  const title = step.title ?? step.name ?? "";
  const parts = titleParts(title);
  const head = (
    <>
      <span className="ico">
        {step.running ? (
          <Icon name="spin" size={14} className="spin" />
        ) : (
          <Icon name={TOOL_ICON[step.name ?? ""] ?? (/^(lore|memory)_/.test(step.name ?? "") ? "mem" : "more")} size={14} />
        )}
      </span>
      <span className="tt">
        {parts.map((part, index) => (
          <span key={index} className={part.mono ? "mono" : undefined}>
            {part.text}
          </span>
        ))}
      </span>
      {step.thinking ? (
        <span className="blb" title={t("有思考过程")}>
          <Icon name="bulb" size={13} />
        </span>
      ) : null}
      <span className="tm">{step.isError ? t("出错") : step.durationMs && step.durationMs >= 1000 ? fmtDuration(step.durationMs) : ""}</span>
    </>
  );
  return (
    <div data-job-approval={step.name === "ask_user" ? "true" : undefined}>
      <Disclosure
        className={`jd-tool${step.isError ? " bad" : ""}`}
        label={head}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      >
        <StepBody step={step} cwd={cwd} />
      </Disclosure>
    </div>
  );
}

/**
 * 归到这一步的思考过程：灰色一段，可以收起。
 * 工具步骤展开时默认展开它（先看思考再看做了什么）；回复文字下面默认收起，不把时间线描得太长。
 */
function ThinkingBlock({ text, open: startOpen }: { text: string; open: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <Disclosure
      className="jd-think-in"
      label={<><span className="ico"><Icon name="bulb" size={13} /></span><span className="tt">{t("思考过程")}</span></>}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <div className="jd-think-body">{text}</div>
    </Disclosure>
  );
}

/** 最后一段思考后面还没有步骤：任务还在想，单留一行。 */
function ThinkingLive({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      className="jd-think"
      label={<><span className="ico"><Icon name="bulb" size={14} /></span><span className="tt">{t("思考中")}</span></>}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <div className="jd-think-body">{text}</div>
    </Disclosure>
  );
}

function editPairs(step: JobStep): { oldText: string; newText: string }[] {
  const edits = (step.args as { edits?: unknown } | undefined)?.edits;
  if (!Array.isArray(edits)) return [];
  return edits.map((edit) => ({
    oldText: String((edit as { oldText?: unknown })?.oldText ?? ""),
    newText: String((edit as { newText?: unknown })?.newText ?? ""),
  }));
}

/** 步骤里的文件路径：能定位到绝对路径就点开预览，不能就按原样显示。 */
function PathLink({ path, cwd }: { path: string; cwd?: string }) {
  if (!path) return null;
  const abs = path.startsWith("/") ? path : cwd ? `${cwd.replace(/\/+$/, "")}/${path}` : null;
  if (!abs) return <div className="jd-kv mono">{path}</div>;
  return (
    <button className="jd-kv mono jd-path" title={abs} onClick={() => openFilePreview(abs)}>
      {path}
    </button>
  );
}

function StepBody({ step, cwd }: { step: StepRow; cwd?: string }) {
  const args = step.args ?? {};
  const pairs = editPairs(step);
  return (
    <div className="jd-tool-body">
      {step.thinking ? <ThinkingBlock text={step.thinking} open /> : null}
      {pairs.length ? (
        <>
          <PathLink path={String(args.path ?? "")} cwd={cwd} />
          {pairs.map((pair, index) => (
            <Diff key={index} before={pair.oldText} after={pair.newText} />
          ))}
        </>
      ) : (
        <Args step={step} args={args} cwd={cwd} />
      )}
      {step.output ? <LongText text={step.output} className="jd-out mono" /> : null}
      {step.outputPath ? (
        <button className="jd-file" onClick={() => openFilePreview(step.outputPath!)}>
          <Icon name="doc" size={12} />
          {t("完整输出")}
        </button>
      ) : null}
    </div>
  );
}

function Args({ step, args, cwd }: { step: JobStep; args: Record<string, unknown>; cwd?: string }) {
  if (step.name === "bash") return <LongText text={String(args.command ?? "")} className="jd-arg mono" lines={8} />;
  if (step.name === "write") {
    return (
      <div className="jd-kv-wrap">
        <PathLink path={String(args.path ?? "")} cwd={cwd} />
        <span className="jd-kv-len">{t("{n} 字", { n: String(args.contentLength ?? 0) })}</span>
      </div>
    );
  }
  if (step.name === "read" || step.name === "ls" || step.name === "edit") {
    return <PathLink path={String(args.path ?? "")} cwd={cwd} />;
  }
  const text = JSON.stringify(args, null, 2);
  if (text === "{}") return null;
  return <LongText text={text} className="jd-arg mono" lines={6} />;
}

function Diff({ before, after }: { before: string; after: string }) {
  const [all, setAll] = useState(false);
  const lines = diffLines(before, after);
  const preview = lines.slice(0, 24);
  const rest = lines.slice(24);
  const renderLine = (line: (typeof lines)[number], index: number) => (
    <div className={`dl ${line.sign === "-" ? "del" : line.sign === "+" ? "add" : ""}`} key={index}>
      <span className="sg">{line.sign}</span>
      <span className="mono">{line.text || " "}</span>
    </div>
  );
  return (
    <div className="jd-diff">
      {preview.map(renderLine)}
      {rest.length ? <Disclosure className="jd-more-disclosure" label={t("其余差异")} count={rest.length} open={all} onToggle={() => setAll(value => !value)}>{rest.map((line, index) => renderLine(line, index + preview.length))}</Disclosure> : null}
    </div>
  );
}

function LongText({ text, className, lines = 12 }: { text: string; className: string; lines?: number }) {
  const [all, setAll] = useState(false);
  const rows = text.split("\n");
  const preview = rows.slice(0, lines).join("\n");
  const rest = rows.slice(lines);
  return (
    <>
      <pre className={className}>{preview}</pre>
      {rest.length ? <Disclosure className="jd-more-disclosure" label={t("其余行")} count={rest.length} open={all} onToggle={() => setAll(value => !value)}><pre className={className}>{rest.join("\n")}</pre></Disclosure> : null}
    </>
  );
}

/** 报告：只放摘要（markdown）；产出文件在下面单独一节。 */
function Report({ job }: { job: Job }) {
  if (!job.summary) return null;
  return (
    <>
      <div className="lbl">{t("报告")}</div>
      <Markdown className="jd-report" text={job.summary} />
    </>
  );
}

/** 只展示报告交回的文件，大小通过文件元数据取得。 */
function Outputs({ job }: { job: Job }) {
  const paths = [...new Set(job.files ?? [])];
  return paths.length ? <><div className="lbl">{t("产出文件")}</div><div className="jd-files">{paths.map((path) => <OutputFile key={path} path={path} />)}</div></> : null;
}

function OutputFile({ path }: { path: string }) {
  const [size, setSize] = useState<number>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void fetchFileMeta(path).then((meta) => { if (live) setSize(meta.size); }).catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [path]);
  return <button className="jd-file-row" onClick={() => openFilePreview(path)}><Icon name={fileIcon(path)} size={18} /><span>{path.split("/").pop()}</span>{error ? <small title={error}>{t("大小读取失败")}</small> : size !== undefined ? <small>{fmtBytes(size)}</small> : null}</button>;
}

function Directory({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<JobFilesView>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    void loadJobFiles(jobId).then((result) => { if (live) setView(result); }).catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [jobId, attempt]);
  // 还没建出来或是空的：整行不出现
  if (view && !view.total && !error) return null;
  return <div className="jd-directory">
    <Disclosure label={t("工作目录")} count={view ? `${view.fileCount} ${t("个文件")}、${view.directoryCount} ${t("个文件夹")}` : undefined} open={open} onToggle={() => setOpen(value => !value)}>
      {view ? <DirectoryRows jobId={jobId} view={view} /> : null}
    </Disclosure>
    {error ? <div className="jd-dir-error">{error} <button className="jd-more" onClick={() => setAttempt(attempt + 1)}>{t("重试")}</button></div> : null}
  </div>;
}

function DirectoryRows({ jobId, view }: { jobId: string; view: JobFilesView }) {
  return <div className="jd-files">{view.files.map((entry) => entry.type === "file" ?
    <button className="jd-file-row" key={entry.rel} onClick={() => openFilePreview(entry.path)}><Icon name={fileIcon(entry.name)} size={18} /><span>{entry.name}</span><small>{fmtBytes(entry.size)}</small></button> :
    <DirectoryFolder key={entry.rel} jobId={jobId} entry={entry} />)}
    {view.total > view.files.length ? <div className="jd-dir-more">{t("还有 {n} 项", { n: view.total - view.files.length })}</div> : null}
  </div>;
}

function DirectoryFolder({ jobId, entry }: { jobId: string; entry: Extract<JobFilesView["files"][number], { type: "directory" }> }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<JobFilesView>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || view) return;
    let live = true;
    setError("");
    void loadJobFiles(jobId, entry.rel).then((result) => { if (live) setView(result); }).catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [open, view, jobId, entry.rel, attempt]);
  return <div>
    <Disclosure className="jd-folder-disclosure" label={<><Icon name="folder" size={18} /><span>{entry.name}</span></>} count={`${entry.count} ${t("项")}`} open={open} onToggle={() => setOpen(value => !value)}>
      {error ? <div className="jd-dir-error">{error} <button className="jd-more" onClick={() => setAttempt(attempt + 1)}>{t("重试")}</button></div> : view ? <DirectoryRows jobId={jobId} view={view} /> : <div className="jd-dir-more">{t("正在读取…")}</div>}
    </Disclosure>
  </div>;
}

export function openWorklogJob(job: Job, hasGroup: boolean, hasOwner: boolean) {
  if (hasGroup && job.groupId) void selectGroup(job.groupId, true, true, true);
  else if (hasOwner) void select(job.assistantId, true, true);
  openJob(job.id);
}

function WorklogPage() {
  const s = useApp();
  const log = s.worklog;
  const assistantId = log?.assistantId ?? null;
  const status = log?.status ?? null;

  return (
    <div className="jdbody" onScroll={(event) => { const el = event.currentTarget; if (log?.hasMore && !log.loading && el.scrollHeight - el.scrollTop - el.clientHeight < 100) void moreWorklog(); }}>
      <div className="jd-filters">
        <Select value={assistantId ?? ""} onChange={(value) => void loadWorklog({ assistantId: value || null, status })} options={[{ value: "", label: t("全部助手") }, ...s.assistants.map((assistant) => ({ value: assistant.id, label: assistant.name }))]} />
        <Select value={status ?? ""} onChange={(value) => void loadWorklog({ assistantId, status: (value || null) as JobStatus | null })} options={[{ value: "", label: t("全部状态") }, ...FILTER_STATUS.map((value) => ({ value, label: JOB_STATUS[value].text }))]} />
        <span className="sp" />
        {log ? <span className="dim">{t("{n} 个", { n: log.jobs.length })}</span> : null}
      </div>

      {log === null ? (
        <Empty><DelayedText text={t("正在读取任务记录…")} /></Empty>
      ) : log.jobs.length ? (
        <div className="jd-rows">
          {log.jobs.map((row) => {
            const job = s.jobs[row.id] ?? row;
            const owner = s.assistants.find((assistant) => assistant.id === job.assistantId);
            const group = job.groupId ? s.groups.find((g) => g.id === job.groupId) : undefined;
            return (
              <button
                className="list-row history-row"
                key={job.id}
                onClick={() => {
                  openWorklogJob(job, !!group, !!owner);
                }}
              >
                {owner ? <Avatar sprite={owner.sprite} prop={owner.prop} size={26} /> : <span style={{ width: 26 }} />}
                <span className="history-content">
                  <span className="n">{job.title}</span>
                  <span className="tm">{fmtWhen(job.startedAt ?? job.createdAt)}{job.durationMs !== undefined ? ` · ${fmtDuration(job.durationMs)}` : active(job) ? ` · ${fmtElapsed(job.startedAt ?? job.createdAt)}` : ""}{group ? ` · ${group.name}` : ""}</span>
                </span>
                <StatusTag meta={JOB_STATUS[job.status]} />
              </button>
            );
          })}
        </div>
      ) : (
        <Empty>{t("没有符合条件的任务。")}</Empty>
      )}

      {log?.hasMore ? (
        <button className="hob-btn jd-morebtn" onClick={() => void moreWorklog()}>
          {log.loading ? t("正在读取…") : t("加载更多")}
        </button>
      ) : null}
    </div>
  );
}
