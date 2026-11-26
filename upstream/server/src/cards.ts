import type {
  Card,
  CardBehavior,
  CardElement,
  CardText,
  CardValidationMode,
  CardValidationResult,
  ValidatedCard,
} from "../../shared/cards.ts";

export const MAX_CARD_BYTES = 100 * 1024;
export const MAX_CARD_ELEMENTS = 200;
const ELEMENT_ID = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;
const CARD_TAGS = new Set([
  "markdown", "div", "hr", "img", "table", "form", "column_set", "collapsible_panel", "interactive_container",
  "button", "input", "select_static", "multi_select_static", "date_picker", "picker_time", "picker_datetime", "checker", "overflow",
]);
const FIELD_TAGS = new Set(["input", "select_static", "multi_select_static", "date_picker", "picker_time", "picker_datetime", "checker", "overflow"]);
const INPUT_TYPES = new Set(["text", "multiline_text", "password", "number"]);
const BUTTON_TYPES = new Set(["primary_filled", "default", "danger"]);
const ACTION_TYPES = new Set(["submit", "reset"]);
const URL_PROTOCOL = /^(?:https?:\/\/)/i;
const IMAGE_URL = /^(?:https:\/\/|data:image\/)/i;

type ObjectValue = Record<string, any>;
type ValidationContext = {
  mode: CardValidationMode;
  seenElementIds: Set<string>;
  elementCount: number;
  unsupportedCount: number;
  assistantPassword: boolean;
  formNames: Map<string, Set<string>>;
};

const isObject = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const isTextObject = (value: unknown): value is { tag: "plain_text" | "lark_md"; content: string } =>
  isObject(value) && (value.tag === "plain_text" || value.tag === "lark_md") && typeof value.content === "string";
const isText = (value: unknown): value is CardText => typeof value === "string" || isTextObject(value);
const textContent = (value: unknown): string => typeof value === "string" ? value : isTextObject(value) ? value.content : "";
const headerText = (value: unknown): string => {
  if (isText(value)) return textContent(value);
  return isObject(value) && "content" in value ? textContent(value.content) : "";
};
const pathWith = (path: string, suffix: string): string => `${path}${suffix}`;
const failure = (path: string, message: string): Extract<CardValidationResult, { ok: false }> => ({ ok: false, error: { error: `${path}${message}`, path } });
const typeFailure = (path: string, field: string): Extract<CardValidationResult, { ok: false }> => failure(path, `的 ${field} 无效`);

function requireText(value: ObjectValue, field: string, path: string): CardValidationResult | undefined {
  if (!isText(value[field])) return typeFailure(path, field);
  return undefined;
}

function requireString(value: ObjectValue, field: string, path: string): CardValidationResult | undefined {
  if (typeof value[field] !== "string" || !value[field].trim()) return typeFailure(path, field);
  return undefined;
}

function validHttpUrl(value: unknown): boolean {
  return typeof value === "string" && URL_PROTOCOL.test(value);
}

function validImageUrl(value: unknown): boolean {
  return typeof value === "string" && IMAGE_URL.test(value);
}

function validateBehavior(value: unknown, path: string): CardValidationResult | undefined {
  if (!Array.isArray(value)) return typeFailure(path, "behaviors");
  for (const [index, behavior] of value.entries()) {
    const behaviorPath = `${path}的第 ${index + 1} 个 behavior`;
    if (!isObject(behavior) || (behavior.type !== "callback" && behavior.type !== "open_url")) {
      return failure(behaviorPath, "不支持");
    }
    if (behavior.type === "callback" && behavior.value !== undefined && !isObject(behavior.value)) {
      return typeFailure(behaviorPath, "value");
    }
    if (behavior.type === "open_url" && !validHttpUrl(behavior.default_url)) {
      return failure(behaviorPath, "的 default_url 只支持 http:// 或 https://");
    }
  }
  return undefined;
}

function validateElementId(value: ObjectValue, path: string, context: ValidationContext): CardValidationResult | undefined {
  if (value.element_id === undefined) return undefined;
  if (typeof value.element_id !== "string" || !ELEMENT_ID.test(value.element_id)) {
    return failure(path, "的 element_id 无效：要以字母开头，最多 20 个字，只能用字母、数字和下划线");
  }
  if (context.seenElementIds.has(value.element_id)) return failure(path, `的 element_id「${value.element_id}」重复`);
  context.seenElementIds.add(value.element_id);
  return undefined;
}

