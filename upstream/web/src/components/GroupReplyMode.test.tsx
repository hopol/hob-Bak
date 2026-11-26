import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupSummary } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({
  sel: "hob" as string | null,
  gsel: "g-1" as string | null,
  panelStack: [] as any[],
  nowWide: false,
  sideCollapsed: false,
  collapsed: false,
  files: [] as any[],
  uploading: 0,
  sending: false,
  section: "general" as const,
  gen: {} as Record<string, number>,
  groupGen: {} as Record<string, number>,
  groupPages: {} as Record<string, any>,
  itemPages: {} as Record<string, any>,
  groupMore: {} as Record<string, boolean>,
  more: {} as Record<string, boolean>,
  olderLoading: {} as Record<string, boolean>,
  groupOlderLoading: {} as Record<string, boolean>,
  hasMoreItems: {} as Record<string, boolean>,
  hasMoreGroupItems: {} as Record<string, boolean>,
  loadingOlder: {} as Record<string, boolean>,
  loadingOlderGroup: {} as Record<string, boolean>,
  items: {} as Record<string, any[]>,
  groupItems: { "g-1": [], "t-1": [] } as Record<string, any[]>,
  loading: {} as Record<string, boolean>,
  hasMore: {} as Record<string, boolean>,
  pending: {} as Record<string, any[]>,
  assistants: [
    { id: "hob", name: "Hob", duty: "主助手", sprite: "hob", primary: true, knowledge: [], busy: false, unread: 0, pinned: false, hidden: false, notify: false, createdAt: "2026-01-01T00:00:00Z" } as any,
    { id: "m1", name: "产品", duty: "需求分析", sprite: "page", primary: false, knowledge: [], busy: false, unread: 0, pinned: false, hidden: false, notify: false, createdAt: "2026-01-01T00:00:00Z" } as any,
  ],
  groups: [] as GroupSummary[],
  groupProfiles: {} as Record<string, any>,
  profiles: {} as Record<string, any>,
  jobs: {} as Record<string, any>,
  routines: [] as any[],
  approvals: {} as Record<string, any>,
  delegations: {} as Record<string, any>,
  cards: {} as Record<string, any>,
  drafts: {} as Record<string, any>,
  livePages: {} as Record<string, any>,
  stars: [] as any[],
  assistantSkills: { "g-1": { loading: false, loaded: true, skills: [], error: null } } as Record<string, any>,
  knowledge: { collections: [], collectionsLoaded: true, loading: false, error: null },
  plugins: { loaded: true, loading: false, error: null, items: [] },
  settings: {
    settings: {
      general: { timezone: "Asia/Shanghai" },
      models: { conversation: { ref: "p/m", thinking: "low" }, work: { ref: "p/m", thinking: "low" }, roster: [{ ref: "p/m", note: "" }] },
      image: { source: "off" },
      providers: [{ kind: "builtin", id: "p" }],
    },
  },
  replyMenuOpen: false,
  patchGroup: vi.fn(async () => null),
}));

vi.mock("../store.ts", () => ({
  useApp: () => state,
  composerDraft: () => ({ text: "", quote: null, attachments: [] }),
  groupById: (s: any, id: string | null) => s.groups.find((g: any) => g.id === id),
  groupChatItems: (s: any, id: string) => s.groupItems[id] ?? [],
  chatItems: (s: any, id: string | null) => (id ? s.items[id] ?? [] : []),
  groupSpeaking: () => [],
  openAssistantPanel: vi.fn(),
  openGroupSettings: vi.fn(),
  openMemberPanel: vi.fn(),
  archiveGroup: vi.fn(),
  archiveAssistant: vi.fn(),
  patchGroup: state.patchGroup,
  patchAssistant: vi.fn(),
  patchGroupMemberModels: vi.fn(),
  loadModels: vi.fn(async () => ({ models: [], updatedAt: null, error: null })),
  loadPlugins: vi.fn(async () => undefined),
  loadGroupProfile: vi.fn(async () => undefined),
  loadAssistantSkills: vi.fn(async () => undefined),
  loadKnowledge: vi.fn(async () => undefined),
  collapsePanel: vi.fn(),
  expandPanel: vi.fn(),
  toggleSideCollapsed: vi.fn(),
  openNewRoutine: vi.fn(),
  openJob: vi.fn(),
  openJobs: vi.fn(),
  openSidebarPage: vi.fn(),
  openFilePreview: vi.fn(),
  openKnowledge: vi.fn(),
  openSettings: vi.fn(),
  jumpToDelegation: vi.fn(),
  setNotice: vi.fn(),
  setText: vi.fn(),
  setQuote: vi.fn(),
  setSection: vi.fn(),
  selectGroup: vi.fn(),
  leaveChat: vi.fn(),
  send: vi.fn(),
  stopAssistant: vi.fn(),
  stopGroup: vi.fn(),
  attach: vi.fn(),
  removeAttachment: vi.fn(),
  loadOlderItems: vi.fn(),
  loadOlderGroupItems: vi.fn(),
  photoUrl: (p: string) => p,
  focusComposer: vi.fn(),
  updateRule: vi.fn(),
  runRoutine: vi.fn(),
  saveRoutine: vi.fn(),
  showNowWide: vi.fn(),
  setNowWide: vi.fn(),
  toggleNowWide: vi.fn(),
  closeTopic: vi.fn(async () => null),
  reopenTopic: vi.fn(async () => null),
  openSheet: vi.fn(),
  pendingKeyOf: () => "group:g-1",
  pendingOf: () => undefined,
}));

