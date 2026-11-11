// 右栏：进行中的任务 + 定时任务列表 / 定时任务编辑 / 助手设置 / 应用设置。
import { Select } from "./Select.tsx";
import { DelayedText, Empty } from "./Empty.tsx";
import { SaveMessage, useSaveMessage } from "./SaveMessage.tsx";
import { DetailRow } from "./DetailRow.tsx";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMenu } from "./use-menu.ts";
import { skillUsage } from "../skill-usage.ts";
import { commandSummary } from "../../../shared/command.ts";
import type { ActivityLine, Assistant, CustomProp, GroupSummary, ModelInfo, ModelsView, Routine, Rule, ThinkingLevel, WorkflowId } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { assistantStatus, followingModel, formatNext, nextRoutine, routineSkills, sidebarJobs } from "../sidebar-data.ts";
import { PanelRootDetails } from "./PanelRootDetails.tsx";
import { GroupProjects, ProjectPanel } from "./Projects.tsx";
import { fitThinking } from "../model-list.ts";
import { COLOR_IDS, COLORS, customSprite, parseSprite, PROP_IDS, PROPS, spriteId } from "../../../shared/sprites.ts";
import { Avatar } from "../sprites.tsx";
import { useLeave } from "../motion.ts";
import { useDesktopScreens } from "../desktop-screens.ts";
import {
  addRule,
  archiveGroup,
  backPanel,
  changeAssistantSkill,
  collapsePanel,
  createRoutine,
  deleteRule,
  deleteRoutine,
  jumpToJob,
  jumpToDelegation,
  loadModels,
  loadKnowledge,
  loadAssistantSkills,
  loadGroupProfile,
  openKnowledge,
  openFilePreview,
  archiveAssistant,
  openAssistantPanel,
  openGroupSettings,
  openMemberPanel,
  openJob,
  openJobs,
  openNewRoutine,
  openRoutine,
  patchAssistant,
  patchGroup,
  patchGroupMemberModels,
  setNotice,
  updateRule,
  runRoutine,
  saveRoutine,
  toggleNowWide,
  useApp,
  type PanelPage,
} from "../store.ts";
import { cronText, fmtElapsed, fmtWhen, parseCron, routineRunUsage, scheduleCron, timePointText, WEEK, type Schedule } from "../util.ts";
import { PanelHead } from "./PanelHead.tsx";
import { panelAssistant } from "../panel-stack.ts";
import { DELEGATION_STATUS, JOB_STATUS, StatusTag, jobStatusIcon } from "./status-meta.tsx";
import { GroupCluster, membersOf } from "./Groups.tsx";
import { PlaceJobs, TopicPanel } from "./Topics.tsx";
import { topicsOf, WORKFLOWS, workflowInfo } from "../topics.ts";

// noVNC 要顶层 await，单独分包按需加载
const DesktopMini = lazy(() => import("./DesktopView.tsx").then((m) => ({ default: m.DesktopMini })));
const DesktopScreen = lazy(() => import("./DesktopView.tsx").then((m) => ({ default: m.DesktopView })));

// 活动行存的是单字代码（任务统计也按它数），显示时换成书面动词
const VERB_LABEL: Record<string, string> = { 读: "读取", 跑: "运行", 改: "修改", 写: "写入", 搜: "搜索" };

/** 活动行的动词和正文；命令去掉 cd/timeout/ssh 外壳。 */
export function activityParts(line: ActivityLine): [string, string] {
  return [VERB_LABEL[line.verb] ?? line.verb, line.verb === "跑" ? commandSummary(line.text) : line.text];
}

export function Panel({ mobile = false, page }: { mobile?: boolean; page?: PanelPage | null }) {
  const s = useApp();
  const top = page === undefined ? s.panelStack.at(-1) : page;
  const panel = top && top.kind !== "job" && top.kind !== "jobs" && top.kind !== "file" ? top : { kind: "now" as const };
  // 群成员页和助手的根页长得一样，只是讲的是那个成员、头部带返回
  const member = panel.kind === "member";
  const kind = member ? "now" : panel.kind;
  // 选中群时右栏的根页是群信息（推进了成员页时除外）
  const group = s.gsel && !member ? s.groups.find((g) => g.id === s.gsel) : undefined;
  const groupScope = "groupId" in panel && (panel.kind === "routines" || panel.kind === "skills" || panel.kind === "rules" || panel.kind === "newRoutine") ? panel.groupId : undefined;
  const [rootScrolled, setRootScrolled] = useState(false);
  const selectedAssistant = s.profiles[panelAssistant(s.panelStack, s.sel)]?.assistant ?? s.assistants.find((a) => a.id === (panelAssistant(s.panelStack, s.sel)));
  useEffect(() => setRootScrolled(false), [s.sel, s.gsel]);
  const title = panel.kind === "routine" ? s.routines.find((r) => r.id === panel.id)?.name ?? "定时任务" : kind === "newRoutine" ? "新建定时任务" : kind === "routines" ? "定时任务" : kind === "skills" ? "技能" : kind === "knowledge" ? "知识库" : kind === "rules" ? "执行前确认" : kind === "project" ? "事项" : kind === "now" ? "" : kind === "groupSettings" ? "编辑群" : "编辑助手";
  return (
    <aside className="panel" onScroll={(event) => { if (kind === "now") { const card = event.currentTarget.querySelector(".sidebar-card"); const head = event.currentTarget.querySelector(".phead"); setRootScrolled(!!card && !!head && card.getBoundingClientRect().bottom <= head.getBoundingClientRect().bottom); } }}>
      <PanelHead className="phead" root={kind === "now" && !member} close={kind === "project"} title={<span className="t">{kind === "now" && !group && rootScrolled && selectedAssistant ? <span className="sidebar-head-identity"><Avatar sprite={selectedAssistant.sprite} prop={selectedAssistant.prop} size={24} />{selectedAssistant.name}</span> : title}</span>}>
        {kind === "now" && !group ? <><button className="hob-icon-btn" title="编辑助手" onClick={openAssistantPanel}><Icon name="edit" size={17} /></button><button className="hob-icon-btn panel-close" title="收起右栏" onClick={collapsePanel}><Icon name="dbl" size={17} /></button></> : null}
        {kind === "now" && group ? <>{!group.parentId ? <button className="hob-icon-btn" title="编辑群" onClick={() => openGroupSettings(group.id)}><Icon name="edit" size={17} /></button> : null}<button className="hob-icon-btn panel-close" title="收起右栏" onClick={collapsePanel}><Icon name="dbl" size={17} /></button></> : null}
        {kind === "routines" ? <button className="hob-icon-btn" title="新建定时任务" onClick={openNewRoutine}><Icon name="plus" size={17} /></button> : null}
        {panel.kind === "routine" ? <button className="hob-btn hob-btn-primary hob-btn-compact" onClick={() => void runRoutine(panel.id)}>立即运行</button> : null}
      </PanelHead>
      <div className={`pbody sidebar-page-${kind}`}>
        {kind === "routine" ? (
          <RoutineEditor key={panel.kind === "routine" ? panel.id : ""} id={panel.kind === "routine" ? panel.id : ""} />
        ) : kind === "newRoutine" ? (
          <NewRoutine groupId={groupScope} />
        ) : panel.kind === "groupSettings" ? (
          <GroupSettings id={panel.id} />
        ) : kind === "assistant" ? (
          <AssistantSettings key={panelAssistant(s.panelStack, s.sel)} />
        ) : kind === "routines" ? <RoutineList groupId={groupScope} /> : kind === "skills" ? <AssistantSkills aid={groupScope ?? panelAssistant(s.panelStack, s.sel)} /> : kind === "knowledge" ? <AssistantKnowledge aid={panelAssistant(s.panelStack, s.sel)} /> : kind === "rules" ? <AssistantRules aid={groupScope ?? panelAssistant(s.panelStack, s.sel)} group={!!groupScope} /> : panel.kind === "project" ? (
          <ProjectPanel groupId={panel.groupId} id={panel.id} />
        ) : group ? (
          group.parentId ? <TopicPanel topic={group} /> : <GroupPanel g={group} />
        ) : (
          <><PanelNow />{member && s.gsel ? <GroupMemberModels aid={panelAssistant(s.panelStack, s.sel)} groupId={s.gsel} /> : null}<PanelRootDetails /></>
        )}
      </div>
    </aside>
  );
}