function validateOptions(value: unknown, path: string, field = "options"): CardValidationResult | undefined {
  if (!Array.isArray(value) || !value.length) return typeFailure(path, field);
  for (const [index, option] of value.entries()) {
    const optionPath = `${path}的第 ${index + 1} 个选项`;
    if (!isObject(option)) return failure(optionPath, "不是对象");
    const textError = requireText(option, "text", optionPath);
    if (textError) return textError;
    const valueError = requireString(option, "value", optionPath);
    if (valueError) return valueError;
  }
  return undefined;
}

function validateFieldName(value: ObjectValue, path: string, formName?: string, context?: ValidationContext): CardValidationResult | undefined {
  if (formName !== undefined && (typeof value.name !== "string" || !value.name.trim())) return failure(path, "缺 name");
  if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim())) return typeFailure(path, "name");
  if (formName !== undefined && typeof value.name === "string") {
    const names = context!.formNames.get(formName) ?? new Set<string>();
    if (names.has(value.name)) return failure(path, `的 name「${value.name}」重复`);
    names.add(value.name);
    context!.formNames.set(formName, names);
  }
  return undefined;
}

function validateElement(value: unknown, path: string, context: ValidationContext, formName?: string): CardElement | undefined | CardValidationResult {
  if (!isObject(value)) return failure(path, "不是对象");
  const tag = value.tag;
  if (typeof tag !== "string") return failure(path, "缺 tag");
  if (!CARD_TAGS.has(tag)) {
    if (context.mode === "plugin") {
      context.unsupportedCount += 1;
      return undefined;
    }
    return failure(path, `的 tag「${tag}」不支持`);
  }
  context.elementCount += 1;
  if (context.elementCount > MAX_CARD_ELEMENTS) return failure(path, `超过 ${MAX_CARD_ELEMENTS} 个组件`);
  const idError = validateElementId(value, path, context);
  if (idError) return idError;
  if (tag === "markdown") {
    const error = requireText(value, "content", path);
    return error ?? value as CardElement;
  }
  if (tag === "div") {
    const error = requireText(value, "text", path);
    return error ?? value as CardElement;
  }
  if (tag === "hr") return value as CardElement;
  if (tag === "img") {
    if (!validImageUrl(value.src)) return failure(path, "的 src 只支持 https:// 或 data:image/");
    const error = requireText(value, "alt", path);
    return error ?? value as CardElement;
  }
  if (tag === "table") {
    if (!Array.isArray(value.columns) || !value.columns.length) return typeFailure(path, "columns");
    for (const [index, column] of value.columns.entries()) {
      const columnPath = `${path}的第 ${index + 1} 个列`;
      if (!isObject(column)) return failure(columnPath, "不是对象");
      const nameError = requireString(column, "name", columnPath);
      if (nameError) return nameError;
      const displayError = requireText(column, "display_name", columnPath);
      if (displayError) return displayError;
    }
    if (!Array.isArray(value.rows) || value.rows.some((row) => !isObject(row))) return typeFailure(path, "rows");
    return value as CardElement;
  }
  if (tag === "form") {
    if (formName !== undefined) return failure(path, "里不能嵌套 form");
    const nameError = requireString(value, "name", path);
    if (nameError) return nameError;
    const childResult = validateChildren(value.elements, `${path}「${value.name}」`, context, value.name);
    if (!childResult.ok) return childResult;
    return { ...value, elements: childResult.elements } as CardElement;
  }
  if (tag === "column_set") {
    if (!Array.isArray(value.columns) || !value.columns.length) return typeFailure(path, "columns");
    const columns: ObjectValue[] = [];
    for (const [index, column] of value.columns.entries()) {
      const columnPath = `${path}的第 ${index + 1} 个 column`;
      if (!isObject(column)) return failure(columnPath, "不是对象");
      if (typeof column.weight !== "number" || !Number.isFinite(column.weight) || column.weight <= 0) return typeFailure(columnPath, "weight");
      const childResult = validateChildren(column.elements, columnPath, context, formName);
      if (!childResult.ok) return childResult;
      columns.push({ ...column, elements: childResult.elements });
    }
    return { ...value, columns } as CardElement;
  }
  if (tag === "collapsible_panel") {
    if (!isObject(value.header)) return typeFailure(path, "header");
    const header = value.header as ObjectValue;
    if (!isText(header.title) && !isTextObject(header.title) && !headerText(header.title)) return typeFailure(`${path}的 header`, "title");
    if (value.expanded !== undefined && typeof value.expanded !== "boolean") return typeFailure(path, "expanded");
    const childResult = validateChildren(value.elements, path, context, formName);
    if (!childResult.ok) return childResult;
    return { ...value, elements: childResult.elements } as CardElement;
  }
  if (tag === "interactive_container") {
    const behaviorError = value.behaviors === undefined ? undefined : validateBehavior(value.behaviors, path);
    if (behaviorError) return behaviorError;
    const childResult = validateChildren(value.elements, path, context, formName);
    if (!childResult.ok) return childResult;
    return { ...value, elements: childResult.elements } as CardElement;
  }
  if (tag === "button") {
    const textError = requireText(value, "text", path);
    if (textError) return textError;
    if (value.type !== undefined && (typeof value.type !== "string" || !BUTTON_TYPES.has(value.type))) return typeFailure(path, "type");
    if (value.form_action_type !== undefined && (typeof value.form_action_type !== "string" || !ACTION_TYPES.has(value.form_action_type))) return typeFailure(path, "form_action_type");
    if (value.behaviors !== undefined) {
      const behaviorError = validateBehavior(value.behaviors, path);
      if (behaviorError) return behaviorError;
    }
    if (value.confirm !== undefined) {
      if (!isObject(value.confirm)) return typeFailure(path, "confirm");
      const titleError = requireText(value.confirm, "title", `${path}的 confirm`);
      if (titleError) return titleError;
      const confirmTextError = requireText(value.confirm, "text", `${path}的 confirm`);
      if (confirmTextError) return confirmTextError;
    }
    return value as CardElement;
  }
  if (FIELD_TAGS.has(tag)) {
    const nameError = validateFieldName(value, path, formName, context);
    if (nameError) return nameError;
    if (tag === "input") {
      if (value.input_type !== undefined && (typeof value.input_type !== "string" || !INPUT_TYPES.has(value.input_type))) return typeFailure(path, "input_type");
      if (value.input_type === "password") context.assistantPassword = true;
      if (value.label !== undefined) {
        const error = requireText(value, "label", path);
        if (error) return error;
      }
      if (value.placeholder !== undefined) {
        const error = requireText(value, "placeholder", path);
        if (error) return error;
      }
      if (value.default_value !== undefined && typeof value.default_value !== "string" && typeof value.default_value !== "number") return typeFailure(path, "default_value");
      const integerFields = ["max_length", "min_length"] as const;
      for (const field of integerFields) if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isInteger(value[field]) || value[field] < 0)) return typeFailure(path, field);
      for (const field of ["min", "max"] as const) if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) return typeFailure(path, field);
      if (value.min !== undefined && value.max !== undefined && value.min > value.max) return failure(path, "的 min 不能大于 max");
      if (value.min_length !== undefined && value.max_length !== undefined && value.min_length > value.max_length) return failure(path, "的 min_length 不能大于 max_length");
      if (value.required !== undefined && typeof value.required !== "boolean") return typeFailure(path, "required");
      if (value.generate !== undefined && typeof value.generate !== "boolean") return typeFailure(path, "generate");
      return value as CardElement;
    }
    if (tag === "checker") {
      const textError = requireText(value, "text", path);
      if (textError) return textError;
      if (value.checked !== undefined && typeof value.checked !== "boolean") return typeFailure(path, "checked");
      return value as CardElement;
    }
    if (tag === "select_static" || tag === "multi_select_static") {
      const optionsError = validateOptions(value.options, path);
      if (optionsError) return optionsError;
      if (value.label !== undefined) {
        const error = requireText(value, "label", path);
        if (error) return error;
      }
      if (value.placeholder !== undefined) {
        const error = requireText(value, "placeholder", path);
        if (error) return error;
      }
      const options = value.options as ObjectValue[];
      const values = new Set(options.map((option) => option.value));
      if (tag === "select_static" && value.initial_option !== undefined && (typeof value.initial_option !== "string" || !values.has(value.initial_option))) return failure(path, "的 initial_option 不在 options 里");
      if (tag === "multi_select_static" && value.initial_options !== undefined && (!Array.isArray(value.initial_options) || value.initial_options.some((option) => typeof option !== "string" || !values.has(option)))) return failure(path, "的 initial_options 不在 options 里");
      if (value.required !== undefined && typeof value.required !== "boolean") return typeFailure(path, "required");
      if (tag === "select_static" && value.display !== undefined && value.display !== "dropdown" && value.display !== "chips") return typeFailure(path, "display");
      return value as CardElement;
    }
    if (tag === "overflow") {
      const optionsError = validateOptions(value.options, path);
      if (optionsError) return optionsError;
      if (value.label !== undefined) {
        const error = requireText(value, "label", path);
        if (error) return error;
      }
      return value as CardElement;
    }
    for (const field of ["label"] as const) if (value[field] !== undefined) {
      const error = requireText(value, field, path);
      if (error) return error;
    }
    if (value.required !== undefined && typeof value.required !== "boolean") return typeFailure(path, "required");
    return value as CardElement;
  }
  return value as CardElement;
}

