import { t } from "../../shared/i18n.ts";
import { distinctSprite, parseSprite } from "../../shared/sprites.ts";
import type { AnswerApprovalBody, Approval, ApprovalAnswer, ApprovalQuestion, Assistant, CardActionRequest, CardActionResult, CardElement, CardRecord, Draft, LoginEntryApproval } from "../../shared/types.ts";
import { newId, slugify } from "./ids.ts";
import { checkAssistantModels } from "./models.ts";
import type { HobRuntime } from "./runtime.ts";
import { clampDuty } from "./text.ts";
import { monthDayText } from "./time.ts";
import { cronToChinese } from "./cron-text.ts";
import { validate } from "./routines.ts";
import { cardTitle, validateCard } from "./cards.ts";
import { candidateId, fillCandidate, fillLoginPage, hideSecrets, rememberAutoLogin } from "./login.ts";
import { generateSaveAndFill, newPasswordModeText, passwordCharactersText, NewPasswordError } from "./new-password.ts";
import { CWD_IMMUTABLE, PRIMARY_CWD_FORBIDDEN, normalizeWorkspaceCwdInput, validateWorkspaceCwd } from "./workspace.ts";

export interface ActionResult {
  status: number;
  body: unknown;
}

/** 其他想法的长度上限（字）。 */
export const MAX_ANSWER_TEXT = 1000;

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/** 一张卡问了几个问题时的答案：每个问题都要有，缺一个就不收。 */
function readAnswers(questions: ApprovalQuestion[], input: AnswerApprovalBody): { answers: ApprovalAnswer[] } | { error: string } {
  const given = Array.isArray(input.answers) ? input.answers : [];
  const answers: ApprovalAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const n = index + 1;
    const item = given[index];
    const key = item?.key;
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (question.input) {
      if (key) return { error: `第 ${n} 个问题是填空题，不能按选项回答` };
      if (!text) return { error: `第 ${n} 个问题还没答：请填写「${question.title}」。` };
      if (text.length > MAX_ANSWER_TEXT) return { error: `第 ${n} 个问题的回答最多 ${MAX_ANSWER_TEXT} 字` };
      if (question.input === "number" && !Number.isFinite(Number(text))) {
        return { error: `第 ${n} 个问题需要填写有效数字：「${text}」不是数字。` };
      }
      if (question.input === "date" && !isValidDate(text)) {
        return { error: `第 ${n} 个问题需要填写合法日期（YYYY-MM-DD）：「${text}」格式不对。` };
      }
      if (question.input === "time" && !isValidTime(text)) {
        return { error: `第 ${n} 个问题需要填写合法时间（HH:MM）：「${text}」格式不对。` };
      }
      answers.push({ text });
      continue;
    }
    const option = key ? question.options.find((choice) => choice.key === key) : undefined;
    if (key && !option) return { error: `第 ${n} 个问题没有这个选项：${key}` };
    if (!option && !text) return { error: `第 ${n} 个问题还没答：「${question.title}」要选一个选项，或者自己写一句。` };
    if (text.length > MAX_ANSWER_TEXT) return { error: `第 ${n} 个问题的回答最多 ${MAX_ANSWER_TEXT} 字` };
    answers.push(option ? { key: option.key } : { text });
  }
  return { answers };
}

