import type {
  Card,
  CardButton,
  CardButtonType,
  CardColumn,
  CardElement,
  CardInputType,
} from "../../shared/cards.ts";

export interface MarkdownCardResult {
  card: Card;
  warnings: string[];
  errors: string[];
}

type AttrMap = Record<string, string | true>;

const FENCE_LINE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BLOCK_START = /^\s*(#|[-*+]\s|\d+[.)]\s|\||>|:::|::\w|<details|```|~~~|!\[|---|\+\+\+)/;
const COMPONENT_LINE = /^\s*::(\w+)\[(.*)\]\s*(\{.*\})?\s*$/;
const CONTAINER_OPEN = /^\s*:::\s*(\w+)\s*(\{.*\})?\s*$/;
const CONTAINER_CLOSE = /^\s*:::\s*$/;
const COLUMN_SPLIT = /^\s*\+\+\+\s*$/;
const DETAILS_OPEN = /^\s*<details(\s+open)?\s*>\s*(?:<summary>(.*?)<\/summary>)?\s*$/i;
const SUMMARY_LINE = /^\s*<summary>(.*?)<\/summary>\s*$/i;
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\((\S+?)\)\s*$/;
const HR_LINE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const HTTP_URL = /^https?:\/\//i;
const HTTPS_URL = /^https:\/\//i;

const FIELD_KINDS = new Set(["input", "select", "multiselect", "date", "time", "datetime", "checkbox"]);
const KNOWN_INPUT_TYPES = new Set(["text", "multiline", "multiline_text", "number", "password"]);

function splitTableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function stripInlineFormatting(text: string): string {
  return text.replace(/\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\*(.+?)\*/g, (_match, a, b, c, d) => a ?? b ?? c ?? d);
}

/** 解析 `{name=a placeholder="几个 字" required min=1}` 为键值表。 */
function parseAttrs(raw?: string): AttrMap {
  const out: AttrMap = {};
  if (!raw) return out;
  const body = raw.trim().replace(/^\{|\}$/g, "");
  for (const match of body.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|([^\s"']+)))?/g)) {
    out[match[1]!] = match[2] ?? match[3] ?? match[4] ?? match[5] ?? true;
  }
  return out;
}

const attrString = (value: string | true | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const attrNumber = (value: string | true | undefined): number | undefined =>
  typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;

const isFlag = (value: string | true | undefined): boolean =>
  value === true || value === "true";

/** 选项和多个默认值只按半角 `|` 切开，全角 `｜` 当作文字本身保留。 */
const splitPipeList = (value: string | true | undefined): string[] =>
  typeof value === "string" ? value.split(/\s*\|\s*/).map((item) => item.trim()).filter(Boolean) : [];

/** 普通 Markdown 段：GFM 表格转 table，独立一行的 https 图片转 img，独立一行 --- 转 hr，其余保留为 markdown。 */
function parseProse(text: string): CardElement[] {
  const lines = text.split("\n");
  const out: CardElement[] = [];
  let buf: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const content = buf.join("\n").trim();
    if (content) out.push({ tag: "markdown", content });
    buf = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = line.match(FENCE_LINE);
    if (fence) {
      buf.push(line);
      if (fenceMatch && fenceMatch[1] === fence) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      buf.push(line);
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[index + 1] ?? "")) {
      flush();
      const headers = splitTableCells(line);
      const rows: Record<string, string>[] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index]!)) {
        const row = splitTableCells(lines[index]!);
        rows.push(Object.fromEntries(headers.map((_, col) => [`c${col}`, stripInlineFormatting(row[col] ?? "")])));
        index += 1;
      }
      index -= 1;
      out.push({
        tag: "table",
        columns: headers.map((header, col) => ({ name: `c${col}`, display_name: stripInlineFormatting(header) || " " })),
        rows,
      });
      continue;
    }

    const imageMatch = line.match(IMAGE_LINE);
    if (imageMatch && HTTPS_URL.test(imageMatch[2]!)) {
      flush();
      out.push({ tag: "img", src: imageMatch[2]!, alt: imageMatch[1] || "图片" });
      continue;
    }

    if (HR_LINE.test(line) && !buf.at(-1)?.trim()) {
      flush();
      out.push({ tag: "hr" });
      continue;
    }

    buf.push(line);
  }

  flush();
  return out;
}

