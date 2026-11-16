// 手机（宽 < 768px）：列表页 + 右栏内容的整页。
import { memo } from "react";
import { t } from "../../../shared/i18n.ts";
import { conversations, pinList } from "../home.ts";
import { Icon } from "../icons.tsx";
import { openKnowledge, openSettings, setQuery, setSearch, shallow, useAppSelect, type PanelPage, type State } from "../store.ts";
import { HomeSections, pinLayout, Pin } from "./HomeSections.tsx";
import { GroupPin } from "./Groups.tsx";
import { PlusButton } from "./GroupCreate.tsx";
import { Panel } from "./Panel.tsx";
import { usePinDrag } from "./PinDrag.ts";

/** 手机首页只关心这几位：切页（mobile/sel/gsel）变了不重画这一大片。 */
const pickList = (s: State) => ({
  assistants: s.assistants,
  groups: s.groups,
  groupPrefs: s.groupPrefs,
  query: s.query,
  search: s.search,
});

export const MobileList = memo(function MobileList() {
  const s = useAppSelect(pickList, shallow);
  const pins = pinList(conversations(s.assistants, s.groups, s.groupPrefs), s.query);
  const drag = usePinDrag(pins, s.query.trim().length > 0);
  const layout = pinLayout(pins.length);

  return (
    <>
      <div className="mhead">
        <button className="me" title={t("设置")} onClick={openSettings}>
          <Icon name="user" size={17} />
        </button>
        <span className="sp" />
        {s.search ? (
          <div className="msearch">
            <Icon name="search" size={15} />
            <input autoFocus value={s.query} placeholder={t("搜索助手")} onChange={(e) => setQuery(e.target.value)} />
            <button onClick={() => setSearch(false)} title={t("关闭搜索")}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : (
          <>
            <button className="hob-icon-btn" title={t("知识库")} onClick={openKnowledge}>
              <Icon name="archive" size={19} />
            </button>
            <button className="hob-icon-btn" title={t("搜索助手")} onClick={() => setSearch(true)}>
              <Icon name="search" size={19} />
            </button>
            <PlusButton size={21} />
          </>
        )}
      </div>
      <div className={`mpins${layout.cls}${drag.locked ? " locked" : ""}`} ref={drag.grid}>
        {drag.order.map((row) => (
          <div className={["pinslot", drag.className(row.id)].filter(Boolean).join(" ")} key={row.id} data-pin={row.id}>
            {row.kind === "assistant" ? (
              <Pin a={row.a} size={layout.size} drag={drag.target(row.id)} />
            ) : (
              <GroupPin g={row.g} size={layout.size} drag={drag.target(row.id)} />
            )}
          </div>
        ))}
      </div>
      <div className="mlist">
        <HomeSections size={36} />
      </div>
    </>
  );
});

export function Sheet({ leaving, page }: { leaving: boolean; page?: PanelPage | null }) {
  return (
    <div className={`mfull${leaving ? " leaving" : ""}`}>
      <Panel mobile page={page} />
    </div>
  );
}
