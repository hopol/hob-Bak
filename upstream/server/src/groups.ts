// 群：用户和几个助手共用的时间线。谁说话由代码定（@ 谁、引用谁、没点名就群主），
// 每个成员在群里有一份自己的会话，和它的单聊分开（见 docs/architecture.md「群」）。
import { t } from "../../shared/i18n.ts";
import type {
  Group,
  GroupItem,
  GroupItemsPage,
  GroupReplyMode,
  GroupSummary,
  JobStatus,
  NoteIcon,
  SendMessageBody,
} from "../../shared/types.ts";
import { newId } from "./ids.ts";
import { reactionsList } from "./store.ts";
import { saysNoReply, stripNoReply } from "../../shared/no-reply.ts";
import { clearTodos, readTodos } from "./todos.ts";
import { groupTodosPath } from "./config.ts";
import { nowBlock } from "./now.ts";
import { cardHistoryLine } from "./cards.ts";
import { checkAssistantModels } from "./models.ts";
import type { EventText, NewItem } from "./router.ts";
import type { HobRuntime } from "./runtime.ts";
import { CWD_IMMUTABLE, normalizeWorkspaceCwdInput, topicCwdLockedByGroup, validateWorkspaceCwd } from "./workspace.ts";

/** 一条用户消息引出的助手回合上限：挡来回 @ 的死循环，不是限制正常协作。 */
export const MAX_WAVE_TURNS = 20;
export const RELAY_NOTE = "群内转交次数过多，已在此暂停。";
export const RESTART_NOTE = "服务已重启，本轮已中断。";
/** 话题关了以后发消息：话题关了不能再发，能重新打开。 */
export const TOPIC_CLOSED = "这个话题已关闭，重新打开后才能发消息";
/** 用户关闭话题时没写说明就记这句；助手关闭时由调用方给出说明。 */
export const CLOSED_TOPIC_REASON = "你关闭了这个话题";
/** 主助手交来的话题关的时候要写结论：结论会转给主助手。 */
export const HANDOVER_NOTE_REQUIRED = "note 不能为空：这个话题是 Hob 交给这个群的，结论会转给 Hob，由它告诉用户；不做了的写明原因。";
/** 群主在话题里收到的那条：这件事是主助手交来的。 */
export const HANDOVER_EVENT = "这个话题是 Hob 交给这个群的，上面是 Hob 写的交接说明。完成后用 close_topic 写结论，结论会转给 Hob，由它告诉用户。";

/** 系统写的条目（停下、重启）的发言人。 */
const SYSTEM = "system";

/** 结论后面附的任务记录里，任务状态怎么写。 */
const JOB_STATE: Record<JobStatus, string> = { queued: "排队中", running: "进行中", waiting: "等你回复", done: "已完成", stuck: "受阻", failed: "失败", stopped: "已停止" };

/** 一条用户消息引出的一串助手回合，turns 是已经开了几个（按 @ 接力计，不含全员依次轮到的回合）。 */
interface Wave {
  turns: number;
  stopped: boolean;
  pending: number;
  finalSpeaker?: string;
  /** 全员回应：用户没点名时，群主这一串跑完后，把还没轮到过的成员按成员顺序依次排上。 */
  allReply?: {
    triggerId: string;
    epoch: number;
    participated: Set<string>;
  };
}

/** 一个成员正在说的这一轮：正文（@ 检测用）、当前这条消息的条目、最后一条说成的条目、叫到它的条目。 */
interface RunningTurn {
  itemId?: string;
  lastId?: string;
  text: string;
  triggerId?: string;
  /** 事件那一轮：文字先攒着，这一轮结束再写进时间线（以 NO_REPLY 收尾就不写） */
  event?: true;
  held?: string[];
  /** 这一轮以 NO_REPLY 收尾：收到了用户消息的话，替它挂 👀 */
  silent?: boolean;
}

/** 这一轮该给它的条目，和给到哪一条（seen 存它）。 */
interface TurnInput {
  items: GroupItem[];
  seenTo?: GroupItem;
}

/** 时间线里新条目：去掉 id 和 at（由这里分配），发言人必填。 */
type NewGroupItem = NewItem & { speaker: string; forwardedFrom?: GroupItem["forwardedFrom"] };

/** 触发这一轮的消息：用户的消息，或者定时任务到点的记录。 */
export type RequestItem = Extract<GroupItem, { kind: "user" | "note" }>;

function isRequestItem(item: GroupItem | undefined): item is RequestItem {
  return item?.kind === "user" || (item?.kind === "note" && item.icon === "routine");
}

/** 来由的文字：用户消息取原文；定时记录取到点时交给群主的全文，老数据没有 request 就取记录那一行。 */
export function requestText(item: RequestItem): string {
  return item.kind === "user" ? item.text : item.request ?? item.text;
}

export interface CreateGroupInput {
  name?: unknown;
  purpose?: unknown;
  ownerId?: unknown;
  members?: unknown;
  parentId?: unknown;
  cwd?: unknown;
  replyMode?: unknown;
}

export interface UpdateGroupInput {
  name?: unknown;
  purpose?: unknown;
  ownerId?: unknown;
  members?: unknown;
  listOrder?: unknown;
  cwd?: unknown;
  replyMode?: unknown;
}

export class GroupManager {
  /** `<gid>@<aid>` → 这个成员在这个群里的排队（同一成员同时被叫两次时排队） */
  private queues = new Map<string, Promise<void>>();
  /** `<gid>@<aid>` → 正在说的这一轮 */
  private turns = new Map<string, RunningTurn>();
  /** gid → 已经用到第几号条目 */
  private counters = new Map<string, number>();
  /** gid → 停止代数：按了停止以后，排队里的回合和回复里的 @ 都不再继续 */
  private epochs = new Map<string, number>();
  /** 正在往主助手的对话送结论的话题 */
  private delivering = new Set<string>();

  constructor(private readonly runtime: HobRuntime) {
    this.repairInterrupted();
  }

  private get store() {
    return this.runtime.store;
  }

  private get bus() {
    return this.runtime.bus;
  }

  // ---------- 清单和摘要 ----------

  /** 左栏用的清单：群和话题都在里面，最近有消息的在前。 */
  list(): GroupSummary[] {
    return this.store
      .groups()
      .map((group) => this.summary(group))
      .sort((a, b) => (b.last?.at ?? b.createdAt).localeCompare(a.last?.at ?? a.createdAt));
  }

