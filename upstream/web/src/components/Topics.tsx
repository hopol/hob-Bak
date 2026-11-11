// 群的话题：桌面左栏的二级页、手机的话题列表、开话题对话框。
// 行怎么分组、状态怎么写、头像取谁在 ../topics.ts，这里只管画。
import { useState } from "react";
import { DialogShell } from "./DialogShell.tsx";
import type { GroupSummary, Job } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { Avatar } from "../sprites.tsx";
import { closeTopic, goHome, leaveTopicList, openGroupHome, openJob, openKnowledge, openProject, openSettings, openTopic, reopenTopic, selectGroup, startProject, useApp } from "../store.ts";
import { fmtElapsed, fmtList } from "../util.ts";
import { JOB_STATUS } from "./status-meta.tsx";
import { ownerGroup, topicFace, topicGroups, topicPreview, topicStamp, workflowInfo } from "../topics.ts";
import { GroupCluster, groupPreview } from "./Groups.tsx";
import { requirementSummary, SubtaskRow, TopicStageBar } from "./Projects.tsx";

/** 群头部第二行：「N 位成员 · 软件开发」；工作方式是「无」时只写人数。 */
export function membersLine(g: GroupSummary): string {
  const count = `${g.members.length} 位成员`;
  return g.workflow ? `${count} · ${workflowInfo(g.workflow).label}` : count;
}

function Unread({ g }: { g: GroupSummary }) {
  if (g.unread > 0) return <span className="topic-unread">{g.unread}</span>;
  if (g.busy.length) return <span className="topic-busy" title="正在做" aria-label="正在做" />;
  return null;
}

/** 「综合」那一行：井号方块、最后一条的预览、时间、未读。 */
export function GeneralRow({ g, sel, onClick }: { g: GroupSummary; sel?: boolean; onClick: () => void }) {
  const s = useApp();
  return (
    <button className={`list-row home-row topic-row general-row${sel ? " sel" : ""}`} onClick={onClick}>
      <span className="topic-hash" aria-hidden="true"><Icon name="hash" size={20} /></span>
      <div className="main">
        <div className="l1">
          <span className="nm">综合</span>
          <span className="tm">{fmtList(g.last?.at)}</span>
        </div>
        <div className="pv">{groupPreview(g, s.assistants)}</div>
      </div>
      <Unread g={g} />
    </button>
  );
}

/** 一行话题：现在轮到谁的头像、标题和时间、状态标签加预览、未读。关了的灰一些。 */
export function TopicRow({ g, sel }: { g: GroupSummary; sel?: boolean }) {
  const s = useApp();
  const face = s.assistants.find((a) => a.id === topicFace(g));
  const stamp = topicStamp(g);
  return (
    <button
      className={`list-row home-row topic-row${sel ? " sel" : ""}${g.closedAt ? " closed" : ""}`}
      onClick={() => void selectGroup(g.id)}
    >
      {face ? <Avatar sprite={face.sprite} prop={face.prop} size={36} /> : <span className="topic-hash" aria-hidden="true"><Icon name="hash" size={18} /></span>}
      <div className="main">
        <div className="l1">
          <span className="nm">{g.name}</span>
          <span className="tm">{fmtList(g.closedAt ?? g.last?.at)}</span>
        </div>
        <div className="pv">
          {stamp ? <span className={`topic-stamp ${stamp.tone}`}>{stamp.text}</span> : null}
          <span className="topic-preview">{topicPreview(g, s.assistants)}</span>
        </div>
      </div>
      <Unread g={g} />
    </button>
  );
}

/** 已关闭那一节默认列最近 5 个，多了给一个「查看全部」。 */
function ClosedRows({ list, showAll, onMore }: { list: GroupSummary[]; showAll: boolean; onMore: () => void }) {
  const s = useApp();
  const rows = showAll ? list : list.slice(0, 5);
  return (
    <>
      {rows.map((g) => <TopicRow key={g.id} g={g} sel={s.gsel === g.id} />)}
      {!showAll && list.length > 5 ? (
        <button className="fold gtopic-more" onClick={onMore}>查看全部已关闭的话题 <Icon name="chev" size={13} /></button>
      ) : null}
    </>
  );
}

/**
 * 桌面左栏的群二级页：返回、群头像和名字、成员和工作方式、开新话题；下面是综合和话题。
 * 返回只把左栏换回首页，中间照旧开着当前这个对话。
 */
