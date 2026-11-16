// 首页重画几次（票 188）：接真实的 store，数「按需订阅」和首页那一大片的重画次数。
import { Profiler } from "react";
import { createRoot } from "react-dom/client";
import { HomeSections } from "../src/components/HomeSections.tsx";
import { applyEvent, getState, leaveChat, leaveTopicList, setQuery, useAppSelect } from "../src/store.ts";
import type { State } from "../src/store.ts";

const renders = { home: 0, picked: 0 };
const api = window as Window & { __renders?: typeof renders; __go?: (what: "back" | "search", value?: string) => void; __where?: () => { mobile: string; gsel: string | null } };
api.__renders = renders;
api.__where = () => ({ mobile: getState().mobile, gsel: getState().gsel });

/** 只挑一个值出来：同一个值再 set 一次不该重画，值变了才重画。 */
function Picked() {
  const query = useAppSelect((s: State) => s.query);
  renders.picked++;
  return <output id="picked">{query}</output>;
}

api.__go = (what, value = "") => {
  if (what === "back") {
    // 手机上关群对话回话题列表，再回首页：连续两次 set
    leaveChat();
    leaveTopicList();
    return;
  }
  setQuery(value);
};

// 首页上有几行真实的助手和群，回归时连行里的订阅一起看
applyEvent({ type: "assistant", assistant: { id: "a1", name: "写手", duty: "写稿", sprite: "hob", pinned: true, hidden: false, primary: true, unread: 0, busy: false, createdAt: "2026-01-01T00:00:00Z", last: { text: "写完了", at: "2026-01-02T00:00:00Z" } } as never });
applyEvent({ type: "assistant", assistant: { id: "a2", name: "排版", duty: "整理版面", sprite: "hob", pinned: false, hidden: false, unread: 0, busy: false, createdAt: "2026-01-01T00:01:00Z" } as never });
applyEvent({ type: "assistant", assistant: { id: "a3", name: "收着的", duty: "打杂", sprite: "hob", pinned: false, hidden: true, unread: 0, busy: false, createdAt: "2026-01-01T00:02:00Z" } as never });
applyEvent({ type: "group", group: { id: "g1", name: "编辑部", purpose: "出新一期", ownerId: "a1", members: ["a1", "a2"], createdAt: "2026-01-01T00:03:00Z", unread: 0, busy: [] } as never });

createRoot(document.getElementById("root")!).render(
  <>
    <Picked />
    {/* Profiler 只在子树真提交时才回调：首页没重画，这里就不加数 */}
    <Profiler id="home" onRender={() => { renders.home++; }}>
      <HomeSections size={36} />
    </Profiler>
  </>,
);
