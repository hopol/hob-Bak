// 输入框左边的加号：点开是一个小菜单，加照片、加文件，换这一栏的对话模型和任务模型；只有一个能用的模型时，加号直接选文件。
// 换模型和右栏「模型」里是同一个设置：单聊改助手的；群和话题改本群的（话题记在所属的群上），成员在本群单独设过的仍按成员的。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../../shared/i18n.ts";
import type { AssistantSummary, GroupSummary, ModelInfo } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { BrandIcon, brandForRef } from "../brand-icons.tsx";
import { fitThinking, rosterOptions } from "../model-list.ts";
import { loadModels, patchAssistant, patchGroup, setNotice, useApp } from "../store.ts";
import { useMenu } from "./use-menu.ts";

type Role = "conversation" | "work";

export function ComposerPlus({ g, a, onFiles }: { g?: GroupSummary; a?: AssistantSummary; onFiles: (files: File[]) => void }) {
  const s = useApp();
  const input = useRef<HTMLInputElement>(null);
  const menu = useMenu("left");
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  // 首页是照片、文件、对话模型、任务模型；点模型那行换成那一种的模型列表
  const [page, setPage] = useState<"main" | Role>("main");
  const photos = useRef<HTMLInputElement>(null);
  useEffect(() => { void loadModels().then((view) => setModels(view?.models ?? null)); }, []);
  const settings = s.settings.settings.models;
  const roster = settings.roster.filter((entry) => models?.some((model) => model.ref === entry.ref));
  const switchable = Boolean(models && roster.length > 1 && (g || a));

  const owner = g?.parentId ? s.groups.find((item) => item.id === g.parentId) ?? g : g;
  const roles = [["conversation", "mem", t("对话模型")], ["work", "term", t("任务模型")]] as const;
  const nameOf = (ref: string) => models?.find((model) => model.ref === ref)?.name ?? ref;
  const own = (role: Role) => (owner ? owner.models?.[role] : a?.models?.[role]);
  const follow = (role: Role) => (owner ? t("跟随各成员") : t("跟随全局（{name}）", { name: nameOf(settings[role].ref) }));
  const current = (role: Role) => { const pick = own(role); return pick ? nameOf(pick.ref) : owner ? follow(role) : nameOf(settings[role].ref); };
  const currentRef = (role: Role) => own(role)?.ref ?? (owner ? "" : settings[role].ref);

  const choose = async (role: Role, ref: string) => {
    menu.close();
    const before = own(role);
    if (ref === (before?.ref ?? "")) return;
    const pick = ref ? { ref, thinking: fitThinking(models?.find((model) => model.ref === ref), settings.roster.find((entry) => entry.ref === ref)?.thinking ?? before?.thinking ?? settings[role].thinking) } : null;
    if (owner) {
      const failure = await patchGroup(owner.id, { models: { [role]: pick } });
      if (failure) setNotice(t("保存失败：{error}", { error: failure }));
      return;
    }
    if (!a) return;
    // 只换这一种模型，另一种和可分派范围原样留着；失败时 patchAssistant 自己会提示并退回
    const next = { ...a.models };
    if (pick) next[role] = pick;
    else delete next[role];
    await patchAssistant(a.id, { models: next });
  };
  const pickFiles = () => { menu.close(); input.current?.click(); };
  const pickPhotos = () => { menu.close(); photos.current?.click(); };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length) onFiles(files);
  };

  return (
    <>
      <button
        type="button"
        className="pl"
        title={switchable ? undefined : t("加文件（也可粘贴截图）")}
        aria-label={switchable ? t("更多") : t("加文件（也可粘贴截图）")}
        aria-expanded={switchable ? menu.menu !== null : undefined}
        onClick={(event) => { if (!switchable) { pickFiles(); return; } setPage("main"); menu.toggle("plus", event.currentTarget); }}
      >
        <Icon name="plus" size={19} />
      </button>
      <input ref={input} type="file" multiple hidden onChange={onPick} />
      <input ref={photos} type="file" accept="image/*" multiple hidden onChange={onPick} />
      {menu.menu ? createPortal(
        <div className="plus-menu" ref={menu.box} role="menu">
          {page === "main" ? <>
            <button role="menuitem" onClick={pickPhotos}><span className="pm-ic"><Icon name="image" size={19} /></span><span>{t("照片")}</span></button>
            <button role="menuitem" onClick={pickFiles}><span className="pm-ic"><Icon name="file" size={19} /></span><span>{t("文件")}</span></button>
            {roles.map(([role, icon, label]) => (
              <button key={role} role="menuitem" onClick={() => setPage(role)}><span className="pm-ic"><Icon name={icon} size={19} /></span><span>{label}</span><small><BrandIcon plain size={16} brand={brandForRef(currentRef(role), models ?? [], s.settings.settings.providers)} />{current(role)}</small><Icon name="chev" size={15} /></button>
            ))}
          </> : <>
            <button className="pm-back" onClick={() => setPage("main")}><span className="pm-ic"><Icon name="left" size={19} /></span><span>{roles.find(([role]) => role === page)![2]}</span></button>
            {/* 模型多了只滚列表，返回那行留在顶上 */}
            <div className="pm-list">{[{ value: "", label: follow(page) }, ...rosterOptions(roster, own(page)?.ref, nameOf)].map((option) => (
              <button key={option.value || "follow"} role="menuitemradio" aria-checked={option.value === (own(page)?.ref ?? "")} onClick={() => void choose(page, option.value)}>
                <BrandIcon size={28} brand={brandForRef(option.value || (owner ? "" : settings[page].ref), models ?? [], s.settings.settings.providers)} />
                <span>{option.label}</span>
                {option.value === (own(page)?.ref ?? "") ? <Icon name="check" size={17} /> : null}
              </button>
            ))}</div>
          </>}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
