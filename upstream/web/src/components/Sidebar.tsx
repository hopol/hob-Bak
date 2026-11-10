// 左栏：搜索 + 置顶助手 + 首页各组（待确认 / 进行中 / 日常 / 最近任务 / 定时任务）+ 底部设置。
// 置顶跟着整栏一起滚，「设置」固定在底部；置顶头像可以按住拖着换位置。
import type { AssistantSummary } from "../../../shared/types.ts";
import { pinList } from "../home.ts";
import { Icon } from "../icons.tsx";
import { useRows } from "../motion.ts";
import { newAssistant, openKnowledge, openSettings, setQuery, useApp } from "../store.ts";
import { HomeSections, pinLayout, Pin } from "./HomeSections.tsx";
import { usePinDrag } from "./PinDrag.ts";

const assistantKey = (a: AssistantSummary) => a.id;

export function Sidebar() {
  const s = useApp();
  const pins = pinList(s.assistants, s.query);
  const drag = usePinDrag(pins, s.query.trim().length > 0);
  const pinRows = useRows(drag.order, assistantKey);
  const layout = pinLayout(pins.length);

  return (
    <aside className="side">
      <div className="side-top">
        <div className="search">
          <Icon name="search" size={15} />
          <input value={s.query} placeholder="搜索助手" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="hob-icon-btn" title="创建专属助手" onClick={newAssistant}>
          <Icon name="plus" size={18} />
        </button>
      </div>
      <div className="side-scroll">
        <div className={`pins${layout.cls}${drag.locked ? " locked" : ""}`} ref={drag.grid}>
          {pinRows.map((row) => (
            <div
              className={["srow", row.state === "still" ? "" : row.state, drag.className(row.item.id)].filter(Boolean).join(" ")}
              key={row.key}
              data-pin={row.key}
            >
              <div className="srowclip">
                <Pin a={row.item} sel={row.item.id === s.sel} size={layout.size} drag={drag.target(row.item.id)} />
              </div>
            </div>
          ))}
        </div>
        <HomeSections size={42} markSel />
      </div>
      <div className="side-foot">
        <button className="frow" onClick={openKnowledge}>
          <Icon name="archive" size={18} />
          <span className="sp">知识库</span>
        </button>
        <button className="frow" onClick={openSettings}>
          <Icon name="gear" size={18} />
          <span className="sp">设置</span>
        </button>
      </div>
    </aside>
  );
}
