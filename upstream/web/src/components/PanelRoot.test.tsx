import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Job } from "../../../shared/types.ts";

const data = vi.hoisted(() => ({
  sel: "hob", panelStack: [], nowWide: false,
  assistants: [{ id: "hob", name: "Hob", duty: "主助手", sprite: "hob", knowledge: [], busy: false }],
  profiles: { hob: { assistant: { id: "hob", name: "Hob", duty: "主助手", sprite: "hob", knowledge: [], busy: false }, rules: [], worklog: [] } },
  jobs: {} as Record<string, Job>, routines: [] as any[], approvals: {} as Record<string, any>, delegations: {} as Record<string, any>, assistantSkills: { hob: { loading: false, loaded: true, skills: [] as any[], error: null as string | null } },
  knowledge: { collections: [] as any[], collectionsLoaded: false, loading: false, error: null as string | null }, settings: { settings: { general: { timezone: "UTC" } } },
}));
vi.mock("../store.ts", () => ({ useApp: () => data, openAssistantPanel: vi.fn(), collapsePanel: vi.fn(), openNewRoutine: vi.fn(), openJob: vi.fn(), openJobs: vi.fn(), openSidebarPage: vi.fn(), openFilePreview: vi.fn(), jumpToDelegation: vi.fn(), setNotice: vi.fn(), updateRule: vi.fn(), runRoutine: vi.fn(), saveRoutine: vi.fn(), showNowWide: vi.fn(), setNowWide: vi.fn(), toggleNowWide: vi.fn() }));
vi.mock("../desktop-screens.ts", () => ({ useDesktopScreens: () => ({ profiles: { hob: "screen-a" }, screens: [{ id: "screen-a", running: true, browserRunning: true, viewers: 0, lastActiveAt: null }] }) }));
vi.mock("./PanelHead.tsx", () => ({ PanelHead: ({ children }: { children: React.ReactNode }) => <header>{children}</header>, CollapsePanelButton: () => <button title="收起右栏" /> }));
vi.mock("./use-menu.ts", () => ({ useMenu: () => ({ menu: null }) }));
vi.mock("../sprites.tsx", () => ({ Avatar: () => <span>头像</span> }));
import { Panel } from "./Panel.tsx";
const job = (status: Job["status"]): Job => ({ id: "j", assistantId: "hob", title: "示例任务", instruction: "", status, createdAt: "2026-01-01T00:00:00Z", endedAt: status === "done" ? "2026-01-01T01:00:00Z" : undefined, stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });

beforeEach(() => { data.nowWide = false; data.jobs = {}; data.routines = []; data.approvals = {}; data.delegations = {}; data.profiles.hob.assistant.busy = false; });
it("助手自己工作时显示执行中但不显示命令行", () => { data.profiles.hob.assistant.busy = true; const html = renderToStaticMarkup(<Panel page={null} />); expect(html).toContain("执行中"); expect(html).not.toContain('class="screen '); });
it("等待确认和排队不显示命令行", () => { data.jobs = { j: job("queued") }; data.approvals = { p: { assistantId: "hob", status: "pending" } }; const waiting = renderToStaticMarkup(<Panel page={null} />); expect(waiting).toContain("等你确认"); expect(waiting).not.toContain('class="screen '); data.approvals = {}; const queued = renderToStaticMarkup(<Panel page={null} />); expect(queued).toContain("排队中"); expect(queued).not.toContain('class="screen '); });
it("运行中显示小屏和说明", () => { data.jobs = { j: job("running") }; const html = renderToStaticMarkup(<Panel page={null} />); expect(html).toContain('class="screen '); expect(html).toContain("任务详情"); expect(html).toContain("执行中"); });
it("运行中的云桌面显示侧栏展开按钮", () => {
  const html = renderToStaticMarkup(<Panel page={null} />);
  expect(html).toContain('aria-label="在侧栏展开"');
});
it("展开后只显示桌面与正在运行任务，收起后恢复根页", () => {
  data.jobs = { j: job("running") };
  data.nowWide = true;
  const focused = renderToStaticMarkup(<Panel page={null} />);
  expect(focused).toContain('class="focus-desktop"');
  expect(focused).toContain('title="缩小右栏"');
  expect(focused.match(/title="收起右栏"/g)).toHaveLength(1);
  expect(focused).toContain('class="focus-job"');
  expect(focused).toContain("示例任务");
  expect(focused).not.toContain('class="sidebar-card"');
  expect(focused).not.toContain('class="screen strip"');
  data.nowWide = false;
  const normal = renderToStaticMarkup(<Panel page={null} />);
  expect(normal).toContain("sidebar-card");
  expect(normal).toContain("任务详情");
});

it("空闲显示上次和下一次", () => { data.jobs = { j: job("done") }; data.routines = [{ id: "r", assistantId: "hob", name: "每日简报", schedules: ["0 9 * * *"], active: true }]; const html = renderToStaticMarkup(<Panel page={null} />); expect(html).not.toContain('class="screen '); expect(html).toContain("上次"); expect(html).toContain("下一次"); });
it("助手设置不显示补充说明", () => { const html = renderToStaticMarkup(<Panel page={null} />); expect(html).not.toContain("记下这个助手要知道的事实"); });
it("主助手显示转交", () => { data.delegations = { d: { id: "d", from: "hob", to: "someone", status: "waiting" } }; const html = renderToStaticMarkup(<Panel page={null} />); expect(html).toContain("交给「someone」"); expect(html).toContain("等你确认"); });
it("已有知识库时刷新仍显示列表", () => {
  data.knowledge = { collections: [{ id: "k", name: "项目资料" }], collectionsLoaded: true, loading: true, error: null };
  const html = renderToStaticMarkup(<Panel page={{ kind: "knowledge" }} />);
  expect(html).toContain("项目资料");
  expect(html).not.toContain("正在加载…");
  data.knowledge.error = "网络错误";
  const failed = renderToStaticMarkup(<Panel page={{ kind: "knowledge" }} />);
  expect(failed).toContain("项目资料");
  expect(failed).toContain("加载失败：网络错误");
});
it("已有技能时刷新仍显示列表", () => {
  data.assistantSkills.hob = { loading: true, loaded: true, error: null, skills: [{ name: "brief", title: "每日简报", description: "整理动态", path: "/brief", uses: 0, version: 1, enabled: true }] };
  const html = renderToStaticMarkup(<Panel page={{ kind: "skills" }} />);
  expect(html).toContain("每日简报");
  expect(html).not.toContain("正在加载…");
  data.assistantSkills.hob.error = "网络错误";
  const failed = renderToStaticMarkup(<Panel page={{ kind: "skills" }} />);
  expect(failed).toContain("每日简报");
  expect(failed).toContain("加载失败：网络错误");
  data.assistantSkills.hob = { loading: true, loaded: true, error: null, skills: [] };
  const empty = renderToStaticMarkup(<Panel page={{ kind: "skills" }} />);
  expect(empty).toContain("还没有技能");
  expect(empty).not.toContain("正在加载…");
});
it("停止任务的上次显示状态和知识库加载状态", () => {
  data.jobs = { j: { ...job("stopped"), endedAt: "2026-01-01T01:00:00Z" } };
  const html = renderToStaticMarkup(<Panel page={null} />);
  expect(html).toContain("上次");
  expect(html).not.toContain("正在加载…");
  expect(html).not.toContain(">日志</button>");
});
