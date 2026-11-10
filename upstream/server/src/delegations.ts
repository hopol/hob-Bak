import type { Delegation } from "../../shared/types.ts";
import { newId } from "./ids.ts";
import { jobResultEvent } from "./jobs.ts";
import type { HobRuntime } from "./runtime.ts";

/** 转交状态由目标回合、任务和审批共同决定；判定和标记回流不跨异步边界。 */
export class DelegationManager {
  recovering = false;

  constructor(private readonly runtime: HobRuntime) {
    runtime.bus.subscribe((event) => {
      if (this.recovering) return;
      if (event.type === "job" && event.job.delegationId) this.update(event.job.delegationId);
      if (event.type === "approval") {
        for (const delegation of runtime.store.delegations()) {
          if (delegation.approvalIds?.includes(event.approval.id) || (event.approval.jobId && delegation.jobIds.includes(event.approval.jobId))) this.update(delegation.id);
        }
      }
    });
  }

  async start(to: string, text: string, files: string[] = []): Promise<Delegation> {
    const target = this.runtime.store.assistant(to);
    if (!target || to === "hob") throw new Error("目标助手不存在或不能转交给自己。");
    const delegation: Delegation = { id: newId("dg-"), from: "hob", to, text, createdAt: new Date().toISOString(), status: "running", jobIds: [], approvalIds: [] };
    this.runtime.store.saveDelegation(delegation);
    await this.runtime.router.addItem("hob", { kind: "delegation", delegationId: delegation.id });
    let sourceUserId: string;
    try {
      const forwarded = await this.runtime.router.addForwarded(to, text, delegation.id, "hob", files);
      sourceUserId = forwarded.id;
    } catch (error) {
      this.turnEnded(delegation.id, error instanceof Error ? error.message : String(error), true);
      throw error;
    }
    this.runtime.bus.emit({ type: "delegation", delegation });
    void this.runtime.router.relay(to, `转自 Hob：${text}`, delegation.id, { sourceUserId }, text).catch((error: unknown) => {
      this.turnEnded(delegation.id, error instanceof Error ? error.message : String(error), true);
    });
    return delegation;
  }

  takeOver(to: string): void {
    const { store, bus, router } = this.runtime;
    for (const record of store.delegations()) {
      if (record.to !== to || record.reportedAt || record.status === "interrupted") continue;
      const now = new Date().toISOString();
      const delegation: Delegation = { ...record, status: "takenOver", endedAt: now, reportedAt: now };
      store.saveDelegation(delegation);
      bus.emit({ type: "delegation", delegation });
      const name = store.assistant(to)?.name ?? to;
      void router.event(record.from, `转交给「${name}」的事已被用户接手。原请求：${record.text}`).catch(() => undefined);
    }
  }

  addJob(id: string, jobId: string): void {
    const record = this.runtime.store.delegation(id);
    if (!record || record.jobIds.includes(jobId)) return;
    this.runtime.store.saveDelegation({ ...record, jobIds: [...record.jobIds, jobId] });
  }

  addApproval(id: string, approvalId: string): void {
    const record = this.runtime.store.delegation(id);
    if (!record) return;
    this.runtime.store.saveDelegation({ ...record, approvalIds: [...(record.approvalIds ?? []), approvalId] });
    this.update(id);
  }

  turnEnded(id: string, reply: string, failed = false): void {
    const record = this.runtime.store.delegation(id);
    if (!record || record.turnFinished) return;
    const replies = [record.reply, reply].filter(Boolean).join("\n");
    this.runtime.store.saveDelegation({ ...record, reply: replies, turnFinished: true, ...(failed ? { turnFailed: true } : {}) });
    this.update(id);
  }

  /**
   * 转交里派的任务结束了、或用户答了转交里的提问：结果先回到目标助手，它这一轮可能接着再派任务、再问用户。
   * 这一轮跑完、名下没有在跑的任务，转交才算结束，Hob 才收到结果；
   * 否则目标助手还在处理时 Hob 就会收到「已结束」，另开任务和它冲突。
   * 调用方要在发出 job/approval 事件之前调用，再用 router.relay 把结果送给目标助手。
   * 返回 false 表示转交已经回流过（或已退回），结果按普通事件处理。
   */
  resume(id: string): boolean {
    const record = this.runtime.store.delegation(id);
    if (!record || record.reportedAt || record.status === "returned" || record.status === "interrupted") return false;
    const { turnFailed: _failed, ...rest } = record;
    this.runtime.store.saveDelegation({ ...rest, turnFinished: false });
    return true;
  }

  returnToHob(id: string, text: string, reason: string): void {
    const record = this.runtime.store.delegation(id);
    if (!record || record.turnFinished) throw new Error("转交已结束，无法退回");
    this.runtime.store.saveDelegation({ ...record, status: "returned", reply: `退回：${reason}`, returnedText: text, turnFinished: true });
    this.update(id);
  }

  update(id: string): void {
    const { store, bus, router } = this.runtime;
    const record = store.delegation(id);
    if (!record || record.reportedAt || record.status === "interrupted") return;
    const jobs = record.jobIds.map((jobId) => store.job(jobId));
    const waiting = jobs.some((job) => job?.status === "waiting") || store.approvals().some((approval) => approval.status === "pending" && (record.approvalIds?.includes(approval.id) || (approval.jobId && record.jobIds.includes(approval.jobId))));
    const active = jobs.some((job) => job && ["queued", "running", "waiting"].includes(job.status));
    const failed = record.turnFailed || jobs.some((job) => !job || job.status === "stuck" || job.status === "failed");
    const status = record.status === "returned" ? "returned" : waiting ? "waiting" : !record.turnFinished || active ? "running" : failed ? "stuck" : "done";
    const complete = record.turnFinished && !active && !waiting;
    const now = new Date().toISOString();
    const next: Delegation = { ...record, status, ...(complete ? { endedAt: now, reportedAt: now } : {}) };
    store.saveDelegation(next);
    bus.emit({ type: "delegation", delegation: next });
    if (complete) {
      const reports = jobs.map((job) => {
        if (!job) return "任务记录丢失";
        return jobResultEvent(job);
      });
      const name = store.assistant(record.to)?.name ?? record.to;
      const message = record.status === "returned"
        ? `转交给「${name}」的事已退回：${record.reply}。原请求：${record.text}\n交回内容：${record.returnedText ?? record.text}\n「${name}」已退回过一次。`
        : `转交给「${name}」的事已结束：${record.reply || "（没有回复）"}`;
      void router.event(record.from, `${message}\n${reports.join("\n")}`).catch(() => undefined);
    }
  }

  recover(): void {
    this.recovering = false;
    for (const record of this.runtime.store.delegations()) {
      if (record.reportedAt || !["running", "waiting", "returned"].includes(record.status)) continue;
      if (record.jobIds.some((id) => { const job = this.runtime.store.job(id); return job && ["running", "queued", "waiting"].includes(job.status); })) continue;
      // 目标助手在等用户选：审批卡重启后还在，答了照常继续，不算中断
      if (record.approvalIds?.some((id) => this.runtime.store.approval(id)?.status === "pending")) continue;
      const now = new Date().toISOString();
      const next: Delegation = { ...record, status: "interrupted", endedAt: now, reportedAt: now };
      this.runtime.store.saveDelegation(next);
      this.runtime.bus.emit({ type: "delegation", delegation: next });
      const name = this.runtime.store.assistant(record.to)?.name ?? record.to;
      void this.runtime.router.event(record.from, `转交给「${name}」的事因服务重启中断`).catch(() => undefined);
    }
  }
}