function dedupeFormNames(
  elements: CardElement[],
  seen: Set<string>,
  nextAuto: () => number,
  warnings: string[],
): void {
  for (const child of elements) {
    if ("name" in child && typeof child.name === "string" && child.name && child.tag !== "form") {
      if (seen.has(child.name)) {
        const renamed = `${child.name}_${nextAuto()}`;
        warnings.push(`表单里 name「${child.name}」重复，后一个改成 ${renamed}`);
        child.name = renamed;
      }
      seen.add(child.name);
    }
    if (child.tag === "column_set") {
      for (const column of child.columns) dedupeFormNames(column.elements, seen, nextAuto, warnings);
    } else if (child.tag === "collapsible_panel") {
      dedupeFormNames(child.elements, seen, nextAuto, warnings);
    }
  }
}

function hasSubmitButton(elements: CardElement[]): boolean {
  for (const child of elements) {
    if (child.tag === "button" && child.form_action_type === "submit") return true;
    if (child.tag === "column_set" && child.columns.some((column) => hasSubmitButton(column.elements))) return true;
    if (child.tag === "collapsible_panel" && hasSubmitButton(child.elements)) return true;
  }
  return false;
}

/**
 * 把助手写的卡片 Markdown 翻译成现有的卡片 JSON 2.0。
 * - warnings：已经替模型补好、不影响用户使用的提醒。
 * - errors：会导致用户缺少可用组件的问题，不发卡片、返回给模型改。
 */
