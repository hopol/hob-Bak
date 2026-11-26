// 群的话题：桌面左栏的二级页、手机的话题列表、开话题对话框。
// 行怎么分组、头像取谁在 ../topics.ts，左栏话题行的待办标签在 ./status-meta.tsx，这里只管画。
import { t } from "../../../shared/i18n.ts";
import { useState } from "react";
import { DialogShell } from "./DialogShell.tsx";
import type { GroupSummary, Job } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { Avatar } from "../sprites.tsx";
import { closeTopic, goHome, leaveTopicList, openGroupHome, openJob, openKnowledge, openSettings, openTopic, reopenTopic, selectGroup, toggleSideCollapsed, useApp } from "../store.ts";
import { fmtElapsed, fmtList } from "../util.ts";
import { JOB_STATUS } from "./status-meta.tsx";
import { ownerGroup, topicFace, topicGroups, topicPreview } from "../topics.ts";
import { GroupCluster, groupPreview } from "./Groups.tsx";
import { todoStamp } from "./status-meta.tsx";
import { UpdateDot, availableVersion } from "./SettingsParts.tsx";

/** 群头部第二行：几个成员。 */
export function membersLine(g: GroupSummary): string {
  return t("{n} 位成员", { n: g.members.length });
}

function Unread({ g }: { g: GroupSummary }) {
  if (g.unread > 0) return <span className="topic-unread">{g.unread}</span>;
  if (g.busy.length) return <span className="topic-busy" title={t("进行中")} aria-label={t("进行中")} />;
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
          <span className="nm">{t("综合")}</span>
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
  const stamp = todoStamp(g);
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
          {stamp ? <span className="topic-stamp" title={stamp.title}>{stamp.text}</span> : null}
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
        <button className="fold gtopic-more" onClick={onMore}>{t("查看全部已关闭的话题")} <Icon name="chev" size={13} /></button>
      ) : null}
    </>
  );
}

/**
 * 桌面左栏的群二级页：返回、群头像和名字、成员和人数、开新话题；下面是综合和话题。
 * 返回只把左栏换回首页，中间照旧开着当前这个对话。
 */
