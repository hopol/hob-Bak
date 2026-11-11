// 群话题的数据和说法：左栏二级页、综合的话题卡、右栏话题一节和手机话题列表共用。
// 和 home.ts 一样只算数据、不碰界面，好单测。
import type { AssistantSummary, GroupSummary, WorkflowId } from "../../shared/types.ts";
import { plainText } from "../../shared/plain-text.ts";

export interface WorkflowInfo {
  id: WorkflowId | null;
  label: string;
  /** 「软件开发」后面那行灰字；「无」时是提示去哪里选 */
  flow: string;
  /** 建群对话框里的选择卡说明 */
  blurb: string;
}

export const WORKFLOWS: WorkflowInfo[] = [
  { id: null, label: "无", flow: "在群设置里选", blurb: "大家在群里商量着办；需要来回讨论的事也能开话题" },
  { id: "software", label: "软件开发", flow: "需求澄清 → 需求说明 → 拆分 → 执行 → 验收", blurb: "需求澄清 → 需求说明 → 拆分 → 执行 → 验收，每件事一个话题" },
];

export function workflowInfo(id: WorkflowId | undefined): WorkflowInfo {
  return WORKFLOWS.find((w) => w.id === (id ?? null)) ?? WORKFLOWS[0]!;
}

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
 * 话题行上的标签：等你回答是实心橙色；没关的按事项阶段写；关了的写已完成或已放弃。
 * 没有事项就是没有标签。
 */
export function topicStamp(g: GroupSummary): { text: string; tone: "ask" | "stage" | "done" | "dropped" } | null {
  const p = g.project;
  if (g.closedAt) {
    if (!p) return null;
    return p.stage === "done" ? { text: "已完成", tone: "done" } : { text: "已放弃", tone: "dropped" };
  }
  if (!p) return null;
  if (p.stage === "plan" && p.total > 0) return { text: "等你开始", tone: "ask" };
  if (p.waitingUser) return { text: "等你回答", tone: "ask" };
  if (p.stage === "clarify") return { text: "需求澄清", tone: "stage" };
  if (p.stage === "plan") return { text: "拆分", tone: "stage" };
  if (p.stage === "doing") return { text: `执行 ${p.done}/${p.total}`, tone: "stage" };
  if (p.stage === "review") return { text: "验收", tone: "stage" };
  return { text: p.stage === "done" ? "已完成" : "已放弃", tone: p.stage === "done" ? "done" : "dropped" };
}

/**
 * 话题行的头像：现在轮到谁就画谁（项目给的人 → 最后一条是助手说的那位 → 群主）。
 * 用户最后说的、群里没人说话时用群主，读的人一眼看出这件事归谁。
 */
export function topicFace(g: GroupSummary): string {
  if (g.project?.current) return g.project.current;
  if (g.last && g.last.speaker !== "user") return g.last.speaker;
  return g.ownerId;
}

/** 话题行的预览：关了的先写关闭时留的结论，没有就用最后一条。 */
export function topicPreview(g: GroupSummary, assistants: AssistantSummary[]): string {
  const last = g.last
    ? `${g.last.speaker === "user" ? "你" : (assistants.find((a) => a.id === g.last!.speaker)?.name ?? g.last.speaker)}：${plainText(g.last.text)}`
    : "";
  if (g.closedAt) return g.closeNote?.trim() || last || g.purpose;
  return last || g.purpose;
}

/** 话题卡的第三行：谁说了什么，「发言人：内容」；没有发言就是负责什么。 */
export function spokenPreview(g: GroupSummary, assistants: AssistantSummary[]): string {
  if (!g.last) return g.purpose;
  const speaker = g.last.speaker === "user" ? "你" : (assistants.find((a) => a.id === g.last!.speaker)?.name ?? g.last.speaker);
  return `${speaker}：${plainText(g.last.text)}`;
}
