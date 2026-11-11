import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { archiveAssistantsDir, archiveGroupsDir, assistantDir, assistantJobsDir, groupDir, groupFilesDir, groupsDir, groupProjectsDir, projectRecordPath } from "./config.ts";
import { newId } from "./ids.ts";
import type {
  Approval,
  Assistant,
  Delegation,
  Draft,
  Group,
  GroupItem,
  Job,
  Project,
  Routine,
  Rule,
  WorklogEntry,
} from "../../shared/types.ts";

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

type StoredRecord<T> = T & { _hobRevision?: number };
function withoutRevision<T>(item: StoredRecord<T>): T {
  const { _hobRevision: _revision, ...value } = item;
  return value as T;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (error) {
      console.error(`跳过 ${path} 中损坏的记录：`, error);
    }
  }
  return out;
}

export type StoredDelegation = Delegation & { pendingResult?: string };
export function publicDelegation(record: StoredDelegation): Delegation {
  const { pendingResult: _pending, ...visible } = record;
  return visible;
}

/** 助手的本地状态（不属于前后端契约，只存未读位置）。 */
export interface AssistantState {
  readAt?: string;
}

/** 群的本地状态：已读到哪条；每个成员上一轮给到时间线的哪一条（assistantId → 条目 id）。 */
export interface GroupState {
  readAt?: string;
  seen?: Record<string, string>;
}

/**
 * HOB_HOME 下的全部 JSON / JSONL 数据。文件都小，直接同步读写，写入走临时文件 + rename。
 *
 * v2 布局里任务和审批、定时都跟着所属助手放（assistants/<id>/jobs|approvals.json|routines.json），
 * 进不到目录的地方要知道 jobId 落在哪个助手下面，所以这里维护一份内存索引，启动时扫一遍、
 * 新建任务时登记；不存索引文件，免得和实际目录对不上。
 */
export class Store {
  /** jobId → 任务目录（含归档助手目录里的） */
  private jobIndex: Map<string, string> | null = null;

  constructor(readonly home: string) {}

  init(): void {
    mkdirSync(join(this.home, "assistants"), { recursive: true });
    if (!existsSync(join(this.home, "rules.json"))) {
      const changedAt = new Date().toISOString();
      this.saveGlobalRules([
        ...["删除或覆盖文件、数据和备份", "对外发送（消息、邮件、发布）、付费、充值、改计费", "停止或重启别人正在使用的服务和设备", "修改可能让你失去远程访问的设置（网络、防火墙、登录方式）"].map((text) => ({ id: newId("r-"), text, mode: "ask" as const, changedAt })),
        ...["过去的记录是线索不是现状：动手前先核实实际状态。", "改配置、改数据前先留好退路（备份或记下原值）；改完用实际效果验证，不只看命令返回。", "凭据（密码、密钥、令牌、Cookie）只在用的时候读取，不回显，不写进文件和报告，也不存起来。"].map((text) => ({ id: newId("r-"), text, mode: "allow" as const, changedAt })),
      ]);
    }
  }

  /** 启动时先检查系统数据；单条任务、事项和日志记录在各自列表中跳过并记录。 */
  validate(): void {
    this.globalRules();
    for (const file of ["config.json", "settings.json", "secrets.json", "push.json", "seeded.json", "moves.json"]) {
      readJson(join(this.home, "system", file), null);
    }
    for (const path of ["knowledge/entries.json", "knowledge/collections.json", "system/lore/config.json", "system/engine/mcp.json"]) readJson(join(this.home, path), null);
    for (const root of [join(this.home, "assistants"), archiveAssistantsDir(this.home)]) {
      if (existsSync(root)) for (const id of readdirSync(root)) {
        for (const name of ["profile.json", "rules.json", "state.json", "approvals.json", "routines.json", "memories.json", "drafts.json", "delegations.json"]) {
          readJson(join(root, id, name), null);
        }
      }
    }
    const archivedGroups = archiveGroupsDir(this.home);
    if (existsSync(archivedGroups)) for (const folder of readdirSync(archivedGroups)) {
      const dir = join(archivedGroups, folder);
      for (const name of ["group.json", "rules.json", "state.json", "routines.json"]) readJson(join(dir, name), null);
      const topics = join(dir, "topics");
      if (existsSync(topics)) for (const topic of readdirSync(topics)) {
        for (const name of ["group.json", "state.json"]) readJson(join(topics, topic, name), null);
      }
    }
    for (const id of this.groupIds()) {
      for (const name of ["group.json", "rules.json", "state.json", "routines.json"]) readJson(join(groupDir(this.home, id), name), null);
    }
  }

