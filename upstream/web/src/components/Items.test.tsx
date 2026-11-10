import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Item, JobStatus, SedimentStatus } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({ sediment: undefined as SedimentStatus | undefined, status: "done" as JobStatus, statusReason: undefined as string | undefined }));

vi.mock("../store.ts", () => ({
  useApp: () => ({ assistants: [], approvals: {}, drafts: {}, delegations: {}, livePages: {}, sel: "hob", jobs: { "t-1": { id: "t-1", title: "测试任务", status: state.status, statusReason: state.statusReason, sediment: state.sediment, assistantId: "hob", createdAt: "2026-01-01T00:00:00Z", stats: { reads: 0, commands: 0, edits: 0 } } } }),
  photoUrl: (path: string) => path, fileUrl: (path: string) => path,
}));
vi.mock("./ImageGen.tsx", () => ({ ImageGenCard: ({ itemId }: { itemId: string }) => <div data-item-id={itemId}>生成的图片</div> }));
vi.mock("./Markdown.tsx", () => ({ Markdown: () => null }));

import { ItemList } from "./Items.tsx";

const card = () => renderToStaticMarkup(<ItemList items={[{ kind: "job", id: "item", at: "2026-01-01T00:00:00Z", jobId: "t-1" }]} />);

describe("对话卡片出处", () => {
  it.each([
    [{ status: "running" }, "沉淀技能中…"],
    [{ status: "saved", name: "x", title: "写报告", version: 1, updated: false }, "已沉淀技能「写报告」"],
    [{ status: "saved", name: "x", title: "写报告", version: 2, updated: true }, "已更新技能「写报告」· 第 2 版"],
    [{ status: "failed", reason: "失败" }, "沉淀失败"],
  ] as [SedimentStatus, string][])("显示沉淀状态 %s", (sediment, expected) => {
    state.sediment = sediment;
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try { expect(card()).toContain(expected); }
    finally { state.sediment = undefined; vi.unstubAllGlobals(); }
  });
  it("没沉淀出东西时卡片上不写", () => {
    state.sediment = { status: "empty", reason: "不需要" };
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try { expect(card()).not.toContain("没有要沉淀的"); }
    finally { state.sediment = undefined; vi.unstubAllGlobals(); }
  });
  it("状态原因放在标题下面的说明块里", () => {
    state.status = "stopped";
    state.statusReason = "你叫停了";
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try {
      const html = card();
      expect(html).toContain("已停止");
      expect(html).toContain("你叫停了");
      expect(html).toMatch(/class="stline"[\s\S]*已停止[\s\S]*class="jnote"[\s\S]*你叫停了/);
    }
    finally { state.status = "done"; state.statusReason = undefined; vi.unstubAllGlobals(); }
  });
  it("文件、图片、生图和任务条目带各自的 item id", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    const at = "2026-01-01T00:00:00Z";
    const items: Item[] = [
      { kind: "file", id: "file-1", at, name: "报告", path: "/报告.md" },
      { kind: "file", id: "photo-1", at, name: "图片", path: "/图片.png" },
      { kind: "file", id: "audio-1", at, name: "音频", path: "/音频.mp3" },
      { kind: "file", id: "video-1", at, name: "视频", path: "/视频.mp4" },
      { kind: "image", id: "image-1", at, prompt: "图片", startedAt: at, status: "done", path: "/生成.png" },
      { kind: "job", id: "job-item-1", at, jobId: "t-1" },
    ];
    const html = renderToStaticMarkup(<ItemList items={items} />);
    for (const item of items) expect(html).toContain(`data-item-id="${item.id}"`);
    vi.unstubAllGlobals();
  });

  it("文件条目没存 path 时不崩，仍然显示名字", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    const at = "2026-01-01T00:00:00Z";
    const legacy = { kind: "file", id: "file-no-path", at, name: "旧文件.pdf", meta: "12 KB" } as unknown as Item;
    const html = renderToStaticMarkup(<ItemList items={[legacy]} />);
    expect(html).toContain('data-item-id="file-no-path"');
    expect(html).toContain("旧文件.pdf");
    expect(html).toContain("12 KB");
    vi.unstubAllGlobals();
  });
});