/**
 * 右栏：群信息——群头像和名字、群主和人数、状态、负责什么、成员（空闲 / 在办几件）、添加成员、结束这个群。
 * 成员的「设为群主 / 移出群」在成员行右边的 ⋯ 里（手机上一直看得见，桌面上悬停才出现）。
 */
function GroupPanel({ g }: { g: GroupSummary }) {
  const s = useApp();
  const members = membersOf(g, s.assistants);
  const owner = members.find((m) => m.id === g.ownerId);
  // 群的事连同各话题一起算：成员在哪个话题里做事，群信息里都看得到
  const places = [g, ...topicsOf(s.groups, g.id)];
  const ids = places.map((place) => place.id);
  const busy = new Set(places.flatMap((place) => place.busy));
  const jobs = Object.values(s.jobs);
  const doing = (id: string) => jobs.filter((job) => job.groupId && ids.includes(job.groupId) && job.assistantId === id && (job.status === "running" || job.status === "queued" || job.status === "waiting")).length;
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState(false);
  const [pickingWorkflow, setPickingWorkflow] = useState(false);
  const [workflowError, setWorkflowError] = useState("");
  const menu = useMenu();
  const picked = menu.menu ? s.assistants.find((a) => a.id === menu.menu!.id) : undefined;
  const workflow = workflowInfo(g.workflow);

  const change = async (patch: { ownerId?: string; members?: string[] }) => {
    const failure = await patchGroup(g.id, patch);
    if (failure) setNotice(`保存失败：${failure}`);
    return !failure;
  };

  // 改成「无」时服务端会拦住还有没结束的事项的群，原因原样显示出来
  const pickWorkflow = async (id: WorkflowId | null) => {
    setPickingWorkflow(false);
    setWorkflowError("");
    const failure = await patchGroup(g.id, { workflow: id });
    if (failure) setWorkflowError(failure);
  };

  return (
    <>
      <div className="group-card sidebar-card">
        <div className="sidebar-identity">
          <GroupCluster g={g} assistants={s.assistants} size={44} />
          <span>
            <strong>{g.name}</strong>
            <small>群主 {owner?.name ?? g.ownerId} · {g.members.length} 位成员</small>
          </span>
          <em className={busy.size ? "active" : ""}><span key={busy.size ? "busy" : "idle"}>{busy.size ? "执行中" : "空闲"}</span></em>
        </div>
        <div className="gpanel-origin"><small>负责什么</small>{g.purpose || "还没写"}</div>
        <div className="gpanel-origin gpanel-wf">
          <small>工作方式</small>
          <button className="wf-row" aria-expanded={pickingWorkflow} onClick={() => setPickingWorkflow(!pickingWorkflow)}>
            <strong>{workflow.label}</strong>
            <span>{workflow.flow}</span>
          </button>
          {pickingWorkflow ? (
            <div className="wf-menu" role="menu">
              {WORKFLOWS.map((item) => (
                <button key={item.label} role="menuitem" className={item.label === workflow.label ? "on" : ""} onClick={() => void pickWorkflow(item.id)}>{item.label}</button>
              ))}
            </div>
          ) : null}
          {workflowError ? <div className="badline">保存失败：{workflowError}</div> : null}
        </div>
      </div>

      <PanelRootDetails groupId={g.id} part="info" />

      <PlaceJobs ids={ids} />

      <GroupProjects groupId={g.id} />

      <div className="group-card gmembers">
        <span className="gm-title">成员</span>
        {members.map((m) => {
          const count = doing(m.id);
          return (
            <div className="gm-row" key={m.id}>
              {/* 点头像或名字：右栏进这个助手的信息页，返回回到群信息 */}
              <button className="gm-open" title={`${m.name}的设置`} onClick={() => openMemberPanel(m.id)}>
                <Avatar sprite={m.sprite} prop={m.prop} size={30} />
                <span><strong>{m.name}</strong><small>{m.id === g.ownerId ? `群主 · ${m.duty}` : m.duty}</small></span>
              </button>
              <em className={count ? "busy" : ""}>{count ? `在办 ${count} 件` : busy.has(m.id) ? "在说" : "空闲"}</em>
              {/* 群主没有操作菜单：占住同样的宽度，状态和别的行对齐 */}
              {m.id === g.ownerId ? <i className="gm-dots gm-dots-gap" aria-hidden="true"><Icon name="more" size={18} /></i> : (
                <button className="gm-dots" aria-label={`${m.name}的操作`} onClick={(event) => menu.toggle(m.id, event.currentTarget)}><Icon name="more" size={18} /></button>
              )}
            </div>
          );
        })}
        {adding ? (
          <div className="gm-add">
            <div className="gm-add-head">
              <span>选一个助手加进群</span>
              <button onClick={() => setAdding(false)}>取消</button>
            </div>
            {s.assistants.filter((a) => !g.members.includes(a.id)).map((a) => (
              <button key={a.id} className="gm-row gm-pick" onClick={() => void change({ members: [...g.members, a.id] }).then((ok) => { if (ok) setAdding(false); })}>
                <Avatar sprite={a.sprite} prop={a.prop} size={30} />
                <span><strong>{a.name}</strong><small>{a.duty}</small></span>
                <em className="gm-pick-add"><Icon name="plus" size={14} />加入</em>
              </button>
            ))}
            {s.assistants.every((a) => g.members.includes(a.id)) ? <div className="gm-empty">所有助手都在这个群里了</div> : null}
          </div>
        ) : (
          <button className="gm-row gm-add-row" onClick={() => setAdding(true)}>
            <span className="addi"><Icon name="plus" size={14} /></span>添加成员
          </button>
        )}
      </div>

      <PanelRootDetails groupId={g.id} part="tabs" />

      {ending ? (
        <div className="group-card sidebar-card-group mergeconfirm">
          结束「{g.name}」？群会归档，时间线和任务都留着，不会转给别人。
          <div className="acts">
            <button className="hob-btn hob-btn-primary" onClick={() => void archiveGroup(g.id)}>确认结束</button>
            <button className="hob-btn" onClick={() => setEnding(false)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="gm-end" onClick={() => setEnding(true)}>结束这个群</button>
      )}

      {picked && menu.menu ? createPortal(
        <div className="amenu" ref={menu.box}>
          <button onClick={() => { menu.close(); void change({ ownerId: picked.id }); }}>设为群主</button>
          <button onClick={() => { menu.close(); void change({ members: g.members.filter((id) => id !== picked.id) }); }}>移出群</button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function PanelNow() {
  const s = useApp();
  const aid = panelAssistant(s.panelStack, s.sel);
  const assistant = s.profiles[aid]?.assistant ?? s.assistants.find((a) => a.id === aid);
  const jobs = Object.values(s.jobs);
  const { running: job, last } = sidebarJobs(jobs, aid);
  const status = assistant ? assistantStatus(assistant, jobs, Object.values(s.approvals), Object.values(s.delegations)) : "空闲";
  const next = nextRoutine(s.routines.filter((r) => r.assistantId === aid && !r.groupId), s.settings.settings.general.timezone);

  // 只有当前助手的屏幕运行时显示小屏，屏幕关闭后恢复命令行。
  const desktop = useDesktopScreens();
  const screenId = desktop.profiles[panelAssistant(s.panelStack, s.sel)];
  const desk = !!screenId && desktop.screens.some((entry) => entry.id === screenId && entry.running);
  const [screen, setScreen] = useState<null | "view" | "take">(null);
  const wide = desk && s.nowWide;
  const previousLines = useRef<ActivityLine[]>([]);
  if (job) previousLines.current = job.activity;
  const lines = (job?.activity ?? previousLines.current).slice(desk && !wide ? -2 : -8);
  const logPresence = useLeave(Boolean(job) && !desk);
  // 新活动行淡入；打开面板时已经有的行不动
  const keys = lines.map((l) => `${l.at}|${l.verb}|${l.text}`);
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(keys);
  const freshLines = new Set(keys.filter((k) => !seen.current!.has(k)));
  useEffect(() => {
    for (const k of keys) seen.current!.add(k);
  });

  const log = (cls: string, title: string, onClick: () => void) => (
    <button className={`screen ${cls}`} title={title} onClick={onClick}>
      {lines.map((line, i) =>
        line.verb === "$" ? (
          <div key={keys[i]} className={freshLines.has(keys[i]) ? "new" : undefined}>
            <span className="p">$</span> {line.text}
          </div>
        ) : (
          <div key={keys[i]} className={freshLines.has(keys[i]) ? "new" : undefined}>
            <span className="v">{activityParts(line)[0]}</span>
            {activityParts(line)[1]}
          </div>
        ),
      )}
      <div><span className="cur" /></div>
    </button>
  );

  return (
    <div className="group-card sidebar-card">
      {assistant ? <div className="sidebar-identity"><Avatar sprite={assistant.sprite} prop={assistant.prop} size={44} /><span><strong>{assistant.name}</strong><small>{assistant.duty}</small></span><em className={status !== "空闲" ? "active" : ""}><span key={status}>{status}</span></em></div> : null}
      {desk ? (
        <div className="now-desk">
          <div className="now-screen">
            <button className="now-hit" title={wide ? "收起" : "在侧栏展开"} aria-label={wide ? "收起" : "在侧栏展开"} onClick={toggleNowWide} />
            <Suspense fallback={null}><DesktopMini key={screenId} screen={screenId!} /></Suspense>
            <span className="now-live">实时</span>
            <div className="now-acts">
              {wide ? <button className="now-btn" title="收起" aria-label="收起" onClick={toggleNowWide}><Icon name="shrink" size={15} /></button> : null}
              <button className="now-btn" title="全屏" aria-label="全屏查看云桌面" onClick={() => setScreen("view")}><Icon name="expand" size={15} /></button>
              <button className="now-btn txt" title="接管云桌面" onClick={() => setScreen("take")}><Icon name="pointer" size={14} />接管</button>
            </div>
          </div>
          {job ? log("strip", wide ? "收起" : "在侧栏展开", toggleNowWide) : null}
        </div>
      ) : null}
      {screen && screenId ? <Suspense fallback={null}><DesktopScreen initialScreen={screenId} takeOver={screen === "take"} onClose={() => setScreen(null)} /></Suspense> : null}
      {desktop.error ? <div className="badline">云桌面状态读取失败：{desktop.error}</div> : null}
      {!desk ? <div className={`now-log${job ? " open" : ""}`} inert={!job}><div>{logPresence.mounted && job ? log("jd-open", "打开任务详情", () => openJob(job.id)) : logPresence.mounted ? log("jd-open", "打开任务详情", () => {}) : null}</div></div> : null}
      {job ? (
        <>
          <div className="caprow"><span className="cap">{job.title}{job.routineId ? " · 定时执行" : ""} · 已进行 {fmtElapsed(job.startedAt ?? job.createdAt)}</span><button className="more" onClick={() => openJob(job.id)}>任务详情 ›</button></div>
        </>
      ) : <div className="sidebar-facts">{last ? <button onClick={() => openJob(last.id)}>上次 <span>{jobStatusIcon(last.status, 14)}<span>{last.title}</span></span><small>{fmtWhen(last.endedAt!)}</small></button> : null}{next ? <div>下一次 <span><span aria-hidden="true">⏱</span><span>{next.routine.name}</span></span><small>{formatNext(next.at, s.settings.settings.general.timezone)}</small></div> : null}</div>}

      {panelAssistant(s.panelStack, s.sel) === "hob" ? Object.values(s.delegations).filter((delegation) => delegation.status === "running" || delegation.status === "waiting").map((delegation) => {
        const target = s.assistants.find((assistant) => assistant.id === delegation.to);
        return <button className="sidebar-delegation" key={delegation.id} onClick={() => void jumpToDelegation("hob", delegation.id, false)}>{target ? <Avatar sprite={target.sprite} prop={target.prop} size={22} /> : null}<span>交给「{target?.name ?? delegation.to}」</span><small><StatusTag meta={DELEGATION_STATUS[delegation.status]} /></small> ›</button>;
      }) : null}
    </div>
  );
}

function GroupSettings({ id }: { id: string }) {
  const s = useApp();
  const group = s.groups.find((item) => item.id === id);
  const [view, setView] = useState<ModelsView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void loadModels().then(setView); }, []);
  if (!group) return <Empty>这个群已不存在</Empty>;
  const save = async (patch: Parameters<typeof patchGroup>[1]) => { const failure = await patchGroup(id, patch); setError(failure ?? ""); return !failure; };
  const settings = s.settings.settings.models;
  return <>
    <div className="pgroup"><div className="bigav"><GroupCluster g={group} assistants={s.assistants} size={64} /></div>
      <div className="sech"><span>基本信息</span></div><div className="group-card sidebar-card-group">
      {([ ["name", "群名"], ["purpose", "负责什么"], ["instructions", "补充说明"] ] as const).map(([key, label]) => <div key={key}><div className="lbl">{label}</div><PanelText value={group[key] ?? ""} multiline={key === "instructions"} save={(value) => save({ [key]: value })} /></div>)}
      </div></div>
    <div className="pgroup"><div className="sech"><span>模型</span></div>
    <div className="group-card sidebar-card-group">{([ ["conversation", "对话模型"], ["work", "默认任务模型"] ] as const).map(([key, label]) => <div key={key}><div className="lbl">{label}</div><Select aria-label={label} value={group.models?.[key]?.ref ?? ""} onChange={(ref) => { const model = view?.models.find((item) => item.ref === ref); void save({ models: { [key]: ref ? { ref, thinking: fitThinking(model, settings.roster.find((entry) => entry.ref === ref)?.thinking ?? settings[key].thinking) } : null } }); }} options={[{ value: "", label: "跟随各成员" }, ...settings.roster.map((entry) => ({ value: entry.ref, label: view?.models.find((item) => item.ref === entry.ref)?.name ?? entry.ref }))]} /></div>)}
    <div className="note">成员在本群单独设过的，按成员的；都没设，跟随助手自己的。</div></div></div>
    {error ? <div className="badline">保存失败：{error}</div> : null}
  </>;
}

function GroupMemberModels({ aid, groupId }: { aid: string; groupId: string }) {
  const s = useApp();
  const selected = s.groups.find((g) => g.id === groupId);
  const group = s.groups.find((g) => g.id === (selected?.parentId ?? groupId));
  const assistant = s.profiles[aid]?.assistant ?? s.assistants.find((a) => a.id === aid);
  const [view, setView] = useState<ModelsView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void loadModels().then(setView); if (group) void loadGroupProfile(group.id); }, [group?.id]);
  if (!group || !assistant) return null;
  const resolved = s.groupProfiles[group.id];
  const settings = s.settings.settings.models;
  const name = (ref: string) => view?.models.find((model) => model.ref === ref)?.name ?? ref;
  return <div className="group-card sidebar-info group-member-models">
    <div className="group-member-models-head"><span>在「{group.name}」里</span><small>只在本群生效</small></div>
    {([ ["conversation", "对话模型"], ["work", "默认任务模型"] ] as const).map(([key, label]) => {
      const effective = resolved?.value?.memberModels[aid]?.[key];
      const inherited = effective?.inherited;
      const follow = inherited ? followingModel(inherited.source, name(inherited.pick.ref)) : undefined;
      const pick = effective?.source === "member" ? effective.pick : undefined;
      return <label className="group-member-model-row" key={key}>
        <span>{label}</span><span className={pick ? "" : "following"}>{pick ? name(pick.ref) : follow ? follow.text : resolved?.error ? "加载失败" : "正在加载…"}</span><Icon name="updown" size={14} />
        <Select aria-label={label} value={pick?.ref ?? ""} onChange={(ref) => {
          const thinking = fitThinking(view?.models.find((model) => model.ref === ref), settings.roster.find((entry) => entry.ref === ref)?.thinking ?? inherited?.pick.thinking ?? settings[key].thinking);
          void patchGroupMemberModels(group.id, aid, { [key]: ref ? { ref, thinking } : null }).then((failure) => { setError(failure ?? ""); if (!failure) void loadGroupProfile(group.id); });
        }} options={[{ value: "", label: follow?.option ?? "跟随" }, ...settings.roster.map((entry) => ({ value: entry.ref, label: name(entry.ref) }))]} />
      </label>;
    })}
    {error ? <div className="badline">保存失败：{error}</div> : null}
  </div>;
}

/** 停了的定时任务怎么说：列表和详情用同一句，详情后面再带时间。 */
function stoppedText(routine: Routine): string | undefined {
  if (routine.stopReason === "hit") return "已触发，已停";
  if (routine.stopReason === "finished") return "已跑完";
  return undefined;
}

function routineDetail(r: Routine, s: ReturnType<typeof useApp>) {
  const topic = r.groupId ? s.groups.find((g) => g.id === r.groupId) : undefined;
  return <>{r.active ? <>{cronText(r.schedules[0] ?? "")}{r.check ? r.checks?.failing ? <> · <span className="rt-bad">检查失败</span></> : ` · 检查 ${r.checks?.total ?? 0} 次 · 触发 ${r.checks?.hits ?? 0} 次` : r.runs[0] ? <> · 上次 {r.runs[0].status === "handed" ? "交给群主" : <StatusTag meta={JOB_STATUS[r.runs[0].status]} />} {fmtWhen(r.runs[0].at)}</> : null}</> : stoppedText(r) ?? "已暂停"}{topic?.parentId ? ` · 发到话题「${topic.name}」` : ""}</>;
}

function RoutineList({ groupId }: { groupId?: string }) {
  const s = useApp();
  const routines = s.routines.filter((r) => groupId ? r.groupId === groupId || s.groups.some((g) => g.id === r.groupId && g.parentId === groupId) : r.assistantId === panelAssistant(s.panelStack, s.sel) && !r.groupId);
  return routines.length ? <div className="group-card sidebar-card-group card-rows">{routines.map((r) => <DetailRow key={r.id} leading={<Icon name={r.active ? "clock" : "pause"} size={18} />} title={r.name} detail={routineDetail(r, s)} onClick={() => openRoutine(r.id)} />)}</div> : <Empty>{groupId ? "这个群还没有定时任务" : "这个助手还没有定时任务"}</Empty>;
}

function AssistantRules({ aid, group = false }: { aid: string; group?: boolean }) {
  const s = useApp();
  const rules = group ? s.groupProfiles[aid]?.value?.rules ?? [] : s.profiles[aid]?.rules ?? [];
  useEffect(() => { if (group) void loadGroupProfile(aid); }, [aid, group]);
  if (group && s.groupProfiles[aid]?.error) return <div className="badline">加载失败：{s.groupProfiles[aid].error} <button onClick={() => void loadGroupProfile(aid)}>重试</button></div>;
  return <><div className="note">标为「需确认」的事项，助手执行前会先征求你的同意。</div>{!rules.length ? <Empty>还没有执行前确认事项</Empty> : null}<div className="group-card sidebar-card-group card-rows">{rules.map((rule) => <RuleRow key={rule.id} aid={aid} rule={rule} />)}<RuleCreator aid={aid} /></div></>;
}

function ScheduleRow({
  value,
  onSave,
  onRemove,
}: {
  value: string;
  onSave: (next: string) => void;
  /** 不止一个执行时间时才能删 */
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sch = parseCron(value);

  // 具体时间点只显示、能删；cron 编辑器改不了它
  if (timePointText(value)) {
    return (
      <div className="w">
        <Icon name="clock" size={15} />
        {cronText(value)}
        {onRemove ? (
          <button className="hob-btn hob-btn-danger" style={{ marginLeft: "auto" }} onClick={onRemove}>
            删除
          </button>
        ) : null}
      </div>
    );
  }

  if (!open) {
    return (
      <button className="w" onClick={() => setOpen(true)}>
        <Icon name="clock" size={15} />
        {cronText(value)}
      </button>
    );
  }

  const update = (patch: Partial<Schedule>) => {
    const base: Schedule = sch.kind === "raw" ? { ...sch, kind: "daily" } : sch;
    onSave(scheduleCron({ ...base, ...patch }));
  };
  const time = `${String(sch.hour).padStart(2, "0")}:${String(sch.minute).padStart(2, "0")}`;

  return (
    <div className="w sched-edit">
      <Select value={sch.kind} onChange={(value) => update({ kind: value as Schedule["kind"] })} options={[{ value: "daily", label: "每天" }, { value: "weekly", label: "每周" }, { value: "monthly", label: "每月" }, { value: "raw", label: "自定义" }]} />
      {sch.kind === "weekly" ? (
        <Select value={String(sch.weekday)} onChange={(value) => update({ weekday: Number(value) })} options={WEEK.map((w, i) => ({ value: String(i), label: `周${w}` }))} />
      ) : null}
      {sch.kind === "monthly" ? (
        <input
          type="number"
          min={1}
          max={28}
          value={sch.day}
          onChange={(e) => update({ day: Number(e.target.value) || 1 })}
        />
      ) : null}
      {sch.kind === "raw" ? (
        <input className="rawcron" value={sch.raw} onChange={(e) => onSave(e.target.value)} />
      ) : (
        <input
          type="time"
          value={time}
          onChange={(e) => {
            const [h, m] = e.target.value.split(":").map(Number);
            update({ hour: h || 0, minute: m || 0 });
          }}
        />
      )}
      {onRemove ? (
        <button className="hob-btn hob-btn-danger" onClick={onRemove}>
          删除
        </button>
      ) : null}
      <button className="hob-btn" onClick={() => setOpen(false)}>
        完成
      </button>
    </div>
  );
}

/** 新建定时任务：先在本地填写，名称和任务内容都有了才创建（建好后切到它的编辑页）。 */
function NewRoutine({ groupId }: { groupId?: string }) {
  const s = useApp();
  const group = s.groups.find((g) => g.id === groupId);
  const aid = groupId ? group?.ownerId ?? "" : panelAssistant(s.panelStack, s.sel);
  const [destination, setDestination] = useState(groupId ?? "");
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [active, setActive] = useState(true);
  const [skill, setSkill] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (aid) void loadAssistantSkills(aid); if (groupId) void loadAssistantSkills(groupId); }, [aid, groupId]);
  const ready = name.trim() !== "" && instruction.trim() !== "" && !busy;
  const create = async () => {
    setBusy(true);
    await createRoutine({
      assistantId: aid,
      ...(groupId ? { groupId: destination } : {}),
      name: name.trim(),
      instruction: instruction.trim(),
      schedules: [schedule],
      active,
      ...(skill ? { skill } : {}),
    });
    setBusy(false);
  };

  return (
    <>
      <div className="group-card sidebar-card-group"><div className="ctl"><span>启用</span><span className="sp" /><button className={`tog${active ? "" : " off"}`} title={active ? "暂停" : "启用"} onClick={() => setActive(!active)} /></div></div>
      <div className="lbl">名称</div>
      <label className="field">
        <input autoFocus value={name} placeholder="如「每日简报」" onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="lbl">任务内容</div>
      <label className="field">
        <textarea
          rows={4}
          value={instruction}
          placeholder={groupId ? "到点后交给群主处理的内容，写清楚需要什么结果" : "到点后交给后台任务执行的内容，写清楚需要什么结果"}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>

      <div className="lbl">执行时间</div>
      <div className="when">
        <ScheduleRow value={schedule} onSave={setSchedule} />
      </div>

      {group ? <RoutineTarget group={group} destination={destination} onDestination={setDestination} /> : null}
      <div className="lbl">技能</div>
      {groupId && s.assistantSkills[groupId]?.error ? <div className="badline">本群技能加载失败：{s.assistantSkills[groupId].error} <button onClick={() => void loadAssistantSkills(groupId)}>重试</button></div> : null}
      {s.assistantSkills[aid]?.error ? <div className="badline">加载失败：{s.assistantSkills[aid].error} <button onClick={() => void loadAssistantSkills(aid)}>重试</button></div> : null}
      <div className="group-card sidebar-card-group"><Select aria-label="技能" value={skill} disabled={!s.assistantSkills[aid] || s.assistantSkills[aid].loading || !!s.assistantSkills[aid].error || !!(groupId && (!s.assistantSkills[groupId]?.loaded || s.assistantSkills[groupId]?.error))} onChange={setSkill} options={[{ value: "", label: "不用技能" }, ...routineSkills(s.assistantSkills[groupId ?? ""]?.skills ?? [], s.assistantSkills[aid]?.skills ?? []).map(({ skill: item, group }) => ({ value: item.name, label: `${item.title}${group ? "（本群）" : ""}` }))]} /></div>
      <div className="ctl">
        <span className="sp" />
        <button className="hob-btn" onClick={backPanel}>
          取消
        </button>
        <button className="hob-btn hob-btn-primary" disabled={!ready} onClick={() => void create()}>
          创建
        </button>
      </div>
    </>
  );
}

