import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ChangeEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeEntry } from "../../../shared/knowledge.ts";

vi.mock("../store.ts", () => ({ patchKnowledgeEntry: vi.fn(), fileUrl: (path: string) => path }));
import { patchKnowledgeEntry } from "../store.ts";
import { CollectionChoices, EntryMenuActions, collectionDeleteText } from "./Knowledge.tsx";

const entry: KnowledgeEntry = { id: "k-1", origin: "output", name: "报告", kind: "text", path: "/report.txt", hash: "hash", size: 10, createdAt: "2026-01-01", updatedAt: "2026-01-01", collections: ["a"] };
const collections = [{ id: "a", name: "甲", count: 1, createdAt: "2026-01-01" }, { id: "b", name: "乙", count: 0, createdAt: "2026-01-01" }];

describe("知识库管理", () => {
  it("勾选或取消所属知识库时提交完整列表", () => {
    const choices = CollectionChoices({ entry, collections });
    const labels = choices.props.children as ReactElement<{ children: [ReactElement<{ onChange: (event: ChangeEvent<HTMLInputElement>) => void }>, string] }>[];
    labels[1].props.children[0].props.onChange({ target: { checked: true } } as ChangeEvent<HTMLInputElement>);
    expect(patchKnowledgeEntry).toHaveBeenLastCalledWith("k-1", { collections: ["a", "b"] });
    labels[0].props.children[0].props.onChange({ target: { checked: false } } as ChangeEvent<HTMLInputElement>);
    expect(patchKnowledgeEntry).toHaveBeenLastCalledWith("k-1", { collections: [] });
  });
  it("仅在知识库分类中提供移出", () => {
    const props = { entry, collections, join: vi.fn(), rename: vi.fn(), remove: vi.fn(), confirm: vi.fn() };
    expect(renderToStaticMarkup(<EntryMenuActions {...props} category="a" />)).toContain("移出这个知识库");
    expect(renderToStaticMarkup(<EntryMenuActions {...props} category="all" />)).not.toContain("移出这个知识库");
  });
  it("删库确认说明会一起删除的文件", () => {
    expect(collectionDeleteText("甲")).toBe("删除知识库「甲」？直接上传到这里、又不在别的知识库里的文件会一起删除，其余文件只是移出。");
  });
});
