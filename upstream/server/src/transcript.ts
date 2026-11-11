// 任务过程（transcript）：从任务的 worker.jsonl 推导步骤列表，实时事件和落盘推导共用一套拼装。
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { commandSummary } from "../../shared/command.ts";
import type { JobStep } from "../../shared/types.ts";
import { showPath } from "./text.ts";

/** 沉淀技能那一轮发给任务的话的开头：任务详情里这句显示成「沉淀技能」。 */
export const SEDIMENT_PROMPT_HEAD = "回顾刚才的过程，看看有没有能复用的做法。这类事以后还会再做的，把做法写成技能";

/** 旧版用过的开头：已经存下来的任务记录里还是这些，任务详情照样显示成「沉淀技能」。 */
const LEGACY_SEDIMENT_HEADS = [
  "这件事以后还会再做。回顾刚才的过程，把能复用的做法写成技能",
  "这件事以后还会再做。回顾刚才的过程，把能复用的做法沉淀成技能",
];

function isSedimentPrompt(text: string): boolean {
  return text.startsWith(SEDIMENT_PROMPT_HEAD) || LEGACY_SEDIMENT_HEADS.some((head) => text.startsWith(head));
}

/** transcript 里单步输出最多这么多字，超出的整段落盘，页面按路径去拉。 */
export const STEP_OUTPUT_LIMIT = 20 * 1024;
/** 实时事件里的单步输出最多这么多字（全文落盘，给路径）。 */
export const STEP_EVENT_LIMIT = 4 * 1024;
/** diff 只给看得清的一段，超长的改动不整段塞进接口。 */
const EDIT_TEXT_LIMIT = 4_000;

const AUTO_FOLLOW_UP = "这一轮结束了，还没有交结果。";

function oneLine(value: string, max = 120): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function tick(text: string): string {
  return `\`${oneLine(text, 90)}\``;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clipEdit(edits: unknown): { oldText: string; newText: string }[] {
  if (!Array.isArray(edits)) return [];
  return edits.map((edit) => ({
    oldText: clip(String((edit as { oldText?: unknown })?.oldText ?? ""), EDIT_TEXT_LIMIT),
    newText: clip(String((edit as { newText?: unknown })?.newText ?? ""), EDIT_TEXT_LIMIT),
  }));
}

/** 只留详情页要看的那几个参数（write 的正文不整段传，只给长度）。 */
export function toolArgs(name: string, raw: Record<string, unknown>, cwd = "", resolvePath?: (path: string) => string): Record<string, unknown> {
  const given = String(raw.path ?? "");
  // 迁移前写进会话的绝对路径先按 moves.json 换成新位置再和 cwd 比：老步骤照样显示成短文件名
  const path = showPath(isAbsolute(given) && resolvePath ? resolvePath(given) : given, cwd);
  switch (name) {
    case "bash":
      return { command: String(raw.command ?? "") };
    case "read":
      return {
        path,
        ...(raw.offset !== undefined ? { offset: raw.offset } : {}),
        ...(raw.limit !== undefined ? { limit: raw.limit } : {}),
      };
    case "edit":
      return { path, edits: clipEdit(raw.edits) };
    case "write":
      return { path, contentLength: String(raw.content ?? "").length };
    case "grep":
      return {
        pattern: String(raw.pattern ?? ""),
        ...(path ? { path } : {}),
        ...(raw.glob ? { glob: String(raw.glob) } : {}),
      };
    case "find":
      return { pattern: String(raw.pattern ?? ""), ...(path ? { path } : {}) };
    case "ls":
      return { path: path || "." };
    default:
      return raw;
  }
}

/** 记忆插件的工具（本地记忆 / Lore）：名字是英文的，显示成动作。 */
const MEMORY_TOOLS: Record<string, string> = {
  memory_search: "搜索记忆",
  memory_read: "读取记忆",
  memory_write: "保存记忆",
  memory_forget: "删除记忆",
  memory_restore: "恢复记忆",
  memory_status: "查看记忆状态",
  lore_boot: "读取记忆",
  lore_get_node: "读取记忆",
  lore_search: "搜索记忆",
  lore_create_node: "保存记忆",
  lore_update_node: "保存记忆",
  lore_move_node: "整理记忆",
  lore_delete_node: "删除记忆",
  lore_list_domains: "查看记忆状态",
  lore_status: "查看记忆状态",
};

/** MCP 工具（mcp__<服务>__<工具>）显示成「服务名 · 工具名」，不露原始名。 */
function mcpToolDisplay(name: string, mcpServers: Record<string, string> | undefined): string | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const split = rest.indexOf("__");
  if (split <= 0) return undefined;
  const server = mcpServers?.[rest.slice(0, split)] ?? rest.slice(0, split);
  const tool = rest.slice(split + 2) || "?";
  return `${server} · ${tool}`;
}