function validateChildren(value: unknown, path: string, context: ValidationContext, formName?: string): { ok: true; elements: CardElement[] } | Extract<CardValidationResult, { ok: false }> {
  if (!Array.isArray(value)) return typeFailure(path, "elements");
  const elements: CardElement[] = [];
  for (const [index, child] of value.entries()) {
    const result = validateElement(child, `${path}里的第 ${index + 1} 个组件`, context, formName);
    if (result && typeof result === "object" && "ok" in result) {
      if (!result.ok) return result;
    } else if (result) {
      elements.push(result);
    }
  }
  return { ok: true, elements };
}

function interactive(value: CardElement): boolean {
  if (["button", "input", "select_static", "multi_select_static", "date_picker", "picker_time", "picker_datetime", "checker", "overflow"].includes(value.tag)) return true;
  if (value.tag === "interactive_container") return (value.behaviors?.length ?? 0) > 0 || value.elements.some(interactive);
  if (value.tag === "form" || value.tag === "column_set" || value.tag === "collapsible_panel") {
    const children = value.tag === "form" || value.tag === "collapsible_panel" ? value.elements : value.columns.flatMap((column) => column.elements);
    return children.some(interactive);
  }
  return false;
}

export function cardTitle(card: Card): string {
  return card.header ? headerText(card.header.title) : "";
}

