// 群话题的数据和说法：左栏二级页、综合的话题卡、右栏话题一节和手机话题列表共用。
// 和 home.ts 一样只算数据、不碰界面，好单测。
import { t } from "../../shared/i18n.ts";
import type { AssistantSummary, GroupSummary } from "../../shared/types.ts";
import { plainText } from "../../shared/plain-text.ts";

/** 群和话题都在这个列表里：没有 parentId 的才是群。 */
export function rootGroups(groups: GroupSummary[]): GroupSummary[] {
  return groups.filter((g) => !g.parentId);
}

export function topicsOf(groups: GroupSummary[], groupId: string | null | undefined): GroupSummary[] {
  return groupId ? groups.filter((g) => g.parentId === groupId) : [];
}

/** 选中的会话所属的群：选的是群就是它自己，选的是话题就是话题的群。 */
export function ownerGroup(groups: GroupSummary[], id: string | null | undefined): GroupSummary | undefined {
  const g = id ? groups.find((x) => x.id === id) : undefined;
  return g?.parentId ? groups.find((x) => x.id === g.parentId) : g;
}

/**
 * 桌面左栏该画哪个群的二级页：选中群或话题时是它（或它所属的群）的二级页，
 * 点了返回（sideHome）或者没选中群时是首页。
 */
export function groupSidebarFor(sel: string | null, sideHome: boolean, groups: GroupSummary[]): GroupSummary | undefined {
  return sideHome || !sel ? undefined : ownerGroup(groups, sel);
}

function lastAt(g: GroupSummary): string {
  return g.last?.at ?? g.createdAt;
}

export interface TopicGroups {
  /** 没关的话题，最近有消息的在前 */
  active: GroupSummary[];
  /** 关了的，最近关的在前 */
  closed: GroupSummary[];
}

export function topicGroups(groups: GroupSummary[], groupId: string): TopicGroups {
  const list = topicsOf(groups, groupId);
  return {
    active: list.filter((g) => !g.closedAt).sort((a, b) => lastAt(b).localeCompare(lastAt(a))),
    closed: list.filter((g) => g.closedAt).sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")),
  };
}

/**
 * 话题行的头像：最后一条是助手说的就是那位，否则用群主（用户最后说的、群里没人说话时），
 * 读的人一眼看出这件事归谁。
 */
export function topicFace(g: GroupSummary): string {
  if (g.last && g.last.speaker !== "user") return g.last.speaker;
  return g.ownerId;
}

/** 话题行的预览：关了的先写关闭时留的结论，没有就用最后一条。 */
export function topicPreview(g: GroupSummary, assistants: AssistantSummary[]): string {
  const last = g.last
    ? `${t("{name}：", { name: g.last.speaker === "user" ? t("你") : (assistants.find((a) => a.id === g.last!.speaker)?.name ?? g.last.speaker)})}${plainText(g.last.text)}`
    : "";
  if (g.closedAt) return g.closeNote?.trim() || last || g.purpose;
  return last || g.purpose;
}

/** 话题卡的第三行：谁说了什么，「发言人：内容」；没有发言就是负责什么。 */
export function spokenPreview(g: GroupSummary, assistants: AssistantSummary[]): string {
  if (!g.last) return g.purpose;
  const speaker = g.last.speaker === "user" ? t("你") : (assistants.find((a) => a.id === g.last!.speaker)?.name ?? g.last.speaker);
  return `${t("{name}：", { name: speaker })}${plainText(g.last.text)}`;
}
