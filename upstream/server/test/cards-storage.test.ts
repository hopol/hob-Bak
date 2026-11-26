import { describe, expect, it } from "vitest";
import type { CardRecord, HobEvent } from "../../shared/types.ts";
import { Store } from "../src/store.ts";
import { makeHob } from "./helpers.ts";

const card = (id = "c-storage", groupId?: string): CardRecord => ({
  id,
  owner: groupId ? { type: "plugin", pluginId: "demo", assistantId: "hob" } : { type: "assistant", assistantId: "hob" },
  ...(groupId ? { groupId } : {}),
  card: { body: { elements: [{ tag: "div", text: "卡片内容" }] } },
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("card storage and timeline push", () => {
  it("persists assistant and group card records and reloads them", () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "卡片群", purpose: "测试卡片", ownerId: "hob", members: ["hob"] });
      hob.runtime.store.saveCard(card());
      hob.runtime.store.saveCard(card("c-group", group.id));
      const reopened = new Store(hob.home);
      expect(reopened.card("c-storage")).toMatchObject({ id: "c-storage", owner: { type: "assistant" } });
      expect(reopened.card("c-group")).toMatchObject({ id: "c-group", groupId: group.id, owner: { type: "plugin" } });
    } finally { hob.close(); }
  });

  it("writes a card reference, returns the card with the page, and emits both timeline and card events", async () => {
    const hob = makeHob();
    const events: HobEvent[] = [];
    const stop = hob.runtime.bus.subscribe((event) => events.push(event));
    try {
      await hob.runtime.router.addCard("hob", card("c-push"));
      const page = hob.runtime.router.items("hob");
      expect(page.items).toEqual(expect.arrayContaining([{ kind: "card", cardId: "c-push", id: expect.any(String), at: expect.any(String) }]));
      expect(page.cards).toEqual([expect.objectContaining({ id: "c-push" })]);
      expect(events.some((event) => event.type === "item" && event.item.kind === "card")).toBe(true);
      expect(events.some((event) => event.type === "card" && event.card.id === "c-push")).toBe(true);
    } finally {
      stop();
      hob.close();
    }
  });
});