/** 多问题卡回给助手的文字：一行一个问题，没按推荐答的标出推荐的是哪个；填空题直接写答案值。 */
function answersText(approval: Approval, questions: ApprovalQuestion[], answers: ApprovalAnswer[], note: string): string {
  const lines = [`用户回答了「${approval.title}」：`];
  questions.forEach((question, index) => {
    const answer = answers[index]!;
    if (question.input) {
      lines.push(`${index + 1}. ${question.title}：${answer.text ?? ""}`);
    } else if (answer.key) {
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

function cardChildren(element: CardElement): CardElement[] {
  if (element.tag === "form" || element.tag === "collapsible_panel" || element.tag === "interactive_container") return element.elements;
  if (element.tag === "column_set") return element.columns.flatMap((column) => column.elements);
  return [];
}

function cardElements(card: CardRecord): CardElement[] {
  const result: CardElement[] = [];
  const visit = (elements: CardElement[]) => {
    for (const element of elements) {
      result.push(element);
      visit(cardChildren(element));
    }
  };
  visit(card.card.body.elements);
  return result;
}

function cardText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { content?: unknown }).content === "string") return (value as { content: string }).content;
  return "";
}

function cardField(card: CardRecord, name: string | undefined): { label: string; element?: CardElement } | undefined {
  if (!name) return undefined;
  const element = cardElements(card).find((item) => {
    const raw = item as unknown as { tag?: string; name?: unknown };
    return raw.tag !== "form" && raw.tag !== "button" && raw.name === name;
  });
  if (!element) return undefined;
  const raw = element as unknown as { label?: unknown; text?: unknown };
  return { label: cardText(raw.label) || cardText(raw.text) || name, element };
}

function cardOption(card: CardRecord, name: string | undefined, selected: unknown): string {
  const field = cardField(card, name)?.element as unknown as { options?: { text?: unknown; value?: unknown }[] } | undefined;
  const values = Array.isArray(field?.options) ? field.options : [];
  const selectedValues = Array.isArray(selected) ? selected : [selected];
  const labels = selectedValues.map((value) => values.find((option) => option.value === value)?.text).map(cardText).filter(Boolean);
  return labels.length ? labels.join("、") : selectedValues.map((value) => value == null ? "（没填）" : String(value)).join("、");
}

function cardValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "（没填）";
  if (typeof value === "boolean") return value ? "开" : "关";
  if (Array.isArray(value)) return value.length ? value.map(cardValue).join("、") : "（没填）";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function cardFormFields(card: CardRecord, values: Record<string, unknown>): string[] {
  return cardElements(card)
    .filter((element) => ["input", "select_static", "multi_select_static", "date_picker", "picker_time", "picker_datetime", "checker", "overflow"].includes(element.tag))
    .flatMap((element) => {
      const raw = element as unknown as { name?: unknown; label?: unknown; text?: unknown };
      if (typeof raw.name !== "string" || !raw.name) return [];
      const label = cardText(raw.label) || cardText(raw.text) || raw.name;
      return [`- ${label}：${cardValue(values[raw.name])}`];
    });
}

function recordObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function submittedValues(input: CardActionRequest): string[] {
  const values: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      if (text) values.push(text);
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (recordObject(value)) {
      Object.values(value).forEach(collect);
    }
  };
  collect(input.form_value);
  const action = input.action;
  collect(action.value);
  collect(action.option);
  collect(action.options);
  collect(action.checked);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

function redactSubmittedText(text: string, values: string[]): string {
  return values.reduce((result, value) => result.split(value).join("***"), text);
}

function pluginText(response: { content?: { type?: string; text?: string }[] }, runtime: HobRuntime, pluginId: string, redact: (text: string) => string = (text) => text): string {
  return (response.content ?? []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => redact(runtime.plugins.redact(pluginId, block.text!))).join("\n").trim();
}

function pluginFeedback(meta: Record<string, unknown>, redact: (text: string) => string = (text) => text): { toast?: { type: "info" | "success" | "error" | "warning"; content: string }; errors?: Record<string, string> } {
  const result: { toast?: { type: "info" | "success" | "error" | "warning"; content: string }; errors?: Record<string, string> } = {};
  const toast = meta["hob/toast"];
  if (recordObject(toast) && ["info", "success", "error", "warning"].includes(String(toast.type)) && typeof toast.content === "string") {
    result.toast = { type: toast.type as "info" | "success" | "error" | "warning", content: redact(toast.content) };
  }
  const errors = meta["hob/errors"];
  if (recordObject(errors)) {
    const fields = Object.fromEntries(Object.entries(errors).filter(([, value]) => typeof value === "string").map(([name, value]) => [name, redact(value as string)])) as Record<string, string>;
    if (Object.keys(fields).length) result.errors = fields;
  }
  return result;
}

function pluginCard(value: unknown): { card?: CardRecord["card"]; unsupported?: number; error?: string } {
  const validation = validateCard(value, { mode: "plugin" });
  if (!validation.ok) return { error: validation.error.error };
  let card = validation.value.card;
  if (validation.value.unsupportedCount) {
    card = { ...card, body: { ...card.body, elements: [...card.body.elements, { tag: "div", text: t("有 {count} 个组件 Hob 显示不了", { count: validation.value.unsupportedCount }) }] } };
  }
  return { card, unsupported: validation.value.unsupportedCount };
}

/** 插件更新后，它更新前出的、还没处理的卡作废：卡片内容是出卡时旧版定下的，字段和回调可能已经变了。 */
export function retirePluginCards(runtime: HobRuntime, pluginId: string): void {
  for (const card of runtime.store.cards()) {
    if (card.status !== "open" || card.processing || card.owner.type !== "plugin" || card.owner.pluginId !== pluginId) continue;
    const next: CardRecord = { ...card, status: "done", feedback: { unavailable: t("{plugin} 更新了，这张卡是更新前出的，已作废。还需要的话，请助手重新发起。", { plugin: card.plugin?.pluginName ?? pluginId }) }, updatedAt: new Date().toISOString() };
    runtime.store.saveCard(next);
    runtime.bus.emit({ type: "card", card: next });
  }
}

const pluginCardCalls = new WeakMap<HobRuntime, Set<string>>();

async function answerPluginCard(runtime: HobRuntime, record: CardRecord, input: CardActionRequest): Promise<ActionResult> {
  const plugin = record.plugin;
  if (!plugin || record.owner.type !== "plugin" || !plugin.callbackTool) return { status: 400, body: { error: "插件卡片没有可用的回调工具" } };
  const pluginId = record.owner.type === "plugin" ? record.owner.pluginId : "";
  const installed = runtime.plugins.store.list().find((item) => item.id === pluginId);
  const service = runtime.plugins.states(pluginId).find((item) => item.name === plugin.service);
  const unavailable = t("{plugin} 现在用不了", { plugin: plugin.pluginName });
  if (!installed?.enabled || !service || !["connected", "idle", "connecting"].includes(service.status)) {
    const next = { ...record, feedback: { unavailable }, updatedAt: new Date().toISOString() };
    runtime.store.saveCard(next);
    runtime.bus.emit({ type: "card", card: next });
    return { status: 409, body: { error: unavailable, card: next } };
  }
  const calls = pluginCardCalls.get(runtime) ?? new Set<string>();
  pluginCardCalls.set(runtime, calls);
  if (record.processing || calls.has(record.id)) return { status: 409, body: { error: t("这张卡正在处理中") } };
  calls.add(record.id);
  const processing: CardRecord = { ...record, processing: true, updatedAt: new Date().toISOString() };
  runtime.store.saveCard(processing);
  runtime.bus.emit({ type: "card", card: processing });
  const action = { ...(input.action as Record<string, unknown>), ...(input.form_value ? { form_value: input.form_value } : {}) } as Record<string, unknown>;
  const redact = (text: string) => redactSubmittedText(runtime.plugins.redact(pluginId, text), submittedValues(input));
  const buttonText = input.button_text || (typeof action.text === "string" ? action.text : undefined) || (typeof action.name === "string" ? action.name : undefined) || "按钮";
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      runtime.plugins.call(pluginId, plugin.service, plugin.callbackTool, { card_id: record.id, action }, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("插件回调超过 60 秒未返回")); }, 60_000); }),
    ]);
    const meta = recordObject(response._meta) ? response._meta : {};
    const feedback = pluginFeedback(meta, redact);
    let nextCard = record.card;
    if (meta["hob/card"] !== undefined) {
      const parsed = pluginCard(meta["hob/card"]);
      if (parsed.error) {
        feedback.toast = { type: "error", content: redact(`插件返回的卡片格式不对：${parsed.error}`) };
      } else if (parsed.card) {
        nextCard = parsed.card;
      }
    }
    if (response.isError) {
      feedback.toast = { type: "error", content: pluginText(response, runtime, pluginId, redact) || "插件调用失败" };
    }
    const nextPlugin = nextCard.config && recordObject(nextCard.config) && typeof nextCard.config.callback_tool === "string"
      ? { ...plugin, callbackTool: nextCard.config.callback_tool }
      : plugin;
    const next: CardRecord = { ...record, card: nextCard, plugin: nextPlugin, updatedAt: new Date().toISOString() };
    if (Object.keys(feedback).length) next.feedback = feedback;
    else delete next.feedback;
    runtime.store.saveCard(next);
    runtime.bus.emit({ type: "card", card: next });
    const text = pluginText(response, runtime, pluginId, redact);
    if (text) await runtime.router.answerEvent(record.owner.assistantId, `用户在 ${plugin.pluginName} 的卡片「${cardTitle(record.card) || "未命名"}」上点了「${buttonText}」，${plugin.pluginName} 返回：${text}`, record.groupId);
    return { status: 200, body: { card: next } };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    const next: CardRecord = { ...record, feedback: { toast: { type: "error", content: message } }, updatedAt: new Date().toISOString() };
    runtime.store.saveCard(next);
    runtime.bus.emit({ type: "card", card: next });
    return { status: 200, body: { card: next } };
  } finally {
    if (timer) clearTimeout(timer);
    calls.delete(record.id);
    const current = runtime.store.card(record.id);
    if (current?.processing) {
      const cleared = { ...current };
      delete cleared.processing;
      runtime.store.saveCard(cleared);
      runtime.bus.emit({ type: "card", card: cleared });
    }
  }
}

