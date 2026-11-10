import type { PageLive } from "../../shared/types.ts";

export function shouldOpenLive(page: PageLive, options: { seen: boolean; closed: boolean; assistantId: string | null; inChat: boolean }): boolean {
  return page.state === "writing" && !options.seen && !options.closed && options.inChat && page.assistantId === options.assistantId;
}

export function visibleLiveCards(pages: PageLive[], assistantId: string | null): PageLive[] {
  return pages.filter((page) => page.assistantId === assistantId && page.state === "writing");
}
