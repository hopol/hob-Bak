import { byStarted } from "../home.ts";
import { panelAssistant } from "../panel-stack.ts";
import { DelayedText, Empty } from "./Empty.tsx";
import { useEffect, useRef, useState } from "react";
import { fileIcon } from "../file-icons.ts";
import { Icon } from "../icons.tsx";
import { jobStatusIcon } from "./status-meta.tsx";
import { DetailRow } from "./DetailRow.tsx";
import { groupSidebarFiles, routineSummary, sidebarInfoValues } from "../sidebar-data.ts";
import { loadAssistantSkills, loadGroupProfile, loadSidebarCollections, loadSidebarFiles, loadSidebarJobs, openAssistantPanel, openGroupSettings, openFilePreview, openJob, openSidebarPage, useApp } from "../store.ts";
import { fmtBytes, fmtDuration, fmtElapsed, fmtWhen } from "../util.ts";

function LoadingRow() { return <div className="sidebar-loading" role="status"><DelayedText text="正在读取…" /></div>; }

export function PanelRootDetails({ groupId, part }: { groupId?: string; part?: "info" | "tabs" } = {}) {
  const s = useApp();
  const aid = groupId ?? panelAssistant(s.panelStack, s.sel);
  const group = groupId ? s.groups.find((item) => item.id === groupId) : undefined;
  const groupProfile = groupId ? s.groupProfiles[groupId] : undefined;
  const profile = s.profiles[aid];
  const a = profile?.assistant ?? s.assistants.find((item) => item.id === aid);
  const routines = s.routines.filter((item) => groupId ? item.groupId === groupId || s.groups.some((g) => g.id === item.groupId && g.parentId === groupId) : item.assistantId === aid && !item.groupId);
  const skills = s.assistantSkills[aid];
  const [tab, setTab] = useState<"任务" | "文件">("任务");
  const [collectionsError, setCollectionsError] = useState("");
  const [collectionsLoading, setCollectionsLoading] = useState(!s.knowledge.collectionsLoaded);
  const jobsPage = s.sidebarJobs?.[aid];
  const filesPage = s.sidebarFiles?.[aid];
  const files = filesPage?.items ?? [];
  const jobs = Object.values({ ...Object.fromEntries((jobsPage?.items ?? []).map((job) => [job.id, job])), ...s.jobs }).filter((job) => groupId ? job.groupId === groupId || s.groups.some((g) => g.id === job.groupId && g.parentId === groupId) : job.assistantId === aid && !job.groupId).sort(byStarted);
  const seenJobs = useRef<{ aid: string; ids: Set<string> } | null>(null);
  const jobsReady = useRef(false);
  if (!seenJobs.current || seenJobs.current.aid !== aid) { seenJobs.current = { aid, ids: new Set() }; jobsReady.current = false; }
  const freshJobs = jobsPage?.loaded ? new Set(jobs.filter((job) => !seenJobs.current!.ids.has(job.id)).map((job) => job.id)) : new Set<string>();
  useEffect(() => { if (!jobsPage?.loaded) { jobsReady.current = false; return; } jobs.forEach((job) => seenJobs.current?.ids.add(job.id)); jobsReady.current = true; });
  useEffect(() => { setTab("任务"); if (part !== "tabs") { void loadAssistantSkills(aid); if (groupId) void loadGroupProfile(groupId); } if (part !== "info") void loadSidebarJobs(aid); }, [aid, groupId, part]);
  useEffect(() => { if (!groupId && !s.knowledge.collectionsLoaded) { setCollectionsLoading(true); setCollectionsError(""); void loadSidebarCollections().catch((e: unknown) => setCollectionsError(e instanceof Error ? e.message : String(e))).finally(() => setCollectionsLoading(false)); } }, [groupId, s.knowledge.collectionsLoaded]);
  useEffect(() => { if (tab === "文件") void loadSidebarFiles(aid); }, [aid, tab]);
  const page = tab === "任务" ? jobsPage : filesPage;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !page?.hasMore || page.loading || page.error) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void (tab === "任务" ? loadSidebarJobs(aid, true) : loadSidebarFiles(aid, true)); }, { root: element.closest(".panel") });
    observer.observe(element);
    return () => observer.disconnect();
  }, [aid, tab, page?.hasMore, page?.loading, page?.error, page?.cursor]);
  const collections = (a?.knowledge ?? []).map((id) => s.knowledge.collections.find((c) => c.id === id)?.name).filter((name): name is string => !!name);
  const values = sidebarInfoValues(skills?.skills.length ?? 0, collections, groupId ? groupProfile?.value?.rules.length ?? 0 : profile?.rules.length ?? 0);
  const groups = groupSidebarFiles(files);
  return <>
    {part !== "tabs" ? <div className="group-card sidebar-info">
      <button className="sidebar-instructions" onClick={() => groupId ? openGroupSettings(groupId) : openAssistantPanel()}><small>补充说明</small><span className={(groupId ? group?.instructions : a?.instructions) ? "" : "muted"}>{(groupId ? group?.instructions : a?.instructions) || (groupId ? "记下这个群要知道的事实" : "记下这个助手要知道的事实")}</span><b>›</b></button>
      <button onClick={() => openSidebarPage("routines", groupId)}><Icon name="clock" size={15} /><span>定时任务</span><small>{routineSummary(routines, s.settings.settings.general.timezone)}</small><b>›</b></button>
      <button onClick={() => openSidebarPage("skills", groupId)}><Icon name="mem" size={15} /><span>技能</span><small>{skills?.error ? "加载失败" : !skills?.loaded ? <DelayedText key={aid} text="正在加载…" /> : values.skills}</small><b>›</b></button>
      {!groupId ? <button onClick={() => openSidebarPage("knowledge")}><Icon name="archive" size={15} /><span>知识库</span><small>{collectionsError ? "加载失败" : collectionsLoading ? <DelayedText text="正在加载…" /> : values.knowledge}</small><b>›</b></button> : null}
      <button onClick={() => openSidebarPage("rules", groupId)}><Icon name="rule" size={15} /><span>执行前确认</span><small>{groupId && groupProfile?.error ? "加载失败" : groupId && !groupProfile?.value ? <DelayedText text="正在加载…" /> : values.rules}</small><b>›</b></button>
    </div> : null}
    {part !== "info" ? <>
    <div className="sidebar-tabs"><div className="seg" style={{ "--seg-count": 2, "--seg-index": ["任务", "文件"].indexOf(tab) } as React.CSSProperties}>{(["任务", "文件"] as const).map((name) => <button key={name} className={tab === name ? "on" : ""} onClick={() => setTab(name)}>{name}</button>)}</div></div>
    <div key={tab} className="sidebar-tab-content"><div className="group-card sidebar-list">
      {tab === "任务" ? jobs.map((job) => <div className={`srow${jobsReady.current && freshJobs.has(job.id) ? " enter" : ""}`} key={job.id}><div className="srowclip"><DetailRow leading={jobStatusIcon(job.status, 16)} title={<>{job.routineId ? "⏱ " : ""}{job.title}</>} detail={`${groupId ? `${s.assistants.find((item) => item.id === job.assistantId)?.name ?? job.assistantName ?? job.assistantId} · ` : ""}${fmtWhen(job.startedAt ?? job.createdAt)}${job.status === "running" || job.status === "waiting" ? ` · 已进行 ${fmtElapsed(job.startedAt ?? job.createdAt)}` : job.durationMs !== undefined ? ` · 用时 ${fmtDuration(job.durationMs)}` : ""}`} onClick={() => openJob(job.id)} /></div></div>) : ([['本周', groups.week], ['更早', groups.older]] as const).map(([label, items]) => items.length ? <div key={label}><div className="sidebar-group-label">{label}</div>{items.map((entry) => <DetailRow key={entry.id} leading={<Icon name={fileIcon(entry.name)} size={18} />} title={entry.name} detail={`${fmtBytes(entry.size)} · ${fmtWhen(entry.updatedAt)}`} onClick={() => openFilePreview(entry.path, entry.name)} />)}</div> : null)}
      {page?.loaded && !(tab === "任务" ? jobs.length : files.length) && !page.error ? <Empty>{tab === "任务" ? "分派的任务会显示在这里" : "还没有产出文件"}</Empty> : null}
      {page?.error ? <div className="badline">加载失败：{page.error} <button onClick={() => void (tab === "任务" ? loadSidebarJobs(aid, page.failedMore) : loadSidebarFiles(aid, page.failedMore))}>重试</button></div> : null}
      {(!page?.loaded && !page?.error) || page?.loadingMore ? <LoadingRow /> : null}
      {page?.hasMore && !page.error ? <div ref={sentinel} /> : null}
    </div></div></> : null}
  </>;
}
