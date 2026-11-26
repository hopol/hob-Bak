// 图标路径照 docs/design/v2/index.html 的 I。
import type { CSSProperties } from "react";

const I = {
  star: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  starFilled: '<path fill="currentColor" d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  hash: '<path d="M9.5 4 7.5 20M16.5 4l-2 16M4 9.5h16M3 15h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  home: '<path d="m3.5 11 8.5-7 8.5 7"/><path d="M6 9.5V19a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V9.5"/>',
  minus: '<path d="M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  gear: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  dbl: '<path d="m6 17 5-5-5-5M13 17l5-5-5-5"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  check: '<path d="M5 12.5 10 17l9-10"/>',
  spin: '<path d="M12 3a9 9 0 1 0 9 9" />',
  // 待办的状态：空圈是还没做，半实心圈是在做（静止的，不表示有人此刻正在做）
  ring: '<circle cx="12" cy="12" r="8.5"/>',
  half: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  out: '<path d="M7 17 17 7M8.5 7H17v8.5"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M3.5 14.5h17M10 9.5v10"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  plugin: '<path d="M8 3v5M16 3v5M5 8h14v3a7 7 0 0 1-14 0zM12 18v3"/>',
  archive: '<rect x="4" y="7" width="16" height="13" rx="2"/><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M10 12h4"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/>',
  mem: '<path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5L4.5 11 10 9z"/>',
  rule: '<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  arrowDown: '<path d="M12 5v14M5.5 12.5 12 19l6.5-6.5"/>',
  updown: '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6M10 22h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  send: '<path d="M12 20V5M5.5 11.5 12 5l6.5 6.5"/>',
  trash: '<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 10v7M14 10v7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeoff: '<path d="M17.94 17.94A10 10 0 0 1 12 19.5c-6.5 0-10.5-7.5-10.5-7.5a17.6 17.6 0 0 1 4.06-5.19M9.9 4.74A9.6 9.6 0 0 1 12 4.5c6.5 0 10.5 7.5 10.5 7.5a17.7 17.7 0 0 1-2.16 3.19"/><path d="m14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m3 3 18 18"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l3 3M14 9l2 2"/>',
  // 对不上的网址旁边的警示（效果图 253/5）
  alert: '<path d="M12 4 21 19.5H3Z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  // 卡片里「生成密码」按钮上的骰子（效果图 252/1）
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M9 9h.01M15 15h.01M15 9h.01M9 15h.01M12 12h.01"/>',
  mail: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="m4 6 8 6 8-6"/>',
  monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M12 16.5V20M8 20h8"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  textSelect: '<path d="M9 4h6M9 20h6M12 4v16"/><path d="M4 9v6M20 9v6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1.5"/>',
  split: '<path d="M4 5h4l8 14h4M4 19h4l8-14h4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.9h.01"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  term: '<path d="m5 16 5-4-5-4M12 17h7"/>',
  dl: '<path d="M12 4v11M7.5 11.5 12 16l4.5-4.5"/><path d="M5 20h14"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  pointer: '<path d="m5 3 6.5 17 2.3-7.2L21 10.5Z"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-4.5-4.5L7 19.5"/>',
  // 设置导航线性图标：通知、模型、技能、任务、消耗
  bell: '<path d="M18 9a6 6 0 0 0-12 0c0 5.5-2.5 7.5-2.5 7.5h17S18 14.5 18 9"/><path d="M10.2 19.5a2 2 0 0 0 3.6 0"/>',
  layers: '<path d="M12 3 20.5 7.5 12 12 3.5 7.5Z"/><path d="M3.5 12 12 16.5 20.5 12"/><path d="M3.5 16.5 12 21 20.5 16.5"/>',
  book: '<path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H8a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H4.5A1.5 1.5 0 0 1 3 15.5Z"/><path d="M21 5.5A1.5 1.5 0 0 0 19.5 4H16a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h4.5a1.5 1.5 0 0 0 1.5-1.5Z"/>',
  tasks: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  chart: '<path d="M6 19v-5.5M12 19V5M18 19v-9"/>',
  // GitHub 的猫头标记是实心的，单给这一条覆盖描边
  github: '<path fill="currentColor" stroke="none" d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.28-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.3 0 .32.21.7.82.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z"/>',
} as const;

export type IconName = keyof typeof I;

/** 同一套图标的字符串形式：给 innerHTML 拼出来的地方（markdown 代码块的复制按钮）用。 */
export function iconSvg(name: IconName, size = 16): string {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;
}

export function Icon({
  name,
  size = 16,
  w = 1.7,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  w?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={`i${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: I[name] }}
    />
  );
}
