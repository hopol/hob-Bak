// 时区相关的文字：提示词里的“现在时间”按 config.timezone 算，不看服务器系统时区。

/** "2026-11-01 09:10 周日" */
export function nowText(timezone: string, at: Date = new Date()): string {
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, weekday: "short" }).format(at);
  return `${stamp} ${weekday}`;
}

/** "11月1日"：配置时区下的月日，不看服务器系统时区。 */
export function monthDayText(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "long", day: "numeric" }).format(at);
}

/** "11月1日 09:43"：配置时区下的月日和时刻（报告里的结束时间用），不看服务器系统时区。 */
export function monthDayTimeText(timezone: string, at: Date = new Date()): string {
  const clock = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  return `${monthDayText(timezone, at)} ${clock}`;
}

/** "11-08 09:41"：配置时区下的月日和时刻（待办列表用）。 */
export function monthDayClockText(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

/**
 * 多久以前：「刚刚」「3 分钟前」「5 小时前」「昨天」「3 天前」。给模型看的相对时间。
 * 天数按配置时区的日历日算，上海 0 点前后才算跨天。
 */
export function agoText(timezone: string, at: Date, now: Date = new Date()): string {
  if (Number.isNaN(at.getTime())) return "刚刚";
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const day = (value: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, dateStyle: "short" }).format(value);
  const days = Math.max(0, Math.round((Date.parse(`${day(now)}T00:00:00Z`) - Date.parse(`${day(at)}T00:00:00Z`)) / 86_400_000));
  if (days === 0) return `${Math.floor(minutes / 60)} 小时前`;
  if (days === 1) return "昨天";
  return `${days} 天前`;
}

/** 时区名不合法就直接报错，不悄悄退回系统时区。 */
export function checkTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("sv-SE", { timeZone: timezone });
  } catch {
    throw new Error(`时区不合法：${timezone}（例：Europe/Berlin）`);
  }
  return timezone;
}
