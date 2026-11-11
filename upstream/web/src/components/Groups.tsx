// 群里到处要用的东西：成员头像叠成一簇、置顶里的群头像、左栏的群行（可展开成员）。
// 群聊页在 Chat.tsx / Items.tsx，右栏群信息在 Panel.tsx，建群在 GroupCreate.tsx。
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { AssistantSummary, GroupSummary } from "../../../shared/types.ts";
import { plainText } from "../../../shared/plain-text.ts";
import { Icon } from "../icons.tsx";
import { Avatar } from "../sprites.tsx";
import { fmtList } from "../util.ts";
import { selectGroup, useApp } from "../store.ts";
import type { GroupRowData } from "../home.ts";
import { useRowToPin, type PinDragTarget } from "./PinDrag.ts";

/** 群的成员助手，群主排第一（叠放时在最上面）；归档了的助手不在里面。 */
export function membersOf(g: GroupSummary, assistants: AssistantSummary[]): AssistantSummary[] {
  const list = g.members.map((id) => assistants.find((a) => a.id === id)).filter((a): a is AssistantSummary => Boolean(a));
  return [...list.filter((a) => a.id === g.ownerId), ...list.filter((a) => a.id !== g.ownerId)];
}

/** 成员头像叠成一簇：群主在中间的上方，另两个在下面两角；两个人就并排，一个人居中。 */
export function GroupCluster({ g, assistants, size, mark }: { g: GroupSummary; assistants: AssistantSummary[]; size: number; mark?: "busy" | "ask" }) {
  const list = membersOf(g, assistants).slice(0, 3);
  const inner = Math.round(size * 0.6);
  const d = size - inner;
  const pos = list.length === 1 ? [[d / 2, d / 2]] : list.length === 2 ? [[0, d / 2], [d, d / 2]] : [[d / 2, 0], [0, d], [d, d]];
  return (
    <div className="gav" style={{ "--gs": `${size}px`, "--av-size": `${size}px` } as CSSProperties} aria-hidden="true">
      {list.map((a, i) => (
        <span className="gav-one" key={a.id} style={{ left: pos[i][0], top: pos[i][1], zIndex: list.length - i }}>
          <Avatar sprite={a.sprite} prop={a.prop} size={inner} />
        </span>
      ))}
      {/* 首页那行：有话题在等你回答是「?」，有人在说话或任务在跑是三个点，和助手头像的标记一样 */}
      {mark ? (
        <span className={`av-mark present ${mark}`}>
          <span className="av-mark-icon">{mark === "busy" ? <svg viewBox="0 0 13 5"><circle className="av-dot" cx="2.5" cy="2.5" r="1.5" /><circle className="av-dot" cx="6.5" cy="2.5" r="1.5" /><circle className="av-dot" cx="10.5" cy="2.5" r="1.5" /></svg> : "?"}</span>
        </span>
      ) : null}
    </div>
  );
}

/** 左栏那行的预览：学 TG 写成「发言人：内容」。 */
export function groupPreview(g: GroupRowData | GroupSummary, assistants: AssistantSummary[]): string {
  if (!g.last) return g.purpose;
  const speaker = g.last.speaker === "user" ? "你" : (assistants.find((a) => a.id === g.last!.speaker)?.name ?? g.last.speaker);
  const where = "lastTopic" in g && g.lastTopic ? `「${g.lastTopic}」` : "";
  return `${where}${speaker}：${plainText(g.last.text)}`;
}

/** 首页那行群头像上的标记：有话题等你回答优先，其次有人在忙。 */
function groupMark(g: GroupRowData | GroupSummary): "busy" | "ask" | undefined {
  if ("waiting" in g && g.waiting) return "ask";
  return g.busy.length ? "busy" : undefined;
}

/** 置顶区里的群头像：叠放头像 + 群名 + 人数。 */
export function GroupPin({ g, sel, size = 52, drag }: { g: GroupRowData; sel?: boolean; size?: number; drag?: Pick<PinDragTarget, "handlers" | "takeMoved"> }) {
  const s = useApp();
  return (
    <button
      className={`pin${sel ? " sel" : ""}`}
      onPointerDown={drag?.handlers.onPointerDown}
      onClick={() => {
        if (drag?.takeMoved()) return;
        void selectGroup(g.id);
      }}
    >
      {drag ? <Icon name="grip" size={14} className="grip" /> : null}
      <GroupCluster g={g} assistants={s.assistants} size={size} mark={groupMark(g)} />
      <div className="nm">{g.name}</div>
      <div className="sub">{g.members.length} 位成员</div>
    </button>
  );
}

/**
 * 左栏的群行：整行点开群聊；能像助手一样拖进置顶区和换先后。
 */
export function GroupRow({ g, size = 42, sel }: { g: GroupRowData; size?: number; sel?: boolean }) {
  const s = useApp();
  const prefs = s.groupPrefs[g.id];
  const toPin = useRowToPin({ id: g.id, pinned: Boolean(prefs?.pinned), hidden: false });
  return (
    <>
      <div className={`list-row home-row group-row${sel ? " sel" : ""}`} data-row={prefs?.pinned ? undefined : g.id}>
        <button
          className="gline"
          onPointerDown={(e) => {
            if (!prefs?.pinned) toPin.onPointerDown(e);
          }}
          onClick={() => {
            if (toPin.takeMoved()) return;
            void selectGroup(g.id);
          }}
        >
          <GroupCluster g={g} assistants={s.assistants} size={size} mark={groupMark(g)} />
          <div className="main">
            <div className="l1">
              <span className="nm">
                {g.name}
                <span className="gcountb">{g.members.length}</span>
              </span>
              <span className="tm">{fmtList(g.last?.at)}</span>
            </div>
            <div className="pv">{groupPreview(g, s.assistants)}</div>
          </div>
          {g.unread > 0 ? <span className="gunread" title="有未读消息" aria-label="有未读消息" /> : null}
        </button>
        {toPin.ghost ? createPortal(
          <div className={`pin-ghost${toPin.ghost.over ? " over" : ""}`} style={{ left: toPin.ghost.x, top: toPin.ghost.y }}>
            <GroupCluster g={g} assistants={s.assistants} size={36} />
            <span>{toPin.ghost.over ? "松手置顶" : g.name}</span>
          </div>,
          document.body,
        ) : null}
      </div>
    </>
  );
}
