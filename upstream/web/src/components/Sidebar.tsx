// 左栏：搜索和回首页 + 置顶助手和群 + 首页各组（待确认 / 进行中 / 对话 / 最近任务 / 定时任务）+ 底部设置。
// 置顶跟着整栏一起滚，「设置」固定在底部；置顶头像可以按住拖着换位置。
import { t } from "../../../shared/i18n.ts";
import { conversations, pinList } from "../home.ts";
import { Icon } from "../icons.tsx";
import { useRows } from "../motion.ts";
import { goHome, openKnowledge, openPlugins, openSettings, openStars, setQuery, toggleSideCollapsed, useApp } from "../store.ts";
import { HistoryResults } from "./HistoryResults.tsx";
import { HomeSections, pinLayout, Pin } from "./HomeSections.tsx";
import { GroupPin } from "./Groups.tsx";
import { PlusButton } from "./GroupCreate.tsx";
import { usePinDrag } from "./PinDrag.ts";
import { UpdateDot, availableVersion } from "./SettingsParts.tsx";

export function Sidebar() {
  const s = useApp();
  const updateVersion = availableVersion(s.update);
  const pins = pinList(conversations(s.assistants, s.groups, s.groupPrefs), s.query);
  const drag = usePinDrag(pins, s.query.trim().length > 0);
  const pinRows = useRows(drag.order, (row) => row.id);
  const layout = pinLayout(pins.length);

  return (
    <aside className="side">
      <div className="side-top">
        <div className="search">
          <Icon name="search" size={15} />
          <input value={s.query} placeholder={t("搜索对话和消息")} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {s.sel || s.gsel ? <button className="hob-icon-btn" title={t("收起左栏")} aria-label={t("收起左栏")} onClick={toggleSideCollapsed}><Icon name="panel" size={18} style={{ transform: "scaleX(-1)" }} /></button> : null}
        <button className={`hob-icon-btn side-home${!s.sel && !s.gsel ? " on" : ""}`} title={t("首页")} onClick={goHome}>
          <Icon name="home" size={18} />
        </button>
        <PlusButton />
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
                {row.item.kind === "assistant" ? (
                  <Pin a={row.item.a} sel={row.item.id === s.sel} size={layout.size} drag={drag.target(row.item.id)} />
                ) : (
                  <GroupPin g={row.item.g} sel={row.item.id === s.gsel} size={layout.size} drag={drag.target(row.item.id)} />
                )}
              </div>
            </div>
          ))}
        </div>
        <HomeSections size={42} markSel />
        <HistoryResults />
      </div>
      <div className="side-foot">
        <button className="frow" onClick={openStars}><Icon name="star" size={18} /><span className="sp">{t("收藏")}</span></button>
        <button className="frow" onClick={() => openPlugins()}><Icon name="plugin" size={18} /><span className="sp">{t("插件")}</span></button>
        <button className="frow" onClick={openKnowledge}>
          <Icon name="archive" size={18} />
          <span className="sp">{t("知识库")}</span>
        </button>
        <button className="frow" onClick={openSettings}>
          <Icon name="gear" size={18} />
          <span className="sp">
            {t("设置")}
            {updateVersion ? <UpdateDot version={updateVersion} /> : null}
          </span>
        </button>
      </div>
    </aside>
  );
}
