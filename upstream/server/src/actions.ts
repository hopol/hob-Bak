import { distinctSprite } from "../../shared/sprites.ts";
import type { AnswerApprovalBody, Approval, Assistant, Draft } from "../../shared/types.ts";
import { newId, slugify } from "./ids.ts";
import type { HobRuntime } from "./runtime.ts";
import { monthDayText } from "./time.ts";

export interface ActionResult {
  status: number;
  body: unknown;
}

/** 其他想法的长度上限（字）。 */
export const MAX_ANSWER_TEXT = 1000;

/** 答复审批卡：记答案、写 always 规则、叫醒阻塞的 Worker 或把答案推回 Router。 */
export async function answerApproval(runtime: HobRuntime, approvalId: string, input: AnswerApprovalBody): Promise<ActionResult> {
  const { store, bus, router, jobs } = runtime;
  const approval = store.approval(approvalId);
  if (!approval) return { status: 404, body: { error: "审批不存在" } };
  if (approval.status !== "pending") return { status: 409, body: { error: "这个审批已经答复过了" } };
  const option = input.key ? approval.options.find((item) => item.key === input.key) : undefined;
  if (input.key && !option) return { status: 400, body: { error: "没有这个选项" } };
  // 没选选项就是想自己写：空白和字数都有上限，不合格的不收
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!option) {
    if (!text) return { status: 400, body: { error: "其他想法不能为空" } };
    if (text.length > MAX_ANSWER_TEXT) return { status: 400, body: { error: `其他想法最多 ${MAX_ANSWER_TEXT} 字` } };
  }

  const answered: Approval = {
    ...approval,
    status: "answered",
    ...(option ? { chosen: option.key } : { answerText: text }),
    answeredAt: new Date().toISOString(),
  };
  store.saveApproval(answered);
  // 转交里 Router 问的：答案回到目标助手接着办，办完才算转交结束（任务里的提问由任务自己接着跑）
  const delegation = approval.source === "job" ? undefined : store.delegations().find((item) => item.approvalIds?.includes(approval.id));
  const delegationId = delegation && runtime.delegations.resume(delegation.id) ? delegation.id : undefined;
  bus.emit({ type: "approval", approval: answered });

  if (option?.always) {
    const assistant = store.assistant(approval.assistantId);
    const ruleText = approval.ruleText?.trim() || option.label;
    const rules = store.rules(approval.assistantId);
    const existing = rules.find((rule) => rule.text === ruleText);
    if (existing) {
      existing.mode = "allow";
      existing.changedAt = new Date().toISOString();
    } else {
      rules.push({ id: newId("r-"), text: ruleText, mode: "allow", changedAt: new Date().toISOString() });
    }
    store.saveRules(approval.assistantId, rules);
    await router.addItem(approval.assistantId, {
      kind: "note",
      icon: "rule",
      text: `已记入${assistant?.name ?? approval.assistantId}的规则 · ${ruleText}`,
    });
    bus.emit({ type: "profile", assistantId: approval.assistantId });
  }

  // 回给模型：自己写的那句要说明是用户写的、没选给出的选项
  const answer = option ? `用户选择了：${option.label}` : `用户没有选给出的选项，而是回复：${text}`;
  if (approval.source === "job" && approval.jobId) jobs.resolveAsk(answered, answer);
  else {
    const reply = option ? `用户选择了 ${option.key}：${option.label}` : answer;
    if (delegationId) void router.relay(approval.assistantId, reply, delegationId).catch(() => runtime.delegations.turnEnded(delegationId, "目标助手处理失败", true));
    else await router.answerEvent(approval.assistantId, reply);
  }

  return { status: 200, body: { approval: answered } };
}

function uniqueAssistantId(name: string): string {
  const base = slugify(name);
  return base;
}

