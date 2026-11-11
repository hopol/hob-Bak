// 手机上的返回：每次打开页面（对话、助手信息、设置的各级、任务、文件预览）压一条浏览器历史。
// iPhone 侧滑、安卓返回键、浏览器后退都走 popstate，关到上一条历史那时的样子；
// 点页面里的返回按钮关掉的，同步退掉多出来的历史，免得之后侧滑多退一次。桌面不压历史。
// 地址 hash 跟着当前页面走（#/chat/<助手>、#/settings/<分栏>），桌面手机都一样，刷新回到原来那页。
import {
  backPanel,
  closeImageViewer,
  closeKnowledge,
  closeSettings,
  closeSheet,
  closeSub,
  getState,
  leaveChat,
  leaveTopicList,
  setMobile,
  setSection,
  subscribe,
  type State,
} from "./store.ts";
import { routeHash } from "./route.ts";

type Layer = "chat" | "topics" | "sheet" | "knowledge" | "settings" | "section" | "sub" | "panelPage" | "viewer";

/** 当前从底到顶叠着哪几层。 */
export function layers(s: State, narrow: boolean): Layer[] {
  if (!narrow) return [];
  const out: Layer[] = [];
  if (s.page === "knowledge") {
    out.push("knowledge");
  } else if (s.page === "settings") {
    out.push("settings");
    if (s.section) out.push("section");
    if (s.sub) out.push("sub");
  } else {
    if (s.gsel && s.mobile !== "list") out.push("topics");
    if (s.mobile === "chat" && (s.sel || s.gsel)) out.push("chat");
    if (s.sheet) out.push("sheet");
  }
  for (const _page of s.panelStack) out.push("panelPage");
  if (s.viewer) out.push("viewer");
  return out;
}

const CLOSE: Record<Layer, () => void> = {
  panelPage: backPanel,
  viewer: closeImageViewer,
  sheet: closeSheet,
  knowledge: () => { closeKnowledge(); setMobile("list"); },
  chat: leaveChat,
  topics: leaveTopicList,
  sub: closeSub,
  section: () => setSection(null),
  settings: closeSettings,
};

export function startHistory(narrow: () => boolean = () => window.innerWidth < 768) {
  // 每条历史记着它那时叠了几层。一次打开好几层（首页直接点进群里的任务）只压一条：
  // iPhone 侧滑时显示的是压历史那一刻的截图，中间几层从没露过面，截图全是首页；退一次就回到原来那页
  const entries = [0];
  let skipPops = 0;
  let popping = false;
  const url = () => location.pathname + location.search + routeHash(getState(), narrow());
  history.replaceState({ hobDepth: 0 }, "", url());

  const sync = () => {
    // 退历史（history.go）是异步的，等它落地再改地址，免得改到正要离开的那条
    if (popping || skipPops > 0) return;
    const n = layers(getState(), narrow()).length;
    let back = 0;
    while (entries.length - back > 1 && entries[entries.length - back - 2]! >= n) back++;
    if (back) {
      skipPops++;
      entries.length -= back;
      history.go(-back);
      return;
    }
    if (entries.at(-1)! > n) {
      entries[entries.length - 1] = n;
      history.replaceState({ hobDepth: n }, "", url());
    }
    if (entries.at(-1)! < n) {
      entries.push(n);
      history.pushState({ hobDepth: n }, "", url());
    }
    if (url() !== location.pathname + location.search + location.hash) history.replaceState(history.state, "", url());
  };

  window.addEventListener("popstate", (event) => {
    if (skipPops > 0) {
      skipPops--;
      sync();
      return;
    }
    const depth = Number((event.state as { hobDepth?: number } | null)?.hobDepth ?? 0);
    while (entries.length > 1 && entries.at(-1)! > depth) entries.pop();
    popping = true;
    // 一次后退可能跨好几层（长按返回选更早的一条、一次打开的几层），逐层关到和历史一样深
    for (let guard = 0; guard < 10; guard++) {
      const top = layers(getState(), narrow()).at(-1);
      if (!top || layers(getState(), narrow()).length <= depth) break;
      CLOSE[top]();
    }
    popping = false;
    sync();
  });

  // 一次点击里的几次状态变化（收右栏、换对话、开任务）合成一次再对历史
  let queued = false;
  subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; sync(); });
  });
  sync();
}
