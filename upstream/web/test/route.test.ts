import { describe, expect, it } from "vitest";
import { parseRoute, routeHash } from "../src/route.ts";

describe("地址 hash", () => {
  it("当前页面写成 hash，读回来是同一页", () => {
    const chat = routeHash({ page: "main", section: null, sel: "ops 2", mobile: "chat" }, true);
    expect(chat).toBe("#/chat/ops%202");
    expect(parseRoute(chat)).toEqual({ sel: "ops 2", settings: false, section: null });
    const models = routeHash({ page: "settings", section: "models", sel: "hob", mobile: "list" }, false);
    expect(parseRoute(models)).toEqual({ sel: null, settings: true, section: "models" });
  });

  it("知识库地址可以恢复", () => {
    expect(routeHash({ page: "knowledge", section: null, sel: "hob", mobile: "list" }, true)).toBe("#/knowledge");
    expect(parseRoute("#/knowledge").knowledge).toBe(true);
  });

  it("手机首页列表没有 hash，桌面总带当前助手", () => {
    expect(routeHash({ page: "main", section: null, sel: "ops", mobile: "list" }, true)).toBe("");
    expect(routeHash({ page: "main", section: null, sel: "ops", mobile: "list" }, false)).toBe("#/chat/ops");
  });

  it("右栏开着的页接在助手后面，刷新回到这一页", () => {
    const route = (panelStack: Parameters<typeof routeHash>[0]["panelStack"]) => routeHash({ page: "main", section: null, sel: "hob", mobile: "chat", panelStack }, false);
    expect(route([{ kind: "skills" }])).toBe("#/chat/hob/skills");
    expect(parseRoute("#/chat/hob/skills").panel).toEqual({ kind: "skills" });
    const job = route([{ kind: "jobs" }, { kind: "job", id: "t-1", round: 2 }]);
    expect(job).toBe("#/chat/hob/job/t-1");
    expect(parseRoute(job)).toEqual({ sel: "hob", settings: false, section: null, panel: { kind: "job", id: "t-1" } });
    const file = route([{ kind: "file", path: "/a b/报告.md", full: true }]);
    expect(parseRoute(file).panel).toEqual({ kind: "file", path: "/a b/报告.md", full: false });
    expect(route([{ kind: "file", path: "", full: false, liveId: "c1" }])).toBe("#/chat/hob");
    for (const h of ["#/chat/hob/nope", "#/chat/hob/job", "#/chat/hob/file/%E0"]) expect(parseRoute(h)).toEqual({ sel: "hob", settings: false, section: null });
  });

  it("认不出的 hash 不改任何东西", () => {
    expect(parseRoute("#/settings/nope")).toEqual({ sel: null, settings: true, section: null });
    for (const h of ["", "#", "#/chat", "#/x/y", "#ops", "#/chat/%E0"]) expect(parseRoute(h)).toEqual({ sel: null, settings: false, section: null });
  });
});