/** 用户操作助手发的卡片：锁卡、保存结果，并以事件消息回到原来的助手。 */
export async function answerCard(runtime: HobRuntime, cardId: string, input: CardActionRequest): Promise<ActionResult> {
  const { store, bus, router } = runtime;
  const record = store.card(cardId);
  if (!record) return { status: 404, body: { error: "卡片不存在" } };
  if (record.status !== "open") return { status: 409, body: { error: "这张卡片已操作" } };
  if (!input || typeof input.action !== "object" || Array.isArray(input.action)) return { status: 400, body: { error: "卡片操作无效" } };
  if (record.owner.type === "plugin") return answerPluginCard(runtime, record, input);
  if (record.owner.type !== "assistant") return { status: 400, body: { error: "卡片主人无效" } };
  const action = input.action;
  const tag = typeof action.tag === "string" ? action.tag : "";
  const name = typeof action.name === "string" ? action.name : undefined;
  const title = cardTitle(record.card) || "未命名卡片";
  const fields = input.form_value && typeof input.form_value === "object" ? input.form_value : undefined;
  let text: string;
  let result: CardActionResult;
  if (tag === "button" && fields) {
    const buttonText = input.button_text || (typeof action.text === "string" ? action.text : undefined) || name || "提交";
    const lines = cardFormFields(record, fields);
    text = `用户在卡片「${title}」上点了「${buttonText}」，填写的内容：${lines.length ? `\n${lines.join("\n")}` : ""}`;
    result = { action, ...(input.button_text ? { buttonText: input.button_text } : { buttonText }), fields };
  } else if (tag === "button") {
    const buttonText = input.button_text || (typeof action.text === "string" ? action.text : undefined) || name || "按钮";
    text = `用户在卡片「${title}」上点了「${buttonText}」。`;
    result = { action, buttonText };
  } else if (["select_static", "multi_select_static", "date_picker", "picker_time", "picker_datetime", "checker", "overflow", "input"].includes(tag)) {
    const field = cardField(record, name);
    if (!field) return { status: 400, body: { error: "卡片操作的字段不存在" } };
    const rawValue = action.option ?? action.options ?? action.value ?? action.checked;
    const selected = ["select_static", "multi_select_static", "overflow"].includes(tag) ? cardOption(record, name, rawValue) : cardValue(rawValue);
    text = `用户在卡片「${title}」的「${field.label}」里选了「${selected}」。`;
    result = { action, fields: name ? { [name]: rawValue } : undefined };
  } else {
    return { status: 400, body: { error: "卡片操作类型无效" } };
  }
  const answered: CardRecord = { ...record, status: "done", result, updatedAt: new Date().toISOString() };
  store.saveCard(answered);
  bus.emit({ type: "card", card: answered });
  try {
    await router.answerEvent(record.owner.assistantId, text, record.groupId);
  } catch {
    return { status: 503, body: { error: "卡片操作已保存，但没有送回助手" } };
  }
  return { status: 200, body: { card: answered } };
}

