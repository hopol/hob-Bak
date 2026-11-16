import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AssistantSummary, Group } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({ groups: [] as Group[], assistants: [] as AssistantSummary[] }));

vi.mock("../store.ts", () => ({
  useApp: () => ({ assistants: state.assistants, groups: state.groups }),
  createGroup: async () => null,
  newAssistant: () => undefined,
}));
vi.mock("./use-menu.ts", () => ({ useMenu: () => ({ menu: null, box: null, toggle: () => undefined, close: () => undefined }) }));
// 对话框用 portal 挂到 body 上；服务端渲染没有 document，直接渲染在原位
vi.mock("react-dom", async (importOriginal) => ({ ...(await importOriginal<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));

import { createBody, draftError, MemberList, membersOfGroup, NewGroupDialog } from "./GroupCreate.tsx";

function assistant(id: string, name: string, duty: string, hidden = false): AssistantSummary {
  return { id, name, duty, sprite: "page", primary: false, pinned: false, hidden, notify: false, instructions: "", createdAt: "2026-11-08T01:00:00.000Z", unread: 0, busy: false };
}

const list: AssistantSummary[] = [
  assistant("hob", "Hob", "主助手"),
  assistant("write", "写作", "周报和文章"),
  assistant("po", "产品负责人", "需求和验收", true),
  assistant("dev", "开发", "写代码", true),
];
state.assistants = list;

const groups: Group[] = [
  { id: "g-1", name: "Hob 开发", purpose: "仓库的需求、开发、测试和发布", ownerId: "po", members: ["po", "dev"], createdAt: "2026-11-08T01:00:00.000Z" },
  { id: "g-2", name: "家里机器", purpose: "家里 NAS", ownerId: "hob", members: ["hob"], createdAt: "2026-11-09T01:00:00.000Z" },
];

const dialog = () => {
  // 对话框挂到 body 上：mock 掉的 createPortal 用不到它，只求 document.body 这步不求错
  vi.stubGlobal("document", { body: null });
  try {
    return renderToStaticMarkup(<NewGroupDialog onClose={() => undefined} />);
  } finally {
    vi.unstubAllGlobals();
  }
};
const members = (picked: string[], ownerId: string) => renderToStaticMarkup(<MemberList assistants={list} members={picked} ownerId={ownerId} onToggle={() => undefined} onOwner={() => undefined} />);

describe("建群", () => {
  it("收起的助手也列出来，排在没收起的后面，中间有小标题", () => {
    const html = members([], "");
    expect(html).toContain("收起的助手");
    for (const name of ["Hob", "写作", "产品负责人", "开发"]) expect(html).toContain(name);
    expect(html.indexOf("写作")).toBeLessThan(html.indexOf("收起的助手"));
    expect(html.indexOf("收起的助手")).toBeLessThan(html.indexOf("产品负责人"));
  });

  it("有群时最上面能照着已有的群建，没有群就不显示这一行", () => {
    state.groups = groups;
    try {
      const html = dialog();
      expect(html).toContain("照着已有的群建");
      expect(html).toContain("不照，自己选成员");
      expect(html).toContain('aria-haspopup="listbox"');
    } finally {
      state.groups = [];
    }
    expect(dialog()).not.toContain("照着已有的群建");
  });

  it("照着某个群建：成员和群主照它勾好", () => {
    const picked = membersOfGroup(groups[0]!);
    expect(picked).toEqual({ members: ["po", "dev"], ownerId: "po" });
    const html = members(picked.members, picked.ownerId);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).toContain(">群主<");
    // 群主标在勾好的成员那行：产品负责人后面的按钮是「群主」，开发的是「设为群主」
    expect(html.indexOf("产品负责人")).toBeLessThan(html.indexOf(">群主<"));
    expect(html.indexOf(">群主<")).toBeLessThan(html.indexOf("设为群主"));
    // 没选中的助手不显示群主按钮
    expect(html.indexOf("设为群主")).toBeGreaterThan(html.indexOf("开发"));
  });

  it("只选一个助手就能建群", () => {
    expect(draftError("周报", ["write"])).toBeNull();
    expect(draftError("周报", [])).toBe("至少选一个助手。");
    expect(draftError("  ", ["write"])).toBe("给群起个名字。");
  });

  it("建群带着名字、负责什么、成员和群主，没有工作方式", () => {
    expect(createBody(" Pix 开发 ", " 仓库的事 ", ["po", "dev"], "")).toEqual({
      name: "Pix 开发",
      purpose: "仓库的事",
      ownerId: "po",
      members: ["po", "dev"],
    });
  });

  it("对话框标题是新建群，没有工作方式，照着的下拉只列群不列话题", () => {
    state.groups = [...groups, { id: "t-1", name: "导出月度报表", purpose: "", ownerId: "po", members: ["po"], createdAt: "2026-11-10T01:00:00.000Z", parentId: "g-1" }];
    try {
      const html = dialog();
      expect(html).toContain("新建群");
      expect(html).not.toContain("工作方式");
      expect(html).not.toContain("软件开发");
      expect(html).not.toContain("gcreate-wf");
      // 话题过滤由浏览器交互测试检查展开后的选项。
    } finally {
      state.groups = [];
    }
  });
});
