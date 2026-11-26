import type { Theme } from "../../shared/types.ts";

/**
 * 手机布局：取窗口宽度和屏幕宽度里小的那个。iPhone 主屏应用冷启动时 innerWidth 偶尔还是 980 这类默认值，
 * 只看它会先按宽屏画一帧、把状态栏色写成 --side，而 iOS 只认启动那一刻的颜色（index.html 里同样这么判断）。
 */
export function isNarrow(): boolean {
  return Math.min(window.innerWidth || Infinity, window.screen?.width || Infinity) < 768;
}

export function resolveTheme(theme: Theme, systemDark: boolean) {
  const dark = theme === "dark" || (theme === "system" && systemDark);
  return { dark, color: dark ? "#1b1b1d" : "#f6f6f4" };
}

interface StatusPage {
  phase: "loading" | "login" | "ready" | "error";
  page: "main" | "settings" | "knowledge" | "plugins" | "stars";
  sheet: boolean;
  panelStack: Array<{ kind: string; full?: boolean }>;
}

export function statusSurface(page: StatusPage, narrow: boolean): "bg" | "side" | "panel" {
  // 手机上加载 / 登录页和首页同色：iOS 只认启动时的颜色，启动后再变它不跟，首页就会一直是加载时的颜色
  if (page.phase !== "ready") return narrow ? "bg" : "side";
  const top = page.panelStack.at(-1);
  if (top?.kind === "file" && (narrow || top.full)) return "bg";
  if (page.page === "plugins") return "bg";
  if (narrow) return top?.kind === "job" || top?.kind === "jobs" || page.page === "settings" || page.page === "knowledge" ? "bg" : top || page.sheet ? "panel" : "bg";
  return page.page === "settings" || page.page === "knowledge" ? "bg" : "side";
}

const LIGHT_MANIFEST = "/manifest.webmanifest?v=4";
const DARK_MANIFEST = "/manifest-dark.webmanifest?v=4";

/**
 * 装到主屏后，iOS 画启动屏和状态栏用的是 manifest 里的 background_color / theme_color。
 * manifest 只有一份、不跟系统主题走，所以按当前主题换一份深色的；index.html 里预判过一次，
 * 这里在主题真正确定下来后再对一次（服务端保存的主题可能和本地缓存不一致）。
 */
export function updateManifest(dark: boolean) {
  document.getElementById("manifest")?.setAttribute("href", dark ? DARK_MANIFEST : LIGHT_MANIFEST);
}

let statusKey = "";

export function updateStatusColor(page: StatusPage, narrow: boolean) {
  const root = document.documentElement;
  // 根元素上的变量一改，整页样式都要重算；没变就不写（回首页、开关右栏都会走到这里）
  const surface = statusSurface(page, narrow);
  const background = `var(--${surface})`;
  if (root.style.getPropertyValue("--status-background") !== background) root.style.setProperty("--status-background", background);
  // 读计算样式会逼浏览器当场重算整页样式；底色、深浅、配色都没变就不读
  const key = `${background}|${root.classList.contains("dark")}|${root.getAttribute("data-palette")}`;
  if (key === statusKey) return;
  statusKey = key;
  // 写成 #rrggbb，和 index.html、manifest 一致（iPhone 主屏应用其实不用它画状态栏，见 styles.css 手机深色那段）
  const computed = getComputedStyle(root);
  // 主题切换会暂时给背景加 CSS transition。读 backgroundColor 会拿到过渡中的旧色，
  // 让 meta theme-color 落后一套配色；直接读当前 surface 变量得到稳定的最终色。
  const color = toHex(computed.getPropertyValue(`--${surface}`).trim() || computed.backgroundColor);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta?.getAttribute("content") === color) return;
  meta?.setAttribute("content", color);
}

export function toHex(color: string): string {
  const parts = color.match(/\d+(\.\d+)?/g);
  if (!color.startsWith("rgb") || !parts || parts.length < 3) return color;
  return `#${parts.slice(0, 3).map((part) => Math.round(Number(part)).toString(16).padStart(2, "0")).join("")}`;
}
