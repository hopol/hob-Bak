// 思考档的规则：7 个标准档、默认档位、写给引擎的稀疏 thinkingLevelMap。前后端和假后端共用一份，别各写一遍。
import type { ThinkingLevel, ThinkingLevelMapSetting } from "./types.ts";

/** 7 个标准档，从低到高（和引擎的 ThinkingLevel 一致）。 */
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 界面和报错用的中文档名。 */
export const THINKING_TEXT: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

/** 思考档字符的长度上限（存得下，也给服务商发得出去）。 */
export const THINKING_TEXT_MAX = 40;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

/**
 * 默认档位（唯一的默认规则）：
 * - 会推理的模型 off … max；
 * - 模型 id 含 gpt（不分大小写）的只到 xhigh；
 * - 不会推理的只有 off。
 */
export function defaultThinkingLevels(id: string, reasoning: boolean): ThinkingLevel[] {
  if (!reasoning) return ["off"];
  return /gpt/i.test(id) ? THINKING_LEVELS.slice(0, 6) : [...THINKING_LEVELS];
}

/**
 * 引擎默认不开 xhigh / max：要开就得在映射里写个值。
 * Google 那套只有 low / medium / high，写档名会被引擎当成不认识的档（请求时直接抛错），
 * 所以在 Google 协议上按它能给的最高档 high 开。
 */
function enableText(level: ThinkingLevel, api?: string): string {
  return api === "google-generative-ai" || api === "google-vertex" ? "high" : level;
}

export interface ThinkingPlan {
  /** Hob 认为这个模型能选的档，从低到高（等于引擎对这个模型算出的可选档） */
  levels: ThinkingLevel[];
  /** 每档现在的字符：用户填的；空串 = 这一档开着，按服务商协议的默认 */
  chars: Partial<Record<ThinkingLevel, string>>;
  /**
   * 写给引擎的 thinkingLevelMap（稀疏）：只放必要的键——
   * 用户自己填的字符、要开的 xhigh / max、关掉的档写 null。
   * 没改过的 off、minimal…high 不写：引擎对写了字符串的档会原样发出去，
   * 没写的档才按各协议的默认翻译（off 写字符串会被当成 reasoning_effort 发出去）。
   */
  map: Partial<Record<ThinkingLevel, string | null>>;
}

/**
 * 这个模型的思考档：设置里存了自定义就按自定义，没存就按默认规则。
 * 不看引擎注册表里自带的 thinkingLevelMap：Hob 决定有哪些档，引擎只负责按协议把字符发出去。
 */
export function thinkingPlan(
  id: string,
  reasoning: boolean,
  custom?: ThinkingLevelMapSetting,
  api?: string,
): ThinkingPlan {
  if (!reasoning) return { levels: ["off"], chars: {}, map: {} };
  const range = defaultThinkingLevels(id, reasoning);
  const levels: ThinkingLevel[] = [];
  const chars: Partial<Record<ThinkingLevel, string>> = {};
  const map: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const level of THINKING_LEVELS) {
    const value = custom?.[level];
    // 设置里明写了这一档就按它（空串 = 开着的默认字符），没写就按默认范围
    const wanted = value !== undefined ? value !== null : range.includes(level);
    if (!wanted) {
      // 关掉的档写 null：内置服务商的底表里可能开着它
      map[level] = null;
      continue;
    }
    levels.push(level);
    const text = typeof value === "string" ? value.trim() : "";
    chars[level] = text;
    if (text) map[level] = text;
    else if (level === "xhigh" || level === "max") map[level] = enableText(level, api);
  }
  return { levels, chars, map };
}

/**
 * 规整一个模型的自定义思考档（读设置文件时用）：
 * 只认 7 个标准档；null = 这一档不要；字符串去首尾空白，空串 = 按协议默认；
 * 超长的按没填处理（不因此把这一档删掉）；off 不能删。
 * 返回 undefined 表示没有可用的自定义档（用默认规则）。
 */
export function normalizeThinkingMap(raw: unknown): ThinkingLevelMapSetting | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const map: ThinkingLevelMapSetting = {};
  let seen = false;
  for (const level of THINKING_LEVELS) {
    if (!(level in input)) continue;
    seen = true;
    const value = input[level];
    if (value === null) {
      map[level] = null;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    map[level] = text.length <= THINKING_TEXT_MAX ? text : "";
  }
  if (!seen) return undefined;
  // off 是关掉思考这一档，不能没有
  if (map.off === null) map.off = "";
  return map;
}
