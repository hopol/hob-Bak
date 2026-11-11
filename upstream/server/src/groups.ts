// 群：用户和几个助手共用的时间线。谁说话由代码定（@ 谁、引用谁、没点名就群主），
// 每个成员在群里有一份自己的会话，和它的单聊分开（见 docs/architecture.md「群」）。
import type {
  Group,
  GroupItem,
  GroupItemsPage,
  GroupSummary,
  NoteIcon,
  SendMessageBody,
  WorkflowId,
} from "../../shared/types.ts";
import { newId } from "./ids.ts";
import { nowBlock } from "./now.ts";
import { checkAssistantModels } from "./models.ts";
import type { NewItem } from "./router.ts";
import type { HobRuntime } from "./runtime.ts";

/** 一条用户消息引出的助手回合上限：挡来回 @ 的死循环，不是限制正常协作。 */
export const MAX_WAVE_TURNS = 20;
export const RELAY_NOTE = "群里接力太多次，先停在这里";
export const RESTART_NOTE = "服务重启，这一轮中断了";
/** 话题关了以后发消息：话题关了不能再发，能重新打开。 */
export const TOPIC_CLOSED = "这个话题已关闭，重新打开后才能发消息";
/** 用户关闭话题时，话题里没结束的事项按放弃处理，原因写这句。 */
export const CLOSED_TOPIC_REASON = "用户关闭了这个话题";

/** 系统写的条目（停下、重启）的发言人。 */
const SYSTEM = "system";

/** 一条用户消息引出的一串助手回合，turns 是已经开了几个。 */
interface Wave {
  turns: number;
  stopped: boolean;
}

/** 一个成员正在说的这一轮：正文（@ 检测用）、当前这条消息的条目、最后一条说成的条目、叫到它的条目。 */
interface RunningTurn {
  itemId?: string;
  lastId?: string;
  text: string;
  triggerId?: string;
}

/** 这一轮该给它的条目，和给到哪一条（seen 存它）。 */
interface TurnInput {
  items: GroupItem[];
  seenTo?: GroupItem;
}

/** 时间线里新条目：去掉 id 和 at（由这里分配），发言人必填。 */
type NewGroupItem = NewItem & { speaker: string; forwardedFrom?: GroupItem["forwardedFrom"] };

export interface CreateGroupInput {
  name?: unknown;
  purpose?: unknown;
  ownerId?: unknown;
  members?: unknown;
  workflow?: unknown;
  parentId?: unknown;
}

export interface UpdateGroupInput {
  name?: unknown;
  purpose?: unknown;
  instructions?: unknown;
  ownerId?: unknown;
  members?: unknown;
  workflow?: unknown;
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
    let last: GroupSummary["last"];
    for (const item of items) {
      if (item.kind === "assistant" || item.kind === "user" || item.kind === "note") last = { at: item.at, speaker: item.speaker, text: item.text };
    }
    const project = group.parentId ? this.runtime.projects.topicOf(group) : undefined;
    return {
      ...group,
      ...(last ? { last } : {}),
      unread: this.unread(group.id, items),
      busy: this.busyOf(group.id),
      ...(project ? { project } : {}),
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
    if (input.parentId !== undefined) throw new Error("建群不接受 parentId：话题在群里开（POST /api/groups/:gid/topics）。");
    const members = this.membersOf(input.members, "群里至少要有一个助手");
    const workflow = this.workflowOf(input.workflow);
    const group: Group = {
      id: newId("g-"),
      name: this.text(input.name, "群名", 40),
      purpose: this.text(input.purpose, "负责什么", 200),
      ownerId: this.ownerOf(input.ownerId, members),
      members,
      createdAt: new Date().toISOString(),
      ...(workflow ? { workflow } : {}),
    };
    this.store.saveGroup(group);
    this.note(group.id, SYSTEM, `建了群「${group.name}」`, "info");
    this.publish(group.id);
    return group;
  }