  summary(groupOrId: Group | string): GroupSummary {
    const group = typeof groupOrId === "string" ? this.group(groupOrId) : groupOrId;
    const items = this.timeline(group.id);
    const activity = this.runtime.router.groupActivity(group.id);
    let last: GroupSummary["last"];
    for (const item of items) {
      if (item.kind === "assistant" || item.kind === "user" || item.kind === "note") last = { at: item.at, speaker: item.speaker, text: item.text };
    }
    return {
      ...group,
      ...(last ? { last } : {}),
      unread: this.unread(group.id, items),
      busy: this.busyOf(group.id),
      todos: readTodos(groupTodosPath(this.runtime.home, group.id)),
      ...(this.runtime.router.suggestionsFor(group.ownerId, group.id)?.length ? { suggestions: this.runtime.router.suggestionsFor(group.ownerId, group.id) } : {}),
      ...(Object.keys(activity).length ? { activity } : {}),
    };
  }

  /** 这个群下面的话题（新的在前）。 */
  topicsOf(gid: string): Group[] {
    return this.store
      .groups()
      .filter((group) => group.parentId === gid)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 这个群下面没关的话题（新的在前）。 */
  activeTopics(gid: string): Group[] {
    return this.topicsOf(gid).filter((topic) => !topic.closedAt);
  }

  /** 正在这个群里说话、或者在这个群里有任务在跑的成员。 */
  private busyOf(gid: string): string[] {
    const busy = new Set(this.runtime.router.busyMembers(gid));
    for (const job of this.store.jobs()) {
      if (job.groupId !== gid) continue;
      if (job.status === "running" || job.status === "queued" || job.status === "waiting") busy.add(job.assistantId);
    }
    return [...busy];
  }

  /** 忙闲变了推给前端（左栏小橙点、群状态行看它）。 */
  publish(gid: string): void {
    const group = this.store.group(gid);
    if (!group) return;
    this.bus.emit({ type: "group", group: this.summary(group) });
  }

  read(gid: string): void {
    this.group(gid);
    this.store.saveGroupState(gid, { readAt: new Date().toISOString() });
    this.publish(gid);
  }

  private unread(gid: string, items: GroupItem[]): number {
    const readAt = this.store.groupState(gid).readAt;
    // 从没记过已读：从现在开始算，以前的都当读过（和助手的未读一样）
    if (!readAt) {
      this.store.saveGroupState(gid, { readAt: new Date().toISOString() });
      return 0;
    }
    return items.filter((item) => item.kind === "assistant" && item.at > readAt).length;
  }

  // ---------- 建群、改群、归档 ----------

  create(input: CreateGroupInput): Group {
    // 话题是挂在群下面的群，但得先有群：建群的接口不建话题
    if (input.parentId !== undefined) throw new Error("创建群不接受 parentId：话题在群里创建（POST /api/groups/:gid/topics）。");
    const members = this.membersOf(input.members, "群里至少要有一个助手");
    const normalizedCwd = normalizeWorkspaceCwdInput(input.cwd);
    const cwd = normalizedCwd ? validateWorkspaceCwd(normalizedCwd, this.runtime.home) : undefined;
    const replyMode = this.replyModeOf(input.replyMode);
    const group: Group = {
      id: newId("g-"),
      name: this.text(input.name, "群名", 40),
      purpose: this.text(input.purpose, "职责", 200),
      ownerId: this.ownerOf(input.ownerId, members),
      members,
      ...(replyMode ? { replyMode } : {}),
      ...(cwd ? { cwd } : {}),
      createdAt: new Date().toISOString(),
    };
    this.store.saveGroup(group);
    this.note(group.id, SYSTEM, t("已创建群「{name}」", { name: group.name }), "info");
    this.publish(group.id);
    return group;
  }

  /**
   * 开一个话题：话题是挂在群下面的群，时间线、成员会话、已读都是自己的。
   * 成员、群主、负责什么取所属的群，不另存。
   */
  createTopic(gid: string, title: unknown, createdBy: string, options?: { cwd?: unknown }): Group {
    const group = this.group(gid);
    if (group.parentId) throw new Error("话题挂在群下面：话题里不能再创建话题。");
    const normalizedCwd = normalizeWorkspaceCwdInput(options?.cwd);
    let cwd: string | undefined;
    if (group.cwd) {
      if (normalizedCwd) throw new Error(topicCwdLockedByGroup(group.cwd));
    } else if (normalizedCwd) {
      cwd = validateWorkspaceCwd(normalizedCwd, this.runtime.home);
    }
    const topic: Group = {
      id: newId("g-"),
      name: this.text(title, "话题名", 40),
      purpose: group.purpose,
      ownerId: group.ownerId,
      members: group.members,
      ...(group.replyMode ? { replyMode: group.replyMode } : {}),
      ...(cwd ? { cwd } : {}),
      createdAt: new Date().toISOString(),
      parentId: gid,
      createdBy,
    };
    this.store.saveGroup(topic);
    // 综合里落一张话题卡，谁开的谁就是发言人
    this.appendItem(gid, createdBy, { kind: "topic", topicId: topic.id });
    this.publish(gid);
    this.publish(topic.id);
    return this.group(topic.id);
  }

  /**
   * 把综合里的一条用户消息复制进话题：原话、附件、引用照原样，记着它从哪来。
   * 用户和群主开话题都走这里。
   */
  forwardUserItem(gid: string, topicId: string, item: GroupItem): GroupItem | undefined {
    if (item.kind === "note" && item.icon === "routine") {
      return this.appendItem(topicId, item.speaker, { kind: "note", icon: "routine", text: item.text, ...(item.routineId ? { routineId: item.routineId } : {}), ...(item.request ? { request: item.request } : {}), forwardedFrom: { groupId: gid, itemId: item.id } });
    }
    if (item.kind !== "user") return undefined;
    return this.appendItem(topicId, "user", {
      kind: "user",
      text: item.text,
      ...(item.quote ? { quote: item.quote } : {}),
      ...(item.files?.length ? { files: item.files } : {}),
      forwardedFrom: { groupId: gid, itemId: item.id },
    });
  }

  /**
   * 任意助手把一件事交给这个群：开一个话题，把交接说明作为第一条用户条目转进去，
   * 记下是谁交来的，综合里落一行。叫醒群主由调用方发（它还要结束这一轮）。
   */
  handOver(gid: string, title: unknown, by: string, original: { text: string; files: string[]; itemId?: string; cwd?: unknown }): { topic: Group; item: GroupItem } {
    const topic = this.createTopic(gid, title, by, original.cwd !== undefined ? { cwd: original.cwd } : undefined);
    const item = this.appendItem(topic.id, "user", {
      kind: "user",
      text: original.text,
      ...(original.files.length ? { files: original.files } : {}),
      forwardedFrom: { assistantId: by, ...(original.itemId ? { itemId: original.itemId } : {}) },
    });
    this.store.saveGroup({ ...this.group(topic.id), handover: { by, at: new Date().toISOString() } });
    const byName = this.nameOf(by);
    this.note(gid, by, t("{name} 已将「{topic}」交由这个群处理", { name: byName, topic: topic.name }));
    return { topic: this.group(topic.id), item };
  }

  /** 用户或助手关闭话题：写上时间和说明；用户本人没填时用固定的关闭说明。正在跑的回合和任务不停。 */
  closeByUser(tid: string, note: unknown, by: "user" | "assistant" = "user"): Group {
    const topic = this.topic(tid);
    const text = typeof note === "string" ? note.trim() : "";
    return this.closeTopic(topic, text || (by === "user" ? t("你关闭了这个话题") : ""), text, by);
  }

  /** 群主关话题：主助手交来的，要写给用户的结论。 */
  closeByOwner(tid: string, note: unknown): Group {
    const topic = this.topic(tid);
    const text = typeof note === "string" ? note.trim() : "";
    if (topic.handover && !text) throw new Error(HANDOVER_NOTE_REQUIRED);
    return this.closeTopic(topic, text, text);
  }

  /** 重新打开话题：清掉关闭说明。 */
  reopen(tid: string): Group {
    const topic = this.topic(tid);
    const { closedAt: _closedAt, closeNote: _closeNote, ...rest } = topic;
    this.store.saveGroup(rest);
    this.publish(tid);
    if (topic.parentId) this.publish(topic.parentId);
    return this.group(tid);
  }

  private closeTopic(topic: Group, note: unknown, conclusion: string, by: "user" | "assistant" = "user"): Group {
    const text = typeof note === "string" ? note.trim() : "";
    const next: Group = { ...topic, closedAt: new Date().toISOString(), ...(text ? { closeNote: text } : {}) };
    // 上一句结论还在时，这次没给说明就把它清掉，免得卡片上留着旧话
    if (!text && next.closeNote) delete next.closeNote;
    this.store.saveGroup(next);
    // 关了这个话题就没人再管它的待办了：没做完的直接清掉，不再写进时间线
    const left = readTodos(groupTodosPath(this.runtime.home, topic.id));
    if (left.length) clearTodos(groupTodosPath(this.runtime.home, topic.id));
    // 主助手交来的话题：先记下要送回去的那句，再送；重新打开再关不再送
    if (topic.handover && !topic.handover.result) {
      const host = topic.parentId ? this.store.group(topic.parentId) : undefined;
      const groupName = host?.name ?? topic.parentId ?? "";
      const result = conclusion
        ? `交给群「${groupName}」的话题「${topic.name}」关了。结论：${conclusion}${this.topicJobsLine(topic.id)}`
        : `交给群「${groupName}」的话题「${topic.name}」被${by === "user" ? "用户" : "助手"}关了，没有写结论。${this.topicJobsLine(topic.id)}`;
      this.store.saveGroup({ ...this.group(topic.id), handover: { ...topic.handover, result } });
      this.deliverHandover(topic.id);
    }
    this.publish(topic.id);
    if (topic.parentId) this.publish(topic.parentId);
    return this.group(topic.id);
  }

  /**
   * 这个话题里开过的任务，一行一条，附在交回的结论后面：主助手说得清谁做了什么，不看也能对上。
   * 同一张任务卡续做几轮只算一条。
   */
  private topicJobsLine(tid: string): string {
    const jobs = this.store.jobs().filter((job) => job.groupId === tid).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!jobs.length) return "";
    const rows = jobs.map((job) => `${job.assistantName ?? job.assistantId}「${job.title}」${JOB_STATE[job.status]}`);
    return `\n话题里的任务：${rows.join("；")}`;
  }