export function cardSummary(card: Card): string {
  return card.config?.summary ? headerText(card.config.summary.content) : "";
}

export function validateCard(input: unknown, options: { mode?: CardValidationMode } = {}): CardValidationResult {
  if (!isObject(input)) return failure("卡片", "必须是对象");
  if (input.schema !== undefined && input.schema !== "2.0") return failure("卡片", "的 schema 只能是「2.0」");
  let serialized: string;
  try { serialized = JSON.stringify(input); }
  catch { return failure("卡片", "不是有效的 JSON"); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_CARD_BYTES) return failure("卡片", "不能超过 100 KB");
  if (!isObject(input.body)) return failure("卡片", "缺 body");
  const context: ValidationContext = { mode: options.mode ?? "assistant", seenElementIds: new Set(), elementCount: 0, unsupportedCount: 0, assistantPassword: false, formNames: new Map() };
  const children = validateChildren(input.body.elements, "卡片 body", context);
  if (!children.ok) return children;
  if ((options.mode ?? "assistant") === "assistant" && context.assistantPassword) {
    return failure("卡片", "不能有 input_type 为 password 的输入框：密码这类值要交给插件的卡片，不经过你。");
  }
  const card = { ...input, body: { ...input.body, elements: children.elements } } as Card;
  const value: ValidatedCard = {
    card,
    title: cardTitle(card),
    interactive: children.elements.some(interactive),
    componentCount: context.elementCount,
    unsupportedCount: context.unsupportedCount,
  };
  return { ok: true, value };
}

export function cardComponentSummary(card: Card): string {
  const elements = card.body.elements;
  const forms = elements.filter((element) => element.tag === "form").length;
  const tables = elements.filter((element) => element.tag === "table").reduce((count, element) => count + element.rows.length, 0);
  if (forms) return `表单 ${forms} 项`;
  if (tables) return `表格 ${tables} 行`;
  return `组件 ${elements.length} 个`;
}

export function cardHistoryLine(card: Card): string {
  return `（卡片「${cardTitle(card) || "未命名卡片"}」：${cardSummary(card) || cardComponentSummary(card)}）`;
}

export function cardHasCallback(card: Card): boolean {
  const visit = (element: CardElement): boolean => {
    const behaviors: CardBehavior[] = "behaviors" in element && Array.isArray(element.behaviors) ? element.behaviors : [];
    if (behaviors.some((behavior) => behavior.type === "callback")) return true;
    if (element.tag === "form" || element.tag === "collapsible_panel" || element.tag === "interactive_container") return element.elements.some(visit);
    if (element.tag === "column_set") return element.columns.some((column) => column.elements.some(visit));
    return false;
  };
  return card.body.elements.some(visit);
}
