import { useEffect, useLayoutEffect, useState } from "react";
import { AssistantMenu } from "./components/AssistantMenu.tsx";
import { Chat, ChatPage } from "./components/Chat.tsx";
import { DropFiles } from "./components/DropFiles.tsx";
import { FilePreviewOverlay } from "./components/FilePreview.tsx";
import { JobOverlay } from "./components/JobDetail.tsx";
import { Login } from "./components/Login.tsx";
import { Knowledge } from "./components/Knowledge.tsx";
import { MobileList, Sheet } from "./components/Mobile.tsx";
import { Panel } from "./components/Panel.tsx";
import { SettingsPage } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { useLeave } from "./motion.ts";
import { applyUpdate } from "./pwa.ts";
import { gonePages, layerList, pageKey, type GonePage } from "./panel-stack.ts";
import { backPanel, clearNotice, start, tick, useApp, type PanelPage } from "./store.ts";
import { updateStatusColor } from "./theme.ts";
import { Avatar } from "./sprites.tsx";

/** 右栏的页一层层盖上去：新页从右边滑进来，下面的页不动也不隐藏；退掉的页滑出去以后再卸。换了助手直接换，不滑。 */
function useLayers(stack: PanelPage[], owner: string | null) {
  const [shown, setShown] = useState({ stack, owner });
  const [gone, setGone] = useState<GonePage[]>([]);
  if (shown.stack !== stack || shown.owner !== owner) {
    const keys = new Set(stack.map(pageKey));
    setGone(shown.owner !== owner ? [] : [...gone.filter((g) => !keys.has(pageKey(g.page))), ...gonePages(shown.stack, stack)]);
    setShown({ stack, owner });
  }
  useEffect(() => {
    if (!gone.length) return;
    const timer = setTimeout(() => setGone([]), 240);
    return () => clearTimeout(timer);
  }, [gone]);
  return layerList(stack, gone);
}

/** 页面已经写了「无法连接 Hob」，原始错误里重复的前缀去掉。 */
function rawError(text: string): string {
  return text.replace(/^无法连接 Hob：/, "");
}

export function App() {
  const s = useApp();
  const [narrow, setNarrow] = useState(() => window.innerWidth < 768);
  const chat = useLeave(s.mobile === "chat" && Boolean(s.sel), 240);
  const settings = useLeave(s.page === "settings", 180);
  const knowledge = useLeave(s.page === "knowledge", 180);
  const sheet = useLeave(s.sheet, 180);
  const top = s.panelStack.at(-1);
  const layers = useLayers(s.panelStack, s.sel);
  const mobileLayers = layers.map(({ page, leaving }) => (
    <div key={pageKey(page)} className={`mlayer${leaving ? " leaving" : ""}`}>
      {page.kind === "file" ? <FilePreviewOverlay page={page} />
        : page.kind === "job" || page.kind === "jobs" ? <JobOverlay page={page} />
        : <Sheet page={page} leaving={false} />}
    </div>
  ));

  useLayoutEffect(() => {
    updateStatusColor(s, narrow);
  }, [s.phase, s.page, s.mobile, s.sheet, s.panelStack, s.theme, narrow]);

  useEffect(() => {
    void start();
  }, []);

  useEffect(() => {
    if (!s.panelStack.length) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) backPanel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.panelStack]);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // “进行中 · N 分钟”要自己走
  useEffect(() => {
    const timer = setInterval(() => tick(), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const n = s.assistants.reduce((sum, a) => sum + a.unread, 0);
    document.title = n > 0 ? `(${n}) Hob` : "Hob";
  }, [s.assistants]);

  useEffect(() => {
    if (!s.notice) return;
    const timer = setTimeout(() => clearNotice(), 6000);
    return () => clearTimeout(timer);
  }, [s.notice]);

  if (s.phase === "login") return <Login />;

  if (s.phase === "error") {
    return (
      <div className="boot">
        <div className="boot-card">
          <div className="t">无法连接 Hob</div>
          <div className="d">请检查网络，或确认 Hob 服务已启动。</div>
          <button className="hob-btn hob-btn-primary" onClick={() => location.reload()}>
            重试
          </button>
          {s.error ? <div className="raw">{rawError(s.error)}</div> : null}
        </div>
      </div>
    );
  }

  if (s.phase === "loading") return <div className="boot"><div className="boot-loading"><Avatar sprite="hob" size={92} motion="think" /><span className="activity-shimmer">正在连接 Hob…</span></div></div>;

  const toast = s.notice ? (
    <div className="toast">{s.notice}</div>
  ) : s.updateReady ? (
    <button className="upd" onClick={() => void applyUpdate()}>
      有新版本，点击更新
    </button>
  ) : null;

  // 拖文件进窗口：只在界面里接管，登录页/连不上时不管
  const drop = <DropFiles />;

  if (settings.mounted) {
    return (
      <>
        <SettingsPage narrow={narrow} leaving={settings.leaving} />
        {/* 设置 → 工作 → 查看全部任务：任务记录直接盖在设置页上 */}
        {narrow ? mobileLayers : <><JobOverlay /><FilePreviewOverlay /></>}
        {drop}
        {toast}
      </>
    );
  }

  if (knowledge.mounted) {
    return (
      <>
        {/* 知识库自己能拖文件进分类，这里不接管，免得一次拖放传两份 */}
        <Knowledge narrow={narrow} leaving={knowledge.leaving} />
        {narrow ? mobileLayers : null}
        {toast}
      </>
    );
  }

  const filePreview = top?.kind === "file" ? top : null;

  if (narrow) {
    return (
      <>
        <div className="mapp">
          <div className={`mpane list${s.mobile === "chat" ? " back" : ""}`}>
            <MobileList />
          </div>
          {chat.mounted ? (
            <div className={`mpane chat${chat.leaving ? " out" : ""}`}>
              <ChatPage />
            </div>
          ) : null}
          {sheet.mounted ? <Sheet leaving={sheet.leaving} page={null} /> : null}
          {mobileLayers}
        </div>
        <AssistantMenu />
        {drop}
        {toast}
      </>
    );
  }

  return (
    <div className={`app${filePreview?.full ? " preview-full" : ""}`}>
      <Sidebar />
      <Chat />
      {/* 右栏宽度只跟根页走（收起、云桌面展开）；上面的页盖上去，宽页直接盖在对话区上，不挤对话区 */}
      <div className={`panelwrap${filePreview?.full ? " full" : s.collapsed ? " off" : s.nowWide ? " wide" : ""}`}>
        <Panel page={null} />
        {layers.map(({ page, leaving }) => (
          <div key={pageKey(page)} className={`panel-layer${page.kind === "file" || page.kind === "job" || page.kind === "jobs" ? " wide" : ""}${leaving ? " leaving" : ""}`}>
            {page.kind === "file" ? <FilePreviewOverlay embedded page={page} />
              : page.kind === "job" || page.kind === "jobs" ? <JobOverlay embedded page={page} />
              : <Panel page={page} />}
          </div>
        ))}
      </div>
      <AssistantMenu />
      {s.offline ? <div className="toast">{s.offline}</div> : null}
      {drop}
      {toast}
    </div>
  );
}
