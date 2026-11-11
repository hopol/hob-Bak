import { distinctSprite, parseSprite } from "../../shared/sprites.ts";
import type { AnswerApprovalBody, Approval, ApprovalAnswer, ApprovalQuestion, Assistant, Draft } from "../../shared/types.ts";
import { newId, slugify } from "./ids.ts";
import { checkAssistantModels } from "./models.ts";
import type { HobRuntime } from "./runtime.ts";
import { clampDuty } from "./text.ts";
import { monthDayText } from "./time.ts";
import { cronToChinese } from "./cron-text.ts";
import { validate } from "./routines.ts";

export interface ActionResult {
  status: number;
  body: unknown;
}

/** 其他想法的长度上限（字）。 */
export const MAX_ANSWER_TEXT = 1000;

/** 一张卡问了几个问题时的答案：每个问题都要有，缺一个就不收。 */
function readAnswers(questions: ApprovalQuestion[], input: AnswerApprovalBody): { answers: ApprovalAnswer[] } | { error: string } {
  const given = Array.isArray(input.answers) ? input.answers : [];
  const answers: ApprovalAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const n = index + 1;
    const item = given[index];
    const key = item?.key;
    const option = key ? question.options.find((choice) => choice.key === key) : undefined;
    if (key && !option) return { error: `第 ${n} 个问题没有这个选项：${key}` };
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!option && !text) return { error: `第 ${n} 个问题还没答：「${question.title}」要选一个选项，或者自己写一句。` };
    if (text.length > MAX_ANSWER_TEXT) return { error: `第 ${n} 个问题的回答最多 ${MAX_ANSWER_TEXT} 字` };
    answers.push(option ? { key: option.key } : { text });
  }
  return { answers };
}

/** 多问题卡回给助手的文字：一行一个问题，没按推荐答的标出推荐的是哪个。 */
function answersText(approval: Approval, questions: ApprovalQuestion[], answers: ApprovalAnswer[], note: string): string {
  const lines = [`用户回答了「${approval.title}」：`];
  questions.forEach((question, index) => {
    const answer = answers[index]!;
    if (answer.key) {
      const label = question.options.find((option) => option.key === answer.key)?.label ?? "";
      const tip = question.recommended && question.recommended !== answer.key ? `（推荐的是 ${question.recommended}）` : "";
      lines.push(`${index + 1}. ${question.title}：选了 ${answer.key}：${label}${tip}`);
    } else {
      lines.push(`${index + 1}. ${question.title}：没有选给出的选项，而是回复：${answer.text}`);
    }
  });
  if (note) lines.push(`补充：${note}`);
  return lines.join("\n");
}

/** 答案的去向：转交回合回到目标助手，群里回到群会话，其余回到这个助手的对话。 */
async function routeAnswer(runtime: HobRuntime, approval: Approval, reply: string, delegationId?: string): Promise<void> {
  if (delegationId) {
    void runtime.router.relay(approval.assistantId, reply, delegationId).catch(() => runtime.delegations.turnEnded(delegationId, "目标助手处理失败", true));
  } else if (approval.groupId) await runtime.router.answerEvent(approval.assistantId, reply, approval.groupId);
  else await runtime.router.answerEvent(approval.assistantId, reply);
}