  globalRules(): Rule[] {
    const path = join(this.home, "rules.json");
    const rules = readJson<unknown>(path, []);
    if (!Array.isArray(rules)) throw new Error(`全局规则文件格式无效：${path}`);
    return rules as Rule[];
  }

  saveGlobalRules(rules: Rule[]): void {
    writeJsonAtomic(join(this.home, "rules.json"), rules);
  }

  // ---------- 助手 ----------
  private assistantDir(id: string): string {
    return assistantDir(this.home, id);
  }

  assistants(): Assistant[] {
    const root = join(this.home, "assistants");
    if (!existsSync(root)) return [];
    const out: Assistant[] = [];
    for (const id of readdirSync(root)) {
      const profile = this.assistant(id);
      if (profile) out.push(profile);
    }
    // 主助手永远在最前：新装时自带的助手和它同一毫秒建出来，按时间排会被目录顺序排到前面
    return out.sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || a.createdAt.localeCompare(b.createdAt));
  }

  assistant(id: string): Assistant | undefined {
    const profile = readJson<Assistant | null>(join(this.assistantDir(id), "profile.json"), null);
    if (!profile) return undefined;
    // 旧档案没有这个字段
    return { ...profile, instructions: profile.instructions ?? "" };
  }

  saveAssistant(assistant: Assistant): void {
    writeJsonAtomic(join(this.assistantDir(assistant.id), "profile.json"), assistant);
  }

  deleteAssistant(id: string): void {
    rmSync(this.assistantDir(id), { recursive: true, force: true });
  }

  /**
   * 归档助手：整个助手目录（含自己的任务、定时、审批、文件）移进 archive/assistants/<id>-<时间>/。
   * 同盘 rename，不复制也不删数据。
   */
  archiveAssistant(id: string, name: string, routines: Routine[] = []): string {
    if (routines.length) writeJsonAtomic(join(this.assistantDir(id), "routines.json"), routines);
    const target = join(archiveAssistantsDir(this.home), name);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(this.assistantDir(id), target);
    // 任务跟着搬走了，索引要重建
    this.jobIndex = null;
    return target;
  }

  state(id: string): AssistantState {
    return readJson<AssistantState>(join(this.assistantDir(id), "state.json"), {});
  }

  saveState(id: string, state: AssistantState): void {
    writeJsonAtomic(join(this.assistantDir(id), "state.json"), state);
  }

  routerFile(id: string): string {
    return join(this.assistantDir(id), "router.jsonl");
  }

  rules(id: string): Rule[] {
    return readJson<Rule[]>(join(this.assistantDir(id), "rules.json"), []);
  }

  saveRules(id: string, rules: Rule[]): void {
    writeJsonAtomic(join(this.assistantDir(id), "rules.json"), rules);
  }

  groupMatches(filter: string, groupId?: string): boolean {
    if (filter === "none") return !groupId;
    if (!groupId) return false;
    const target = this.group(filter), actual = this.group(groupId);
    return !!target && !!actual && (target.parentId ?? target.id) === (actual.parentId ?? actual.id);
  }

  groupRules(id: string): Rule[] {
    const group = this.group(id);
    if (!group) throw new Error("群不存在");
    return readJson<Rule[]>(join(groupDir(this.home, group.parentId ?? group.id), "rules.json"), []);
  }

  saveGroupRules(id: string, rules: Rule[]): void {
    const group = this.group(id);
    if (!group) throw new Error("群不存在");
    writeJsonAtomic(join(groupDir(this.home, group.parentId ?? group.id), "rules.json"), rules);
  }

  worklog(id: string, limit = 30): WorklogEntry[] {
    return readJsonl<WorklogEntry>(join(this.assistantDir(id), "worklog.jsonl")).slice(-limit).reverse();
  }

  addWorklog(id: string, entry: WorklogEntry): void {
    const dir = this.assistantDir(id);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "worklog.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  // ---------- 群 ----------
  /** 群目录名（只认有 group.json 的）。 */
  private groupIds(): string[] {
    const root = groupsDir(this.home);
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((id) => existsSync(join(root, id, "group.json")));
  }

  groups(): Group[] {
    return this.groupIds()
      .flatMap((id) => { const group = this.group(id); return group ? [group] : []; })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 读一个群。话题带 parentId，读出来时补上所属群的成员、群主、负责什么和工作方式：
   * 这些只在群上存一份，群改了，话题读到的跟着变。
   */
  group(id: string): Group | undefined {
    const own = readJson<Group | null>(join(groupDir(this.home, id), "group.json"), null);
    if (!own) return undefined;
    if (!own.parentId) return own;
    const parent = readJson<Group | null>(join(groupDir(this.home, own.parentId), "group.json"), null);
    // 所属的群不在了（目录坏了）：当这个话题不存在，别处拿不到缺成员、缺群主的数据
    if (!parent) return undefined;
    return {
      id: own.id,
      name: own.name,
      purpose: parent.purpose,
      ...(parent.instructions !== undefined ? { instructions: parent.instructions } : {}),
      ownerId: parent.ownerId,
      members: parent.members,
      ...(parent.models ? { models: parent.models } : {}),
      ...(parent.memberModels ? { memberModels: parent.memberModels } : {}),
      createdAt: own.createdAt,
      parentId: own.parentId,
      ...(parent.workflow ? { workflow: parent.workflow } : {}),
      ...(own.createdBy ? { createdBy: own.createdBy } : {}),
      ...(own.closedAt ? { closedAt: own.closedAt } : {}),
      ...(own.closeNote ? { closeNote: own.closeNote } : {}),
    };
  }

  /** 存一个群。话题只写自己的字段，成员、群主、负责什么和工作方式留在所属的群上。 */
  saveGroup(group: Group): void {
    const path = join(groupDir(this.home, group.id), "group.json");
    if (!group.parentId) {
      writeJsonAtomic(path, group);
      return;
    }
    writeJsonAtomic(path, {
      id: group.id,
      parentId: group.parentId,
      name: group.name,
      createdAt: group.createdAt,
      ...(group.createdBy ? { createdBy: group.createdBy } : {}),
      ...(group.closedAt ? { closedAt: group.closedAt } : {}),
      ...(group.closeNote ? { closeNote: group.closeNote } : {}),
    });
  }

  /**
   * 归档群：整个群目录（时间线、成员会话、文件）同盘 rename 进 archive/groups/<gid>-<时间>/，
   * 话题跟着放进去，各自一个目录。
   */
  archiveGroup(id: string, name: string, topics: string[] = []): string {
    const target = join(archiveGroupsDir(this.home), name);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(groupDir(this.home, id), target);
    if (topics.length) {
      const root = join(target, "topics");
      mkdirSync(root, { recursive: true });
      for (const topic of topics) renameSync(groupDir(this.home, topic), join(root, topic));
    }
    return target;
  }

  groupState(id: string): GroupState {
    return readJson<GroupState>(join(groupDir(this.home, id), "state.json"), {});
  }

  /** 只改给出的字段，别的照旧。 */
  saveGroupState(id: string, patch: GroupState): void {
    writeJsonAtomic(join(groupDir(this.home, id), "state.json"), { ...this.groupState(id), ...patch });
  }

  groupTimelineFile(id: string): string {
    return join(groupDir(this.home, id), "timeline.jsonl");
  }

  /** 一个成员在这个群里的会话文件。 */
  groupMemberFile(id: string, assistantId: string): string {
    return join(groupDir(this.home, id), "members", `${assistantId}.jsonl`);
  }

  /** 这个群里所有成员的会话文件。 */
  groupMemberFiles(id: string): { assistantId: string; file: string }[] {
    const root = join(groupDir(this.home, id), "members");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => ({ assistantId: name.slice(0, -".jsonl".length), file: join(root, name) }));
  }

  groupFiles(id: string, kind?: "uploads" | "images"): string {
    return groupFilesDir(this.home, id, kind);
  }

  /**
   * 群的时间线：追加写，同 id 后写的覆盖前面的（条目更新），顺序按第一次出现的先后。
   */
  groupItems(id: string): GroupItem[] {
    const items = new Map<string, GroupItem>();
    for (const line of readJsonl<GroupItem>(this.groupTimelineFile(id))) {
      if (typeof line?.id !== "string" || !line.id) continue;
      items.set(line.id, line);
    }
    return [...items.values()];
  }

  appendGroupItem(id: string, item: GroupItem): void {
    const file = this.groupTimelineFile(id);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(item)}\n`);
  }

  // ---------- 事项：跟着群 ----------
  /** 这个群的事项（新的在前）。 */
  projects(gid: string): Project[] {
    const root = groupProjectsDir(this.home, gid);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          const project = readJson<Project | null>(join(root, name), null);
          return project ? [project] : [];
        } catch (error) { console.error(error); return []; }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  project(gid: string, pid: string): Project | undefined {
    return readJson<Project | null>(join(groupProjectsDir(this.home, gid), `${pid}.json`), null) ?? undefined;
  }

  saveProject(project: Project): void {
    writeJsonAtomic(join(groupProjectsDir(this.home, project.groupId), `${project.id}.json`), project);
  }

  /** 事项的记录（给成员和任务读的那份 md）。 */
  saveProjectRecord(gid: string, pid: string, markdown: string): void {
    const path = projectRecordPath(this.home, gid, pid);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, markdown);
    renameSync(tmp, path);
  }

  // ---------- 定时和审批：跟着所属助手 ----------
  /** 每个助手目录下的一份记录文件（含归档目录里的），有就给路径。 */
  private recordFiles(name: string, archived: boolean): string[] {
    const out: string[] = [];
    const live = join(this.home, "assistants");
    if (existsSync(live)) {
      for (const id of readdirSync(live)) {
        const file = join(live, id, name);
        if (existsSync(file)) out.push(file);
      }
    }
    if (!archived) return out;
    const root = archiveAssistantsDir(this.home);
    if (existsSync(root)) {
      for (const folder of readdirSync(root)) {
        const file = join(root, folder, name);
        if (existsSync(file)) out.push(file);
      }
    }
    return out;
  }

  /** 写这个助手的记录文件：助手归档了就跟到归档目录，不然就地建。 */
  private ownerFile(assistantId: string, name: string): string {
    const live = this.assistantDir(assistantId);
    if (existsSync(join(live, "profile.json"))) return join(live, name);
    const root = archiveAssistantsDir(this.home);
    if (existsSync(root)) {
      for (const folder of readdirSync(root)) {
        const dir = join(root, folder);
        const profile = readJson<{ id?: unknown }>(join(dir, "profile.json"), {});
        if (profile.id === assistantId) return join(dir, name);
      }
    }
    return join(live, name);
  }

  routines(): Routine[] {
    const files = [...this.recordFiles("routines.json", false), ...this.groupIds().flatMap((id) => {
      const group = this.group(id);
      return group && !group.parentId ? [join(groupDir(this.home, id), "routines.json")] : [];
    })];
    const found = new Map<string, { item: StoredRecord<Routine>; modified: bigint }>();
    for (const file of files) for (const item of readJson<StoredRecord<Routine>[]>(file, [])) {
      const modified = statSync(file, { bigint: true }).mtimeNs;
      const old = found.get(item.id);
      if (!old || (item._hobRevision ?? 0) > (old.item._hobRevision ?? 0) || ((item._hobRevision ?? 0) === (old.item._hobRevision ?? 0) && modified > old.modified)) found.set(item.id, { item, modified });
    }
    return [...found.values()].map(({ item }) => withoutRevision(item));
  }

  routine(id: string): Routine | undefined {
    return this.routines().find((r) => r.id === id);
  }

  saveRoutine(routine: Routine): void {
    const group = routine.groupId ? this.group(routine.groupId) : undefined;
    if (routine.groupId && !group) throw new Error("群不存在");
    const target = group ? join(groupDir(this.home, group.parentId ?? group.id), "routines.json") : this.ownerFile(routine.assistantId, "routines.json");
    const files = [...new Set([target, ...this.recordFiles("routines.json", true), ...this.groupIds().map((id) => join(groupDir(this.home, id), "routines.json"))])];
    const records = files.map((file) => ({ file, list: readJson<StoredRecord<Routine>[]>(file, []) }));
    const revision = 1 + Math.max(0, ...records.flatMap(({ list }) => list.filter((item) => item.id === routine.id).map((item) => item._hobRevision ?? 0)));
    const list = records.find(({ file }) => file === target)!.list.filter((r) => r.id !== routine.id);
    list.push({ ...routine, _hobRevision: revision });
    writeJsonAtomic(target, list);
    for (const { file, list: old } of records) {
      if (file === target) continue;
      const next = old.filter((r) => r.id !== routine.id);
      if (next.length !== old.length) writeJsonAtomic(file, next);
    }
  }

  /** 只从还在的助手里拿掉；归档目录里那份是历史，留着。 */
  deleteRoutine(id: string): void {
    for (const file of [...this.recordFiles("routines.json", false), ...this.groupIds().map((gid) => join(groupDir(this.home, gid), "routines.json"))]) {
      const list = readJson<Routine[]>(file, []);
      const next = list.filter((r) => r.id !== id);
      if (next.length !== list.length) writeJsonAtomic(file, next);
    }
  }

  // ---------- 审批 ----------
  approvals(): Approval[] {
    const found = new Map<string, { item: StoredRecord<Approval>; modified: bigint }>();
    for (const file of this.recordFiles("approvals.json", true)) for (const item of readJson<StoredRecord<Approval>[]>(file, [])) {
      const modified = statSync(file, { bigint: true }).mtimeNs;
      const old = found.get(item.id);
      if (!old || (item._hobRevision ?? 0) > (old.item._hobRevision ?? 0) || ((item._hobRevision ?? 0) === (old.item._hobRevision ?? 0) && modified > old.modified)) found.set(item.id, { item, modified });
    }
    return [...found.values()].map(({ item }) => withoutRevision(item));
  }

  approval(id: string): Approval | undefined {
    return this.approvals().find((a) => a.id === id);
  }

  saveApproval(approval: Approval): void {
    const target = this.ownerFile(approval.assistantId, "approvals.json");
    const files = [...new Set([target, ...this.recordFiles("approvals.json", true)])];
    const records = files.map((file) => ({ file, list: readJson<StoredRecord<Approval>[]>(file, []) }));
    const revision = 1 + Math.max(0, ...records.flatMap(({ list }) => list.filter((item) => item.id === approval.id).map((item) => item._hobRevision ?? 0)));
    const list = records.find(({ file }) => file === target)!.list.filter((a) => a.id !== approval.id);
    list.push({ ...approval, _hobRevision: revision });
    writeJsonAtomic(target, list);
    for (const { file, list: old } of records) {
      if (file === target) continue;
      const next = old.filter((a) => a.id !== approval.id);
      if (next.length !== old.length) writeJsonAtomic(file, next);
    }
  }

  // ---------- 委派 ----------
  private hobFile(name: string): string {
    return join(this.assistantDir("hob"), name);
  }

  internalDelegations(): StoredDelegation[] {
    return readJson<StoredDelegation[]>(this.hobFile("delegations.json"), []);
  }

  delegations(): Delegation[] {
    return this.internalDelegations().map(publicDelegation);
  }

  delegation(id: string): Delegation | undefined {
    return this.delegations().find((item) => item.id === id);
  }

  internalDelegation(id: string): StoredDelegation | undefined {
    return this.internalDelegations().find((item) => item.id === id);
  }

  saveDelegation(delegation: StoredDelegation): void {
    const all = this.internalDelegations().filter((item) => item.id !== delegation.id);
    all.push(delegation);
    writeJsonAtomic(this.hobFile("delegations.json"), all);
  }

  // ---------- 草稿 ----------
  drafts(): Draft[] {
    return readJson<Draft[]>(this.hobFile("drafts.json"), []);
  }

  draft(id: string): Draft | undefined {
    return this.drafts().find((d) => d.id === id);
  }

  saveDraft(draft: Draft): void {
    const all = this.drafts().filter((d) => d.id !== draft.id);
    all.push(draft);
    writeJsonAtomic(this.hobFile("drafts.json"), all);
  }

  // ---------- 任务 ----------
  /** 所有任务目录的根：在的助手和归档的助手都算。 */
  private jobRoots(): string[] {
    const out: string[] = [];
    const live = join(this.home, "assistants");
    if (existsSync(live)) for (const id of readdirSync(live)) out.push(assistantJobsDir(this.home, id));
    const archived = archiveAssistantsDir(this.home);
    if (existsSync(archived)) for (const folder of readdirSync(archived)) out.push(join(archived, folder, "jobs"));
    return out.filter((dir) => existsSync(dir));
  }

  private rebuildJobIndex(): Map<string, string> {
    const index = new Map<string, string>();
    for (const root of this.jobRoots()) {
      for (const id of readdirSync(root).sort()) {
        const dir = join(root, id);
        if (existsSync(join(dir, "job.json"))) index.set(id, dir);
      }
    }
    this.jobIndex = index;
    return index;
  }

  private findJobDir(id: string): string | undefined {
    const hit = (this.jobIndex ?? this.rebuildJobIndex()).get(id);
    if (hit) return hit;
    return this.rebuildJobIndex().get(id);
  }

  jobDir(id: string): string {
    return this.findJobDir(id) ?? join(this.home, "assistants", "hob", "jobs", id);
  }

  jobs(): Job[] {
    const out: Job[] = [];
    for (const dir of this.rebuildJobIndex().values()) {
      try {
        const job = readJson<Job | null>(join(dir, "job.json"), null);
        if (job) out.push(job);
      } catch (error) {
        console.error(error);
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  job(id: string): Job | undefined {
    const dir = this.findJobDir(id);
    return dir ? readJson<Job | null>(join(dir, "job.json"), null) ?? undefined : undefined;
  }

  saveJob(job: Job): void {
    const dir = this.findJobDir(job.id) ?? join(assistantJobsDir(this.home, job.assistantId), job.id);
    writeJsonAtomic(join(dir, "job.json"), job);
    this.jobIndex ??= new Map();
    this.jobIndex.set(job.id, dir);
  }

  writeReport(jobId: string, text: string): string {
    const path = join(this.jobDir(jobId), "report.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  workerFile(jobId: string): string {
    return join(this.jobDir(jobId), "worker.jsonl");
  }

  /** 任务过程里超长输出的全文：落在任务目录下，页面按路径去拉。 */
  writeStepOutput(jobId: string, stepId: string, text: string): string {
    const safe = stepId.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = join(this.jobDir(jobId), "steps", `${safe}.txt`);
    if (existsSync(path)) return path;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  /**
   * 本机任务的默认工作目录：产出文件只能落在这里。
   * 建任务时 job.json 还没写，任务目录还找不到，用 assistantId 定归属（不然会落到主助手名下）。
   */
  workDir(jobId: string, assistantId = "hob"): string {
    const path = join(this.findJobDir(jobId) ?? join(assistantJobsDir(this.home, assistantId), jobId), "work");
    mkdirSync(path, { recursive: true });
    return path;
  }

  /**
   * 一次性迁移：老的 assistants/<id>/memories.json 每条追加成该助手 instructions 的一行，
   * 然后删掉文件；草稿里的 memories 改名成 instructions。跑过一次就没有了，不是兼容层。
   */
  migrateMemories(): void {
    type OldDraft = Draft & { memories?: string[]; carry: Draft["carry"] & { memories?: number } };
    const drafts = readJson<OldDraft[]>(this.hobFile("drafts.json"), []);
    if (drafts.some((draft) => !Array.isArray(draft.instructions))) {
      writeJsonAtomic(
        this.hobFile("drafts.json"),
        drafts.map(({ memories, carry, ...draft }) => ({
          ...draft,
          instructions: draft.instructions ?? memories ?? [],
          ...(carry ? { carry: { ...(carry.conversations !== undefined ? { conversations: carry.conversations } : {}) } } : {}),
        })),
      );
    }
    const root = join(this.home, "assistants");
    if (!existsSync(root)) return;
    for (const id of readdirSync(root)) {
      const file = join(root, id, "memories.json");
      if (!existsSync(file)) continue;
      const lines = readJson<{ text?: string }[]>(file, [])
        .map((memory) => (memory?.text ?? "").trim())
        .filter(Boolean);
      const assistant = this.assistant(id);
      if (!assistant && lines.length) throw new Error(`迁移 ${file} 失败：助手 ${id} 不存在`);
      if (assistant && lines.length) {
        const current = assistant.instructions.trim();
        this.saveAssistant({ ...assistant, instructions: [current, ...lines].filter(Boolean).join("\n") });
      }
      rmSync(file, { force: true });
    }
  }

  /** 从已创建的草稿补全旧助手的详细职责，不覆盖已有值。 */
  migrateAssistantDuties(): void {
    const drafts = this.drafts();
    for (const assistant of this.assistants()) {
      if (assistant.dutyLong !== undefined) continue;
      const draft = drafts.find((item) => item.status === "created" && item.createdAssistantId === assistant.id && item.dutyLong);
      if (draft) this.saveAssistant({ ...assistant, dutyLong: draft.dutyLong });
    }
  }

  // ---------- 首次启动 ----------
  ensurePrimary(): Assistant {
    const existing = this.assistant("hob");
    if (existing) return existing;
    const hob: Assistant = {
      id: "hob",
      name: "Hob",
      duty: "主助手",
      sprite: "hob",
      primary: true,
      pinned: true,
      hidden: false,
      notify: true,
      instructions: "",
      createdAt: new Date().toISOString(),
    };
    this.saveAssistant(hob);
    return hob;
  }
}