/** 登录卡的答案记下以后：推给界面；任务里问的叫醒任务，其余回到助手（转交回合回到目标助手，群里回到群会话）。 */
async function settleLoginAnswer(runtime: HobRuntime, approval: Approval, answered: Approval, reply: string): Promise<void> {
  const { store, bus, router, jobs } = runtime;
  store.saveApproval(answered);
  if (answered.groupId) runtime.groups.publish(answered.groupId);
  const delegation = approval.source === "job" ? undefined : store.delegations().find((item) => item.approvalIds?.includes(approval.id));
  const delegationId = delegation && runtime.delegations.resume(delegation.id) ? delegation.id : undefined;
  bus.emit({ type: "approval", approval: answered });
  if (approval.source === "job" && approval.jobId) jobs.resolveAsk(answered, reply);
  else await routeAnswer(runtime, approval, reply, delegationId);
}

/** 用户在卡上点「我自己登录」：同一张卡换成自己登录卡的样子，还挂着等用户登完，不回模型。 */
function switchLoginToSelf(runtime: HobRuntime, approval: Approval): ActionResult {
  const { store, bus } = runtime;
  const login = approval.login!;
  if (!login.fillLogin && !login.entry) return { status: 400, body: { error: "这张卡没有「我自己登录」" } };
  const switched: Approval = {
    ...approval,
    login: {
      ...login,
      ...(login.fillLogin ? { fillLogin: { ...login.fillLogin, state: "self" } } : {}),
      ...(login.entry ? { entry: { ...login.entry, state: "self" } } : {}),
    },
  };
  store.saveApproval(switched);
  if (switched.groupId) runtime.groups.publish(switched.groupId);
  bus.emit({ type: "approval", approval: switched });
  return { status: 200, body: { approval: switched } };
}

