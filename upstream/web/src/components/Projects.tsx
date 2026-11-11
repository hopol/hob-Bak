// 事项：群时间线里的事项卡、右栏的事项页、右栏群信息里的两段。视觉照 g6、g7。
import { useState } from "react";
import { projectEnded, projectProgress, stageIndex, STAGE_STEPS, subtaskStatus } from "../../../shared/project.ts";
import type { Job, Project, ProjectStage, Subtask, TopicProject } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { Avatar } from "../sprites.tsx";
import { doneSubtask, openFilePreview, openJob, openProject, sendProjectNote, startProject, selectGroup, useApp } from "../store.ts";
import { spokenPreview, topicFace } from "../topics.ts";
import { fmtDuration, fmtElapsed, fmtWhen } from "../util.ts";
import { Markdown } from "./Markdown.tsx";
import { ReplyInput } from "./ReplyInput.tsx";
import { DetailRow } from "./DetailRow.tsx";
import { PROJECT_STAGE, StatusTag, SUBTASK_STATUS } from "./status-meta.tsx";

/** 按钮的状态：点了转圈，服务器（或事件）回来再变；失败把原因显示在旁边，不先改界面。 */
function useAction(): { busy: boolean; error: string; run: (work: () => Promise<string | null>) => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (work: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const failure = await work();
    setBusy(false);
    if (failure) setError(failure);
  };
  return { busy, error, run };
}

/** 这个事项里某个子任务对应的任务（界面按 id 在 store 里找）。 */
function jobOf(jobs: Record<string, Job>, subtask: Subtask): Job | undefined {
  return subtask.jobId ? jobs[subtask.jobId] : undefined;
}

/** 子任务现在的状态：界面和服务端用同一个推导（shared/project.ts）。 */
function stateOf(project: Project, subtask: Subtask, jobs: Record<string, Job>) {
  return subtaskStatus(project, subtask, jobOf(jobs, subtask), (other) => jobOf(jobs, other));
}

