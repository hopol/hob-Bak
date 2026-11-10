import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  phase: "ready", page: "main", mobile: "chat", sel: "hob", sheet: false,
  assistants: [], panelStack: [] as Array<{ kind: string; id?: string; path?: string; full?: boolean }>,
  livePages: {}, collapsed: true, nowWide: false,
  notice: null, updateReady: false, offline: null,
  knowledge: { category: "all", q: "", kind: "", assistantId: "", entries: [{ id: "k-1", name: "测试文档.md", kind: "markdown", path: "/mock/test.md", size: 100, updatedAt: "2026-01-01T00:00:00Z", collections: [] }], collections: [], loading: false, hasMore: false, error: null },
}));
vi.mock("./store.ts", () => ({
  useApp: () => state,
  backPanel: () => { state.panelStack.pop(); }, closePanelPages: vi.fn(), closeSheet: vi.fn(),
  fileUrl: (path: string) => path,
  photoUrl: (path: string) => path,
  fetchFileMeta: vi.fn(), setNotice: vi.fn(), togglePreviewFull: vi.fn(),
  clearNotice: vi.fn(), start: vi.fn(), tick: vi.fn(), openKnowledge: vi.fn(), closeKnowledge: vi.fn(), jumpToItem: vi.fn(), loadKnowledge: vi.fn(), openFilePreview: vi.fn(), openJob: vi.fn(), setKnowledgeFilter: vi.fn(),
}));
vi.mock("./components/Sidebar.tsx", () => ({ Sidebar: () => <aside className="side" /> }));
vi.mock("./components/Chat.tsx", () => ({ Chat: () => <main className="chat"><input defaultValue="草稿" /></main>, ChatPage: () => null }));
vi.mock("./components/Panel.tsx", () => ({ Panel: () => <div>右栏</div> }));
vi.mock("./components/JobDetail.tsx", () => ({ JobOverlay: () => <div className="jd-embedded">任务详情</div> }));
vi.mock("./components/AssistantMenu.tsx", () => ({ AssistantMenu: () => null }));
vi.mock("./components/Login.tsx", () => ({ Login: () => null }));
vi.mock("./components/Mobile.tsx", () => ({ MobileList: () => null, Sheet: () => null }));
vi.mock("./components/Settings.tsx", () => ({ SettingsPage: () => null }));
vi.mock("./components/Markdown.tsx", () => ({ Markdown: () => null }));
vi.mock("./pwa.ts", () => ({ applyUpdate: vi.fn() }));
vi.mock("./theme.ts", () => ({ updateStatusColor: vi.fn() }));

import { App } from "./App.tsx";
import { backPanel } from "./store.ts";

describe("桌面文件预览", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { innerWidth: 1440 });
    state.page = "main";
    state.panelStack = [{ kind: "file", path: "/mock/page.html", full: false }];
  });

  it("盖在右栏上，收起的右栏也能显示；全宽保留聊天组件", () => {
    let html = renderToStaticMarkup(<App />);
    expect(html).toContain('class="panelwrap off"');
    expect(html).toContain('<div class="panel-layer wide"><div class="fp-embedded">');
    expect(html).not.toContain("fpwrap");
    state.panelStack[0]!.full = true;
    html = renderToStaticMarkup(<App />);
    expect(html).toContain('class="app preview-full"');
    expect(html).toContain('class="panelwrap full"');
    expect(html).toContain('value="草稿"');
  });

  it("知识库独占页面，预览嵌入知识库页",  () => {
    state.page = "knowledge";
    state.panelStack = [];
    let html = renderToStaticMarkup(<App />);
    expect(html).toContain("助手产出");
    expect(html).toContain("对话上传");
    expect(html).toContain("测试文档.md");
    expect(html).not.toContain('class="chat"');
    expect(html).not.toContain('class="panelwrap');
    expect(html).not.toContain('class="side"');
    expect(html).toContain("返回 Hob");
    expect(html).toContain('class="setnav"');
    state.panelStack = [{ kind: "file", path: "/mock/page.html", full: false }];
    html = renderToStaticMarkup(<App />);
    expect(html).not.toContain('class="side"');
    expect(html).toContain('class="knowledge-preview"><div class="fp-embedded"');
  });

  it("收起根页时仍可打开任务", () => {
    state.panelStack = [];
    expect(renderToStaticMarkup(<App />)).toContain('class="panelwrap off"');
    state.panelStack = [{ kind: "job", id: "t-1" }];
    expect(renderToStaticMarkup(<App />)).toContain("任务详情");
  });

  it("预览盖在任务详情上，下面那页照常显示；关掉预览露出详情", () => {
    state.panelStack.unshift({ kind: "job", id: "t-1" });
    let html = renderToStaticMarkup(<App />);
    expect(html).toContain('<div>右栏</div><div class="panel-layer wide"><div class="jd-embedded">任务详情</div></div><div class="panel-layer wide"><div class="fp-embedded">');
    expect(html).not.toContain("display:none");
    backPanel();
    html = renderToStaticMarkup(<App />);
    expect(html).toContain('<div class="panel-layer wide"><div class="jd-embedded">任务详情</div></div></div>');
    expect(html).not.toContain("fp-embedded");
  });
});
