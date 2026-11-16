// 时间与 cron 的显示/解析。界面文字用中文，时间格式照设计稿（今天 10:05 / 昨天 17:05 / 10月30日 09:00）。
import { currentLocale, t } from "../../shared/i18n.ts";
import type { Locale } from "../../shared/i18n.ts";
import type { RoutineRun } from "../../shared/types.ts";
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const WEEK_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function monthDay(d: Date, locale?: Locale, year = false): string {
  const active = locale ?? currentLocale();
  if (active === "en") {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) }).format(d);
  }
  return `${year ? `${d.getFullYear()}年` : ""}${d.getMonth() + 1}月${d.getDate()}日`;
}

function dayDiff(iso: string, now: Date): number {
  const d = new Date(iso);
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((a - b) / 86400000);
}

function dayLabel(d: Date, diff: number, time: string, locale?: Locale): string {
  const active = locale ?? currentLocale();
  if (active === "en") {
    if (diff === 0) return t("今天 {time}", { time }, locale);
    if (diff === 1) return t("昨天 {time}", { time }, locale);
    if (diff === -1) return t("明天 {time}", { time }, locale);
  } else {
    if (diff === 0) return `今天 ${time}`;
    if (diff === 1) return `昨天 ${time}`;
    if (diff === -1) return `明天 ${time}`;
  }
  return `${monthDay(d, locale)} ${time}`;
}

/** 对话里用的完整时间：今天 10:05 / 昨天 17:05 / 10月30日 09:00 */
export function fmtWhen(iso: string, now = new Date(), locale?: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return dayLabel(d, dayDiff(iso, now), clock(d), locale);
}

/** 左栏列表用的短时间：09:00 / 昨天 / 10月30日 */
export function fmtList(iso: string | undefined, now = new Date(), locale?: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = dayDiff(iso, now);
  if (diff === 0) return clock(d);
  if (diff === 1) return (locale ?? currentLocale()) === "en" ? t("昨天", {}, locale) : "昨天";
  return monthDay(d, locale);
}

/** "6 分钟" 这类相对时长。 */
export function fmtElapsed(fromIso: string, now = Date.now(), locale?: Locale): string {
  const mins = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 60000));
  if (mins < 1) return t("刚刚", {}, locale);
  if (mins < 60) return t("{n} 分钟", { n: mins }, locale);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? t("{hours} 小时 {minutes} 分钟", { hours: h, minutes: m }, locale) : t("{n} 小时", { n: h }, locale);
}

/** 已经用掉的时间："12 秒" / "1 分 20 秒" / "2 小时 5 分钟"。 */
export function fmtDuration(ms: number, locale?: Locale): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t("{n} 秒", { n: seconds }, locale);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? t("{minutes} 分 {seconds} 秒", { minutes, seconds: rest }, locale) : t("{n} 分钟", { n: minutes }, locale);
  }
  return t("{hours} 小时 {minutes} 分钟", { hours: Math.floor(minutes / 60), minutes: minutes % 60 }, locale);
}

/** token 数：1.2k / 32k。 */
export function fmtTokens(count: number): string {
  if (count < 1000) return String(count);
  const k = count / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
}

/** 定时执行的用量：用时 · 操作次数 · token，旧记录没有就是空串。 */
export function routineRunUsage(run: RoutineRun, locale?: Locale): string {
  return [run.durationMs !== undefined ? fmtDuration(run.durationMs, locale) : undefined, run.tools !== undefined ? t("{n} 次操作", { n: run.tools }, locale) : undefined, run.tokens !== undefined ? t("{n} token", { n: fmtTokens(run.tokens) }, locale) : undefined].filter(Boolean).join(" · ");
}

/** 文件大小：3.2 KB / 1.4 MB。 */
export function fmtBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${size < 10240 ? (size / 1024).toFixed(1) : Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 是不是今天。 */
export function isToday(iso: string, now = new Date()): boolean {
  return dayDiff(iso, now) === 0;
}

/** 相邻两条间隔是否该插时间分隔（> 5 分钟）。 */
export function needDivider(prev: string | undefined, cur: string): boolean {
  if (!prev) return false;
  return new Date(cur).getTime() - new Date(prev).getTime() > 5 * 60 * 1000;
}

export interface Schedule {
  kind: "daily" | "weekly" | "monthly" | "raw";
  hour: number;
  minute: number;
  weekday: number; // 0=周日
  day: number; // 每月几号
  raw: string;
}

export function parseCron(cron: string): Schedule {
  const raw: Schedule = { kind: "raw", hour: 9, minute: 0, weekday: 5, day: 1, raw: cron };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return raw;
  const [mi, ho, dom, mon, dow] = parts;
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(ho) || mon !== "*") return raw;
  const minute = Number(mi);
  const hour = Number(ho);
  if (minute > 59 || hour > 23) return raw;
  if (dom === "*" && dow === "*") return { ...raw, kind: "daily", hour, minute };
  if (dom === "*" && /^\d$/.test(dow)) return { ...raw, kind: "weekly", hour, minute, weekday: Number(dow) };
  if (/^\d{1,2}$/.test(dom) && dow === "*")
    return { ...raw, kind: "monthly", hour, minute, day: Number(dom) };
  return raw;
}

export function scheduleCron(s: Schedule): string {
  const mi = String(s.minute).padStart(2, "0");
  const ho = String(s.hour).padStart(2, "0");
  if (s.kind === "daily") return `${s.minute} ${s.hour} * * *`;
  if (s.kind === "weekly") return `${s.minute} ${s.hour} * * ${s.weekday}`;
  if (s.kind === "monthly") return `${s.minute} ${s.hour} ${s.day} * *`;
  return s.raw.trim() || `${mi} ${ho} * * *`;
}

/** 具体时间点（2026-11-08T09:00，可带秒）→「11月8日 09:00」，跨年的带年份；不是时间点就是 undefined。 */
export function timePointText(cron: string, now = new Date(), locale?: Locale): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(cron.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  if (locale === "en") {
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    const label = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(Number(year) === now.getFullYear() ? {} : { year: "numeric" }) }).format(date);
    return `${label} ${hour}:${minute}`;
  }
  return `${Number(year) === now.getFullYear() ? "" : `${Number(year)}年`}${Number(month)}月${Number(day)}日 ${hour}:${minute}`;
}

function ordinal(day: number): string {
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${suffix}`;
}

/** cron → localized schedule text. */
export function cronText(cron: string, locale?: Locale): string {
  const active = locale ?? currentLocale();
  const point = timePointText(cron, new Date(), active);
  if (point) return active === "en" ? t("{point}（一次）", { point }, active) : `${point}（一次）`;
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(cron.trim());
  if (every) return t("每 {n} 分钟", { n: Number(every[1]) }, active);
  const s = parseCron(cron);
  const time = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  if (s.kind === "daily") return t("每天 {time}", { time }, active);
  if (s.kind === "weekly") return t("每周{day} {time}", { day: active === "en" ? WEEK_EN[s.weekday] ?? "?" : WEEK[s.weekday] ?? "?", time }, active);
  if (s.kind === "monthly") return active === "en" ? `Monthly on the ${ordinal(s.day)} ${time}` : `每月${s.day}日 ${time}`;
  return cron;
}

export function cronListText(schedules: string[], locale?: Locale): string {
  const list = schedules.filter(Boolean);
  if (!list.length) return t("没有设置时间", {}, locale);
  return list.map((item) => cronText(item, locale)).join((locale ?? currentLocale()) === "en" ? ", " : "、");
}

export { WEEK };
