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

/** "11-08 09:41"：配置时区下的月日和时刻，不带年份（事项列表用）。 */
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

/** 时区名不合法就直接报错，不悄悄退回系统时区。 */
export function checkTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("sv-SE", { timeZone: timezone });
  } catch {
    throw new Error(`时区不合法：${timezone}（例：Europe/Berlin）`);
  }
  return timezone;
}