export function markdownToCard(text: string): MarkdownCardResult {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const warnings: string[] = [];
  const errors: string[] = [];
  let cursor = 0;
  let auto = 0;
  const nextAuto = () => {
    auto += 1;
    return auto;
  };

  while (cursor < lines.length && !lines[cursor]!.trim()) cursor += 1;

  let header: { title: string; subtitle?: string } | undefined;
  const headingMatch = lines[cursor]?.match(/^#\s+(.+?)\s*#*\s*$/);
  if (headingMatch) {
    header = { title: headingMatch[1]! };
    cursor += 1;
    const nextLine = lines[cursor];
    if (nextLine !== undefined && nextLine.trim() && !BLOCK_START.test(nextLine)) {
      header.subtitle = nextLine.trim();
      cursor += 1;
    }
  }

  const parseComponent = (kind: string, label: string, attrs: AttrMap, formName: string | null): CardElement | null => {
    if (kind === "button") {
      const url = attrString(attrs.url);
      if (url && !HTTP_URL.test(url)) warnings.push(`按钮「${label}」的 url 不是 http(s) 网址，已去掉`);
      const type: CardButtonType | undefined = isFlag(attrs.primary) ? "primary_filled" : isFlag(attrs.danger) ? "danger" : undefined;
      const submit = isFlag(attrs.submit);
      if (submit && !formName) warnings.push(`按钮「${label}」写了 submit 但不在表单里，按普通按钮处理`);
      const button: CardButton = {
        tag: "button",
        text: label,
        ...(type ? { type } : {}),
        ...(submit && formName ? { form_action_type: "submit" } : {}),
        ...(url && HTTP_URL.test(url) ? { behaviors: [{ type: "open_url", default_url: url }] } : {}),
      };
      return button;
    }

    if (!FIELD_KINDS.has(kind)) {
      errors.push(`组件「::${kind}」不认识：能用的是 input、select、multiselect、date、time、datetime、checkbox、button（数字输入框写 ::input[…]{type=number}）`);
      return null;
    }

    const explicitName = attrString(attrs.name);
    const name = explicitName ?? `f${nextAuto()}`;
    if (formName && !explicitName) warnings.push(`「${label}」没写 name，用了 ${name}`);

    const required = isFlag(attrs.required) ? { required: true } : {};
    const labelled = label ? { label } : {};

    if (kind === "input") {
      const type = attrString(attrs.type);
      const inputType: CardInputType =
        type === "multiline" || type === "multiline_text"
          ? "multiline_text"
          : type === "number"
            ? "number"
            : type === "password"
              ? "password"
              : "text";
      if (type && !KNOWN_INPUT_TYPES.has(type)) {
        warnings.push(`「${label}」的 type「${type}」不认识，按一行文字处理`);
      }
      const placeholder = attrString(attrs.placeholder);
      const defaultRaw = attrString(attrs.default);
      const defaultNum = attrNumber(attrs.default);
      const min = attrNumber(attrs.min);
      const max = attrNumber(attrs.max);
      return {
        tag: "input",
        name,
        ...labelled,
        ...(placeholder ? { placeholder } : {}),
        ...(defaultRaw ? { default_value: inputType === "number" && defaultNum !== undefined ? defaultNum : defaultRaw } : {}),
        ...(inputType !== "text" ? { input_type: inputType } : {}),
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...required,
      };
    }

    if (kind === "select" || kind === "multiselect") {
      const options = splitPipeList(attrs.options);
      if (!options.length) {
        errors.push(`「::${kind}[${label}]」没写 options：写成 options="选项1|选项2"`);
        return null;
      }
      const defaults = splitPipeList(attrs.default);
      const invalid = defaults.filter((item) => !options.includes(item));
      if (invalid.length) warnings.push(`「${label}」的 default「${invalid.join("|")}」不在 options 里，已去掉`);
      const valid = defaults.filter((item) => options.includes(item));
      const optionItems = options.map((option) => ({ text: option, value: option }));
      if (kind === "select") {
        return {
          tag: "select_static",
          name,
          ...labelled,
          options: optionItems,
          ...(valid.length ? { initial_option: valid[0] } : {}),
          ...required,
        };
      }
      return {
        tag: "multi_select_static",
        name,
        ...labelled,
        options: optionItems,
        ...(valid.length ? { initial_options: valid } : {}),
        ...required,
      };
    }

    if (kind === "date") return { tag: "date_picker", name, ...labelled, ...required };
    if (kind === "time") return { tag: "picker_time", name, ...labelled, ...required };
    if (kind === "datetime") return { tag: "picker_datetime", name, ...labelled, ...required };

    return {
      tag: "checker",
      name,
      text: label,
      ...(isFlag(attrs.checked) ? { checked: true } : {}),
    };
  };

  const parseRange = (
    source: string[],
    startIndex: number,
    isEnd: ((line: string) => boolean) | null,
    formName: string | null,
    inDetails: boolean,
  ): { elements: CardElement[]; nextIndex: number } => {
    const out: CardElement[] = [];
    let buf: string[] = [];
    let fence: string | null = null;
    let index = startIndex;

    const flush = () => {
      const content = buf.join("\n").trim();
      if (content) out.push(...parseProse(content));
      buf = [];
    };

    while (index < source.length) {
      const line = source[index]!;
      const fenceMatch = line.match(FENCE_LINE);
      if (fence) {
        buf.push(line);
        if (fenceMatch && fenceMatch[1] === fence) fence = null;
        index += 1;
        continue;
      }
      if (fenceMatch) {
        fence = fenceMatch[1]!;
        buf.push(line);
        index += 1;
        continue;
      }

      if (isEnd?.(line)) {
        flush();
        return { elements: out, nextIndex: index };
      }

      const compMatch = line.match(COMPONENT_LINE);
      if (compMatch) {
        const element = parseComponent(compMatch[1]!.toLowerCase(), compMatch[2]!.trim(), parseAttrs(compMatch[3]), formName);
        if (element) {
          flush();
          out.push(element);
        } else {
          buf.push(line);
        }
        index += 1;
        continue;
      }

      const containerMatch = line.match(CONTAINER_OPEN);
      if (containerMatch && containerMatch[1] === "columns") {
        flush();
        index += 1;
        const rawColumns: string[][] = [[]];
        let closed = false;
        let depth = 0;
        let innerFence: string | null = null;

        while (index < source.length) {
          const innerLine = source[index]!;
          const innerFenceMatch = innerLine.match(FENCE_LINE);
          if (innerFence) {
            rawColumns.at(-1)!.push(innerLine);
            if (innerFenceMatch && innerFenceMatch[1] === innerFence) innerFence = null;
            index += 1;
            continue;
          }
          if (innerFenceMatch) {
            innerFence = innerFenceMatch[1]!;
            rawColumns.at(-1)!.push(innerLine);
            index += 1;
            continue;
          }
          if (CONTAINER_OPEN.test(innerLine)) depth += 1;
          if (CONTAINER_CLOSE.test(innerLine)) {
            if (depth === 0) {
              closed = true;
              index += 1;
              break;
            }
            depth -= 1;
          }
          if (depth === 0 && COLUMN_SPLIT.test(innerLine)) {
            rawColumns.push([]);
            index += 1;
            continue;
          }
          rawColumns.at(-1)!.push(innerLine);
          index += 1;
        }

        if (!closed) warnings.push("分栏没有用 ::: 闭合，已按到结尾处理");
        const filled = rawColumns.filter((column) => column.join("\n").trim());
        if (filled.length < rawColumns.length) warnings.push("分栏里有空栏，已去掉");

        const columns: CardColumn[] = filled.map((columnLines) => ({
          weight: 1,
          elements: parseRange(columnLines, 0, null, formName, false).elements,
        }));
        const rawWeights = attrString(parseAttrs(containerMatch[2]).weights);
        const weights = splitPipeList(rawWeights?.replace(/[\s,]+/g, "|")).map(Number);
        if (weights.length === columns.length && weights.every((weight) => Number.isFinite(weight) && weight > 0)) {
          columns.forEach((column, colIndex) => {
            column.weight = weights[colIndex]!;
          });
        }
        if (columns.length) out.push({ tag: "column_set", columns });
        continue;
      }

      if (containerMatch && containerMatch[1] === "form") {
        if (formName) {
          warnings.push("表单里又写了表单，里面那层当作同一个表单");
          index += 1;
          continue;
        }
        flush();
        index += 1;
        const explicitFormName = attrString(parseAttrs(containerMatch[2]).name);
        const currentFormName = explicitFormName ?? `form${nextAuto()}`;
        if (!explicitFormName) warnings.push(`表单没写 name，用了 ${currentFormName}`);

        const inner = parseRange(source, index, (l) => CONTAINER_CLOSE.test(l), currentFormName, inDetails);
        index = inner.nextIndex;
        if (index < source.length) index += 1;
        else warnings.push("表单没有用 ::: 闭合，已按到结尾处理");

        const children = inner.elements;
        dedupeFormNames(children, new Set<string>(), nextAuto, warnings);
        if (!hasSubmitButton(children)) {
          warnings.push("表单里没有 submit 按钮，用户交不回来；已在最后加一个「提交」");
          children.push({ tag: "button", text: "提交", type: "primary_filled", form_action_type: "submit" });
        }
        out.push({ tag: "form", name: currentFormName, elements: children });
        continue;
      }

      if (containerMatch) {
        warnings.push(`块「:::${containerMatch[1]}」不认识，按普通文字显示`);
        buf.push(line);
        index += 1;
        continue;
      }

      const detailsMatch = line.match(DETAILS_OPEN);
      if (detailsMatch) {
        if (inDetails) {
          warnings.push("折叠里又套了折叠，里面那层按普通文字显示");
          buf.push(line);
          index += 1;
          continue;
        }
        flush();
        index += 1;
        let title = detailsMatch[2]?.trim();
        if (title === undefined) {
          const summaryMatch = source[index]?.match(SUMMARY_LINE);
          if (summaryMatch) {
            title = summaryMatch[1]!.trim();
            index += 1;
          }
        }
        if (!title) warnings.push("折叠没有写 <summary> 标题，用了「详情」");

        const inner = parseRange(source, index, (l) => DETAILS_CLOSE.test(l), formName, true);
        index = inner.nextIndex;
        if (index < source.length) index += 1;
        else warnings.push("折叠没有用 </details> 闭合，已按到结尾处理");

        out.push({
          tag: "collapsible_panel",
          expanded: Boolean(detailsMatch[1]),
          header: { title: title || "详情" },
          elements: inner.elements,
        });
        continue;
      }

      if (COLUMN_SPLIT.test(line) || CONTAINER_CLOSE.test(line)) {
        warnings.push(`多出来一行「${line.trim()}」，按普通文字显示`);
      }
      buf.push(line);
      index += 1;
    }

    if (fence) warnings.push("代码块没有闭合");
    flush();
    return { elements: out, nextIndex: index };
  };

  const { elements } = parseRange(lines, cursor, null, null, false);
  const card: Card = {
    schema: "2.0",
    ...(header ? { header } : {}),
    body: { elements },
  };
  return { card, warnings, errors };
}
