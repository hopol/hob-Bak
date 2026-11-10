export interface FilePreviewState {
  path: string;
  full: boolean;
  title?: string;
  liveId?: string;
  find?: string;
  page?: number;
}

export type PanelPage =
  | { kind: "routine"; id: string }
  | { kind: "newRoutine" }
  | { kind: "assistant" }
  | { kind: "routines" | "skills" | "knowledge" | "rules" }
  | { kind: "jobs" }
  | { kind: "job"; id: string; round?: number }
  | ({ kind: "file" } & FilePreviewState);

function samePage(a: PanelPage, b: PanelPage): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "routine" && b.kind === "routine") return a.id === b.id;
  if (a.kind === "job" && b.kind === "job") return a.id === b.id;
  if (a.kind === "file" && b.kind === "file") return a.liveId || b.liveId ? a.liveId === b.liveId : a.path === b.path;
  return true;
}

/** 打开已在栈里的页面时，退回该层并更新参数。 */
export function pushPage(stack: PanelPage[], page: PanelPage): PanelPage[] {
  const index = stack.findIndex((entry) => samePage(entry, page));
  return [...(index < 0 ? stack : stack.slice(0, index)), page];
}

export function selectPanelStack(stack: PanelPage[], previous: string | null, next: string, keep: boolean): PanelPage[] {
  return previous !== next && !keep ? [] : stack;
}

export function popPage(stack: PanelPage[]): PanelPage[] {
  return stack.slice(0, -1);
}

export function replacePage(stack: PanelPage[], page: PanelPage): PanelPage[] {
  return pushPage(popPage(stack), page);
}

export function pageKey(page: PanelPage): string {
  return `${page.kind}:${"id" in page ? page.id : "path" in page ? page.liveId ?? page.path : ""}`;
}

export type GonePage = { page: PanelPage; index: number; leaving: boolean };

/** 栈从 previous 变成 next 时退掉的页和它原来在第几层。退回去（栈变短）才滑出去；换掉栈顶时旧页垫在新页下面，等新页盖上再卸。 */
export function gonePages(previous: PanelPage[], next: PanelPage[]): GonePage[] {
  const keys = new Set(next.map(pageKey));
  const leaving = next.length < previous.length;
  return previous.flatMap((page, index) => (keys.has(pageKey(page)) ? [] : [{ page, index, leaving }]));
}

/** 栈里的页加上还没退完的页，按原来的层次排：后面的盖在前面的上面。 */
export function layerList(stack: PanelPage[], gone: GonePage[]): { page: PanelPage; leaving: boolean }[] {
  const list = stack.map((page) => ({ page, leaving: false }));
  for (const g of gone) list.splice(Math.min(g.index, list.length), 0, { page: g.page, leaving: g.leaving });
  return list;
}

export function removeMissingLivePages(stack: PanelPage[], livePages: Record<string, unknown>): PanelPage[] {
  return stack.filter((page) => page.kind !== "file" || !page.liveId || Boolean(livePages[page.liveId]));
}