/** 填登录批准卡的答案：凭据只在这次 CDP 操作里取用，不进入审批记录。 */
async function answerFillLoginApproval(runtime: HobRuntime, approval: Approval, input: AnswerApprovalBody): Promise<ActionResult> {
  const { store } = runtime;
  const fill = approval.login?.fillLogin;
  if (!fill) return { status: 400, body: { error: "登录批准卡数据不完整" } };
  const option = input.key ? approval.options.find((item) => item.key === input.key) : undefined;
  if (!option) return { status: 400, body: { error: "没有这个选项" } };
  // 换成自己登录卡以后，用户点的是「已登录」（选项 A）
  if (fill.state === "self") {
    if (option.key !== "A") return { status: 400, body: { error: "这张卡在等用户自己登录" } };
    const answered: Approval = { ...approval, status: "answered", chosen: option.key, answeredAt: new Date().toISOString() };
    await settleLoginAnswer(runtime, approval, answered, `用户已在「${approval.login!.site}」完成登录。`);
    return { status: 200, body: { approval: answered } };
  }
  const selectedId = input.candidateId || fill.chosenId || (fill.candidates.length === 1 ? candidateId(fill.candidates[0]!) : undefined);
  const candidate = selectedId ? fill.candidates.find((item) => candidateId(item) === selectedId) : undefined;
  if (option.key !== "A" && !candidate) return { status: 400, body: { error: "请选择要填写的账号" } };
  let reply: string;
  let nextFill = { ...fill, ...(selectedId ? { chosenId: selectedId } : {}) };
  if (option.key === "A") {
    nextFill = { ...nextFill, state: "rejected", result: "已拒绝" };
    reply = `用户没有允许在 ${fill.host} 填写登录。`;
  } else {
    try {
      const result = await fillCandidate(runtime, approval.assistantId, candidate!, fill.host);
      nextFill = { ...nextFill, state: "filled", result: result.kind === "username" ? `已填好用户名 ${result.username}` : option.key === "C" ? "已登录 · 以后都允许" : "已登录 · 这次允许" };
      if (option.key === "C") rememberAutoLogin(runtime, candidate!, fill.host);
      reply = result.kind === "username"
        ? `用户允许了在 ${fill.host} 登录，Hob 已填好用户名 ${result.username}，点下一步后再调一次 login 填密码。`
        : `用户允许了在 ${fill.host} 登录，Hob 已填好 ${result.username} 的账号和密码，接下来点登录按钮。`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      nextFill = { ...nextFill, state: "failed", result: `没有填写：${reason}` };
      reply = `用户允许了在 ${fill.host} 登录，但没有填上：${reason}`;
    }
  }
  const answered: Approval = { ...approval, status: "answered", chosen: option.key, login: { ...approval.login!, fillLogin: nextFill }, answeredAt: new Date().toISOString() };
  await settleLoginAnswer(runtime, approval, answered, reply);
  return { status: 200, body: { approval: answered } };
}

