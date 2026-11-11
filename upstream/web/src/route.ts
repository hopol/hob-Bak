// 地址里的 hash 和页面的对应：#/chat/<助手 id>[/<右栏的页>]、#/group/<群 id>[/<右栏的页>]、#/settings[/<分栏>]。首页没有 hash。
import type { PanelPage } from "./panel-stack.ts";

export const SETTINGS_SECTIONS = ["general", "rules", "providers", "models", "memory", "image", "knowledge", "search", "skills", "mcp", "desktop", "work", "usage", "push", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

type RouteState = { page: "main" | "settings" | "knowledge"; section: SettingsSection | null; sel: string | null; gsel?: string | null; mobile: "list" | "topics" | "chat"; panelStack?: PanelPage[] };

function decode(arg: string | undefined): string | null {
  try {
    return arg ? decodeURIComponent(arg) : null;
  } catch {
    return null; // 手改坏的 %xx：当成没写
  }
}

/** 右栏的页：#/chat/<助手>/skills、/job/<id>、/file/<路径> 这样接在助手后面。 */
function parsePanel(kind: string | undefined, arg: string | null): PanelPage | undefined {
  if (kind === "job" || kind === "routine") return arg ? { kind, id: arg } : undefined;
  if (kind === "file") return arg ? { kind, path: arg, full: false } : undefined;
  if (kind === "routines" || kind === "skills" || kind === "knowledge" || kind === "rules" || kind === "assistant" || kind === "jobs" || kind === "newRoutine") return { kind };
}

function panelHash(page: PanelPage): string {
  if (page.kind === "job" || page.kind === "routine") return `/${page.kind}/${encodeURIComponent(page.id)}`;
  if (page.kind === "file") return page.liveId || !page.path ? "" : `/file/${encodeURIComponent(page.path)}`;
  return `/${page.kind}`;
}

/** 地址里的 hash：刷新时据此回到原来那页。 */
export function parseRoute(hash: string): { sel: string | null; group?: string; settings: boolean; section: SettingsSection | null; knowledge?: boolean; panel?: PanelPage } {
  const [kind, arg, panel, panelArg] = hash.replace(/^#\/?/, "").split("/");
  const value = decode(arg);
  if (kind === "knowledge") return { sel: null, settings: false, section: null, knowledge: true };
  if (kind === "group" && value) return { sel: null, group: value, settings: false, section: null, panel: parsePanel(panel, decode(panelArg)) };
  if (kind === "chat" && value) return { sel: value, settings: false, section: null, panel: parsePanel(panel, decode(panelArg)) };
  if (kind === "settings") {
    const section = SETTINGS_SECTIONS.find((s) => s === value) ?? null;
    return { sel: null, settings: true, section };
  }
  return { sel: null, settings: false, section: null };
}

/** 当前页面对应的 hash；右栏开着的页接在会话后面；首页没有 hash。 */
export function routeHash(s: RouteState, narrow: boolean): string {
  if (s.page === "knowledge") return "#/knowledge";
  if (s.page === "settings") return s.section ? `#/settings/${s.section}` : "#/settings";
  const conv = s.gsel ?? s.sel;
  if (!conv || (narrow && s.mobile !== "chat")) return "";
  const top = s.panelStack?.at(-1);
  return `#/${s.gsel ? "group" : "chat"}/${encodeURIComponent(conv)}${top ? panelHash(top) : ""}`;
}