  /**
   * 开一个话题：话题是挂在群下面的群，时间线、成员会话、已读都是自己的。
   * 成员、群主、负责什么、工作方式取所属的群，不另存。
   */
  createTopic(gid: string, title: unknown, createdBy: string): Group {
    const group = this.group(gid);
    if (group.parentId) throw new Error("话题挂在群下面：话题里不能再开话题。");
    const topic: Group = {
      id: newId("g-"),
      name: this.text(title, "话题名", 40),
      purpose: group.purpose,
      ownerId: group.ownerId,
      members: group.members,
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
   * 用户和群主开话题、在综合里立事项都走这里。
   */
  forwardUserItem(gid: string, topicId: string, item: GroupItem): GroupItem | undefined {
    if (item.kind === "note" && item.icon === "routine") return this.appendItem(topicId, item.speaker, { kind: "note", icon: "routine", text: item.text, forwardedFrom: { groupId: gid, itemId: item.id } });
    if (item.kind !== "user") return undefined;
    return this.appendItem(topicId, "user", {
      kind: "user",
      text: item.text,
      ...(item.quote ? { quote: item.quote } : {}),
      ...(item.files?.length ? { files: item.files } : {}),
      forwardedFrom: { groupId: gid, itemId: item.id },
    });
  }

  /** 用户关闭话题：写上时间和结论；话题里没结束的事项按放弃处理。正在跑的回合和任务不停。 */
  closeByUser(tid: string, note: unknown): Group {
    const topic = this.topic(tid);
    for (const project of this.runtime.projects.active(tid)) this.runtime.projects.drop(project, CLOSED_TOPIC_REASON);
    return this.closeTopic(topic, note);
  }

  /** 群主关话题：close_topic（工具先挡住有没结束事项的话题），或者 close_project 结束了话题里的事项。 */
  closeByOwner(tid: string, note: unknown): Group {
    return this.closeTopic(this.topic(tid), note);
  }

  /** 重新打开话题：清掉关闭的时间和说明；已经结束的事项保持结束。 */
  reopen(tid: string): Group {
    const topic = this.topic(tid);
    const { closedAt: _closedAt, closeNote: _closeNote, ...rest } = topic;
    this.store.saveGroup(rest);
    this.publish(tid);
    if (topic.parentId) this.publish(topic.parentId);
    return this.group(tid);
  }

  private closeTopic(topic: Group, note: unknown): Group {
    const text = typeof note === "string" ? note.trim() : "";
    const next: Group = { ...topic, closedAt: new Date().toISOString(), ...(text ? { closeNote: text } : {}) };
    // 上一句结论还在时，这次没给说明就把它清掉，免得卡片上留着旧话
    if (!text && next.closeNote) delete next.closeNote;
    this.store.saveGroup(next);
    this.publish(topic.id);
    if (topic.parentId) this.publish(topic.parentId);
    return this.group(topic.id);
  }

  /** 这个群（连同它的话题）里还有没结束的事项：工作方式不能改成「无」。 */
  private hasOpenProjects(gid: string): boolean {
    return [gid, ...this.topicsOf(gid).map((topic) => topic.id)].some((id) => this.runtime.projects.active(id).length > 0);
  }

  update(gid: string, patch: UpdateGroupInput): Group {
    const group = this.group(gid);
    if (group.parentId) {
      if (patch.instructions !== undefined) {
        this.update(group.parentId, { instructions: patch.instructions });
        const { instructions: _instructions, ...rest } = patch;
        return Object.keys(rest).length ? this.renameTopic(group, rest) : this.group(gid);
      }
      return this.renameTopic(group, patch);
    }
    // 带了这个键就是要改它：null 是「无」，没带才是不改
    const changingWorkflow = Object.prototype.hasOwnProperty.call(patch, "workflow");
    const workflow = changingWorkflow ? this.workflowOf(patch.workflow) : group.workflow;
    if (workflow !== group.workflow && !workflow && this.hasOpenProjects(gid)) {
      throw new Error("这个群还有没结束的事项，结束以后才能改工作方式");
    }
    const members = patch.members === undefined ? group.members : this.membersOf(patch.members, "群里至少要留一个成员");
    const ownerId = patch.ownerId === undefined ? group.ownerId : this.ownerOf(patch.ownerId, members);
    if (!members.includes(ownerId)) throw new Error("群主要在成员里");
    if (patch.instructions !== undefined && typeof patch.instructions !== "string") throw new Error("补充说明必须是文字");
    const next: Group = {
      ...group,
      members,
      ownerId,
      ...(patch.name !== undefined ? { name: this.text(patch.name, "群名", 40) } : {}),
      ...(patch.purpose !== undefined ? { purpose: this.text(patch.purpose, "负责什么", 200) } : {}),
      ...(typeof patch.instructions === "string" ? { instructions: patch.instructions } : {}),
    };
    if (group.memberModels) next.memberModels = Object.fromEntries(Object.entries(group.memberModels).filter(([id]) => members.includes(id)));
    if (workflow) next.workflow = workflow;
    else delete next.workflow;
    this.store.saveGroup(next);
    for (const routine of this.store.routines()) {
      const destination = routine.groupId ? this.store.group(routine.groupId) : undefined;
      if (!destination || (destination.parentId ?? destination.id) !== gid || routine.assistantId === ownerId) continue;
      this.runtime.routines.transfer(routine, ownerId);
    }
    const topicIds = this.topicsOf(gid).map((topic) => topic.id);
    // 被移出的成员在各话题里的会话也跟着放掉
    for (const id of group.members) if (!members.includes(id)) this.forgetMemberSessions([gid, ...topicIds], id);
    // 换了群主：两边重开会话，事项工具和提示词才跟着换
    if (ownerId !== group.ownerId) for (const id of [group.ownerId, ownerId]) this.forgetMemberSessions([gid, ...topicIds], id);
    // 工作方式变了：群主重开会话，工具和提示词才跟着换
    if (workflow !== group.workflow) for (const id of new Set([group.ownerId, ownerId])) this.forgetMemberSessions([gid, ...topicIds], id);
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

  /** 话题只能改名：成员、群主、负责什么、工作方式跟着所属的群。 */
  private renameTopic(topic: Group, patch: UpdateGroupInput): Group {
    if (patch.members !== undefined || patch.ownerId !== undefined || patch.purpose !== undefined || patch.workflow !== undefined) {
      throw new Error("话题的成员、群主、负责什么和工作方式跟着所属的群，在群里改");
    }
    const next: Group = { ...topic, ...(patch.name !== undefined ? { name: this.text(patch.name, "话题名", 40) } : {}) };
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
      this.note(group.id, SYSTEM, `「${this.nameOf(assistantId)}」归档了，已移出这个群`, "info");
      this.publish(group.id);
      for (const topic of this.topicsOf(group.id)) this.publish(topic.id);
    }
  }

  /** 工作方式：software 是「软件开发」；null / 不填是「无」。 */
  private workflowOf(value: unknown): WorkflowId | undefined {
    if (value === undefined || value === null) return undefined;
    if (value === "software") return "software";
    throw new Error("工作方式只能填 software（软件开发），或者不填");
  }

  private topic(id: string): Group {
    const group = this.group(id);
    if (!group.parentId) throw new Error("关闭和重新打开只对话题用：群用归档。");
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
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id)) throw new Error("成员要是助手 id 的列表");
    const ids = [...new Set(value as string[])];
    if (!ids.length) throw new Error(tooFew);
    for (const id of ids) {
      if (!this.store.assistant(id)) throw new Error(`助手不存在或已归档：${id}`);
    }
    return ids;
  }