/** 录入卡的「保存并登录」：密码只在这一次请求、提供者的 save 和 CDP 填写之间经过，不进审批记录、事件、日志和回给模型的文字。 */
async function answerLoginEntryApproval(runtime: HobRuntime, approval: Approval, input: AnswerApprovalBody): Promise<ActionResult> {
  const { store } = runtime;
  const entry = approval.login?.entry;
  if (!entry) return { status: 400, body: { error: "登录录入卡数据不完整" } };
  const option = input.key ? approval.options.find((item) => item.key === input.key) : undefined;
  if (!option) return { status: 400, body: { error: "没有这个选项" } };
  const site = approval.login!.site;
  if (entry.state === "self") {
    if (option.key !== "A") return { status: 400, body: { error: "这张卡在等用户自己登录" } };
    const answered: Approval = { ...approval, status: "answered", chosen: option.key, answeredAt: new Date().toISOString() };
    await settleLoginAnswer(runtime, approval, answered, `用户已在「${site}」完成登录。`);
    return { status: 200, body: { approval: answered } };
  }
  let reply: string;
  let next: LoginEntryApproval;
  if (option.key === "A") {
    const withoutError = { ...entry };
    delete withoutError.error;
    next = { ...withoutError, state: "rejected", result: "没有登录" };
    reply = `用户没有登录 ${entry.host}。`;
  } else {
    const username = typeof input.username === "string" ? input.username.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (!username || !password) return { status: 400, body: { error: "用户名和密码都要填。" } };
    const chosen = entry.providers.find((item) => item.provider === (input.provider ?? entry.providers[0]?.provider));
    const provider = chosen && runtime.plugins.credentialProviders(approval.assistantId, "save").find((item) => item.pluginId === chosen.provider);
    if (!chosen || !provider) {
      const message = `${chosen?.providerName ?? "密码管理器"} 的凭据保存工具现在不可用。`;
      const failed: Approval = { ...approval, login: { ...approval.login!, entry: { ...entry, error: message } } };
      store.saveApproval(failed);
      if (failed.groupId) runtime.groups.publish(failed.groupId);
      runtime.bus.emit({ type: "approval", approval: failed });
      return { status: 400, body: { error: message } };
    }
    // 存进密码管理器的名称用助手写的网站名（去掉「」这类引号），网址用当前主机
    const name = site.trim().replace(/^[「『"'“]+|[」』"'”]+$/g, "") || entry.host;
    const uris = [`https://${entry.host}`];
    let savedId: string;
    try {
      const saved = await runtime.plugins.callCredential(provider, { name, uris, username, password });
      savedId = typeof saved.id === "string" ? saved.id : "";
      if (!savedId) throw new Error("密码管理器没有返回已保存条目的 id。");
    } catch (error) {
      // 没存上：卡上写原因，表单保持可填，不回模型；密码先脱敏再存给界面
      const message = `${provider.providerName} 没有保存：${hideSecrets(error, [password])}`;
      const failed: Approval = { ...approval, login: { ...approval.login!, entry: { ...entry, error: message } } };
      store.saveApproval(failed);
      if (failed.groupId) runtime.groups.publish(failed.groupId);
      runtime.bus.emit({ type: "approval", approval: failed });
      return { status: 400, body: { error: message } };
    }
    const candidate = { provider: provider.pluginId, providerName: provider.providerName, id: savedId, uris };
    try {
      const result = await fillLoginPage(runtime, approval.assistantId, candidate, entry.host, async () => ({ username, password }));
      const withoutError = { ...entry };
      delete withoutError.error;
      next = { ...withoutError, provider: provider.pluginId, username, twoStep: result.kind === "username", state: "filled", result: result.kind === "username" ? "已填好用户名" : "已填好" };
      reply = result.kind === "username"
        ? `用户在卡片上填了 ${entry.host} 的账号，Hob 已存进${provider.providerName}，并填好用户名 ${username}，点下一步后再调一次 login 填密码。`
        : `用户在卡片上填了 ${entry.host} 的账号，Hob 已存进${provider.providerName}，并填好 ${username} 的账号和密码，接下来点登录按钮。`;
    } catch (error) {
      const reason = hideSecrets(error, [password]);
      next = { ...entry, provider: provider.pluginId, username, state: "failed", result: reason };
      reply = `用户在卡片上填了 ${entry.host} 的账号，Hob 已存进${provider.providerName}，但没有填上：${reason}`;
    }
  }
  const answered: Approval = { ...approval, status: "answered", chosen: option.key, login: { ...approval.login!, entry: next }, answeredAt: new Date().toISOString() };
  await settleLoginAnswer(runtime, approval, answered, reply);
  return { status: 200, body: { approval: answered } };
}

/** 答复生成新密码批准卡：密码只在生成、保存和 CDP 填写的这次调用里经过。 */
async function answerFillNewPasswordApproval(runtime: HobRuntime, approval: Approval, input: AnswerApprovalBody): Promise<ActionResult> {
  const { store, bus, router, jobs } = runtime;
  const fill = approval.login?.fillNewPassword;
  if (!fill) return { status: 400, body: { error: "新密码批准卡数据不完整" } };
  const option = input.key ? approval.options.find((item) => item.key === input.key) : undefined;
  if (!option) return { status: 400, body: { error: "没有这个选项" } };
  const folder = fill.mode === "register" ? (input.folder !== undefined ? input.folder : fill.folder) : undefined;
  if (fill.mode === "register" && folder && !fill.folders.includes(folder)) return { status: 400, body: { error: "没有这个文件夹选项" } };
  const storedFolder = fill.mode === "register" ? folder : fill.candidate?.folder;
  let reply: string;
  let nextFill = { ...fill };
  const mode = newPasswordModeText(fill.mode);
  const characters = passwordCharactersText(fill.characters);
  const folderText = storedFolder || "未分类";
  if (option.key === "A") {
    nextFill = { ...nextFill, state: "rejected", result: "已拒绝" };
    reply = `用户没有允许在 ${fill.host} ${mode}。`;
  } else {
    try {
      await generateSaveAndFill(runtime, approval.assistantId, fill, folder);
      nextFill = { ...nextFill, state: "filled", ...(fill.mode === "register" && folder ? { folder } : {}), result: `已填写，已存进 ${fill.providerName}「${folderText}」` };
      reply = `用户允许了在 ${fill.host} ${mode}，Hob 已生成 ${fill.length} 位新密码（${characters}），存进 ${fill.providerName}「${folderText}」的「${fill.name}」，并填好了密码框。接下来提交表单；网站不接受这个密码的话，照页面提示的要求再调一次 fill_new_password，会更新同一条，不会多存。`;
    } catch (error) {
      const reason = error instanceof NewPasswordError && error.saved
        ? `新密码已经存进 ${error.providerName}「${error.itemName}」；${error.message}`
        : error instanceof Error ? error.message : String(error);
      nextFill = { ...nextFill, state: "failed", result: `没有完成：${reason}` };
      reply = `用户允许了在 ${fill.host} ${mode}，但没有完成：${reason}`;
    }
  }
  const answered: Approval = { ...approval, status: "answered", chosen: option.key, login: { ...approval.login!, fillNewPassword: nextFill }, answeredAt: new Date().toISOString() };
  store.saveApproval(answered);
  if (answered.groupId) runtime.groups.publish(answered.groupId);
  const delegation = approval.source === "job" ? undefined : store.delegations().find((item) => item.approvalIds?.includes(approval.id));
  const delegationId = delegation && runtime.delegations.resume(delegation.id) ? delegation.id : undefined;
  bus.emit({ type: "approval", approval: answered });
  if (approval.source === "job" && approval.jobId) jobs.resolveAsk(answered, reply);
  else await routeAnswer(runtime, approval, reply, delegationId);
  return { status: 200, body: { approval: answered } };
}

/** 答复审批卡：记答案、写 always 规则、叫醒阻塞的 Worker 或把答案推回 Router。 */
export async function answerApproval(runtime: HobRuntime, approvalId: string, input: AnswerApprovalBody): Promise<ActionResult> {
  const { store, bus, router, jobs } = runtime;
  const approval = store.approval(approvalId);
  if (!approval) return { status: 404, body: { error: "审批不存在" } };
  if (approval.status !== "pending") return { status: 409, body: { error: "这个审批已答复" } };
  if (input.self && approval.login) return switchLoginToSelf(runtime, approval);
  if (approval.login?.fillNewPassword) return answerFillNewPasswordApproval(runtime, approval, input);
  if (approval.login?.fillLogin) return answerFillLoginApproval(runtime, approval, input);
  if (approval.login?.entry) return answerLoginEntryApproval(runtime, approval, input);
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
      text: t("已记入{owner}的规则 · {rule}", { owner: approval.groupId && store.group(approval.groupId) ? "本群" : assistant?.name ?? approval.assistantId, rule: ruleText }),
    }, approval.groupId);
    bus.emit({ type: "profile", assistantId: approval.assistantId });
  }

  // 回给模型：自己写的那句要说明是用户写的、没选给出的选项；多问题卡一行一个问题
  const reply = approval.login && option?.key === "A"
    ? `用户已在「${approval.login.site}」完成登录。`
    : questions
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
  instructions?: unknown;
  sprite?: unknown;
  pinned?: unknown;
  pinOrder?: unknown;
  listOrder?: unknown;
  hidden?: unknown;
  notify?: unknown;
  models?: unknown;
  abilities?: unknown;
  knowledge?: unknown;
  cwd?: unknown;
}

