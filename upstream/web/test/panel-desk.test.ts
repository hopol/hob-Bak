import { describe, expect, it } from "vitest";
import { panelDesk } from "../src/panel-stack.ts";

const groups = [{ id: "g", ownerId: "po", members: ["dev", "po", "qa"] }, { id: "t", parentId: "g", ownerId: "po", members: ["dev", "po", "qa"] }];
const profiles = { po: "s-po", dev: "s-dev", qa: "s-qa", solo: "s-solo" };
const screens = (...running: string[]) => ["s-po", "s-dev", "s-qa", "s-solo"].map((id) => ({ id, running: running.includes(id) }));

describe("panelDesk：右栏的云桌面看谁", () => {
  it("单聊看这个助手自己的屏幕", () => {
    expect(panelDesk([], "solo", null, groups, { screens: screens("s-dev"), profiles })).toEqual({ aid: "solo", screenId: "s-solo", running: false, watch: ["s-solo"] });
  });
  it("群信息页看屏幕在跑的成员，群主排前；话题看所属群的成员", () => {
    expect(panelDesk([], null, "g", groups, { screens: screens("s-qa"), profiles })).toMatchObject({ aid: "qa", running: true, watch: ["s-po", "s-dev", "s-qa"] });
    expect(panelDesk([], null, "t", groups, { screens: screens("s-qa", "s-po"), profiles })).toMatchObject({ aid: "po", running: true });
    expect(panelDesk([], null, "g", groups, { screens: screens(), profiles })).toMatchObject({ aid: "po", running: false });
  });
  it("群里推进了成员页：看那个成员", () => {
    expect(panelDesk([{ kind: "member", id: "dev" }], null, "g", groups, { screens: screens("s-qa"), profiles })).toMatchObject({ aid: "dev", running: false });
  });
});