/** 一行中文：「运行 `npm test`」「修改 server/src/jobs.ts」「读取 README.md」。 */
export function toolTitle(name: string, args: Record<string, unknown>, mcpServers?: Record<string, string>): string {
  const path = String(args.path ?? "");
  switch (name) {
    case "bash":
      return `运行 ${tick(commandSummary(String(args.command ?? "")))}`;
    case "read":
      return `读取 ${path}${readRange(args)}`;
    case "edit":
      return `修改 ${path}`;
    case "write":
      return `写入 ${path}`;
    case "grep":
      return `搜索 ${tick(String(args.pattern ?? ""))}`;
    case "find":
      return `查找 ${tick(String(args.pattern ?? ""))}`;
    case "ls":
      return `列出 ${path}`;
    case "report":
      return "提交结果";
    case "save_skill":
      return `保存技能：${oneLine(String(args.title ?? ""), 60)}`;
    case "ask_user":
      return `询问用户：${oneLine(String(args.title ?? ""), 60)}`;
    case "overview":
      return `查看最近 ${Number(args.sinceHours ?? 24)} 小时的记录`;
    case "generate_image":
      return `生成图片：${oneLine(String(args.prompt ?? ""), 60)}`;
    case "web_search":
      return `联网搜索：${oneLine(String(args.query ?? ""), 60)}`;
    case "find_knowledge":
      return args.query ? `找资料：${oneLine(String(args.query), 60)}` : "找资料";
    case "search_knowledge":
      return args.query ? `查知识库：${oneLine(String(args.query), 60)}` : "查知识库";
    case "web_fetch":
      return `读取网页：${oneLine(String(args.url ?? ""), 60)}`;
    case "browser_open": {
      let target = oneLine(String(args.url ?? ""), 60);
      try { target = new URL(target).hostname; } catch { /* 无效地址保留原样 */ }
      return `浏览器 · 打开 ${target}`;
    }
    case "browser_snapshot": return "浏览器 · 读取页面";
    case "browser_click": return "浏览器 · 点击";
    case "browser_type": return "浏览器 · 输入";
    case "browser_press": return "浏览器 · 按键";
    case "browser_back": return "浏览器 · 返回";
    case "browser_screenshot": return "浏览器 · 截图";
    case "desktop_screenshot": return "桌面 · 截图";
    case "desktop_action": {
      const names: Record<string, string> = { click: "点击", move: "移动", drag: "拖动", type: "输入", key: "按键", scroll: "滚动", wait: "等待" };
      const first = Array.isArray(args.actions) ? args.actions[0] as { type?: string } | undefined : undefined;
      return `桌面 · ${names[first?.type ?? ""] ?? "操作"}`;
    }
    case "tool_search":
      return `搜索可用工具：${oneLine(String(args.query ?? ""), 60)}`;
    case "list_mcp_resources":
      return "列出 MCP 资源";
    case "list_mcp_resource_templates":
      return "列出 MCP 资源模板";
    case "read_mcp_resource":
      return `读取 MCP 资源：${oneLine(String(args.uri ?? ""), 90)}`;
    default: {
      const mcp = mcpToolDisplay(name, mcpServers);
      if (mcp) return `调用 ${mcp}`;
      const label = MEMORY_TOOLS[name];
      if (!label) return name;
      const target = String(args.uri ?? args.query ?? "");
      return target ? `${label} ${tick(target)}` : label;
    }
  }
}

function readRange(args: Record<string, unknown>): string {
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset !== undefined && limit !== undefined) return ` · ${offset}–${offset + limit - 1} 行`;
  if (offset !== undefined) return ` · 第 ${offset} 行起`;
  if (limit !== undefined) return ` · 前 ${limit} 行`;
  return "";
}

export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => Boolean(block) && block.type === "text")
    .map((block) => block.text)
    .join("");
}

export interface ToolStepInput {
  id: string;
  name: string;
  args: Record<string, unknown>;
  at?: string;
  cwd?: string;
  running?: boolean;
  /** MCP 工具的显示名映射（转义后的服务名 → 配置里的原名） */
  mcpServers?: Record<string, string>;
  /** 会话里的老绝对路径换到新位置（迁移后显示老步骤用） */
  resolvePath?: (path: string) => string;
}

/** 一次工具调用 → 一个步骤（还没有结果）。实时事件和落盘推导都用它，页面按 id 合并。 */
export function toolStep(input: ToolStepInput): JobStep {
  const args = toolArgs(input.name, input.args, input.cwd ?? "", input.resolvePath);
  const mcp = mcpToolDisplay(input.name, input.mcpServers);
  return {
    id: input.id,
    kind: "tool",
    at: input.at ?? new Date().toISOString(),
    name: mcp ?? input.name,
    title: toolTitle(input.name, args, input.mcpServers),
    args,
    ...(input.running ? { running: true } : {}),
  };
}