/** 答复审批卡：记答案、写 always 规则、叫醒阻塞的 Worker 或把答案推回 Router。 */
export async function answerApproval(runtime: HobRuntime, approvalId: string, input: AnswerApprovalBody): Promise<ActionResult> {
  const { store, bus, router, jobs } = runtime;
  const approval = store.approval(approvalId);
  if (!approval) return { status: 404, body: { error: "审批不存在" } };
  if (approval.status !== "pending") return { status: 409, body: { error: "这个审批已经答复过了" } };
  const questions = approval.questions?.length ? approval.questions : undefined;
  // 多问题卡：每个问题都要答（选了选项或自己写了一句都算），补充说明可有可无
  let answers: ApprovalAnswer[] = [];
  let note = "";
  if (questions) {
    const read = readAnswers(questions, input);
    if ("error" in read) return { status: 400, body: { error: read.error } };
    answers = read.answers;
    note = typeof input.text === "string" ? input.text.trim() : "";
    if (note.length > MAX_ANSWER_TEXT) return { status: 400, body: { error: `补充说明最多 ${MAX_ANSWER_TEXT} 字` } };
  }

  const option = questions ? undefined : input.key ? approval.options.find((item) => item.key === input.key) : undefined;
  if (!questions && input.key && !option) return { status: 400, body: { error: "没有这个选项" } };
  // 没选选项就是想自己写：空白和字数都有上限，不合格的不收
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!questions && !option) {
    if (!text) return { status: 400, body: { error: "其他想法不能为空" } };
    if (text.length > MAX_ANSWER_TEXT) return { status: 400, body: { error: `其他想法最多 ${MAX_ANSWER_TEXT} 字` } };
  }

  const answered: Approval = {
    ...approval,
    status: "answered",
    ...(questions
      ? { answers, ...(note ? { answerText: note } : {}) }
      : option
        ? { chosen: option.key }
        : { answerText: text }),
    answeredAt: new Date().toISOString(),
  };
  store.saveApproval(answered);
  // 提问的成员在这个群里负责一件在需求澄清的事项：问答记进那件事
  runtime.projects.recordAnswers(answered);
  // 话题里的提问卡答了：左栏和话题卡上的「等你」跟着变
  if (answered.groupId) runtime.groups.publish(answered.groupId);
  // 转交里 Router 问的：答案回到目标助手接着办，办完才算转交结束（任务里的提问由任务自己接着跑）
  const delegation = approval.source === "job" ? undefined : store.delegations().find((item) => item.approvalIds?.includes(approval.id));
  const delegationId = delegation && runtime.delegations.resume(delegation.id) ? delegation.id : undefined;
  bus.emit({ type: "approval", approval: answered });

  if (option?.always) {
    const assistant = store.assistant(approval.assistantId);
    const ruleText = approval.ruleText?.trim() || option.label;
    const rules = approval.groupId && store.group(approval.groupId) ? store.groupRules(approval.groupId) : store.rules(approval.assistantId);
    const existing = rules.find((rule) => rule.text === ruleText);
    if (existing) {
      existing.mode = "allow";
      existing.changedAt = new Date().toISOString();
    } else {
      rules.push({ id: newId("r-"), text: ruleText, mode: "allow", changedAt: new Date().toISOString() });
    }
    if (approval.groupId && store.group(approval.groupId)) store.saveGroupRules(approval.groupId, rules);
    else store.saveRules(approval.assistantId, rules);
    await router.addItem(approval.assistantId, {
      kind: "note",
      icon: "rule",
      text: `已记入${approval.groupId && store.group(approval.groupId) ? "本群" : assistant?.name ?? approval.assistantId}的规则 · ${ruleText}`,
    }, approval.groupId);
    bus.emit({ type: "profile", assistantId: approval.assistantId });
  }

  // 回给模型：自己写的那句要说明是用户写的、没选给出的选项；多问题卡一行一个问题
  const reply = questions
    ? answersText(approval, questions, answers, note)
    : option
      ? `用户选择了 ${option.key}：${option.label}`
      : `用户没有选给出的选项，而是回复：${text}`;
  if (approval.source === "job" && approval.jobId) jobs.resolveAsk(answered, option ? `用户选择了：${option.label}` : reply);
  else await routeAnswer(runtime, approval, reply, delegationId);

  return { status: 200, body: { approval: answered } };
}

/** 改助手资料时能带的字段：没给就是不改。 */
export interface AssistantPatch {
  name?: unknown;
  duty?: unknown;
  dutyLong?: unknown;
  sprite?: unknown;
  pinned?: unknown;
  pinOrder?: unknown;
  hidden?: unknown;
  notify?: unknown;
  models?: unknown;
  abilities?: unknown;
  instructions?: unknown;
  knowledge?: unknown;
}

/**
 * 改助手资料：HTTP 的 PATCH /api/assistants/:id 和主助手的 update_assistant 共用，
 * 校验、重开会话和事件推送都走这里。不合法的补丁不改任何东西。
 */
export async function updateAssistant(runtime: HobRuntime, id: string, body: AssistantPatch): Promise<ActionResult> {
  const { store, bus, router } = runtime;
  const assistant = store.assistant(id);
  if (!assistant) return { status: 404, body: { error: "助手不存在" } };
  if (body.knowledge !== undefined) {
    if (!Array.isArray(body.knowledge) || body.knowledge.some((item) => typeof item !== "string")) return { status: 400, body: { error: "知识库绑定无效。" } };
    const collections = (await runtime.knowledge.list()).collections;
    if (body.knowledge.some((item) => !collections.some((collection) => collection.id === item))) return { status: 400, body: { error: "知识库不存在。" } };
  }
  if (typeof body.sprite === "string" && body.sprite !== assistant.sprite) {
    const parsed = parseSprite(body.sprite);
    // custom 要有画法数据才收（画法在 prop 字段上，这里不改它）；否则渲染成空手火苗，不如拒绝
    if (!parsed || (parsed.prop === "custom" && !assistant.prop)) return { status: 400, body: { error: "头像无效。" } };
  }
  let models;
  let abilities;
  try {
    await runtime.models.get();
    ({ models, abilities } = checkAssistantModels(
      { ...(body.models ? { models: body.models as Assistant["models"] } : {}), ...(body.abilities ? { abilities: body.abilities as Assistant["abilities"] } : {}) },
      runtime.settings.settings.models.roster,
      runtime.models,
    ));
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  const next: Assistant = {
    ...assistant,
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.duty === "string" ? { duty: clampDuty(body.duty) } : {}),
    ...(typeof body.dutyLong === "string" ? { dutyLong: body.dutyLong } : {}),
    ...(typeof body.sprite === "string" ? { sprite: body.sprite } : {}),
    ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
    // 置顶区里的位置：拖动头像换位置后按 0、1、2… 存，取整且不为负
    ...(typeof body.pinOrder === "number" && Number.isFinite(body.pinOrder) ? { pinOrder: Math.max(0, Math.round(body.pinOrder)) } : {}),
    ...(typeof body.hidden === "boolean" ? { hidden: body.hidden } : {}),
    ...(typeof body.notify === "boolean" ? { notify: body.notify } : {}),
    ...(models ? { models } : {}),
    ...(abilities ? { abilities } : {}),
    ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
    ...(Array.isArray(body.knowledge) ? { knowledge: [...new Set(body.knowledge as string[])] } : {}),
  };
  store.saveAssistant(next);
  // 工具说明和注册取决于模型及助手能力，变化后重开会话
  if (models || abilities) router.releaseSessions();
  const summary = router.summary(next);
  bus.emit({ type: "assistant", assistant: summary });
  return { status: 200, body: { assistant: summary } };
}