function RoutineTarget({ group, destination, onDestination }: { group: GroupSummary; destination: string; onDestination: (id: string) => void }) {
  const s = useApp();
  return <><div className="lbl">发到</div><div className="group-card sidebar-card-group"><Select aria-label="发到" value={destination} onChange={onDestination} options={[{ value: group.id, label: "综合" }, ...s.groups.filter((topic) => topic.parentId === group.id && !topic.closedAt).map((topic) => ({ value: topic.id, label: `话题「${topic.name}」` }))]} /></div></>;
}

function RoutineEditor({ id }: { id: string }) {
  const s = useApp();
  const r = s.routines.find((x) => x.id === id);
  const aid = r?.assistantId;
  const place = s.groups.find((group) => group.id === r?.groupId);
  const group = s.groups.find((item) => item.id === (place?.parentId ?? place?.id));
  useEffect(() => { if (aid) void loadAssistantSkills(aid); if (group) void loadAssistantSkills(group.id); }, [aid, group?.id]);
  if (!r) return <Empty>这个定时任务已不存在。</Empty>;

  return (
    <>
      <div className="group-card sidebar-card-group"><div className="ctl">
        <span style={{ fontSize: 14 }}>启用</span>
        <span className="sp" />
        <button
          className={`tog${r.active ? "" : " off"}`}
          title={r.active ? "暂停" : "启用"}
          onClick={() => void saveRoutine(r.id, { active: !r.active })}
        />
      </div></div>

      <div className="lbl">名称</div>
      <label className="field">
        <input
          defaultValue={r.name}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== r.name) void saveRoutine(r.id, { name: v });
          }}
        />
      </label>

      <div className="lbl">任务内容</div>
      <label className="field">
        <textarea
          rows={4}
          defaultValue={r.instruction}
          onBlur={(e) => {
            if (e.target.value !== r.instruction) void saveRoutine(r.id, { instruction: e.target.value });
          }}
        />
      </label>

      <div className="lbl">执行时间</div>
      <div className="when">
        {r.schedules.map((c, i) => (
          <ScheduleRow
            key={i}
            value={c}
            onSave={(next) => {
              const arr = r.schedules.slice();
              arr[i] = next;
              void saveRoutine(r.id, { schedules: arr });
            }}
            onRemove={
              r.schedules.length > 1
                ? () => void saveRoutine(r.id, { schedules: r.schedules.filter((_, j) => j !== i) })
                : undefined
            }
          />
        ))}
        <button className="w" onClick={() => void saveRoutine(r.id, { schedules: [...r.schedules, "0 9 * * *"] })}>
          <Icon name="plus" size={14} />
          添加执行时间
        </button>
      </div>
      {r.once || stoppedText(r) ? (
        <div className="rt-when-note">
          {[r.once ? "触发一次就停" : "", stoppedText(r) ? `${stoppedText(r)}${r.stoppedAt ? ` · ${fmtWhen(r.stoppedAt)}` : ""}` : ""].filter(Boolean).join(" · ")}
        </div>
      ) : null}

      {group ? <RoutineTarget group={group} destination={r.groupId ?? group.id} onDestination={(groupId) => void saveRoutine(r.id, { groupId })} /> : null}
      <div className="lbl">技能</div>
      {group && s.assistantSkills[group.id]?.error ? <div className="badline">本群技能加载失败：{s.assistantSkills[group.id].error} <button onClick={() => void loadAssistantSkills(group.id)}>重试</button></div> : null}
      {s.assistantSkills[r.assistantId]?.error ? <div className="badline">加载失败：{s.assistantSkills[r.assistantId].error} <button onClick={() => void loadAssistantSkills(r.assistantId)}>重试</button></div> : null}
      <div className="group-card sidebar-card-group"><Select aria-label="技能" value={r.skill ?? ""} disabled={!s.assistantSkills[r.assistantId] || s.assistantSkills[r.assistantId].loading || !!s.assistantSkills[r.assistantId].error || !!(group && (!s.assistantSkills[group.id]?.loaded || s.assistantSkills[group.id]?.error))} onChange={(value) => void saveRoutine(r.id, { skill: value || null })} options={[
        { value: "", label: "不用技能" },
        ...(r.skill && !s.assistantSkills[r.assistantId]?.skills.some((skill) => skill.name === r.skill && skill.enabled) && !s.assistantSkills[group?.id ?? ""]?.skills.some((skill) => skill.name === r.skill && skill.enabled) ? [{ value: r.skill, label: r.skill, disabled: true }] : []),
        ...routineSkills(s.assistantSkills[group?.id ?? ""]?.skills ?? [], s.assistantSkills[r.assistantId]?.skills ?? []).map(({ skill, group }) => ({ value: skill.name, label: `${skill.title}${group ? "（本群）" : ""}` }))
      ]} /></div>

      {r.check ? (
        <>
          <div className="lbl">检查</div>
          <div className="group-card sidebar-card-group">
            <div className="rt-check-line">
              检查 {r.checks?.total ?? 0} 次 · 触发 {r.checks?.hits ?? 0} 次{r.checks?.lastAt ? ` · 上次 ${fmtWhen(r.checks.lastAt)}` : ""}
            </div>
            {r.checks?.failing ? <div className="rt-check-line badline">失败原因：{r.checks.failing}</div> : null}
          </div>
          <details className="rt-script">
            <summary>检查脚本</summary>
            <pre className="mono">{r.check.script}</pre>
          </details>
        </>
      ) : null}

      <div className="lbl">运行记录</div>
      <div className="group-card sidebar-card-group sidebar-runs">
      {r.runs.length ? (
        r.runs.map((run) => {
          if (!run.jobId) return <div className="run" key={run.at}><span className="rt">{fmtWhen(run.at)} · 交给群主</span></div>;
          const job = s.jobs[run.jobId];
          const st = job?.status ?? run.status;
          const spinning = st === "running" || st === "queued";
          const bad = st === "failed" || st === "stuck";
          const usage = routineRunUsage(run);
          return (
            <button className={`run${bad ? " bad" : ""}`} key={run.jobId} onClick={() => void jumpToJob(r.assistantId, run.jobId!)}>
              <span className="rt">
                {fmtWhen(run.at)}
                {usage ? <small>{usage}</small> : null}
              </span>
              <Icon name={spinning ? "spin" : bad ? "close" : "check"} size={16} className={spinning ? "spin" : ""} />
            </button>
          );
        })
      ) : (
        <Empty>还没有运行记录</Empty>
      )}
      </div>

      <div className="group-card sidebar-card-group sidebar-danger" style={{ marginTop: 18 }}>
        <button
          className="hob-btn hob-btn-danger"
          onClick={async () => {
            if (!window.confirm(`删除定时任务「${r.name}」？已有的运行记录会保留在对话里。`)) return;
            await deleteRoutine(r.id);
            backPanel();
          }}
        >
          删除定时任务
        </button>
      </div>
    </>
  );
}

