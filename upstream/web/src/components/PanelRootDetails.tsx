import { DelayedText, Empty } from "./Empty.tsx";
import { useEffect, useRef, useState } from "react";
import { fileIcon } from "../file-icons.ts";
import { Icon } from "../icons.tsx";
import { jobStatusIcon } from "./status-meta.tsx";
import { groupSidebarFiles, routineSummary, sidebarInfoValues } from "../sidebar-data.ts";
import { loadAssistantSkills, loadSidebarCollections, loadSidebarFiles, loadSidebarJobs, openAssistantPanel, openFilePreview, openJob, openSidebarPage, useApp } from "../store.ts";
import { fmtBytes, fmtDuration, fmtElapsed, fmtWhen } from "../util.ts";

function LoadingRow() { return <div className="sidebar-loading" role="status"><DelayedText text="正在读取…" /></div>; }

export function PanelRootDetails() {
  const s = useApp();
  const aid = s.sel ?? "hob";
  const profile = s.profiles[aid];
  const a = profile?.assistant ?? s.assistants.find((item) => item.id === aid);
  const routines = s.routines.filter((item) => item.assistantId === aid);
  const skills = s.assistantSkills[aid];
  const [tab, setTab] = useState<"任务" | "文件">("任务");
  const [collectionsError, setCollectionsError] = useState("");
  const [collectionsLoading, setCollectionsLoading] = useState(!s.knowledge.collectionsLoaded);
  const jobsPage = s.sidebarJobs?.[aid];
  const filesPage = s.sidebarFiles?.[aid];
  const files = filesPage?.items ?? [];
  const jobs = Object.values({ ...Object.fromEntries((jobsPage?.items ?? []).map((job) => [job.id, job])), ...s.jobs }).filter((job) => job.assistantId === aid).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const seenJobs = useRef<{ aid: string; ids: Set<string> } | null>(null);
  const jobsReady = useRef(false);
  if (!seenJobs.current || seenJobs.current.aid !== aid) { seenJobs.current = { aid, ids: new Set() }; jobsReady.current = false; }
  const freshJobs = jobsPage?.loaded ? new Set(jobs.filter((job) => !seenJobs.current!.ids.has(job.id)).map((job) => job.id)) : new Set<string>();
  useEffect(() => { if (!jobsPage?.loaded) { jobsReady.current = false; return; } jobs.forEach((job) => seenJobs.current?.ids.add(job.id)); jobsReady.current = true; });
  useEffect(() => { setTab("任务"); void loadAssistantSkills(aid); void loadSidebarJobs(aid); }, [aid]);
  useEffect(() => { void loadSidebarCollections().catch((e: unknown) => setCollectionsError(e instanceof Error ? e.message : String(e))).finally(() => setCollectionsLoading(false)); }, []);
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
  const values = sidebarInfoValues(skills?.skills.length ?? 0, collections, profile?.rules.length ?? 0);
  const groups = groupSidebarFiles(files);
  return <>
    <div className="group-card sidebar-info">
      <button className="sidebar-instructions" onClick={openAssistantPanel}><small>补充说明</small><span className={a?.instructions ? "" : "muted"}>{a?.instructions || "记下这个助手要知道的事实"}</span><b>›</b></button>
      <button onClick={() => openSidebarPage("routines")}><Icon name="clock" size={15} /><span>定时任务</span><small>{routineSummary(routines, s.settings.settings.general.timezone)}</small><b>›</b></button>
      <button onClick={() => openSidebarPage("skills")}><Icon name="mem" size={15} /><span>技能</span><small>{skills?.error ? "加载失败" : !skills?.loaded ? <DelayedText key={aid} text="正在加载…" /> : values.skills}</small><b>›</b></button>
      <button onClick={() => openSidebarPage("knowledge")}><Icon name="archive" size={15} /><span>知识库</span><small>{collectionsError ? "加载失败" : collectionsLoading ? <DelayedText text="正在加载…" /> : values.knowledge}</small><b>›</b></button>
      <button onClick={() => openSidebarPage("rules")}><Icon name="rule" size={15} /><span>执行前确认</span><small>{values.rules}</small><b>›</b></button>
    </div>
    <div className="sidebar-tabs"><div className="seg" style={{ "--seg-count": 2, "--seg-index": ["任务", "文件"].indexOf(tab) } as React.CSSProperties}>{(["任务", "文件"] as const).map((name) => <button key={name} className={tab === name ? "on" : ""} onClick={() => setTab(name)}>{name}</button>)}</div></div>
    <div key={tab} className="sidebar-tab-content"><div className="group-card sidebar-list">
      {tab === "任务" ? jobs.map((job) => <div className={`srow${jobsReady.current && freshJobs.has(job.id) ? " enter" : ""}`} key={job.id}><div className="srowclip"><button className="list-row sidebar-row" onClick={() => openJob(job.id)}>{jobStatusIcon(job.status, 16)}<span><strong>{job.routineId ? "⏱ " : ""}{job.title}</strong><small>{fmtWhen(job.startedAt ?? job.createdAt)}{job.status === "running" || job.status === "waiting" ? ` · 已进行 ${fmtElapsed(job.startedAt ?? job.createdAt)}` : job.durationMs !== undefined ? ` · 用时 ${fmtDuration(job.durationMs)}` : ""}</small></span><b>›</b></button></div></div>) : ([['本周', groups.week], ['更早', groups.older]] as const).map(([label, items]) => items.length ? <div key={label}><div className="sidebar-group-label">{label}</div>{items.map((entry) => <button className="list-row sidebar-row" key={entry.id} onClick={() => openFilePreview(entry.path, entry.name)}><Icon name={fileIcon(entry.name)} size={18} /><span><strong>{entry.name}</strong><small>{fmtBytes(entry.size)} · {fmtWhen(entry.updatedAt)}</small></span><b>›</b></button>)}</div> : null)}
      {page?.loaded && !(tab === "任务" ? jobs.length : files.length) && !page.error ? <Empty>{tab === "任务" ? "分派的任务会显示在这里" : "还没有产出文件"}</Empty> : null}
      {page?.error ? <div className="badline">加载失败：{page.error} <button onClick={() => void (tab === "任务" ? loadSidebarJobs(aid, page.failedMore) : loadSidebarFiles(aid, page.failedMore))}>重试</button></div> : null}
      {(!page?.loaded && !page?.error) || page?.loadingMore ? <LoadingRow /> : null}
      {page?.hasMore && !page.error ? <div ref={sentinel} /> : null}
    </div></div>
  </>;
}