/** 草稿 → 真正创建助手：带规则、补充说明、定时任务，两边对话各写一行说明。 */
export async function createFromDraft(runtime: HobRuntime, draftId: string): Promise<ActionResult> {
  const { store, bus, router, routines } = runtime;
  const draft = store.draft(draftId);
  if (!draft) return { status: 404, body: { error: "草稿不存在" } };
  if (draft.status !== "pending") return { status: 409, body: { error: "这个草稿已经处理过了" } };
  const id = slugify(draft.name);
  if (store.assistant(id)) {
    return { status: 409, body: { error: `已存在名称为「${draft.name}」的助手` } };
  }

  // 先把全部定时校验一遍：有一条不合法就整个不建，说清是哪条
  for (const [index, item] of draft.routines.entries()) {
    try { validate([item.schedule], runtime.settings.settings.general.timezone); }
    catch (error) { return { status: 400, body: { error: `第 ${index + 1} 条定时「${item.name}」：${error instanceof Error ? error.message : String(error)}` } }; }
  }

  const now = new Date().toISOString();
  const assistant: Assistant = {
    id,
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
    },
  };
  store.saveAssistant(assistant);

  store.saveRules(
    assistant.id,
    draft.askFirst.map((text) => ({ id: newId("r-"), text, mode: "ask" as const, changedAt: now })),
  );
  const createdRoutines: string[] = [];
  const savedRoutines: Draft["routines"] = [];
  const failedRoutines: string[] = [];
  for (const item of draft.routines) {
    try {
      routines.create({ assistantId: assistant.id, name: item.name, instruction: item.instruction, schedules: [item.schedule] });
      savedRoutines.push(item);
      createdRoutines.push(`${item.name} · ${cronToChinese(item.schedule)}`);
    } catch (error) {
      failedRoutines.push(`${item.name}未建成：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const routineReport = [
    ...(createdRoutines.length ? [`定时任务：${createdRoutines.join("、")}`] : []),
    ...(failedRoutines.length ? [`定时处理失败：${failedRoutines.join("、")}`] : []),
  ];

  const splitNote = `${monthDayText(runtime.settings.settings.general.timezone)} 由 Hob 创建`;
  await router.ensure(assistant.id);
  await router.addItem(assistant.id, { kind: "note", icon: "split", text: splitNote });
  // 新助手自己的开场：固定模板，不过模型
  await router.addItem(assistant.id, {
    kind: "assistant",
    text: [`我是${assistant.name}，负责${assistant.duty}。`, ...routineReport].join(
      "\n",
    ),
  });
  await router.addItem(draft.assistantId, { kind: "note", icon: "split", text: `已创建「${assistant.name}」` });

  const created: Draft = { ...draft, routines: savedRoutines, routinesText: createdRoutines.join("、"), status: "created", createdAssistantId: assistant.id };
  store.saveDraft(created);
  bus.emit({ type: "draft", draft: created });
  bus.emit({ type: "assistant", assistant: router.summary(assistant) });
  return { status: 200, body: { assistant: router.summary(assistant), routineReport } };
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
  // 助手走了：从它所在的群里移出，群主换人；群里没人了就一起归档
  await runtime.groups.assistantArchived(id);
  const routines = store.routines().filter((routine) => routine.assistantId === id);
  // 先停表并从列表里拿掉（归档后这条定时就不再属于还在的助手了）
  for (const routine of routines) runtime.routines.remove(routine.id);
  store.archiveAssistant(id, `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`, routines);
  bus.emit({ type: "assistant_removed", id });
  return { status: 200, body: { ok: true } };
}