/**
 * 改助手资料：HTTP 的 PATCH /api/assistants/:id 和主助手的 update_assistant 共用，
 * 校验、重开会话和事件推送都走这里。不合法的补丁不改任何东西。
 */
export async function updateAssistant(runtime: HobRuntime, id: string, body: AssistantPatch): Promise<ActionResult> {
  const { store, bus, router } = runtime;
  const assistant = store.assistant(id);
  if (!assistant) return { status: 404, body: { error: "助手不存在" } };
  if (body.cwd !== undefined) {
    return { status: 400, body: { error: assistant.primary ? PRIMARY_CWD_FORBIDDEN : CWD_IMMUTABLE } };
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") return { status: 400, body: { error: "说明必须是文字。" } };
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
    ...(typeof body.instructions === "string" ? { instructions: body.instructions.trim() || undefined } : {}),
    ...(typeof body.sprite === "string" ? { sprite: body.sprite } : {}),
    ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
    // 置顶区里的位置：拖动头像换位置后按 0、1、2… 存，取整且不为负
    ...(typeof body.pinOrder === "number" && Number.isFinite(body.pinOrder) ? { pinOrder: Math.max(0, Math.round(body.pinOrder)) } : {}),
    // 首页列表里的固定顺序：拖动助手行后按 0、1、2… 存，取整且不为负
    ...(typeof body.listOrder === "number" && Number.isFinite(body.listOrder) ? { listOrder: Math.max(0, Math.round(body.listOrder)) } : {}),
    ...(typeof body.hidden === "boolean" ? { hidden: body.hidden } : {}),
    ...(typeof body.notify === "boolean" ? { notify: body.notify } : {}),
    ...(models ? { models } : {}),
    ...(abilities ? { abilities } : {}),
    ...(Array.isArray(body.knowledge) ? { knowledge: [...new Set(body.knowledge as string[])] } : {}),
  };
  store.saveAssistant(next);
  // 工具说明和注册取决于模型及助手能力，变化后重开会话
  if (models || abilities) router.releaseSessions();
  const summary = router.summary(next);
  bus.emit({ type: "assistant", assistant: summary });
  return { status: 200, body: { assistant: summary } };
}