export function GroupSidebar({ groupId }: { groupId?: string }) {
  const s = useApp();
  const g = ownerGroup(s.groups, groupId ?? s.gsel);
  const [creating, setCreating] = useState(false);
  const [showAllClosed, setShowAllClosed] = useState(false);
  if (!g) return null;
  const groups = topicGroups(s.groups, g.id);
  const updateVersion = availableVersion(s.update);

  return (
    <aside className="side gside">
      <div className="gside-head">
        <button className="hob-icon-btn" title={t("返回首页")} onClick={goHome}>
          <Icon name="left" size={20} />
        </button>
        <GroupCluster g={g} assistants={s.assistants} size={30} />
        <span className="gside-id">
          <strong>{g.name}</strong>
          <small>{membersLine(g)}</small>
        </span>
        <button className="hob-icon-btn" title={t("收起左栏")} aria-label={t("收起左栏")} onClick={toggleSideCollapsed}><Icon name="panel" size={18} style={{ transform: "scaleX(-1)" }} /></button>
        <button className="hob-icon-btn" title={t("创建新话题")} onClick={() => setCreating(true)}>
          <Icon name="plus" size={19} />
        </button>
      </div>
      <div className="side-scroll gside-rows">
        <GeneralRow g={g} sel={s.gsel === g.id} onClick={() => void selectGroup(g.id)} />
        {groups.active.length ? <div className="gt"><span>{t("进行中 {n}", { n: groups.active.length })}</span></div> : null}
        {groups.active.map((topic) => <TopicRow key={topic.id} g={topic} sel={s.gsel === topic.id} />)}
        {groups.closed.length ? <div className="gt"><span>{t("已关闭 {n}", { n: groups.closed.length })}</span></div> : null}
        <ClosedRows list={groups.closed} showAll={showAllClosed} onMore={() => setShowAllClosed(true)} />
      </div>
      <div className="side-foot">
        <button className="frow" onClick={openKnowledge}>
          <Icon name="archive" size={18} />
          <span className="sp">{t("知识库")}</span>
        </button>
        <button className="frow" onClick={openSettings}>
          <Icon name="gear" size={18} />
          <span className="sp">
            {t("设置")}
            {updateVersion ? <UpdateDot version={updateVersion} /> : null}
          </span>
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
        <button className="hob-icon-btn" title={t("返回")} onClick={leaveTopicList}>
          <Icon name="left" size={22} />
        </button>
        <GroupCluster g={g} assistants={s.assistants} size={30} />
        <span className="gside-id">
          <strong>{g.name}</strong>
          <small>{membersLine(g)}</small>
        </span>
        <span className="sp" />
        <button className="hob-icon-btn" title={t("创建新话题")} onClick={() => setCreating(true)}>
          <Icon name="plus" size={20} />
        </button>
      </div>
      <div className="mlist gtopics-list">
        <GeneralRow g={g} sel={false} onClick={() => void openGroupHome(g.id)} />
        {groups.active.map((topic) => <TopicRow key={topic.id} g={topic} sel={s.gsel === topic.id} />)}
        {groups.closed.length ? <div className="gt"><span>{t("已关闭")}</span></div> : null}
        <ClosedRows list={groups.closed} showAll={showAllClosed} onMore={() => setShowAllClosed(true)} />
      </div>
      {creating ? <NewTopicDialog group={g} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

const ACTIVE_JOB: Job["status"][] = ["running", "queued", "waiting"];

/**
 * 右栏「正在做」：这些地方（群和它的话题，或者一个话题）里还没结束的任务，谁在做、在哪、做了多久；点开看任务。
 */
export function PlaceJobs({ ids, where = true }: { ids: string[]; where?: boolean }) {
  const s = useApp();
  const jobs = Object.values(s.jobs)
    .filter((job) => job.groupId && ids.includes(job.groupId) && ACTIVE_JOB.includes(job.status))
    .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
  if (!jobs.length) return null;
  return (
    <div className="group-card gmembers place-jobs">
      <span className="gm-title">{t("进行中 · {n}", { n: jobs.length })}</span>
      {jobs.map((job) => {
        const a = s.assistants.find((x) => x.id === job.assistantId);
        const place = s.groups.find((g) => g.id === job.groupId);
        const parts = [a?.name ?? job.assistantId, where ? (place?.parentId ? t("「{name}」", { name: place.name }) : t("综合")) : "", `${JOB_STATUS[job.status].text} ${fmtElapsed(job.startedAt ?? job.createdAt)}`].filter(Boolean);
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
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const failure = await openTopic(group.id, title.trim(), group.cwd ? undefined : cwd.trim() || undefined);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };
  return <DialogShell label={t("新话题")} title={t("新话题")} className="topic-create" onClose={onClose} onSubmit={(event) => { event.preventDefault(); void submit(); }} actions={<><button type="button" className="hob-btn" onClick={onClose}>{t("取消")}</button><button type="submit" className="hob-btn hob-btn-primary" disabled={busy || !title.trim()}>{t("创建话题")}</button></>}>
        <label className="gcreate-field">
          <span>{t("话题名")}</span>
          <input autoFocus maxLength={40} value={title} placeholder={t("一件事，如「相册备份出错」")} onChange={(event) => setTitle(event.target.value)} />
        </label>
        {group.cwd ? (
          <div className="gcreate-field">
            <span>{t("工作目录")}</span>
            <div className="field ro" title={group.cwd}>{t("跟随群（{path}）", { path: group.cwd })}</div>
          </div>
        ) : (
          <label className="gcreate-field">
            <span>{t("工作目录（可选）")}</span>
            <input value={cwd} placeholder={t("如 /workspace/app，创建后不可修改")} onChange={(event) => setCwd(event.target.value)} />
          </label>
        )}
        {error ? <div className="gcreate-error">{error}</div> : null}
      </DialogShell>;
}

/** 话题的右栏和综合一样是群信息；话题自己多的只有最下面的关闭（或重新打开）。 */
export function TopicClose({ topic }: { topic: GroupSummary }) {
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
      {error ? <div className="badline">{error}</div> : null}

      {topic.closedAt ? (
        <button className="gm-end" disabled={busy} onClick={() => run(() => reopenTopic(topic.id))}>{t("重新打开")}</button>
      ) : confirming ? (
        <div className="group-card sidebar-card-group mergeconfirm">
          {t("关闭「{name}」？", { name: topic.name })}
          <div className="acts">
            <button className="hob-btn hob-btn-primary" disabled={busy} onClick={() => run(() => closeTopic(topic.id))}>{t("确认关闭")}</button>
            <button className="hob-btn" onClick={() => setConfirming(false)}>{t("取消")}</button>
          </div>
        </div>
      ) : (
        <button className="gm-end" onClick={() => setConfirming(true)}>{t("关闭这个话题")}</button>
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
            <strong>{t("这个话题已关闭")}</strong>
            {g.closeNote ? <span className="closed-note">{g.closeNote}</span> : null}
            {error ? <span className="badline">{t("重新打开失败：{error}", { error })}</span> : null}
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
              {t("重新打开")}
          </button>
        </div>
      </div>
    </div>
  );
}