function useAssistantSave(aid: string) {
  const [message, setMessage] = useSaveMessage();
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<Assistant>) => {
    setBusy(true);
    const error = await patchAssistant(aid, patch);
    setBusy(false);
    setMessage(error ?? "已保存");
    return !error;
  };
  return { save, busy, message, fail: (error: string) => setMessage(error) };
}

function PanelSaveStatus({ message }: { message: string | null }) {
  return <SaveMessage message={message} />;
}

function PanelText({ value, multiline, placeholder, save }: { value: string; multiline?: boolean; placeholder?: string; save: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const props = { value: text, placeholder, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value), onBlur: () => { if (text !== value) void save(text).then((ok) => { if (!ok) setText(value); }); }, onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } } };
  return <label className="field">{multiline ? <textarea rows={2} {...props} /> : <input {...props} />}</label>;
}

function AssistantModels({ aid }: { aid: string }) {
  const s = useApp();
  const feedback = useAssistantSave(aid);
  const profile = s.profiles[aid];
  const [view, setView] = useState<ModelsView | null>(null);
  useEffect(() => {
    void loadModels().then(setView);
  }, []);
  const roster = s.settings.settings.models.roster;
  if (!profile) return null;
  const models = profile.assistant.models ?? {};
  const globals = s.settings.settings.models;
  const nameOf = (ref: string) => view?.models.find((model) => model.ref === ref)?.name ?? ref;
  const entryOf = (ref: string) => roster.find((entry) => entry.ref === ref);
  const save = (next: NonNullable<typeof models>) => void feedback.save({ models: next });

  const pick = (key: "conversation" | "work") => (ref: string) => {
    const next = { ...models };
    if (ref) {
      const fallback = key === "conversation" ? globals.conversation.thinking : globals.work.thinking;
      next[key] = { ref, thinking: fitThinking(view?.models.find((model) => model.ref === ref), entryOf(ref)?.thinking ?? fallback) };
    } else {
      delete next[key];
    }
    save(next);
  };

  const allowed = models.allowed ?? [];
  const restrict = (refs: string[]) => {
    const next = { ...models };
    if (refs.length) next.allowed = refs;
    else delete next.allowed;
    save(next);
  };

  const roleRow = (label: string, key: "conversation" | "work") => (
    <>
      <div className="lbl">{label}</div>
      <div className="ctl">
        <Select className="grow" aria-label={label} value={models[key]?.ref ?? ""} onChange={pick(key)} options={[{ value: "", label: `跟随全局（${nameOf(key === "conversation" ? globals.conversation.ref : globals.work.ref)}）` }, ...roster.map((entry) => ({ value: entry.ref, label: nameOf(entry.ref) }))]} />
      </div>
    </>
  );

  return (
    <>
      <PanelSaveStatus message={feedback.message} />
      {roleRow("对话模型", "conversation")}
      {roleRow("默认任务模型", "work")}

      <div className="lbl">可分派的模型</div>
      <div className="ctl">
        <button className={`hob-btn${allowed.length ? "" : " hob-btn-primary"}`} onClick={() => restrict([])}>
          全部
        </button>
        <button
          className={`hob-btn${allowed.length ? " hob-btn-primary" : ""}`}
          onClick={() => restrict(roster.map((entry) => entry.ref))}
        >
          指定
        </button>
        <span className="note" style={{ margin: 0 }}>
          {allowed.length ? `已选 ${allowed.length} 个` : `可用模型共 ${roster.length} 个`}
        </span>
      </div>
      {allowed.length ? (
        <div className="chips" style={{ marginTop: 8 }}>
          {roster.map((entry) => {
            const on = allowed.includes(entry.ref);
            return (
              <button
                key={entry.ref}
                className={`chip${on ? " on" : ""}`}
                onClick={() =>
                  restrict(on ? allowed.filter((ref) => ref !== entry.ref) : [...allowed, entry.ref])
                }
              >
                {nameOf(entry.ref)}
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function AssistantAbilities({ aid }: { aid: string }) {
  const s = useApp();
  const feedback = useAssistantSave(aid);
  const profile = s.profiles[aid];
  if (!profile) return null;
  const abilities = profile.assistant.abilities ?? { exec: true, write: true, image: true };
  // 设置里没有图像模型时，图像生成开关没有意义：显示成灰的，点了也没用
  const imageReady = s.settings.settings.image.source !== "off";
  const save = (patch: Partial<typeof abilities>) =>
    void feedback.save({ abilities: { ...abilities, ...patch } });

  const row = (label: string, on: boolean, onToggle: () => void, hint?: string) => (
    <>
      <div className="ctl">
        <span style={{ fontSize: 14 }}>{label}</span>
        <span className="sp" />
        <button className={`tog${on ? "" : " off"}`} title={on ? "关闭" : "开启"} onClick={onToggle} />
      </div>
      {hint ? <div className="note">{hint}</div> : null}
    </>
  );

  return (
    <>
      <PanelSaveStatus message={feedback.message} />
      {row("执行命令", abilities.exec, () => save({ exec: !abilities.exec }), "开启后，任务可以运行命令，并可通过命令访问网络。")}
      {row("修改文件", abilities.write, () => save({ write: !abilities.write }), "开启后，任务可以创建和修改文件。")}
      {imageReady ? (
        row(
          "图像生成",
          abilities.image,
          () => save({ image: !abilities.image }),
          "开启后，任务可以生成图片，图片以缩略图显示在对话中。",
        )
      ) : (
        <>
          <div className="ctl" style={{ marginTop: 8 }}>
            <span style={{ fontSize: 14, color: "var(--text3)" }}>图像生成</span>
            <span className="sp" />
            <button className="tog off" disabled title="需要先在 设置 → 图像生成 中完成配置" />
          </div>
          <div className="note">需要先在 设置 → 图像生成 中完成配置。</div>
        </>
      )}
      <div className="note">读取文件始终可用。</div>
    </>
  );
}

function SidebarLoading() {
  return <div className="sidebar-loading" role="status"><DelayedText text="正在加载…" /></div>;
}

function AssistantKnowledge({ aid }: { aid: string }) {
  const s = useApp();
  const feedback = useAssistantSave(aid);
  useEffect(() => { void loadKnowledge(); }, []);
  const ids = (s.profiles[aid]?.assistant.knowledge ?? []).filter((id) => s.knowledge.collections.some((collection) => collection.id === id));
  return <><PanelSaveStatus message={feedback.message} />
    {s.knowledge.error ? <div className="badline">加载失败：{s.knowledge.error} <button onClick={() => void loadKnowledge()}>重试</button></div> : null}
    {!s.knowledge.collectionsLoaded ? s.knowledge.error ? null : <SidebarLoading /> : s.knowledge.collections.length ? <div className="group-card sidebar-card-group card-rows">{s.knowledge.collections.map((collection) => <div className="ctl" key={collection.id}><span>{collection.name}</span><span className="sp" /><button className={`tog${ids.includes(collection.id) ? "" : " off"}`} aria-label={collection.name} aria-pressed={ids.includes(collection.id)} disabled={feedback.busy} onClick={() => void feedback.save({ knowledge: ids.includes(collection.id) ? ids.filter((id) => id !== collection.id) : [...ids, collection.id] })} /></div>)}</div> : <Empty action={{ label: "去知识库", onClick: openKnowledge }}>还没有知识库</Empty>}
  </>;
}

function AssistantSkills({ aid }: { aid: string }) {
  const state = useApp().assistantSkills[aid];
  const menu = useMenu();
  useEffect(() => { if (!state?.loading) void loadAssistantSkills(aid); }, [aid]);
  const selected = state?.skills.find((skill) => skill.name === menu.menu?.id);
  return <>{state?.error ? <div className="badline">加载失败：{state.error} <button onClick={() => void loadAssistantSkills(aid)}>重试</button></div> : null}
    {!state?.loaded ? state?.error ? null : <SidebarLoading /> : state.skills.length ? <div className="group-card sidebar-card-group card-rows">{state.skills.map((skill) => <div className="list-row assistant-skill" key={skill.name}>
      <button className="assistant-skill-info" onClick={() => openFilePreview(skill.path)} title={`${skill.description} · ${skillUsage(skill)}`}><strong>{skill.title}</strong><span>{skill.description} · {skillUsage(skill)}</span></button>
      <button className={`tog${skill.enabled ? "" : " off"}`} aria-label={skill.title} aria-pressed={skill.enabled} onClick={() => void changeAssistantSkill(aid, skill.name, skill.enabled ? "disable" : "enable")} />
      <button className="knowledge-dots" aria-label={`${skill.title}的操作`} onClick={(e) => menu.toggle(skill.name, e.currentTarget)}><Icon name="more" size={18} /></button>
    </div>)}</div> : <Empty>还没有技能。助手会把做成的事沉淀成技能，你也可以在任务详情里点「沉淀成技能」。</Empty>}
    {selected && menu.menu && createPortal(<div className="amenu knowledge-popup" ref={menu.box}>
      <button onClick={() => { menu.close(); openFilePreview(selected.path); }}>查看</button>
      {selected.version > 1 ? <button onClick={() => { menu.close(); void changeAssistantSkill(aid, selected.name, "rollback"); }}>回退到上一版</button> : null}
      <button onClick={() => { menu.close(); if (window.confirm(`删除「${selected.title}」？`)) void changeAssistantSkill(aid, selected.name, "delete"); }}>删除</button>
    </div>, document.body)}
  </>;
}

/** 换头像：自画的道具（有就排第一个）+ 内置道具，都按当前颜色预览，下面一排换颜色。 */
function SpritePicker({ aid, sprite, prop, onDone }: { aid: string; sprite: string; prop?: CustomProp; onDone: () => void }) {
  const feedback = useAssistantSave(aid);
  const parsed = parseSprite(sprite) ?? { prop: "hob" as const, color: "slate" as const };
  const pick = (next: string) => {
    if (next !== sprite) void feedback.save({ sprite: next });
  };
  return (
    <>
      <PanelSaveStatus message={feedback.message} />
      <div className="sprite-pick">
        {prop ? (
          <button
            className={parsed.prop === "custom" ? "on" : undefined}
            title="自画道具"
            onClick={() => pick(customSprite(parsed.color))}
          >
            <Avatar sprite={customSprite(parsed.color)} prop={prop} size={34} />
          </button>
        ) : null}
        {PROP_IDS.map((p) => (
          <button
            key={p}
            className={p === parsed.prop ? "on" : undefined}
            title={PROPS[p].label}
            onClick={() => pick(spriteId(p, parsed.color))}
          >
            <Avatar sprite={spriteId(p, parsed.color)} size={34} />
          </button>
        ))}
      </div>
      <div className="sprite-colors">
        {COLOR_IDS.map((c) => (
          <button
            key={c}
            className={c === parsed.color ? "on" : undefined}
            title={COLORS[c].name}
            style={{ background: COLORS[c].o }}
            onClick={() => pick(parsed.prop === "custom" ? customSprite(c) : spriteId(parsed.prop, c))}
          />
        ))}
        <button className="hob-btn" onClick={onDone}>
          完成
        </button>
      </div>
    </>
  );
}

function RuleRow({ aid, rule }: { aid: string; rule: Rule }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.text);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useSaveMessage();
  const cancel = useRef(false);
  const save = async (patch: { text?: string; mode?: "ask" | "allow" }) => {
    setBusy(true);
    const error = await updateRule(aid, { id: rule.id, ...patch });
    setBusy(false);
    setMessage(error ?? "已保存");
    if (!error) setEditing(false);
  };
  const commitText = () => {
    if (cancel.current) { cancel.current = false; return; }
    const value = text.trim();
    if (value === rule.text) { setEditing(false); return; }
    if (!value) { setMessage("规则内容不能为空。"); return; }
    void save({ text: value });
  };
  return (
    <div className="rule-wrap">
      <div className="rule">
        {editing ? (
          <input className="rule-input" autoFocus value={text} maxLength={1000} disabled={busy}
            onChange={(e) => setText(e.target.value)} onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") { cancel.current = true; setText(rule.text); setEditing(false); }
            }} />
        ) : (
          <button className="rule-text" onClick={() => { cancel.current = false; setText(rule.text); setEditing(true); }} disabled={busy} title="编辑规则">{rule.text}</button>
        )}
        <span className="v">
          <button className={`rule-mode ${rule.mode}`} disabled={busy} onClick={() => void save({ mode: rule.mode === "ask" ? "allow" : "ask" })} title="切换确认方式">{rule.mode === "ask" ? "需确认" : "直接执行"}</button>
          <button className="del" title="删除这条规则" disabled={busy} onClick={() => setConfirming(true)}><Icon name="close" size={13} /></button>
        </span>
      </div>
      {message ? <SaveMessage message={message} /> : null}
    </div>
  );
}

function RuleCreator({ aid }: { aid: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"ask" | "allow">("ask");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useSaveMessage();
  const cancel = () => { setEditing(false); setText(""); setMode("ask"); setMessage(null); };
  const save = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setMessage(null);
    const error = await addRule(aid, text.trim(), mode);
    setBusy(false);
    if (error) { setMessage(error); return; }
    setText("");
    setMode("ask");
    setEditing(false);
    setMessage("已保存");
  };
  return <div className="rule-wrap">
    {editing ? <form className="rule-new" onSubmit={(e) => { e.preventDefault(); void save(); }} onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); cancel(); } }}>
      <input className="rule-input" autoFocus aria-label="规则文字" placeholder="输入规则内容" maxLength={1000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
      <div className="ctl">
        <Select aria-label="规则确认方式" value={mode} disabled={busy} onChange={(value) => setMode(value as "ask" | "allow")} options={[{ value: "ask", label: "需确认" }, { value: "allow", label: "直接执行" }]} />
        <span className="sp" />
        <button type="button" className="hob-btn" disabled={busy} onClick={cancel}>取消</button>
        <button type="submit" className="hob-btn hob-btn-primary" disabled={busy || !text.trim()}>{busy ? "正在保存…" : "保存"}</button>
      </div>
    </form> : <button className="rule-add" onClick={() => { setMessage(null); setEditing(true); }}>＋ 新增规则</button>}
    {message ? <SaveMessage message={message} /> : null}
  </div>;
}

function AssistantSettings() {
  const s = useApp();
  const aid = panelAssistant(s.panelStack, s.sel);
  const profile = s.profiles[aid];
  const [picking, setPicking] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const feedback = useAssistantSave(aid);
  if (!profile) return <Empty><DelayedText text="正在读取档案…" /></Empty>;
  const a = profile.assistant;

  return (
    <>
      <div className="pgroup">
        <div className="bigav">
          <Avatar sprite={a.sprite} prop={a.prop} size={96} motion="home" onClick={() => setPicking((v) => !v)} title="换头像" />
        </div>
        <div className="avatar-hint">点头像更换</div>
        {picking ? <SpritePicker aid={aid} sprite={a.sprite} prop={a.prop} onDone={() => setPicking(false)} /> : null}

        <PanelSaveStatus message={feedback.message} />
        <div className="sech"><span>基本信息</span></div>
        <div className="group-card sidebar-card-group">
        <div className="lbl">名字</div>
        <PanelText value={a.name} save={(name) => {
          if (name.trim()) return feedback.save({ name: name.trim() });
          feedback.fail("名字不能为空。");
          return Promise.resolve(false);
        }} />

        <div className="lbl">职责简介</div>
        <PanelText value={a.duty} save={(duty) => feedback.save({ duty })} />

        <div className="lbl">详细职责</div>
        <PanelText multiline value={a.dutyLong ?? ""} save={(dutyLong) => feedback.save({ dutyLong })} />

        <div className="lbl">补充说明</div>
        <PanelText multiline value={a.instructions} placeholder="记下这个助手要知道的事实，如“周报发到团队群”" save={(instructions) => feedback.save({ instructions })} />
        </div>
      </div>

      <div className="pgroup">
        <div className="sech">
          <span>模型</span>
        </div>
        <div className="group-card sidebar-card-group"><AssistantModels aid={aid} /></div>
        <div className="sech"><span>能力</span></div>
        <div className="group-card sidebar-card-group"><AssistantAbilities aid={aid} /></div>
      </div>

      <div className="pgroup">
        <div className="sech">
          <span>通知与位置</span>
        </div>

        <div className="group-card sidebar-card-group">
        <div className="lbl">通知</div>
        <div className="ctl">
          <span style={{ fontSize: 14 }}>需要确认时通知我</span>
          <span className="sp" />
          <button
            className={`tog${a.notify ? "" : " off"}`}
            title={a.notify ? "关闭通知" : "开启通知"}
            disabled={feedback.busy}
            onClick={() => void feedback.save({ notify: !a.notify })}
          />
        </div>
        <div className="note">要在手机上接收推送，请先在 设置 → 通知 中开启本机推送。</div>

        {a.primary ? null : (
          <>
            <div className="lbl">位置</div>
            <div className="ctl">
              <span style={{ fontSize: 14 }}>放在顶部</span>
              <span className="sp" />
              <button
                className={`tog${a.pinned ? "" : " off"}`}
                title={a.pinned ? "取消置顶" : "放在顶部"}
                disabled={feedback.busy}
                onClick={() => void feedback.save({ pinned: !a.pinned })}
              />
            </div>
          </>
        )}

        {a.primary ? null : <div className="mergebar"><button className="hob-btn" onClick={() => void feedback.save({ hidden: !a.hidden })}>{a.hidden ? "放回列表" : "收起这个助手"}</button></div>}
        </div>
      </div>
      {a.primary ? null : (
        <div className="pgroup">
          <div className="sech"><span>危险操作</span></div>
          <div className="mergebar sidebar-group">
            {archiving ? (
              <div className="mergeconfirm">
                归档「{a.name}」？它会从列表中移除，定时任务一并停掉。对话、规则和历史任务都留着，不会转给 Hob。
                <div className="acts">
                  <button className="hob-btn hob-btn-primary" onClick={() => void archiveAssistant(aid)}>
                    确认归档
                  </button>
                  <button className="hob-btn" onClick={() => setArchiving(false)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button className="hob-btn hob-btn-danger" onClick={() => setArchiving(true)}>
                归档这个助手
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
