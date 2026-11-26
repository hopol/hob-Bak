/**
 * 配色主题（palette）：在「跟随系统 / 浅色 / 深色」之下的另一层，只换颜色，不动布局、不改尺寸。
 *
 * 只存在这台设备的浏览器里（localStorage 的 hob.palette），不进 settings.json、不上传服务端：
 * 配色是「看的人自己的偏好」，同一台 Hob 在手机和平板上各挑各的，换浏览器也不互相覆盖。
 *
 * 具体色值写在 web/src/styles.css（html[data-palette="…"] 与 html.dark[data-palette="…"] 两块），
 * 这里只放 id 和设置页色卡要画的那颗色点；两边是否对得上由 web/test/palette.test.ts 比对。
 */

export const PALETTE_IDS = ["default", "ocean", "forest", "dusk", "rose"] as const;

export type Palette = (typeof PALETTE_IDS)[number];

export const DEFAULT_PALETTE: Palette = "default";

export const PALETTE_KEY = "hob.palette";

export interface PaletteSwatch {
  id: Palette;
  /** 色卡上的强调色：浅色一份、深色一份，和 styles.css 里那套的 --accent 一致。 */
  light: string;
  dark: string;
}

export const PALETTE_SWATCHES: PaletteSwatch[] = [
  { id: "default", light: "#ff6a2b", dark: "#ff6a2b" },
  { id: "ocean", light: "#2f7de1", dark: "#4a90e8" },
  { id: "forest", light: "#2f9e63", dark: "#3fbc7a" },
  { id: "dusk", light: "#7c5cf0", dark: "#9678ff" },
  { id: "rose", light: "#d94f68", dark: "#f2728c" },
];

export function isPalette(value: unknown): value is Palette {
  return typeof value === "string" && (PALETTE_IDS as readonly string[]).includes(value);
}

/** 没存过、或者存的值坏了，都按默认配色走。 */
export function paletteOf(value: unknown): Palette {
  return isPalette(value) ? value : DEFAULT_PALETTE;
}

/** 默认配色就是 styles.css 里原有的 :root / .dark，页面上不用挂 data-palette。 */
export function paletteAttr(id: Palette): string | null {
  return id === DEFAULT_PALETTE ? null : id;
}

/** localStorage 里读上次用的配色；读不出来（隐私模式、存坏了）就当没选过。 */
export function readStoredPalette(): Palette | null {
  try {
    const value = localStorage.getItem(PALETTE_KEY);
    return isPalette(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 配色挂在 <html data-palette="…"> 上；默认配色用的是样式表里原有的 :root / .dark，不挂属性。
 * 深浅由 .dark 类决定，两件事互不影响，所以换配色不用重新算深浅。
 */
export function applyPalette(id: Palette) {
  const root = typeof document === "undefined" ? null : document.documentElement;
  if (!root?.setAttribute) return; // 测试里、SSR 时没有真正的 <html>
  const attr = paletteAttr(id);
  if (attr) root.setAttribute("data-palette", attr);
  else root.removeAttribute("data-palette");
}

const SWITCH_CLASS = "theme-switching";
let switchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 换主题的那一下给全页开颜色过渡，220ms 后撤掉。平时不加这层，否则每次点按、滚动都会跟着渐变；
 * 系统开了「减少动态效果」就直接换，不做过渡。
 */
export function flashThemeSwitch(windowMs = 220) {
  const root = typeof document === "undefined" ? null : document.documentElement;
  if (!root?.classList?.add) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  root.classList.add(SWITCH_CLASS);
  clearTimeout(switchTimer);
  switchTimer = setTimeout(() => root.classList.remove(SWITCH_CLASS), windowMs);
}

export function storePalette(id: Palette) {
  try {
    localStorage.setItem(PALETTE_KEY, id);
  } catch {
    // 存不下就只在这个页面里生效，不影响使用
  }
}