  private ownerOf(value: unknown, members: string[]): string {
    if (value === undefined) throw new Error("群主不能为空");
    if (typeof value !== "string" || !value) throw new Error("群主要填助手 id");
    if (!members.includes(value)) throw new Error("群主要在成员里");
    return value;
  }

  // ---------- 群里的消息 ----------

  /** 用户在群里说话：写一条 user 条目，算出轮到谁，给每个人开一轮。话题关了就不收，等重新打开。 */
  async send(gid: string, body: SendMessageBody): Promise<GroupItem> {
    const group = this.group(gid);
    if (group.closedAt) throw new Error(TOPIC_CLOSED);
    const item = this.append(gid, {
      kind: "user",
      speaker: "user",
      text: body.text,
      ...(body.quote ? { quote: body.quote } : {}),
      ...(body.files?.length ? { files: body.files } : {}),
    });
    this.bus.emit({ type: "group-item", groupId: gid, item });
    this.publish(gid);
    const wave: Wave = { turns: 0, stopped: false };
    for (const id of this.targetsOf(group, body.text, body.quote)) void this.callTurn(gid, group, id, wave, item.id);
    return item;
  }

  /** 停掉这个群里所有成员正在进行的回合（不停任务）；排队里的回合也不再生效。 */
  async stop(gid: string, group?: Group): Promise<void> {
    const target = group ?? this.group(gid);
    this.epochs.set(gid, (this.epochs.get(gid) ?? 0) + 1);
    await Promise.all(target.members.map((id) => this.runtime.router.stop(id, gid)));
  }