/**
 * 把工具结果的全文装进步骤：超过 limit 就截断并落盘，给出「完整输出在 …」的路径。
 * 没有 save 就只截断。
 */
export function withOutput(
  step: JobStep,
  full: string,
  options: { limit: number; isError?: boolean; durationMs?: number; save?: (stepId: string, text: string) => string },
): JobStep {
  const next: JobStep = { ...step, ...(options.isError ? { isError: true } : {}), ...(options.durationMs ? { durationMs: options.durationMs } : {}) };
  delete next.running;
  if (!full) return next;
  if (full.length <= options.limit) return { ...next, output: full };
  const path = options.save?.(step.id, full);
  const note = `\n\n[输出共 ${full.length} 字，这里截到 ${options.limit} 字。${path ? `完整输出在 ${path}` : ""}]`;
  return { ...next, output: full.slice(0, options.limit) + note, ...(path ? { outputPath: path } : {}) };
}

function stamp(value: unknown, fallback: unknown): string {
  const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  const at = Number.isFinite(ms) ? ms : Date.parse(String(fallback ?? ""));
  return new Date(Number.isFinite(at) ? at : Date.now()).toISOString();
}

export interface DeriveOptions {
  /** 只要这个时间（写进会话的时间）以后的条目 */
  since?: string;
  cwd?: string;
  limit?: number;
  /** 输出过长时落盘，返回路径 */
  save?: (stepId: string, text: string) => string;
  /** MCP 工具的显示名映射（转义后的服务名 → 配置里的原名） */
  mcpServers?: Record<string, string>;
  /** 会话里的老绝对路径换到新位置（迁移后显示老步骤用） */
  resolvePath?: (path: string) => string;
}

/** 从任务会话文件推导整个过程：说明文字、思考摘要、工具调用（含结果）。 */
export function deriveSteps(file: string, options: DeriveOptions = {}): JobStep[] {
  if (!existsSync(file)) return [];
  const limit = options.limit ?? STEP_OUTPUT_LIMIT;
  const steps: JobStep[] = [];
  const toolIndex = new Map<string, number>();
  let seenUser = false;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 半行（进程被杀）跳过
    }
    if (entry?.type !== "message" || !entry.message) continue;
    // 抄过来的那段（沉淀会话开头是任务会话）不算，只记下任务说明已经出现过
    if (options.since && String(entry.timestamp ?? "") < options.since) {
      if (entry.message.role === "user") seenUser = true;
      continue;
    }
    const message = entry.message;
    const at = stamp(message.timestamp, entry.timestamp);

    if (message.role === "assistant") {
      const blocks: any[] = Array.isArray(message.content) ? message.content : [];
      blocks.forEach((block, index) => {
        if (block?.type === "thinking") {
          const text = String(block.thinking ?? "").trim();
          if (!text || block.redacted) return;
          steps.push({ id: `k${message.timestamp}-${index}`, kind: "thinking", at, text });
          return;
        }
        if (block?.type === "text") {
          const text = String(block.text ?? "").trim();
          if (!text) return;
          steps.push({ id: `t${message.timestamp}-${index}`, kind: "text", at, from: "assistant", text });
          return;
        }
        if (block?.type === "toolCall") {
          const step = toolStep({
            id: String(block.id ?? `x${message.timestamp}-${index}`),
            name: String(block.name ?? ""),
            args: block.arguments ?? {},
            at,
            cwd: options.cwd ?? "",
            mcpServers: options.mcpServers,
            resolvePath: options.resolvePath,
            running: true,
          });
          toolIndex.set(step.id, steps.length);
          steps.push(step);
        }
      });
      continue;
    }

    if (message.role === "toolResult") {
      const index = toolIndex.get(String(message.toolCallId ?? ""));
      if (index === undefined) continue;
      steps[index] = withOutput(steps[index], textOfContent(message.content), {
        limit,
        isError: Boolean(message.isError),
        durationMs: typeof message.durationMs === "number" ? message.durationMs : undefined,
        ...(options.save ? { save: options.save } : {}),
      });
      continue;
    }

    if (message.role === "user") {
      const text = textOfContent(message.content).trim();
      if (!text || text.startsWith(AUTO_FOLLOW_UP) || text.startsWith("你还没有调用 report")) continue;
      if (!seenUser) {
        seenUser = true; // 第一句是任务说明，详情头部已经有
        continue;
      }
      steps.push({ id: `u${message.timestamp ?? at}`, kind: "text", at, from: "user", text: isSedimentPrompt(text) ? "沉淀技能" : text });
    }
  }
  return steps;
}