/** 需求说明的第一句：卡片上那一行摘要。 */
export function requirementSummary(project: Project): string {
  const line = project.requirements?.content.split("\n").map((item) => item.replace(/^[-*#>\s]+/u, "").trim()).find(Boolean);
  return line ?? "需求澄清中";
}

/** 结论的第一行：卡片上显示这一句。 */
function summaryLine(project: Project): string {
  return project.summary?.split("\n").map((item) => item.replace(/^[-*#>\s]+/u, "").trim()).find(Boolean) ?? "";
}

function memberName(assistants: { id: string; name: string }[], assignee: string): string {
  if (assignee === "user") return "你";
  return assistants.find((item) => item.id === assignee)?.name ?? assignee;
}

/** 群时间线里的事项卡：标题、状态、需求说明摘要、子任务和状态。点了打开右栏事项页。 */
export function ProjectCard({ project, fresh, itemId }: { project: Project; fresh: boolean; itemId: string }) {
  const s = useApp();
  const action = useAction();
  const jobs = s.jobs;
  const owner = s.assistants.find((assistant) => assistant.id === project.ownerId);
  const members = s.assistants;
  const { done, total } = projectProgress(project, (subtask) => jobOf(jobs, subtask));
  // 拆好了还没开始：卡片上有「开始执行」
  const canStart = project.stage === "plan" && project.subtasks.length > 0;
  const ended = projectEnded(project);
  const spent = project.endedAt ? Date.parse(project.endedAt) - Date.parse(project.createdAt) : 0;
  const open = () => openProject(project.groupId, project.id);

  return (
    <div className={`hov${fresh ? " enter" : ""}`} data-item-id={itemId}>
      <div className="b jobcard projcard" role="button" tabIndex={0} onClick={open} onKeyDown={(event) => { if (event.key === "Enter") open(); }}>
        <div className="tt">
          {owner ? <span className="jav"><Avatar sprite={owner.sprite} prop={owner.prop} size={40} /></span> : null}
          <span className="jt">{project.title}</span>
          <span className="stline">
            <StatusTag meta={PROJECT_STAGE[project.stage]} card>{ended ? (project.stage === "done" && spent ? ` · 用时 ${fmtDuration(spent)}` : null) : total ? ` · 已完成 ${done}/${total}` : null}</StatusTag>
          </span>
        </div>
        <div className="proj-req">
          <strong>需求说明</strong>
          <span>{requirementSummary(project)}</span>
        </div>
        {ended && project.summary ? (
          <div className="proj-req proj-conclusion">
            <strong>{project.stage === "dropped" ? "放弃原因" : "结论"}</strong>
            <span>{summaryLine(project)}</span>
          </div>
        ) : null}
        {project.subtasks.length ? (
          <div className="proj-subs">
            {project.subtasks.map((subtask) => {
              const state = stateOf(project, subtask, jobs);
              const who = memberName(members, subtask.assignee);
              const avatar = s.assistants.find((assistant) => assistant.id === subtask.assignee);
              return (
                <div className="proj-sub" key={subtask.n}>
                  <span className={`proj-n s-${SUBTASK_STATUS[state].color || "idle"}`}>{subtask.n}</span>
                  <span className="proj-sub-t">{subtask.title}</span>
                  <span className="proj-who">
                    {avatar ? <Avatar sprite={avatar.sprite} prop={avatar.prop} size={16} /> : <Icon name="user" size={13} />}
                    {who}
                  </span>
                  <span className={`proj-state s-${SUBTASK_STATUS[state].color || "idle"}`}>
                    <StatusTag meta={SUBTASK_STATUS[state]} card />
                    {state === "待你执行" ? (
                      <button
                        className="proj-btn"
                        disabled={action.busy}
                        onClick={(event) => { event.stopPropagation(); void action.run(() => doneSubtask(project, subtask.n)); }}
                      >
                        已完成
                      </button>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="proj-foot">
          {canStart ? (
            <button className="proj-btn primary" disabled={action.busy} onClick={(event) => { event.stopPropagation(); void action.run(() => startProject(project)); }}>
              开始执行
            </button>
          ) : null}
          <button className="proj-more" onClick={(event) => { event.stopPropagation(); open(); }}>查看事项 <Icon name="chev" size={13} /></button>
        </div>
        {action.error ? <div className="badline">没成功：{action.error}</div> : null}
      </div>
    </div>
  );
}

/** 阶段条：需求澄清 → 需求说明 → 任务拆分 → 执行 {完成}/{总数} → 验收。事项和话题的进度都画这一条。 */
export function StageTrack({ stage, done, total }: { stage: ProjectStage; done: number; total: number }) {
  const finished = stage === "done";
  const index = finished || stage === "dropped" ? -1 : stageIndex(stage);
  return (
    <div className="proj-stages">
      {STAGE_STEPS.map((label, i) => {
        const checked = finished || (index >= 0 && i < index);
        const current = !finished && index >= 0 && i === index;
        return (
          <span key={label} className={`proj-stage${checked ? " checked" : ""}${current ? " current" : ""}`}>
            {checked ? <Icon name="check" size={13} w={2.2} /> : null}
            {i === 3 && total ? `执行 ${done}/${total}` : label}
          </span>
        );
      })}
      <span className="sp" />
    </div>
  );
}

/** 话题带的事项：群列表里只有阶段和子任务数，没有整份事项，照同样的样子画。 */
export function TopicStageBar({ project }: { project: TopicProject }) {
  return <StageTrack stage={project.stage} done={project.done} total={project.total} />;
}

function StageBar({ project }: { project: Project }) {
  const jobs = useApp().jobs;
  const { done, total } = projectProgress(project, (subtask) => jobOf(jobs, subtask));
  return <StageTrack stage={project.stage} done={done} total={total} />;
}

/**
 * 综合时间线里的话题卡：内容从群列表里这条话题的摘要实时取，话题有变化卡片原地更新。
 * 点了进这个话题；话题已经不在了（归档了）就写一句不能点。
 */
export function TopicCard({ topicId, fresh, itemId }: { topicId: string; fresh: boolean; itemId: string }) {
  const s = useApp();
  const g = s.groups.find((item) => item.id === topicId);
  if (!g) {
    return (
      <div className={`hov${fresh ? " enter" : ""}`} data-item-id={itemId}>
        <div className="b topiccard gone">话题已不在</div>
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
          {g.closedAt ? <StatusTag meta={{ text: "已关闭", icon: "archive", color: "", spin: false }} card /> : <button className="topic-enter" onClick={(event) => { event.stopPropagation(); open(); }}>进入话题 <Icon name="chev" size={13} /></button>}
        </div>
        {g.project ? <TopicStageBar project={g.project} /> : null}
        {/* 关了的：右上角已经标了「已关闭」，这里只写关闭时留的话 */}
        {g.closedAt ? (
          g.closeNote ? <div className="topic-line"><span>{g.closeNote}</span></div> : null
        ) : (
          <div className="topic-line">
            <span>{spokenPreview(g, s.assistants)}</span>
            {g.project?.waitingUser ? (
              <button className="topic-answer" onClick={(event) => { event.stopPropagation(); open(); }}>去回答 <Icon name="chev" size={12} /></button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** 子任务一行：序号、标题、人、前置、用时，状态在右边；有任务的点了打开任务详情，用户的子任务轮到时有「已完成」。 */
export function SubtaskRow({ project, subtask }: { project: Project; subtask: Subtask }) {
  const s = useApp();
  const action = useAction();
  const jobs = s.jobs;
  const job = jobOf(jobs, subtask);
  const state = stateOf(project, subtask, jobs);
  const meta = SUBTASK_STATUS[state];
  const who = memberName(s.assistants, subtask.assignee);
  const avatar = s.assistants.find((assistant) => assistant.id === subtask.assignee);
  const before = subtask.after.map((n) => project.subtasks.find((entry) => entry.n === n)).filter((entry): entry is Subtask => Boolean(entry));
  const beforeDone = before.length > 0 && before.every((entry) => stateOf(project, entry, jobs) === "已完成");
  const timing = job
    ? job.status === "running" || job.status === "waiting" || job.status === "queued"
      ? `已进行 ${fmtElapsed(job.startedAt ?? job.createdAt)}`
      : job.durationMs !== undefined
        ? `用时 ${fmtDuration(job.durationMs)}`
        : undefined
    : subtask.doneAt
      ? `完成于 ${fmtWhen(subtask.doneAt)}`
      : undefined;
  const detail = [who, before.length ? (beforeDone ? "前置任务已完成" : `前置任务：子任务 ${subtask.after.join("、")}`) : "", subtask.startError ? `原因：${subtask.startError}` : "", timing].filter(Boolean).join(" · ");
  return (
    <div
      className={`proj-trow${job ? " open" : ""}`}
      role={job ? "button" : undefined}
      tabIndex={job ? 0 : undefined}
      onClick={() => job && openJob(job.id)}
      onKeyDown={(event) => { if (job && event.key === "Enter") openJob(job.id); }}
    >
      <span className={`proj-n s-${meta.color || "idle"}`}>{subtask.n}</span>
      <span className="proj-tmain">
        <span className="proj-tt">{subtask.title}</span>
        <span className="proj-td">
          {avatar ? <Avatar sprite={avatar.sprite} prop={avatar.prop} size={15} /> : <Icon name="user" size={12} />}
          <span className="proj-td-text">{detail}</span>
        </span>
        {action.error ? <span className="badline">没成功：{action.error}</span> : null}
      </span>
      <span className={`proj-tstate s-${meta.color || "idle"}`}>
        <StatusTag meta={meta} card />
        {state === "待你执行" ? (
          <button className="proj-btn" disabled={action.busy} onClick={(event) => { event.stopPropagation(); void action.run(() => doneSubtask(project, subtask.n)); }}>
            已完成
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** 事项页底部：补充说明发到群里，引用事项卡。 */
function NoteBox({ project }: { project: Project }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    const failure = await sendProjectNote(project.groupId, project, text.trim());
    setBusy(false);
    if (failure) setError(failure);
    else setText("");
  };
  return (
    <div className="proj-note">
      <ReplyInput value={text} onChange={setText} sending={busy} placeholder="补充说明…" className="proj-note-row" onSend={send} />
      {error ? <div className="badline">没发出去：{error}</div> : null}
    </div>
  );
}

/** 右栏的事项页：标题、状态、阶段条、原始需求、问答、需求说明、子任务、验收标准、结论。 */
export function ProjectPanel({ groupId, id }: { groupId: string; id: string }) {
  const s = useApp();
  const action = useAction();
  const project = (s.projects[groupId] ?? []).find((item) => item.id === id);
  if (!project) {
    return <div className="sidebar-loading" role="status">{s.projectsError[groupId] ? `没能读到这个事项：${s.projectsError[groupId]}` : "正在读取事项…"}</div>;
  }
  const owner = s.assistants.find((assistant) => assistant.id === project.ownerId);
  const group = s.groups.find((entry) => entry.id === project.groupId);
  const acceptance = project.requirements?.acceptance ?? [];
  const checkOf = (index: number) => project.checks?.find((check) => check.index === index);
  const ended = projectEnded(project);

  return (
    <div className="proj-page">
      <h2 className="proj-title">{project.title}</h2>
      <div className="proj-statusline">
        <StatusTag meta={PROJECT_STAGE[project.stage]} />
        {owner ? <span><Avatar sprite={owner.sprite} prop={owner.prop} size={16} />{owner.name}</span> : null}
        {group ? <span>{group.name}</span> : null}
        <span>{fmtWhen(project.createdAt)}</span>
      </div>
      <StageBar project={project} />
      {project.cwd ? <div className="proj-cwd">工作目录：{project.cwd}</div> : null}

      <section className="proj-sec">
        <h3>原始需求</h3>
        <div className="proj-request">
          {project.request.text ? <p>{project.request.text}</p> : <p className="muted">没有记下原话</p>}
          {project.request.quote ? <button className="quote">{project.request.quote.text}</button> : null}
          {project.request.files?.length ? <div className="proj-files">{project.request.files.map((file) => <span key={file}>{file.split("/").at(-1)}</span>)}</div> : null}
        </div>
      </section>

      {project.clarify.length ? (
        <section className="proj-sec">
          <h3>需求澄清</h3>
          <div className="proj-qa">
            {project.clarify.map((question, index) => (
              <div className="proj-q" key={index}>
                <p><strong>{memberName(s.assistants, question.askedBy)}：</strong>{question.title}</p>
                {question.recommended ? <p className="muted">推荐：{question.recommended}</p> : null}
                <p><strong>你：</strong>{question.answer ?? "（还没回答）"}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {project.requirements ? (
        <section className="proj-sec">
          <h3>需求说明</h3>
          <div className="proj-doc">
            <div className="proj-doc-head">
              <span><Icon name="doc" size={15} />需求说明</span>
              <small>{owner?.name ?? project.ownerId} · {fmtWhen(project.requirements.updatedAt)}</small>
            </div>
            <Markdown className="md proj-doc-body" text={project.requirements.content} />
          </div>
        </section>
      ) : null}

      {project.subtasks.length ? (
        <section className="proj-sec">
          <div className="proj-sec-head">
            <h3>子任务</h3>
            {project.stage === "plan" ? (
              <button className="proj-btn primary" disabled={action.busy} onClick={() => void action.run(() => startProject(project))}>开始执行</button>
            ) : null}
          </div>
          {action.error ? <div className="badline">没成功：{action.error}</div> : null}
          <div className="proj-rows">
            {project.subtasks.map((subtask) => <SubtaskRow key={subtask.n} project={project} subtask={subtask} />)}
          </div>
        </section>
      ) : null}

      {acceptance.length ? (
        <section className="proj-sec">
          <h3>验收标准</h3>
          <div className="proj-checks">
            {acceptance.map((item, index) => {
              const check = checkOf(index + 1);
              return (
                <div className={`proj-check${check ? (check.passed ? " pass" : " fail") : ""}`} key={index}>
                  <span className="proj-box">{check ? <Icon name={check.passed ? "check" : "close"} size={12} w={2.4} /> : null}</span>
                  <span className="proj-check-main">
                    {item}
                    {check ? (
                      <small>
                        {check.evidence}
                        {check.files?.length ? <span className="proj-check-files">{check.files.map((file) => <button key={file} onClick={() => openFilePreview(file)}>{file.split("/").at(-1)}</button>)}</span> : null}
                      </small>
                    ) : <small className="muted">未验证</small>}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {ended && project.summary ? (
        <section className="proj-sec">
          <h3>{project.stage === "dropped" ? "放弃原因" : "结论"}</h3>
          <div className="proj-summary"><Markdown className="md" text={project.summary} /></div>
        </section>
      ) : null}

      {ended ? null : <NoteBox project={project} />}
    </div>
  );
}

/** 右栏群信息里的两段：进行中的事项、已结束的事项（默认收起）。只给以前直接立在群里的事项用，没有就不出。 */
export function GroupProjects({ groupId }: { groupId: string }) {
  const s = useApp();
  const list = s.projects[groupId] ?? [];
  const active = list.filter((project) => !projectEnded(project));
  const ended = list.filter((project) => projectEnded(project));
  const error = s.projectsError[groupId];
  if (!active.length && !ended.length && !error) return null;
  const jobs = s.jobs;
  const row = (project: Project) => {
    const { done, total } = projectProgress(project, (subtask) => jobOf(jobs, subtask));
    const detail = projectEnded(project)
      ? project.stage === "dropped" ? "已放弃" : "已完成"
      : project.subtasks.length ? `${PROJECT_STAGE[project.stage].text} · 已完成 ${done}/${total}` : PROJECT_STAGE[project.stage].text;
    return (
      <DetailRow className="proj-grow" key={project.id} leading={<Icon name={project.stage === "done" ? "check" : project.stage === "dropped" ? "close" : "bulb"} size={16} className={`proj-gicon s-${PROJECT_STAGE[project.stage].color || "idle"}`} />} title={project.title} detail={detail} onClick={() => openProject(project.groupId, project.id)} />
    );
  };
  return (
    <>
      <div className="group-card gmembers">
        <span className="gm-title">进行中的事项</span>
        {error ? <div className="badline">加载失败：{error}</div> : active.length ? active.map(row) : <div className="gm-empty">还没有进行中的事项</div>}
      </div>
      {ended.length ? (
        <details className="group-card gmembers proj-ended">
          <summary className="gm-title">已结束的事项<span>{ended.length}</span></summary>
          {ended.map(row)}
        </details>
      ) : null}
    </>
  );
}
