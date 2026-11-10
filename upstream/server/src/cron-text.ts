const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function time(hour: string, minute: string): string {
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function weekday(token: string): string | undefined {
  const map: Record<string, string> = { "0": "日", "7": "日", "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六" };
  return map[token];
}

/**
 * 具体时间点（2026-11-08T09:00，可带秒）转成「11月8日 09:00」，跨年的带年份；不是时间点就是 undefined。
 * 时间点本身就是设置时区里的钟点，不需要再做时区换算。
 */
export function timePointText(expression: string, now: Date = new Date()): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(expression.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  return `${Number(year) === now.getFullYear() ? "" : `${Number(year)}年`}${Number(month)}月${Number(day)}日 ${hour}:${minute}`;
}

/**
 * cron 转中文：覆盖常见的每天 / 每周 / 每月 / 每隔几分钟，认不出的原样返回。
 * 只处理 5 段表达式（分 时 日 月 周）；具体时间点只说那一刻，标上只跑一次。
 */
export function cronToChinese(expression: string): string {
  const point = timePointText(expression);
  if (point) return `${point}（一次）`;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, day, month, dow] = parts;
  const at = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? time(hour, minute) : undefined;

  if (minute.startsWith("*/") && hour === "*" && day === "*" && month === "*" && dow === "*") {
    return `每 ${minute.slice(2)} 分钟`;
  }
  if (minute === "0" && hour === "*" && day === "*" && month === "*" && dow === "*") return "每小时整点";
  if (!at) return expression;

  if (day === "L" && month === "*" && dow === "*") return `每月最后一天 ${at}`;
  if (/^\d+$/.test(day) && month === "*" && dow === "*") return `每月 ${day} 日 ${at}`;
  if (day === "*" && month === "*") {
    if (dow === "*") return `每天 ${at}`;
    if (/^\d+$/.test(dow)) {
      const name = weekday(dow);
      return name ? `每周${name} ${at}` : expression;
    }
    const range = dow.match(/^(\d)-(\d)$/);
    if (range) {
      const from = weekday(range[1]);
      const to = weekday(range[2]);
      if (from && to) return `每周${from}到${to} ${at}`;
    }
    const list = dow.split(",");
    if (list.length > 1 && list.every((item) => /^\d$/.test(item))) {
      const names = list.map((item) => WEEKDAYS[Number(item) % 7]);
      return `每周${names.join("、")} ${at}`;
    }
  }
  return expression;
}