  /** 把话题的结论送进主助手的对话；送到了记下 deliveredAt。会话条目是去重依据。 */
  private deliverHandover(tid: string): void {
    const topic = this.store.group(tid);
    const handover = topic?.handover;
    if (!topic || !handover?.result || handover.deliveredAt || this.delivering.has(tid)) return;
    this.delivering.add(tid);
    void this.runtime.router.handoverResult(handover.by, tid, handover.result).then((received) => {
      if (!received) return;
      const current = this.store.group(tid);
      if (!current?.handover || current.handover.deliveredAt || current.handover.result !== handover.result) return;
      this.store.saveGroup({ ...current, handover: { ...current.handover, deliveredAt: new Date().toISOString() } });
    }).catch((error) => console.error("话题的结论没送到：", error)).finally(() => this.delivering.delete(tid));
  }

  /** 进程重启：记下了结论、还没送到主助手的，补送一次。 */
  recoverHandovers(): void {
    for (const group of this.store.groups()) {
      if (group.parentId && group.handover?.result && !group.handover.deliveredAt) this.deliverHandover(group.id);
    }
  }

  /** 话题不再依赖工作方式字段。旧群文件里的 workflow 由存储层原样保留。 */
  update(gid: string, patch: UpdateGroupInput): Group {
    const group = this.group(gid);
    if (patch.cwd !== undefined) throw new Error(CWD_IMMUTABLE);
    if (group.parentId) {
      return this.updateTopic(group, patch);
    }
    const members = patch.members === undefined ? group.members : this.membersOf(patch.members, "群里至少要留一个成员");
    const ownerId = patch.ownerId === undefined ? group.ownerId : this.ownerOf(patch.ownerId, members);
    if (!members.includes(ownerId)) throw new Error("群主必须是成员之一");
    const replyMode = this.replyModeOf(patch.replyMode);
    const next: Group = {
      ...group,
      members,
      ownerId,
      ...(patch.name !== undefined ? { name: this.text(patch.name, "群名", 40) } : {}),
      ...(patch.purpose !== undefined ? { purpose: this.text(patch.purpose, "职责", 200) } : {}),
      ...(replyMode !== undefined ? { replyMode } : {}),
      ...(typeof patch.listOrder === "number" && Number.isFinite(patch.listOrder) ? { listOrder: Math.max(0, Math.round(patch.listOrder)) } : {}),
    };
    if (group.memberModels) next.memberModels = Object.fromEntries(Object.entries(group.memberModels).filter(([id]) => members.includes(id)));
    this.store.saveGroup(next);
    for (const routine of this.store.routines()) {
      const destination = routine.groupId ? this.store.group(routine.groupId) : undefined;
      if (!destination || (destination.parentId ?? destination.id) !== gid || routine.assistantId === ownerId) continue;
      this.runtime.routines.transfer(routine, ownerId);
    }
    const topicIds = this.topicsOf(gid).map((topic) => topic.id);
    // 被移出的成员在各话题里的会话也跟着放掉
    for (const id of group.members) if (!members.includes(id)) this.forgetMemberSessions([gid, ...topicIds], id);
    // 换了群主：两边重开会话，群主工具和提示词才跟着换
    if (ownerId !== group.ownerId) for (const id of [group.ownerId, ownerId]) this.forgetMemberSessions([gid, ...topicIds], id);
    this.publish(gid);
    for (const topic of this.topicsOf(gid)) this.publish(topic.id);
    return next;
  }

