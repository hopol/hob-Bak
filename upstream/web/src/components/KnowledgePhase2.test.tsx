import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, realApi } from "../api.ts";
import { createMock } from "../mock.ts";
import { renderMarkdown } from "../markdown.ts";

vi.mock("../store.ts", () => ({ patchAssistant: vi.fn().mockResolvedValue(null), reindexKnowledge: vi.fn().mockResolvedValue({ ok: true }), loadKnowledge: vi.fn().mockResolvedValue(undefined), setNotice: vi.fn(), getKnowledgeEntry: vi.fn(), openFilePreview: vi.fn(), openSettings: vi.fn(), setSection: vi.fn() }));
import { getKnowledgeEntry, openFilePreview, patchAssistant, reindexKnowledge, setNotice } from "../store.ts";
import { openKnowledgeCitation } from "./Markdown.tsx";
import { AssistantChoices, CollectionStatus, IndexRetry } from "./Knowledge.tsx";

describe("知识库二期", () => {
  it("保存向量设置时提交密钥", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ keyConfigured: true }) });
    vi.stubGlobal("fetch", fetch);
    await realApi.putEmbedding(3, { source: "openai", baseUrl: "https://example.com/v1", model: "vector" }, "secret");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ revision: 3, embedding: { source: "openai", baseUrl: "https://example.com/v1", model: "vector" }, apiKey: "secret" });
    vi.unstubAllGlobals();
  });
  it("未绑定显示引导，索引计数来自库", () => {
    const html = renderToStaticMarkup(<CollectionStatus collection={{ id: "kc-1", name: "资料", createdAt: "", count: 5, indexed: 3, failed: 1 }} collections={[]} assistants={[]} embedding={false} />);
    expect(html).toContain("还没有助手用这个库");
    expect(html).toContain("选择助手");
    expect(html).toContain("已建索引 3/5");
    expect(html).toContain("1 个失败");
    expect(html).toContain("重试");
    expect(html).toContain("只按关键词查");
  });
  it("索引计数不包含不支持的文件，零失败不显示失败和重试", () => {
    const html = renderToStaticMarkup(<CollectionStatus collection={{ id: "kc-1", name: "资料", createdAt: "", count: 4, indexed: 3, failed: 0, unsupported: 1 }} collections={[]} assistants={[]} embedding={true} />);
    expect(html).toContain("已建索引 3/3");
    expect(html).not.toContain("失败");
    expect(html).not.toContain("重试");
  });
  it("勾选助手提交完整绑定，重试调用重建接口", async () => {
    const assistants = (await createMock().bootstrap()).assistants.filter((a) => a.id === "hob");
    const choices = AssistantChoices({ collectionId: "kc-2", collections: [{ id: "kc-1", name: "甲", count: 0, createdAt: "" }, { id: "kc-2", name: "乙", count: 0, createdAt: "" }], assistants, busy: false, setBusy: vi.fn() });
    const labels = choices.props.children as ReactElement<{ children: [ReactElement<{ onChange: () => void }>, string] }>[];
    labels[0]!.props.children[0].props.onChange();
    expect(patchAssistant).toHaveBeenCalledWith("hob", { knowledge: ["kc-1", "kc-2"] });
    IndexRetry({ id: "kc-2", busy: false, setBusy: vi.fn() }).props.onClick();
    expect(reindexKnowledge).toHaveBeenCalledWith("kc-2");
  });
  it("给助手绑定时丢弃已经删除的库", async () => {
    const hob = (await createMock().bootstrap()).assistants.find((a) => a.id === "hob")!;
    hob.knowledge = ["kc-deleted"];
    const choices = AssistantChoices({ collectionId: "kc-2", collections: [{ id: "kc-2", name: "乙", count: 0, createdAt: "" }], assistants: [hob], busy: false, setBusy: vi.fn() });
    const labels = choices.props.children as ReactElement<{ children: [ReactElement<{ onChange: () => void }>, string] }>[];
    labels[0]!.props.children[0].props.onChange();
    expect(patchAssistant).toHaveBeenLastCalledWith("hob", { knowledge: ["kc-2"] });
  });
  it("出处使用内联标签而非新窗口", () => {
    const html = renderMarkdown("[工作记录.md](#k/k-2/0)");
    expect(html).toContain('class="knowledge-citation"');
    expect(html).toContain('href="#k/k-2/0"');
    expect(html).toContain("<svg");
    expect(html).not.toContain('target="_blank"');
    expect(renderMarkdown("不用感叹号。（[规范.md](#k/k-3/1)）")).toMatch(/不用感叹号。<a class="knowledge-citation"[^>]*>[\s\S]*规范\.md<\/a><\/p>/);
  });
  it("出处条目不存在时显示删除提示，不打开预览", async () => {
    vi.mocked(getKnowledgeEntry).mockRejectedValueOnce(new ApiError(404, "不存在"));
    await openKnowledgeCitation("k-deleted", 0);
    expect(getKnowledgeEntry).toHaveBeenCalledWith("k-deleted", 0);
    expect(setNotice).toHaveBeenCalledWith("这份资料已经删除");
    expect(openFilePreview).not.toHaveBeenCalled();
  });
  it("演示后端支持绑定、失败重试和段落读取", async () => {
    const api = createMock();
    await api.patchAssistant("hob", { knowledge: ["kc-2"] });
    expect((await api.bootstrap()).assistants.find((a) => a.id === "hob")?.knowledge).toEqual(["kc-2"]);
    const before = (await api.knowledge()).collections.find((c) => c.id === "kc-1")!;
    expect(before.failed).toBeGreaterThan(0);
    await api.reindexKnowledge("kc-1");
    expect((await api.knowledge()).collections.find((c) => c.id === "kc-1")?.failed).toBe(0);
    expect((await api.knowledgeEntry("k-2", 0)).chunk?.text).toContain("项目资料");
  });
});
