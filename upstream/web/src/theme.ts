import type { Theme } from "../../shared/types.ts";

export function resolveTheme(theme: Theme, systemDark: boolean) {
  const dark = theme === "dark" || (theme === "system" && systemDark);
  return { dark, color: dark ? "#1b1b1d" : "#f6f6f4" };
}

interface StatusPage {
  phase: "loading" | "login" | "ready" | "error";
  page: "main" | "settings" | "knowledge";
  sheet: boolean;
  panelStack: Array<{ kind: string; full?: boolean }>;
}

export function statusSurface(page: StatusPage, narrow: boolean): "bg" | "side" | "panel" {
  // 手机上加载 / 登录页和首页同色：iOS 只认启动时的颜色，启动后再变它不跟，首页就会一直是加载时的颜色
  if (page.phase !== "ready") return narrow ? "bg" : "side";
  const top = page.panelStack.at(-1);
  if (top?.kind === "file" && (narrow || top.full)) return "bg";
  if (narrow) return top?.kind === "job" || top?.kind === "jobs" || page.page === "settings" || page.page === "knowledge" ? "bg" : top || page.sheet ? "panel" : "bg";
  return page.page === "settings" || page.page === "knowledge" ? "bg" : "side";
}

export function updateStatusColor(page: StatusPage, narrow: boolean) {
  const root = document.documentElement;
  root.style.setProperty("--status-background", `var(--${statusSurface(page, narrow)})`);
  const color = getComputedStyle(root).backgroundColor;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}