  /** 用户的消息轮到谁：@ 了谁、引用谁的消息就是谁；都没有就轮到群主。 */
  private targetsOf(group: Group, text: string, quote?: { itemId: string; text: string }): string[] {
    const out = this.mentions(text, group);
    if (quote) {
      const quoted = this.store.groupItems(group.id).find((item) => item.id === quote.itemId);
      const speaker = quoted?.speaker;
      if (speaker && speaker !== "user" && speaker !== SYSTEM && group.members.includes(speaker) && !out.includes(speaker)) out.push(speaker);
    }
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
  private schedule(gid: string, assistantId: string, wave: Wave, triggerId: string, event?: string): Promise<void> {
    const key = `${gid}@${assistantId}`;
    const epoch = this.epochs.get(gid) ?? 0;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.runTurn(gid, assistantId, wave, epoch, triggerId, event))
      .catch(() => undefined);
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
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
      if (await this.runtime.router.steerMember(gid, assistantId, text, this.inputFiles(input), () => this.markSeen(gid, assistantId, input.seenTo)).catch(() => false)) {
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
  async deliverEvent(gid: string, assistantId: string, text: string, triggerId = ""): Promise<void> {
    const group = this.group(gid);
    if (!group.members.includes(assistantId)) return;
    await this.schedule(gid, assistantId, { turns: 0, stopped: false }, triggerId, text);
  }

  /**
   * 这一轮是谁叫到它的：用户的消息、别的成员的回复，或者一个事件（事件没有触发条目）。
   * 立事项时用它取「叫到群主的那条用户消息」。
   */
  triggerOf(gid: string, assistantId: string): GroupItem | undefined {
    const id = this.turns.get(`${gid}@${assistantId}`)?.triggerId;
    return id ? this.store.groupItems(gid).find((item) => item.id === id) : undefined;
  }

  /**
   * 这条用户消息该转给谁：先取叫到这个成员的那条，没有就取时间线上最后一条用户消息
   * （立事项的原始需求、开话题时转过去的话都照这个取）。
   */
  requestItem(gid: string, assistantId: string): Extract<GroupItem, { kind: "user" | "note" }> | undefined {
    const trigger = this.triggerOf(gid, assistantId);
    if (trigger?.kind === "user" || (trigger?.kind === "note" && trigger.icon === "routine")) return trigger;
    return this.timeline(gid).findLast((item): item is Extract<GroupItem, { kind: "user" }> => item.kind === "user");
  }

  private async runTurn(gid: string, assistantId: string, wave: Wave, epoch: number, triggerId: string, event?: string): Promise<void> {
    const group = this.store.group(gid);
    if (!group || !group.members.includes(assistantId)) return;
    // 用户按了停止：这一轮不再开始
    if ((this.epochs.get(gid) ?? 0) !== epoch) return;
    // 一条用户消息引出的回合太多：停下，不再按 @ 叫人
    if (wave.turns >= MAX_WAVE_TURNS) {
      if (!wave.stopped) {
        wave.stopped = true;
        this.note(gid, SYSTEM, RELAY_NOTE, "info");
        // 群主在群里收尾：只给它这一轮，它再 @ 人也不接着转，免得停了又起
        void this.schedule(gid, group.ownerId, { turns: MAX_WAVE_TURNS - 1, stopped: true }, "", `${RELAY_NOTE}：一条消息引出的助手回复已经超过 ${MAX_WAVE_TURNS} 轮，后面的 @ 不再转给下一个成员。需要的话，把结论整理一下再发一条。`)
          .catch(() => undefined);
      }
      return;
    }
    // 排到的这一轮已经没有新东西给它（前面那一轮已经带上了）：不跑，不调模型
    const input = this.windowFor(group, assistantId, event === undefined ? triggerId : "");
    if (event === undefined && !input) return;
    wave.turns += 1;
    const key = `${gid}@${assistantId}`;
    const turn: RunningTurn = { text: "", ...(triggerId ? { triggerId } : {}) };
    this.turns.set(key, turn);
    let text = "";
    try {
      const prompt = this.inputText(assistantId, group, input ?? { items: [] }, event);
      await this.runtime.router.deliverMember(gid, assistantId, prompt, () => this.markSeen(gid, assistantId, input?.seenTo), input ? this.inputFiles(input) : []);
      text = turn.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.note(gid, assistantId, `回复失败：${message}。@${this.nameOf(assistantId)} 说一句即可重试。`, "info");
    } finally {
      this.turns.delete(key);
    }
    if ((this.epochs.get(gid) ?? 0) !== epoch) return;
    // 回复里 @ 了别的成员：接着轮到他们（用这一轮最后一条的 id 当触发条目）
    if (!turn.lastId) return;
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
  private inputText(assistantId: string, group: Group, input: TurnInput, event?: string): string {
    const lines = input.items.map((item) => this.lineOf(item, group.id)).filter(Boolean);
    const body = [lines.join("\n"), ...(event === undefined ? [] : [`[hob-event] ${event}`])].filter(Boolean).join("\n\n");
    return `${nowBlock(this.runtime, assistantId)}\n\n${body}`;
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
        return `${who}：开了任务「${job?.title ?? item.jobId}」`;
      }
      case "question": {
        const approval = this.store.approval(item.approvalId);
        return `${who}：问了用户${approval ? `「${approval.title}」` : "一个问题"}`;
      }
      case "file":
        return `${who}：发了文件「${item.name}」`;
      case "image":
        return `${who}：画了一张图`;
      case "draft":
        return `${who}：提议新建一个助手`;
      case "delegation":
        return `${who}：转交了一件事`;
      case "project": {
        const project = this.store.project(gid, item.projectId);
        return `${who}：立了事项「${project?.title ?? item.projectId}」`;
      }
      case "topic": {
        const topic = this.store.group(item.topicId);
        return `${who}：开了话题「${topic?.name ?? item.topicId}」`;
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
    return {
      items: page,
      approvals: this.store.approvals().filter((approval) => approvalIds.has(approval.id)),
      jobs: [...jobIds].flatMap((id) => {
        const job = this.store.job(id);
        return job ? [job] : [];
      }),
      hasMore: start > 0,
    };
  }

  /** 成员的一条回复开始输出：分配条目 id，先写一条流式条目，再按 delta 推给前端。 */
  delta(gid: string, assistantId: string, delta: string): void {
    const turn = this.turns.get(`${gid}@${assistantId}`);
    if (!turn) return;
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
    const id = turn.itemId;
    turn.itemId = undefined;
    if (!text.trim()) {
      // 只流出了空白（工具调用前的换行）：把那条流式条目收掉，重启时才不会当成中断
      if (id) this.bus.emit({ type: "group-item", groupId: gid, item: this.append(gid, { kind: "assistant", speaker: assistantId, text: "" }, id) });
      return;
    }
    turn.text += text;
    const item = this.append(gid, { kind: "assistant", speaker: assistantId, text }, id ?? this.nextId(gid));
    turn.lastId = item.id;
    this.bus.emit({ type: "group-item", groupId: gid, item });
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
  note(gid: string, speaker: string, text: string, icon: NoteIcon = "info"): GroupItem {
    return this.appendItem(gid, speaker, { kind: "note", icon, text });
  }

  /** 这一个群的时间线（去掉没说完的空回复）。 */
  timeline(gid: string): GroupItem[] {
    return this.store.groupItems(gid).filter((item) => item.kind !== "assistant" || item.text.trim().length > 0);
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