  /** 保存本群的模型覆盖，话题共用所属群的设置。 */
  async updateModels(gid: string, patch: unknown): Promise<Group> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("模型设置无效");
    await this.runtime.models.get();
    const selected = this.group(gid);
    const group = selected.parentId ? this.group(selected.parentId) : selected;
    const models = this.modelPatch(group.models, patch as Record<string, unknown>);
    const next = { ...group, models };
    this.store.saveGroup(next);
    const ids = [group.id, ...this.topicsOf(group.id).map((topic) => topic.id)];
    for (const id of group.members) this.runtime.router.releaseGroupMemberSessions(id, ids);
    for (const id of ids) this.publish(id);
    return next;
  }

  /** 保存一个成员在所属群的模型覆盖。 */
  async updateMemberModels(gid: string, assistantId: string, patch: Record<string, unknown>): Promise<Group> {
    await this.runtime.models.get();
    const selected = this.group(gid);
    const group = selected.parentId ? this.group(selected.parentId) : selected;
    if (!group.members.includes(assistantId)) throw new Error("助手不是这个群的成员");
    const models = this.modelPatch(group.memberModels?.[assistantId], patch);
    const memberModels = { ...group.memberModels };
    if (models.conversation || models.work) memberModels[assistantId] = models;
    else delete memberModels[assistantId];
    const next = { ...group, memberModels };
    this.store.saveGroup(next);
    this.runtime.router.releaseGroupMemberSessions(assistantId, [group.id, ...this.topicsOf(group.id).map((topic) => topic.id)]);
    this.publish(group.id);
    for (const topic of this.topicsOf(group.id)) this.publish(topic.id);
    return next;
  }

  private modelPatch(current: Group["models"], patch: Record<string, unknown>): NonNullable<Group["models"]> {
    const models = { ...current };
    for (const key of ["conversation", "work"] as const) {
      if (!(key in patch)) continue;
      if (patch[key] === null) delete models[key];
      else {
        const checked = checkAssistantModels({ models: { [key]: patch[key] } as never }, this.runtime.settings.settings.models.roster, this.runtime.models).models?.[key];
        if (!checked) throw new Error("模型设置无效");
        models[key] = checked;
      }
    }
    return models;
  }

  /** 话题只能改名和回应方式：成员、群主、负责什么跟着所属的群。 */
  private updateTopic(topic: Group, patch: UpdateGroupInput): Group {
    if (patch.cwd !== undefined) throw new Error(CWD_IMMUTABLE);
    if (patch.members !== undefined || patch.ownerId !== undefined || patch.purpose !== undefined) {
      throw new Error("话题的成员、群主与职责随所属的群，请在群设置中修改。");
    }
    const replyMode = this.replyModeOf(patch.replyMode);
    const next: Group = {
      ...topic,
      ...(patch.name !== undefined ? { name: this.text(patch.name, "话题名", 40) } : {}),
      ...(replyMode !== undefined ? { replyMode } : {}),
    };
    this.store.saveGroup(next);
    this.publish(topic.id);
    if (topic.parentId) this.publish(topic.parentId);
    return next;
  }

  private forgetMemberSessions(groupIds: string[], assistantId: string): void {
    for (const gid of groupIds) this.runtime.router.forgetSession(assistantId, gid);
  }

  /** 结束这个群：先停下正在说话的成员，整个群目录连同各话题一起搬进 archive/groups/。 */
  async archive(gid: string): Promise<void> {
    const group = this.group(gid);
    if (group.parentId) throw new Error("话题用关闭，不用归档");
    const topics = this.topicsOf(gid);
    await this.stop(gid, group);
    for (const topic of topics) await this.stop(topic.id, topic);
    this.runtime.router.forgetGroup(gid);
    for (const topic of topics) this.runtime.router.forgetGroup(topic.id);
    for (const routine of this.store.routines()) {
      const target = routine.groupId ? this.store.group(routine.groupId) : undefined;
      if (target && (target.parentId ?? target.id) === gid && routine.active) this.runtime.routines.update(routine.id, { active: false });
    }
    this.store.archiveGroup(gid, `${gid}-${new Date().toISOString().replace(/[:.]/g, "-")}`, topics.map((topic) => topic.id));
    this.runtime.routines.reload();
    for (const id of [gid, ...topics.map((topic) => topic.id)]) {
      this.counters.delete(id);
      this.epochs.delete(id);
    }
    this.bus.emit({ type: "group_removed", id: gid });
    for (const topic of topics) this.bus.emit({ type: "group_removed", id: topic.id });
  }

  /** 助手归档了：从它所在的群里移出；它是群主就换剩下的第一个成员；群里没人了就把群一起归档。 */
  async assistantArchived(assistantId: string): Promise<void> {
    for (const group of this.store.groups()) {
      // 话题的成员跟着所属的群：群处理完，话题跟着变
      if (group.parentId) continue;
      if (!group.members.includes(assistantId)) continue;
      const members = group.members.filter((id) => id !== assistantId);
      if (!members.length) {
        await this.archive(group.id);
        continue;
      }
      const ownerId = group.ownerId === assistantId ? members[0]! : group.ownerId;
      this.update(group.id, { members, ownerId });
      this.forgetMemberSessions([group.id, ...this.topicsOf(group.id).map((topic) => topic.id)], assistantId);
      this.note(group.id, SYSTEM, t("「{name}」已归档，并移出此群", { name: this.nameOf(assistantId) }), "info");
      this.publish(group.id);
      for (const topic of this.topicsOf(group.id)) this.publish(topic.id);
    }
  }

  private topic(id: string): Group {
    const group = this.group(id);
    if (!group.parentId) throw new Error("关闭和重新打开仅适用于话题；群请使用归档。");
    return group;
  }

  private text(value: unknown, label: string, max: number): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
    const text = value.trim();
    if ([...text].length > max) throw new Error(`${label}最多 ${max} 字`);
    return text;
  }

  /** members 里至少要有一个助手；空了就抛 tooFew（建群和改群的说法不一样）。 */
  private membersOf(value: unknown, tooFew: string): string[] {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id)) throw new Error("成员必须是助手 ID 的列表");
    const ids = [...new Set(value as string[])];
    if (!ids.length) throw new Error(tooFew);
    for (const id of ids) {
      if (!this.store.assistant(id)) throw new Error(`助手不存在或已归档：${id}`);
    }
    return ids;
  }

  private ownerOf(value: unknown, members: string[]): string {
    if (value === undefined) throw new Error("群主不能为空");
    if (typeof value !== "string" || !value) throw new Error("群主须填写助手 ID");
    if (!members.includes(value)) throw new Error("群主必须是成员之一");
    return value;
  }

  private replyModeOf(value: unknown): GroupReplyMode | undefined {
    if (value === undefined) return undefined;
    if (value === "owner" || value === "all") return value;
    throw new Error(`回应方式只能填 owner 或 all，收到「${String(value)}」`);
  }

  // ---------- 群里的消息 ----------

  /** 用户在群里说话：写一条 user 条目，算出轮到谁，给每个人开一轮。话题关了就不收，等重新打开。 */
  async send(gid: string, body: SendMessageBody): Promise<GroupItem> {
    const group = this.group(gid);
    if (group.closedAt) throw new Error(TOPIC_CLOSED);
    // 和单聊一样：用户在这里又发了话，成员在这里出的、还没答的问题卡就过期了（显示「已结束」），这句话算什么由成员自己判断
    for (const approval of this.store.approvals()) {
      if (approval.groupId !== gid || approval.source !== "router" || approval.status !== "pending") continue;
      const expired = { ...approval, status: "expired" as const };
      this.store.saveApproval(expired);
      this.bus.emit({ type: "approval", approval: expired });
    }
    this.runtime.router.clearSuggestions(group.ownerId, gid);
    const item = this.append(gid, {
      kind: "user",
      speaker: "user",
      text: body.text,
      ...(body.quote ? { quote: body.quote } : {}),
      ...(body.files?.length ? { files: body.files } : {}),
    });
    this.bus.emit({ type: "group-item", groupId: gid, item });
    this.publish(gid);
    const explicit = this.explicitTargetsOf(group, body.text, body.quote);
    const targets = explicit.length ? explicit : [group.ownerId];
    const wave: Wave = {
      turns: 0,
      stopped: false,
      pending: 0,
      ...(!explicit.length && group.replyMode === "all"
        ? { allReply: { triggerId: item.id, epoch: this.epochs.get(gid) ?? 0, participated: new Set<string>() } }
        : {}),
    };
    for (const id of targets) void this.callTurn(gid, group, id, wave, item.id);
    return item;
  }

  /** 停掉这个群里所有成员正在进行的回合（不停任务）；排队里的回合也不再生效。 */
  async stop(gid: string, group?: Group): Promise<void> {
    const target = group ?? this.group(gid);
    this.runtime.router.clearSuggestions(target.ownerId, gid);
    this.epochs.set(gid, (this.epochs.get(gid) ?? 0) + 1);
    await Promise.all(target.members.map((id) => this.runtime.router.stop(id, gid)));
  }

  /** 用户的消息明确点名了谁：@ 了谁、引用谁的消息就是谁。 */
  private explicitTargetsOf(group: Group, text: string, quote?: { itemId: string; text: string }): string[] {
    const out = this.mentions(text, group);
    if (quote) {
      const quoted = this.store.groupItems(group.id).find((item) => item.id === quote.itemId);
      const speaker = quoted?.speaker;
      if (speaker && speaker !== "user" && speaker !== SYSTEM && group.members.includes(speaker) && !out.includes(speaker)) out.push(speaker);
    }
    return out;
  }

  /** 用户的消息轮到谁：@ 了谁、引用谁的消息就是谁；都没有就轮到群主。 */
  targetsOf(group: Group, text: string, quote?: { itemId: string; text: string }): string[] {
    const out = this.explicitTargetsOf(group, text, quote);
    return out.length ? out : [group.ownerId];
  }

  /** @ 名字：按成员名字精确匹配，长名字优先（「家里 NAS」这种带空格的也认）。 */
  private mentions(text: string, group: Group, exclude?: string): string[] {
    const members = group.members
      .filter((id) => id !== exclude)
      .map((id) => ({ id, name: this.nameOf(id) }))
      .filter((member) => member.name)
      .sort((a, b) => b.name.length - a.name.length);
    const out: string[] = [];
    for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
      const rest = text.slice(at + 1);
      const hit = members.find((member) => rest.startsWith(member.name));
      if (hit && !out.includes(hit.id)) out.push(hit.id);
    }
    return out;
  }

  /** 给一个成员排一轮：同一成员同时被叫两次时排队，第二次的输入包含第一次之后的新条目。 */
  private schedule(gid: string, assistantId: string, wave: Wave, triggerId: string, event?: EventText, workDone = false, allReplyTurn = false): Promise<void> {
    const key = `${gid}@${assistantId}`;
    const epoch = this.epochs.get(gid) ?? 0;
    wave.pending += 1;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.runTurn(gid, assistantId, wave, epoch, triggerId, event, workDone, allReplyTurn))
      .catch(() => undefined)
      .finally(() => {
        wave.pending = Math.max(0, wave.pending - 1);
        this.advanceWave(gid, wave);
      });
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  /**
   * 这一串里正在跑的回合都结束时收尾：
   * 全员回应的波次还有没轮到的成员，就按成员列表顺序排上下一个（前一个跑完才轮到下一个）；
   * 全部跑完后再生成推荐提问。
   */
  private advanceWave(gid: string, wave: Wave): void {
    if (wave.pending > 0 || wave.stopped) return;
    if (wave.allReply && (this.epochs.get(gid) ?? 0) === wave.allReply.epoch) {
      const group = this.store.group(gid);
      if (group && group.replyMode === "all") {
        const nextMember = group.members.find((id) => !wave.allReply!.participated.has(id));
        if (nextMember) {
          void this.schedule(gid, nextMember, wave, wave.allReply.triggerId, undefined, false, true);
          return;
        }
      }
    }
    if (wave.finalSpeaker && !wave.stopped) void this.runtime.router.generateSuggestionsFor(wave.finalSpeaker, gid);
  }

  /**
   * 用户叫到一个成员：它正在这个群里说一轮，就把新条目用 steer 插进那一轮，不另排一轮；
   * 会话刚好跑完（没在流式）就照原来的路子排队。
   */
  private async callTurn(gid: string, group: Group, assistantId: string, wave: Wave, triggerId: string): Promise<void> {
    const input = this.turns.has(`${gid}@${assistantId}`) ? this.windowFor(group, assistantId, triggerId) : undefined;
    if (input) {
      const text = this.inputText(assistantId, group, input);
      // 会话刚好收掉（不在流式、或者 abort 了）：照原来的路子排队，话不会丢
      const received = () => {
        this.markSeen(gid, assistantId, input.seenTo);
        // 插进的是事件那一轮：从用户这条起是回用户的话，前面攒着的先收尾，之后照常边写边推（和单聊一致）
        const turn = this.turns.get(`${gid}@${assistantId}`);
        if (turn?.event) {
          this.settleEventTurn(gid, assistantId, turn);
          delete turn.event;
        }
      };
      if (await this.runtime.router.steerMember(gid, assistantId, text, this.inputFiles(input), received).catch(() => false)) {
        if (wave.allReply) {
          wave.allReply.participated.add(assistantId);
          const running = this.queues.get(`${gid}@${assistantId}`) ?? Promise.resolve();
          wave.pending += 1;
          void running.finally(() => {
            wave.pending = Math.max(0, wave.pending - 1);
            this.advanceWave(gid, wave);
          });
        }
        return;
      }
    }
    await this.schedule(gid, assistantId, wave, triggerId);
  }

  /**
   * 任务结果、审批答案这类事件送进这个成员在群里的会话：和用户叫到它一样排进它的队列、
   * 开一轮（不然流式的文字没有归属，会被丢掉），它说的话照常进时间线。
   * 一个事件算新的一串回合（新的 Wave）。
   */
  async deliverEvent(gid: string, assistantId: string, text: EventText, triggerId = "", workDone = false): Promise<void> {
    const group = this.group(gid);
    if (!group.members.includes(assistantId)) return;
    await this.schedule(gid, assistantId, { turns: 0, stopped: false, pending: 0 }, triggerId, text, workDone);
  }

  /**
   * 这一轮是谁叫到它的：用户的消息、别的成员的回复，或者一个事件（事件没有触发条目）。
   * 开话题时用它取「叫到群主的那条用户消息」。
   */
  triggerOf(gid: string, assistantId: string): GroupItem | undefined {
    const id = this.turns.get(`${gid}@${assistantId}`)?.triggerId;
    return id ? this.store.groupItems(gid).find((item) => item.id === id) : undefined;
  }

  /**
   * 这一轮的来由：触发这一轮的条目是用户消息或定时到点记录，就是它；
   * 否则取时间线上最近的一条用户消息或定时到点记录（开话题时转过去的话都照这个取）。
   */
  requestItem(gid: string, assistantId: string): RequestItem | undefined {
    const trigger = this.triggerOf(gid, assistantId);
    if (isRequestItem(trigger)) return trigger;
    return this.timeline(gid).findLast(isRequestItem);
  }

  private async runTurn(gid: string, assistantId: string, wave: Wave, epoch: number, triggerId: string, event?: EventText, workDone = false, allReplyTurn = false): Promise<void> {
    const group = this.store.group(gid);
    if (!group || !group.members.includes(assistantId)) return;
    // 用户按了停止：这一轮不再开始
    if ((this.epochs.get(gid) ?? 0) !== epoch) return;
    wave.allReply?.participated.add(assistantId);
    // 一条用户消息引出的 @ 接力回合太多：停下，不再按 @ 叫人；全员依次轮到的回合每人最多一次，不受此上限截断
    if (!allReplyTurn && wave.turns >= MAX_WAVE_TURNS) {
      if (!wave.stopped) {
        wave.stopped = true;
        this.note(gid, SYSTEM, RELAY_NOTE, "info");
        // 群主在群里收尾：只给它这一轮，它再 @ 人也不接着转，免得停了又起
        void this.schedule(gid, group.ownerId, { turns: MAX_WAVE_TURNS - 1, stopped: true, pending: 0 }, "", `${RELAY_NOTE}：一条消息引出的助手回复已经超过 ${MAX_WAVE_TURNS} 轮，后面的 @ 不再转给下一个成员。需要的话，把结论整理一下再发一条。`)
          .catch(() => undefined);
      }
      return;
    }
    // 排到的这一轮已经没有新东西给它（前面那一轮已经带上了）：不跑，不调模型
    const input = this.windowFor(group, assistantId, event === undefined ? triggerId : "");
    if (event === undefined && !input) return;
    if (!allReplyTurn) wave.turns += 1;
    const key = `${gid}@${assistantId}`;
    const turn: RunningTurn = { text: "", ...(event !== undefined ? { event: true as const, held: [] } : {}), ...(triggerId ? { triggerId } : {}) };
    this.turns.set(key, turn);
    let text = "";
    try {
      const prompt = this.inputText(assistantId, group, input ?? { items: [] }, event);
      await this.runtime.router.deliverMember(gid, assistantId, prompt, () => this.markSeen(gid, assistantId, input?.seenTo), input ? this.inputFiles(input) : [], event === undefined || workDone);
      if (turn.event) this.settleEventTurn(gid, assistantId, turn);
      text = turn.text;
    } catch (error) {
      // 中途出错：没说到 NO_REPLY，已经写好的那几段照常出（和单聊一致），再写失败原因
      if (turn.event) this.settleEventTurn(gid, assistantId, turn);
      const message = error instanceof Error ? error.message : String(error);
      this.note(gid, assistantId, t("回复失败：{error}。@{name} 发送一条消息即可重试。", { error: message, name: this.nameOf(assistantId) }), "info");
    } finally {
      this.turns.delete(key);
    }
    // 这一轮收到了用户的消息、回了 NO_REPLY、自己也没点表情：替它挂 👀，用户看得出消息到了
    const userItem = input?.items.findLast((item) => item.kind === "user");
    if (userItem && turn.silent && !turn.lastId && !this.store.groupState(gid).reactions?.[userItem.id]?.[assistantId]) this.react(gid, assistantId, "👀", userItem.id);
    if ((this.epochs.get(gid) ?? 0) !== epoch) return;
    // 回复里 @ 了别的成员：接着轮到他们（用这一轮最后一条的 id 当触发条目）
    if (!turn.lastId) return;
    wave.finalSpeaker = assistantId;
    for (const id of this.mentions(text, group, assistantId)) this.schedule(gid, id, wave, turn.lastId);
  }

  /**
   * 这一轮该给它的条目：时间线里它上次说完以后的新条目；叫它的那条在那些条目之前
   * （排队等的时候又来了新的）就补在最后，模型才看得到是谁叫的。
   * 没有新条目、叫它的那条也给过了 → 返回 undefined，这一轮不用跑。
   */
  private windowFor(group: Group, assistantId: string, triggerId: string): TurnInput | undefined {
    const items = this.timeline(group.id);
    // 上一轮给到的最后一条记在 state.json：只调了工具没说话的回合，下一轮（重启后也一样）不重复给
    const seen = this.store.groupState(group.id).seen ?? {};
    const lastOwn = items.findLastIndex((item) => item.kind === "assistant" && item.speaker === assistantId);
    const seenAt = seen[assistantId] ? items.findIndex((item) => item.id === seen[assistantId]) : -1;
    const window = items.slice(Math.max(lastOwn, seenAt) + 1);
    const trigger = triggerId ? items.find((item) => item.id === triggerId) : undefined;
    if (!window.length) return undefined;
    const input = trigger && !window.some((item) => item.id === trigger.id) ? [...window, trigger] : window;
    return { items: input, seenTo: items.at(-1) };
  }

  /**
   * 这一轮的输入：这些条目按「名字：内容」一行一条，前面带现在的时间。
   * 事件那一轮还把事件接在后面，它先看到群里刚发生的事，不照着过时的事件做。
   */
  private inputText(assistantId: string, group: Group, input: TurnInput, event?: EventText): string {
    const lines = input.items.map((item) => this.lineOf(item, group.id)).filter(Boolean);
    const body = [lines.join("\n"), ...(event === undefined ? [] : [`[hob-event] ${typeof event === "function" ? event() : event}`])].filter(Boolean).join("\n\n");
    return `${nowBlock(this.runtime, assistantId, group.id)}\n\n${body}`;
  }

  private inputFiles(input: TurnInput): string[] {
    return input.items.flatMap((item) => item.kind === "user" ? item.files ?? [] : []);
  }

  /** 给到哪一条了：下一轮从这里往后算（只调了工具没说话的回合也记得住）。 */
  private markSeen(gid: string, assistantId: string, item: GroupItem | undefined): void {
    if (!item) return;
    const seen = this.store.groupState(gid).seen ?? {};
    this.store.saveGroupState(gid, { seen: { ...seen, [assistantId]: item.id } });
  }

  /** 时间线里的一条写成一行事实，卡片也写成一句。 */
  private lineOf(item: GroupItem, gid: string): string {
    const who = this.speakerName(item.speaker);
    switch (item.kind) {
      case "user": {
        const parts = [item.text];
        if (item.quote) parts.push(`（引用：「${item.quote.text}」）`);
        if (item.files?.length) parts.push(`（附件：${item.files.join("、")}）`);
        return `${who}：${parts.filter(Boolean).join("")}`;
      }
      case "assistant":
      case "note":
        return `${who}：${item.text}`;
      case "job": {
        const job = this.store.job(item.jobId);
        return `${who}：创建了任务「${job?.title ?? item.jobId}」`;
      }
      case "question": {
        const approval = this.store.approval(item.approvalId);
        return `${who}：询问了用户${approval ? `「${approval.title}」` : "一个问题"}`;
      }
      case "file":
        return `${who}：发送了文件「${item.name}」`;
      case "image":
        return `${who}：生成了一张图片`;
      case "draft":
        return `${who}：提议创建一个助手`;
      case "delegation":
        return `${who}：转交了一件事`;
      case "topic": {
        const topic = this.store.group(item.topicId);
        return `${who}：创建了话题「${topic?.name ?? item.topicId}」`;
      }
      case "card": {
        const card = this.store.card(item.cardId);
        return `${who}：${card ? cardHistoryLine(card.card) : "显示了一张卡片"}`;
      }
      default:
        return "";
    }
  }

  // ---------- 时间线 ----------

  items(gid: string, options: { before?: string; limit?: number } = {}): GroupItemsPage {
    this.group(gid);
    const all = this.timeline(gid);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const found = options.before ? all.findIndex((item) => item.id === options.before) : all.length;
    const end = found === -1 ? all.length : found;
    const start = Math.max(0, end - limit);
    const page = all.slice(start, end);
    const jobIds = new Set(page.flatMap((item) => (item.kind === "job" ? [item.jobId] : [])));
    const approvalIds = new Set(page.flatMap((item) => (item.kind === "question" ? [item.approvalId] : [])));
    const cardIds = new Set(page.flatMap((item) => (item.kind === "card" ? [item.cardId] : [])));
    return {
      items: page,
      approvals: this.store.approvals().filter((approval) => approvalIds.has(approval.id)),
      jobs: [...jobIds].flatMap((id) => {
        const job = this.store.job(id);
        return job ? [job] : [];
      }),
      cards: this.store.cards().filter((card) => cardIds.has(card.id)),
      hasMore: start > 0,
    };
  }

  /** 成员的一条回复开始输出：分配条目 id，先写一条流式条目，再按 delta 推给前端。 */
  delta(gid: string, assistantId: string, delta: string): void {
    const turn = this.turns.get(`${gid}@${assistantId}`);
    if (!turn) return;
    // 事件那一轮的文字等这一轮结束再写（settle 里先攒着），这里不先出条目
    if (turn.event) return;
    if (!turn.itemId) {
      const item = this.append(gid, { kind: "assistant", speaker: assistantId, text: "", streaming: true });
      turn.itemId = item.id;
      this.bus.emit({ type: "group-item", groupId: gid, item });
    }
    this.bus.emit({ type: "group-delta", groupId: gid, itemId: turn.itemId, text: delta });
  }

  /** 说完一条：完整正文按同一个 id 再写一行（后者覆盖前面的）；下一段文字是另一条。 */
  settle(gid: string, assistantId: string, text: string): void {
    const turn = this.turns.get(`${gid}@${assistantId}`);
    if (!turn) return;
    // 事件那一轮：先攒在手里，runTurn 结束时才知道这一轮该不该说
    if (turn.event) {
      if (text.trim()) (turn.held ??= []).push(text);
      return;
    }
    const id = turn.itemId;
    turn.itemId = undefined;
    // NO_REPLY 这个词永远不显示：去掉之后什么都不剩，就当作这一段没说
    const visible = stripNoReply(text);
    if (saysNoReply(text)) turn.silent = true;
    if (!visible) {
      // 只流出了空白（工具调用前的换行）：把那条流式条目收掉，重启时才不会当成中断
      if (id) this.bus.emit({ type: "group-item", groupId: gid, item: this.append(gid, { kind: "assistant", speaker: assistantId, text: "" }, id) });
      return;
    }
    turn.text += visible;
    const item = this.append(gid, { kind: "assistant", speaker: assistantId, text: visible }, id ?? this.nextId(gid));
    turn.lastId = item.id;
    this.bus.emit({ type: "group-item", groupId: gid, item });
    this.publish(gid);
  }

  /**
   * 事件那一轮收尾：以 NO_REPLY 收尾就一段都不写，也不按里面的 @ 叫人；
   * 不然把攒着的各段照原来那样按顺序写进时间线。
   */
  private settleEventTurn(gid: string, assistantId: string, turn: RunningTurn): void {
    const held = turn.held ?? [];
    turn.held = [];
    if (!held.length) return;
    if (saysNoReply(held.at(-1)!)) { turn.silent = true; return; }
    for (const one of held) {
      const text = stripNoReply(one);
      if (!text) continue;
      turn.text += text;
      const item = this.append(gid, { kind: "assistant", speaker: assistantId, text });
      turn.lastId = item.id;
      this.bus.emit({ type: "group-item", groupId: gid, item });
    }
    this.publish(gid);
  }

  /** 卡片、文件、图片从会话落进时间线：发言人是这个成员，id 照 g-N 分配。 */
  appendItem(gid: string, speaker: string, item: NewItem & { forwardedFrom?: GroupItem["forwardedFrom"] }): GroupItem {
    const full = this.append(gid, { ...item, speaker });
    this.bus.emit({ type: "group-item", groupId: gid, item: full });
    return full;
  }

  /** 条目更新（图片画完、失败）：同一个 id 再写一行，读的时候后者覆盖前者。 */
  updateImageItem(gid: string, id: string, update: { status: "done" | "failed"; path?: string; error?: string }): GroupItem | undefined {
    const item = this.store.groupItems(gid).find((entry) => entry.id === id && entry.kind === "image");
    if (item?.kind !== "image") return undefined;
    const full: GroupItem = { ...item, ...update, id, at: item.at };
    this.store.appendGroupItem(gid, full);
    this.bus.emit({ type: "group-item", groupId: gid, item: full });
    return full;
  }

  /** 一行系统提示（停下、重启、无响应、记忆已更新）。 */
  note(gid: string, speaker: string, text: string, icon: NoteIcon = "info", detail?: string, targetGroupId?: string): GroupItem {
    const visibleText = text === RELAY_NOTE ? t("群内转交次数过多，已在此暂停。") : text === RESTART_NOTE ? t("服务已重启，本轮已中断。") : text;
    return this.appendItem(gid, speaker, { kind: "note", icon, text: visibleText, ...(detail ? { detail } : {}), ...(targetGroupId ? { targetGroupId } : {}) });
  }

  /** 给这个群（或话题）时间线上最新的一条用户消息（或指定的那条）点表情回应；再点会换掉。 */
  react(gid: string, assistantId: string, emoji: string, itemId?: string): { ok: true; itemId: string } | { ok: false; error: string } {
    const group = this.group(gid);
    if (!group.members.includes(assistantId)) return { ok: false, error: "你不是这个群的成员。" };
    const target = this.timeline(gid).findLast((item) => item.kind === "user" && (!itemId || item.id === itemId));
    if (!target || target.kind !== "user") return { ok: false, error: "这个群里还没有用户的消息，无法添加表情回应。" };
    const all = this.store.groupState(gid).reactions ?? {};
    const forItem = { ...(all[target.id] ?? {}), [assistantId]: emoji };
    this.store.saveGroupState(gid, { reactions: { ...all, [target.id]: forItem } });
    const reactions = reactionsList(forItem);
    this.bus.emit({ type: "group-item", groupId: gid, item: { ...target, ...(reactions ? { reactions } : {}) } });
    return { ok: true, itemId: target.id };
  }

  /** 这一个群的时间线（去掉没说完的空回复，用户条目补上表情回应）。 */
  timeline(gid: string): GroupItem[] {
    const storedReactions = this.store.groupState(gid).reactions;
    return this.store.groupItems(gid)
      .filter((item) => item.kind !== "assistant" || item.text.trim().length > 0)
      .map((item) => {
        if (item.kind !== "user") return item;
        const reactions = reactionsList(storedReactions?.[item.id]);
        return reactions ? { ...item, reactions } : item;
      });
  }

  private append(gid: string, item: NewGroupItem, id = this.nextId(gid)): GroupItem {
    const full = { ...item, id, at: new Date().toISOString() } as GroupItem;
    this.store.appendGroupItem(gid, full);
    return full;
  }

  /** 条目 id 按群递增：g-1、g-2…；几份成员会话合在一条时间线上，不能用单聊的 a-N。 */
  private nextId(gid: string): string {
    let counter = this.counters.get(gid);
    if (counter === undefined) {
      counter = this.store.groupItems(gid).reduce((max, item) => {
        const match = /^g-(\d+)$/.exec(item.id);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);
    }
    const next = counter + 1;
    this.counters.set(gid, next);
    return `g-${next}`;
  }

  private speakerName(speaker: string): string {
    if (speaker === "user") return "用户";
    if (speaker === SYSTEM) return "系统";
    return this.nameOf(speaker);
  }

  private nameOf(assistantId: string): string {
    return this.store.assistant(assistantId)?.name ?? assistantId;
  }

  private group(gid: string): Group {
    const group = this.store.group(gid);
    if (!group) throw new Error(`群不存在：${gid}`);
    return group;
  }

  /** 重启：被中断的回合和单聊一样不续，但时间线里留一条说明，不留永远在流式的条目。 */
  private repairInterrupted(): void {
    for (const group of this.store.groups()) {
      for (const item of this.store.groupItems(group.id)) {
        if (item.kind !== "assistant" || !item.streaming) continue;
        this.store.appendGroupItem(group.id, { ...item, streaming: false });
        this.note(group.id, SYSTEM, RESTART_NOTE, "info");
      }
    }
  }
}