/** 草稿 → 真正创建助手：带规则、定时任务，两边对话各写一行说明。 */
export async function createFromDraft(runtime: HobRuntime, draftId: string): Promise<ActionResult> {
  const { store, bus, router, routines } = runtime;
  const draft = store.draft(draftId);
  if (!draft) return { status: 404, body: { error: "草稿不存在" } };
  if (draft.status !== "pending") return { status: 409, body: { error: "这个草稿已处理" } };
  const id = slugify(draft.name);
  if (store.assistant(id)) {
    return { status: 409, body: { error: `已存在名称为「${draft.name}」的助手` } };
  }

  // 先把全部定时校验一遍：有一条不合法就整个不建，说清是哪条
  for (const [index, item] of draft.routines.entries()) {
    try { validate([item.schedule], runtime.settings.settings.general.timezone); }
    catch (error) { return { status: 400, body: { error: `第 ${index + 1} 条定时「${item.name}」：${error instanceof Error ? error.message : String(error)}` } }; }
  }

  let cwd: string | undefined;
  try {
    const normalized = normalizeWorkspaceCwdInput(draft.cwd);
    if (normalized) cwd = validateWorkspaceCwd(normalized, runtime.home);
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }

  const now = new Date().toISOString();
  const assistant: Assistant = {
    id,
    name: draft.name,
    duty: draft.duty,
    dutyLong: draft.dutyLong,
    ...(typeof draft.instructions === "string" && draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
    ...(cwd ? { cwd } : {}),
    // 和已有助手撞了头像就换个颜色（自画的图案各不相同，不算撞）
    sprite: distinctSprite(draft.sprite, store.assistants().map((a) => a.sprite)),
    ...(draft.prop ? { prop: draft.prop } : {}),
    primary: false,
    pinned: false,
    hidden: false,
    notify: true,
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
    ...(createdRoutines.length ? [t("定时任务：{items}", { items: createdRoutines.join("、") })] : []),
    ...(failedRoutines.length ? [t("定时处理失败：{items}", { items: failedRoutines.join("、") })] : []),
  ];

  const splitNote = `${monthDayText(runtime.settings.settings.general.timezone)} ${t("由 Hob 创建")}`;
  await router.ensure(assistant.id);
  await router.addItem(assistant.id, { kind: "note", icon: "split", text: splitNote });
  // 新助手自己的开场：固定模板，不过模型
  await router.addItem(assistant.id, {
    kind: "assistant",
    text: [t("我是{assistant}，负责{duty}。", { assistant: assistant.name, duty: assistant.duty }), ...routineReport].join(
      "\n",
    ),
  });
  await router.addItem(draft.assistantId, { kind: "note", icon: "split", text: t("已创建「{name}」", { name: assistant.name }) });

  const created: Draft = { ...draft, routines: savedRoutines, routinesText: createdRoutines.join("、"), status: "created", createdAssistantId: assistant.id };
  store.saveDraft(created);
  bus.emit({ type: "draft", draft: created });
  bus.emit({ type: "assistant", assistant: router.summary(assistant) });
  return { status: 200, body: { assistant: router.summary(assistant), routineReport } };
}

export function dismissDraft(runtime: HobRuntime, draftId: string): ActionResult {
  const draft = runtime.store.draft(draftId);
  if (!draft) return { status: 404, body: { error: "草稿不存在" } };
  if (draft.status !== "pending") return { status: 409, body: { error: "这个草稿已处理" } };
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