/** 草稿 → 真正创建助手：带规则、补充说明、定时任务，两边对话各写一行说明。 */
export async function createFromDraft(runtime: HobRuntime, draftId: string): Promise<ActionResult> {
  const { store, bus, router, routines } = runtime;
  const draft = store.draft(draftId);
  if (!draft) return { status: 404, body: { error: "草稿不存在" } };
  if (draft.status !== "pending") return { status: 409, body: { error: "这个草稿已经处理过了" } };
  if (store.assistant(uniqueAssistantId(draft.name))) {
    return { status: 409, body: { error: `已存在名称为「${draft.name}」的助手` } };
  }

  const now = new Date().toISOString();
  const assistant: Assistant = {
    id: uniqueAssistantId(draft.name),
    name: draft.name,
    duty: draft.duty,
    dutyLong: draft.dutyLong,
    // 和已有助手撞了头像就换个颜色（自画的图案各不相同，不算撞）
    sprite: distinctSprite(draft.sprite, store.assistants().map((a) => a.sprite)),
    ...(draft.prop ? { prop: draft.prop } : {}),
    primary: false,
    pinned: false,
    hidden: false,
    notify: true,
    instructions: draft.instructions.join("\n"),
    createdAt: now,
    splitFrom: {
      from: draft.assistantId,
      at: now,
      conversations: draft.carry.conversations,
    },
  };
  store.saveAssistant(assistant);

  store.saveRules(
    assistant.id,
    draft.askFirst.map((text) => ({ id: newId("r-"), text, mode: "ask" as const, changedAt: now })),
  );
  for (const item of draft.routines) {
    try {
      routines.create({
        assistantId: assistant.id,
        name: item.name,
        instruction: item.instruction,
        schedules: [item.schedule],
      });
    } catch {
      // 模型给的 cron 不合法就跳过，不阻塞创建
    }
  }

  const splitNote = `${monthDayText(runtime.settings.settings.general.timezone)} 由 Hob 创建 · 迁移 ${draft.carry.conversations} 段对话`;
  await router.ensure(assistant.id);
  await router.addItem(assistant.id, { kind: "note", icon: "split", text: splitNote });
  // 新助手自己的开场：固定模板，不过模型
  await router.addItem(assistant.id, {
    kind: "assistant",
    text: [`我是${assistant.name}，负责${assistant.duty}。`, ...(draft.routinesText ? [`定时任务：${draft.routinesText}`] : [])].join(
      "\n",
    ),
  });
  await router.addItem(draft.assistantId, { kind: "note", icon: "split", text: `已创建「${assistant.name}」` });

  const created: Draft = { ...draft, status: "created", createdAssistantId: assistant.id };
  store.saveDraft(created);
  bus.emit({ type: "draft", draft: created });
  bus.emit({ type: "assistant", assistant: router.summary(assistant) });
  return { status: 200, body: { assistant: router.summary(assistant) } };
}

export function dismissDraft(runtime: HobRuntime, draftId: string): ActionResult {
  const draft = runtime.store.draft(draftId);
  if (!draft) return { status: 404, body: { error: "草稿不存在" } };
  if (draft.status !== "pending") return { status: 409, body: { error: "这个草稿已经处理过了" } };
  const next: Draft = { ...draft, status: "dismissed" };
  runtime.store.saveDraft(next);
  runtime.bus.emit({ type: "draft", draft: next });
  return { status: 200, body: { draft: next } };
}

/**
 * 归档助手：整个目录（档案、对话、规则）移进 archive/，它的定时一并存进去再停掉。
 * 什么都不转给主助手。历史任务留在 jobs/，只补上助手名。
 */
export async function archiveAssistant(runtime: HobRuntime, id: string): Promise<ActionResult> {
  const { store, bus, router } = runtime;
  const target = store.assistant(id);
  if (!target) return { status: 404, body: { error: "助手不存在" } };
  if (target.primary) return { status: 400, body: { error: "主助手不能归档" } };
  const live = store
    .jobs()
    .filter((job) => job.assistantId === id && (job.status === "running" || job.status === "queued" || job.status === "waiting"));
  if (live.length) return { status: 409, body: { error: "请等任务结束后再归档" } };

  // 这个助手挂着没答的审批：助手没了，卡片一并结束
  for (const approval of store.approvals()) {
    if (approval.assistantId !== id || approval.status !== "pending") continue;
    const expired: Approval = { ...approval, status: "expired" };
    store.saveApproval(expired);
    bus.emit({ type: "approval", approval: expired });
  }

  // 历史任务留在 jobs/：记下当时的助手名，详情页在助手没了以后照样显示
  for (const job of store.jobs()) {
    if (job.assistantId !== id || job.assistantName) continue;
    store.saveJob({ ...job, assistantName: target.name });
  }

  // 公共屏幕授权不随助手 id 的重新使用继承。
  const desktop = runtime.settings.settings.desktop;
  if (desktop?.publicAssistants?.includes(id)) {
    runtime.settings.setDesktop(runtime.settings.get().revision, { ...desktop, publicAssistants: desktop.publicAssistants.filter((assistantId) => assistantId !== id) });
  }
  router.forget(id);
  const routines = store.routines().filter((routine) => routine.assistantId === id);
  // 先停表并从列表里拿掉（归档后这条定时就不再属于还在的助手了）
  for (const routine of routines) runtime.routines.remove(routine.id);
  store.archiveAssistant(id, `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`, routines);
  bus.emit({ type: "assistant_removed", id });
  return { status: 200, body: { ok: true } };
}
