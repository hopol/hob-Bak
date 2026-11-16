// 左上「+」的菜单（新建助手 / 建群）和建群对话框。
import { Select } from "./Select.tsx";
import { DialogShell } from "./DialogShell.tsx";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { AssistantSummary, Group } from "../../../shared/types.ts";
import { useMenu } from "./use-menu.ts";
import { Icon } from "../icons.tsx";
import { Avatar } from "../sprites.tsx";
import { createGroup, newAssistant, useApp } from "../store.ts";
import { t } from "../../../shared/i18n.ts";

/** 左上角的「+」：新建助手或建群。 */
export function PlusButton({ size = 18 }: { size?: number }) {
  const menu = useMenu();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <button
        className="hob-icon-btn"
        title={t("新建助手或建群")}
        aria-haspopup="menu"
        aria-expanded={menu.menu !== null}
        onClick={(event) => menu.toggle("plus", event.currentTarget)}
      >
        <Icon name="plus" size={size} />
      </button>
      {menu.menu ? createPortal(
        <div className="amenu" ref={menu.box} role="menu">
          <button role="menuitem" onClick={() => { menu.close(); newAssistant(); }}>{t("新建助手")}</button>
          <button role="menuitem" onClick={() => { menu.close(); setCreating(true); }}>{t("建群")}</button>
        </div>,
        document.body,
      ) : null}
      {creating ? <NewGroupDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

/** 成员列表的两段：先列没收起的助手，再列收起的助手。收起的助手也能进群。 */
export function memberSections(assistants: AssistantSummary[]): { open: AssistantSummary[]; hidden: AssistantSummary[] } {
  return { open: assistants.filter((a) => !a.hidden), hidden: assistants.filter((a) => a.hidden) };
}

/** 照着已有的群建：成员和群主照那个群勾好；群名和负责什么不带过来，用户自己填。 */
export function membersOfGroup(group: Group): { members: string[]; ownerId: string } {
  return { members: [...group.members], ownerId: group.ownerId };
}

/** 提交前的检查：返回要显示的错误，没有错误返回 null。 */
export function draftError(name: string, members: string[]): string | null {
  if (!name.trim()) return t("给群起个名字。");
  if (!members.length) return t("至少选一个助手。");
  return null;
}

/** 建群时交给服务端的字段。 */
export function createBody(name: string, purpose: string, members: string[], ownerId: string) {
  return { name: name.trim(), purpose: purpose.trim(), ownerId: ownerId || members[0]!, members };
}

export function MemberList({ assistants, members, ownerId, onToggle, onOwner }: {
  assistants: AssistantSummary[];
  members: string[];
  ownerId: string;
  onToggle: (id: string) => void;
  onOwner: (id: string) => void;
}) {
  const { open, hidden } = memberSections(assistants);
  const rows = (list: AssistantSummary[]) => list.map((a) => {
    const on = members.includes(a.id);
    const owner = on && (ownerId || members[0]) === a.id;
    return (
      <div key={a.id} className={`gc-row${on ? " on" : ""}`}>
        <button type="button" className="gc-pick" aria-pressed={on} onClick={() => onToggle(a.id)}>
          <span className="gc-check">{on ? <Icon name="check" size={13} w={2.4} /> : null}</span>
          <Avatar sprite={a.sprite} prop={a.prop} size={30} />
          <span className="gc-text"><strong>{a.name}</strong><small>{t(a.duty)}</small></span>
        </button>
        {on ? (
          <button type="button" className={`gc-owner${owner ? " is" : ""}`} disabled={owner} onClick={() => onOwner(a.id)}>
            {owner ? t("群主") : t("设为群主")}
          </button>
        ) : null}
      </div>
    );
  });
  return (
    <div className="gcreate-members">
      {rows(open)}
      {hidden.length ? <div className="gc-sect">{t("收起的助手")}</div> : null}
      {hidden.length ? rows(hidden) : null}
    </div>
  );
}

/** 建群：选成员（至少一个助手）、选群主、填群名和负责什么；也可以照着一个已有的群勾。 */
export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const s = useApp();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    const next = members.includes(id) ? members.filter((x) => x !== id) : [...members, id];
    setMembers(next);
    if (!next.includes(ownerId)) setOwnerId(next[0] ?? "");
  };

  const clone = (gid: string) => {
    setFrom(gid);
    const group = s.groups.find((g) => g.id === gid);
    if (!group) return;
    const picked = membersOfGroup(group);
    setMembers(picked.members);
    setOwnerId(picked.ownerId);
    setError(null);
  };

  const submit = async () => {
    const problem = draftError(name, members);
    if (problem) return setError(problem);
    setBusy(true);
    const failure = await createGroup(createBody(name, purpose, members, ownerId));
    setBusy(false);
    if (failure) setError(t("建群失败：{error}", { error: failure }));
    else onClose();
  };

  // 照着建的下拉只列群：话题不是能照着建的东西
  const clones = s.groups.filter((g) => !g.parentId);

  return <DialogShell label={t("新建群")} title={t("新建群")} onClose={onClose} onSubmit={(event) => { event.preventDefault(); void submit(); }} actions={<><button type="button" className="hob-btn" onClick={onClose}>{t("取消")}</button><button type="submit" className="hob-btn hob-btn-primary" disabled={busy}>{t("建群")}</button></>}>
        {clones.length ? (
          <label className="gcreate-field">
            <span>{t("照着已有的群建")}</span>
            <Select value={from} onChange={clone} options={[{ value: "", label: t("不照，自己选成员") }, ...clones.map((g) => ({ value: g.id, label: t("照着「{name}」建", { name: g.name }) }))]} />
          </label>
        ) : null}
        <label className="gcreate-field">
          <span>{t("群名")}</span>
          <input autoFocus value={name} placeholder={t("按范围起，如「家里机器」")} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="gcreate-field">
          <span>{t("负责什么")}</span>
          <input value={purpose} placeholder={t("一句话，如「家里 NAS 和服务器上的存储和备份」")} onChange={(event) => setPurpose(event.target.value)} />
        </label>
        <div className="gcreate-label">{t("成员")}</div>
        <MemberList assistants={s.assistants} members={members} ownerId={ownerId} onToggle={toggle} onOwner={setOwnerId} />
        <div className="gcreate-note">{t("收起的助手也能选。同一位助手在几个群里是同一个人：记忆、技能、规则只有一份，各群的对话分开。")}</div>
        {error ? <div className="gcreate-error">{error}</div> : null}
      </DialogShell>;
}
