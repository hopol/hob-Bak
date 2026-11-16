import type { Locale } from "../../shared/i18n.ts";
import { t } from "../../shared/i18n.ts";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function time(hour: string, minute: string): string {
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function weekday(token: string, locale: Locale): string | undefined {
  const map: Record<string, number> = { "0": 0, "7": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6 };
  const index = map[token];
  return index === undefined ? undefined : locale === "en" ? WEEKDAYS_EN[index] : WEEKDAYS[index];
}

function ordinal(day: number): string {
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${suffix}`;
}

/** 具体时间点（2026-11-08T09:00，可带秒）转成当前语言的显示文字。 */
export function timePointText(expression: string, now: Date = new Date(), locale: Locale = "zh-CN"): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(expression.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  if (locale === "en") {
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    const label = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(Number(year) === now.getFullYear() ? {} : { year: "numeric" }) }).format(date);
    return `${label} ${hour}:${minute}`;
  }
  return `${Number(year) === now.getFullYear() ? "" : `${Number(year)}年`}${Number(month)}月${Number(day)}日 ${hour}:${minute}`;
}

/** cron 转当前语言：覆盖常见的每天 / 每周 / 每月 / 每隔几分钟。 */
export function cronText(expression: string, locale: Locale = "zh-CN"): string {
  const point = timePointText(expression, new Date(), locale);
  if (point) return locale === "en" ? t("{point}（一次）", { point }, locale) : `${point}（一次）`;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, day, month, dow] = parts;
  const at = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? time(hour, minute) : undefined;

  if (minute.startsWith("*/") && hour === "*" && day === "*" && month === "*" && dow === "*") {
    return t("每 {n} 分钟", { n: Number(minute.slice(2)) }, locale);
  }
  if (minute === "0" && hour === "*" && day === "*" && month === "*" && dow === "*") return t("每小时整点", {}, locale);
  if (!at) return expression;

  if (day === "L" && month === "*" && dow === "*") return t("每月最后一天 {time}", { time: at }, locale);
  if (/^\d+$/.test(day) && month === "*" && dow === "*") return locale === "en" ? `Monthly on the ${ordinal(Number(day))} ${at}` : `每月 ${day} 日 ${at}`;
  if (day === "*" && month === "*") {
    if (dow === "*") return t("每天 {time}", { time: at }, locale);
    if (/^\d+$/.test(dow)) {
      const name = weekday(dow, locale);
      return name ? t("每周{day} {time}", { day: name, time: at }, locale) : expression;
    }
    const range = dow.match(/^(\d)-(\d)$/);
    if (range) {
      const from = weekday(range[1]!, locale);
      const to = weekday(range[2]!, locale);
      if (from && to) return locale === "en" ? `${from}s to ${to}s ${at}` : `每周${from}到${to} ${at}`;
    }
    const list = dow.split(",");
    if (list.length > 1 && list.every((item) => /^\d$/.test(item))) {
      const names = list.map((item) => weekday(item, locale) ?? item);
      return locale === "en" ? `${names.map((name) => `${name}s`).join(", ")} ${at}` : `每周${names.join("、")} ${at}`;
    }
  }
  return expression;
}

/** Backward-compatible Chinese name used by model-facing code. */
export function cronToChinese(expression: string, locale: Locale = "zh-CN"): string {
  return cronText(expression, locale);
}