export function GroupSidebar({ groupId }: { groupId?: string }) {
  const s = useApp();
  const g = ownerGroup(s.groups, groupId ?? s.gsel);
  const [creating, setCreating] = useState(false);
  const [showAllClosed, setShowAllClosed] = useState(false);
  if (!g) return null;
  const groups = topicGroups(s.groups, g.id);

  return (
    <aside className="side gside">
      <div className="gside-head">
        <button className="hob-icon-btn" title="返回首页" onClick={goHome}>
          <Icon name="left" size={20} />
        </button>
        <GroupCluster g={g} assistants={s.assistants} size={30} />
        <span className="gside-id">
          <strong>{g.name}</strong>
          <small>{membersLine(g)}</small>
        </span>
        <button className="hob-icon-btn" title="开新话题" onClick={() => setCreating(true)}>
          <Icon name="plus" size={19} />
        </button>
      </div>
      <div className="side-scroll gside-rows">
        <GeneralRow g={g} sel={s.gsel === g.id} onClick={() => void selectGroup(g.id)} />
        {groups.active.length ? <div className="gt"><span>进行中 {groups.active.length}</span></div> : null}
        {groups.active.map((topic) => <TopicRow key={topic.id} g={topic} sel={s.gsel === topic.id} />)}
        {groups.closed.length ? <div className="gt"><span>已关闭 {groups.closed.length}</span></div> : null}
        <ClosedRows list={groups.closed} showAll={showAllClosed} onMore={() => setShowAllClosed(true)} />
      </div>
      <div className="side-foot">
        <button className="frow" onClick={openKnowledge}>
          <Icon name="archive" size={18} />
          <span className="sp">知识库</span>
        </button>
        <button className="frow" onClick={openSettings}>
          <Icon name="gear" size={18} />
          <span className="sp">设置</span>
        </button>
      </div>
      {creating ? <NewTopicDialog group={g} onClose={() => setCreating(false)} /> : null}
    </aside>
  );
}