vi.mock("../desktop-screens.ts", () => ({ useDesktopScreens: () => ({ profiles: {}, screens: [] }) }));
vi.mock("./PanelHead.tsx", () => ({ PanelHead: ({ children }: { children: React.ReactNode }) => <header>{children}</header>, CollapsePanelButton: () => <button title="收起右栏" /> }));
vi.mock("./use-menu.ts", () => {
  let callIndex = 0;
  return {
    useMenu: () => {
      const idx = callIndex++;
      // GroupPanel 里第 1 次是成员菜单，第 2 次是「没点名时」菜单
      const isReplyMenu = idx % 2 === 1;
      return {
        menu: isReplyMenu && state.replyMenuOpen ? { id: "replyMode", anchor: null } : null,
        box: { current: null },
        toggle: vi.fn(),
        close: vi.fn(),
      };
    },
  };
});
vi.mock("../sprites.tsx", () => ({ Avatar: () => <span>头像</span> }));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: unknown) => node,
}));

import { Panel } from "./Panel.tsx";
import { Chat } from "./Chat.tsx";

const makeGroup = (overrides: Partial<GroupSummary> = {}): GroupSummary => ({
  id: "g-1",
  name: "顾问群",
  purpose: "多角度评审",
  ownerId: "hob",
  members: ["hob", "m1"],
  createdAt: "2026-01-01T00:00:00Z",
  unread: 0,
  busy: [],
  ...overrides,
});

describe("群和话题「全员回应」界面", () => {
  beforeEach(() => {
    state.replyMenuOpen = false;
    state.gsel = "g-1";
    state.panelStack = [];
    state.groups = [
      makeGroup({ id: "g-1", replyMode: "owner" }),
      makeGroup({ id: "t-1", parentId: "g-1", name: "预算讨论", replyMode: "all" }),
    ];
    state.groupProfiles = { "g-1": { value: { group: state.groups[0], rules: [], memberModels: {} } } };
    vi.stubGlobal("document", { body: null });
    vi.stubGlobal("window", { innerWidth: 1440, matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
  });

  it("群和话题右栏在设置组里显示「没点名时」及各自当前值", () => {
    // 群：群主回应
    state.gsel = "g-1";
    const groupHtml = renderToStaticMarkup(<Panel page={null} />);
    expect(groupHtml).toContain("<span>没点名时</span><small>群主回应</small><b>›</b>");
    expect(groupHtml.indexOf("执行前确认")).toBeLessThan(groupHtml.indexOf("没点名时"));

    // 话题：全员回应（独立于所属群）
    state.gsel = "t-1";
    const topicHtml = renderToStaticMarkup(<Panel page={null} />);
    expect(topicHtml).toContain("<span>没点名时</span><small>全员回应</small><b>›</b>");
  });

  it("展开菜单（amenu）显示两项二选一且当前项打勾", () => {
    state.gsel = "t-1";
    state.replyMenuOpen = true;
    const html = renderToStaticMarkup(<Panel page={null} />);
    expect(html).toContain('class="amenu select-popup"');
    expect(html).toContain('role="menuitemradio" aria-checked="false" aria-selected="false"><span>群主回应</span></button>');
    expect(html).toContain('role="menuitemradio" aria-checked="true" aria-selected="true"><span>全员回应</span><svg');
  });

  it("输入框占位文字随群/话题的 replyMode 变化", () => {
    // 综合 · 群主回应
    state.gsel = "g-1";
    expect(renderToStaticMarkup(<Chat />)).toContain('placeholder="在综合中发言，未点名时由 Hob 接手"');

    // 综合 · 全员回应
    state.groups[0] = makeGroup({ id: "g-1", replyMode: "all" });
    expect(renderToStaticMarkup(<Chat />)).toContain('placeholder="在综合中发言，未点名时全员依次回应"');

    // 话题 · 全员回应
    state.gsel = "t-1";
    expect(renderToStaticMarkup(<Chat />)).toContain('placeholder="在此话题中发言，未点名时全员依次回应"');

    // 话题 · 群主回应
    state.groups[1] = makeGroup({ id: "t-1", parentId: "g-1", name: "预算讨论", replyMode: "owner" });
    expect(renderToStaticMarkup(<Chat />)).toContain('placeholder="在此话题中发言，未点名时由 Hob 接手"');
  });
});