/** 手机上的话题列表：页面头部是群，第一行综合，然后进行中的话题，最后是已关闭。 */
export function MobileTopics({ groupId }: { groupId?: string }) {
  const s = useApp();
  const g = ownerGroup(s.groups, groupId ?? s.gsel);
  const [creating, setCreating] = useState(false);
  const [showAllClosed, setShowAllClosed] = useState(false);
  if (!g) return null;
  const groups = topicGroups(s.groups, g.id);
  return (
    <>
      <div className="mhead gtopics-head">
        <button className="hob-icon-btn" title="返回" onClick={leaveTopicList}>
          <Icon name="left" size={22} />
        </button>
        <GroupCluster g={g} assistants={s.assistants} size={30} />
        <span className="gside-id">
          <strong>{g.name}</strong>
          <small>{membersLine(g)}</small>
        </span>
        <span className="sp" />
        <button className="hob-icon-btn" title="开新话题" onClick={() => setCreating(true)}>
          <Icon name="plus" size={20} />
        </button>
      </div>
      <div className="mlist gtopics-list">
        <GeneralRow g={g} sel={false} onClick={() => void openGroupHome(g.id)} />
        {groups.active.map((topic) => <TopicRow key={topic.id} g={topic} sel={s.gsel === topic.id} />)}
        {groups.closed.length ? <div className="gt"><span>已关闭</span></div> : null}
        <ClosedRows list={groups.closed} showAll={showAllClosed} onMore={() => setShowAllClosed(true)} />
      </div>
      {creating ? <NewTopicDialog group={g} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

const ACTIVE_JOB: Job["status"][] = ["running", "queued", "waiting"];

/**
 * 右栏「正在做」：这些地方（群和它的话题，或者一个话题）里还没结束的任务，谁在做、在哪、做了多久；点开看任务。
 * exclude 里的任务不列（话题里的子任务列表已经有它们）。
 */
export function PlaceJobs({ ids, where = true, exclude }: { ids: string[]; where?: boolean; exclude?: Set<string> }) {
  const s = useApp();
  const jobs = Object.values(s.jobs)
    .filter((job) => job.groupId && ids.includes(job.groupId) && ACTIVE_JOB.includes(job.status) && !exclude?.has(job.id))
    .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
  if (!jobs.length) return null;
  return (
    <div className="group-card gmembers place-jobs">
      <span className="gm-title">正在做 · {jobs.length}</span>
      {jobs.map((job) => {
        const a = s.assistants.find((x) => x.id === job.assistantId);
        const place = s.groups.find((g) => g.id === job.groupId);
        const parts = [a?.name ?? job.assistantId, where ? (place?.parentId ? `「${place.name}」` : "综合") : "", `${JOB_STATUS[job.status].text} ${fmtElapsed(job.startedAt ?? job.createdAt)}`].filter(Boolean);
        return (
          <button key={job.id} className="gm-row" onClick={() => openJob(job.id)}>
            {a ? <Avatar sprite={a.sprite} prop={a.prop} size={30} /> : null}
            <span>
              <strong>{job.title}</strong>
              <small>{parts.join(" · ")}</small>
            </span>
            <Icon name="chev" size={13} />
          </button>
        );
      })}
    </div>
  );
}

/** 开新话题的小对话框：一个话题名，建好直接进这个话题，失败在框里显示原因。 */
export function NewTopicDialog({ group, onClose }: { group: GroupSummary; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const failure = await openTopic(group.id, title.trim());
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };
  return <DialogShell label="新话题" title="新话题" className="topic-create" onClose={onClose} onSubmit={(event) => { event.preventDefault(); void submit(); }} actions={<><button type="button" className="hob-btn" onClick={onClose}>取消</button><button type="submit" className="hob-btn hob-btn-primary" disabled={busy || !title.trim()}>开话题</button></>}>
        <label className="gcreate-field">
          <span>话题名</span>
          <input autoFocus maxLength={40} value={title} placeholder="一件事，如「相册备份出错」" onChange={(event) => setTitle(event.target.value)} />
        </label>
        {error ? <div className="gcreate-error">{error}</div> : null}
      </DialogShell>;
}

/** 话题页头部下面那一条：左边阶段条，右边进度和子任务数，点了打开右栏的事项页。 */
export function TopicStage({ topic, mobile = false }: { topic: GroupSummary; mobile?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const project = topic.project;
  if (!project) return null;
  const ratio = project.total ? project.done / project.total : 0;
  // 拆好了还没开始：开始键放在这条上，消息翻到哪都看得见，不用回头找最上面那张事项卡
  const canStart = project.stage === "plan" && project.total > 0;
  const start = () => {
    setBusy(true);
    setError("");
    void startProject({ groupId: topic.id, id: project.id }).then((failure) => {
      setBusy(false);
      setError(failure ?? "");
    });
  };
  return (
    <div className={`topic-stage${mobile ? " mobile" : ""}`}>
      <button className="topic-stage-go" title="查看事项" onClick={() => openProject(topic.id, project.id)}>
        {mobile ? (
          <span className="topic-stage-now">{canStart ? "子任务已拆好" : project.waitingUser ? "等你回答" : stageNow(project)}</span>
        ) : (
          <TopicStageBar project={project} />
        )}
        {/* 还没拆子任务：不画进度条和「子任务 0/0」 */}
        {project.total ? <span className="topic-bar" aria-hidden="true"><i style={{ width: `${Math.round(ratio * 100)}%` }} /></span> : <span className="sp" />}
        {mobile ? (canStart ? null : <span className="topic-stage-more">事项 <Icon name="chev" size={12} /></span>) : project.total ? <span className="topic-count">子任务 {project.done}/{project.total}</span> : null}
      </button>
      {error ? <span className="topic-stage-err" title={error}>{error}</span> : null}
      {canStart ? <button className="proj-btn primary" disabled={busy} onClick={start}>开始执行</button> : null}
    </div>
  );
}

/** 手机上那行阶段：进行到哪一步写一句。 */
function stageNow(project: NonNullable<GroupSummary["project"]>): string {
  if (project.stage === "clarify") return "需求澄清";
  if (project.stage === "plan") return "拆分";
  if (project.stage === "doing") return `执行 ${project.done}/${project.total}`;
  if (project.stage === "review") return "验收";
  return project.stage === "done" ? "已完成" : "已放弃";
}

/** 进度环：话题顶上那颗，里面写完成数。 */
function Ring({ done, total }: { done: number; total: number }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const part = total ? done / total : 0;
  return (
    <svg className="tring" width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
      <circle className="tring-bg" cx="19" cy="19" r={r} />
      {/* 一个都没完成时不画：圆头线帽会留下一个点 */}
      {part > 0 ? <circle className="tring-fg" cx="19" cy="19" r={r} strokeDasharray={`${c * part} ${c}`} transform="rotate(-90 19 19)" /> : null}
      {total ? <text className="tring-t" x="19" y="22.5" textAnchor="middle">{`${done}/${total}`}</text> : null}
    </svg>
  );
}

/**
 * 右栏的话题信息：进度环和话题名、群名和负责人、原始需求和阶段；
 * 有事项时给出需求说明入口和子任务；最下面是说过话的成员和关闭（或重新打开）这个话题。
 */
export function TopicPanel({ topic }: { topic: GroupSummary }) {
  const s = useApp();
  const group = ownerGroup(s.groups, topic.id);
  const owner = s.assistants.find((a) => a.id === topic.ownerId);
  const project = (s.projects[topic.id] ?? []).find((p) => p.id === topic.project?.id) ?? (s.projects[topic.id] ?? [])[0];
  const spoken = [...new Set((s.groupItems[topic.id] ?? []).map((item) => item.speaker).filter((speaker) => speaker !== "user"))]
    .map((id) => s.assistants.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (work: () => Promise<string | null>) => {
    setBusy(true);
    setError("");
    void work().then((failure) => {
      setBusy(false);
      if (failure) setError(failure);
      else setConfirming(false);
    });
  };

  return (
    <>
      <div className="group-card sidebar-card topic-head">
        <div className="sidebar-identity">
          {topic.project ? <Ring done={topic.project.done} total={topic.project.total} /> : <span className="topic-hash big" aria-hidden="true"><Icon name="hash" size={20} /></span>}
          <span>
            <strong>{topic.name}</strong>
            <small>{`${group?.name ?? ""}的话题 · ${owner?.name ?? topic.ownerId}负责`}</small>
          </span>
        </div>
        {project ? (
          <div className="gpanel-origin">
            <small>原始需求</small>
            {project.request.text || "没有记下原话"}
          </div>
        ) : null}
        {topic.project ? <TopicStageBar project={topic.project} /> : null}
      </div>

      {project ? (
        <button className="group-card sidebar-card topic-doc" onClick={() => openProject(topic.id, project.id)}>
          <span className="topic-doc-main">
            <small>需求说明</small>
            <strong>{requirementSummary(project)}</strong>
            <span>{project.requirements ? `${project.requirements.acceptance.length} 条验收标准` : "还没写需求说明"}</span>
          </span>
          <Icon name="chev" size={13} />
        </button>
      ) : null}

      {project?.subtasks.length ? (
        <div className="group-card gmembers">
          <span className="gm-title">子任务 · 已完成 {topic.project?.done ?? 0}/{project.subtasks.length}</span>
          <div className="proj-rows">
            {project.subtasks.map((subtask) => <SubtaskRow key={subtask.n} project={project} subtask={subtask} />)}
          </div>
        </div>
      ) : null}

      <PlaceJobs ids={[topic.id]} where={false} exclude={new Set(project?.subtasks.flatMap((subtask) => (subtask.jobId ? [subtask.jobId] : [])))} />

      {spoken.length ? (
        <div className="group-card gmembers topic-spoken">
          <span className="gm-title">话题里说过话的</span>
          <div className="topic-spoken-row">
            {spoken.map((a) => <Avatar key={a.id} sprite={a.sprite} prop={a.prop} size={26} />)}
            <span>{spoken.map((a) => a.name).join("、")}</span>
          </div>
        </div>
      ) : null}

      {error ? <div className="badline">{error}</div> : null}

      {topic.closedAt ? (
        <button className="gm-end" disabled={busy} onClick={() => run(() => reopenTopic(topic.id))}>重新打开</button>
      ) : confirming ? (
        <div className="group-card sidebar-card-group mergeconfirm">
          {`关闭「${topic.name}」？话题里没结束的事项会按放弃处理。`}
          <div className="acts">
            <button className="hob-btn hob-btn-primary" disabled={busy} onClick={() => run(() => closeTopic(topic.id))}>确认关闭</button>
            <button className="hob-btn" onClick={() => setConfirming(false)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="gm-end" onClick={() => setConfirming(true)}>关闭这个话题</button>
      )}
    </>
  );
}

/** 话题关了：输入框换成一句说明和「重新打开」，closeNote 有就一并写出来。 */
export function ClosedTopic({ g }: { g: GroupSummary }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="compwrap">
      <div className="col">
        <div className="comp closed-comp">
          <div className="closed-main">
            <strong>这个话题已关闭</strong>
            {g.closeNote ? <span className="closed-note">{g.closeNote}</span> : null}
            {error ? <span className="badline">重新打开失败：{error}</span> : null}
          </div>
          <button
            className="hob-btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void reopenTopic(g.id).then((failure) => {
                setBusy(false);
                if (failure) setError(failure);
              });
            }}
          >
            重新打开
          </button>
        </div>
      </div>
    </div>
  );
}
