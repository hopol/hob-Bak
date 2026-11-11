import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Approval, ApprovalQuestion, Item, JobStatus, SedimentStatus } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({ sediment: undefined as SedimentStatus | undefined, status: "done" as JobStatus, statusReason: undefined as string | undefined, approvals: {} as Record<string, Approval> }));

vi.mock("../store.ts", () => ({
  useApp: () => ({ assistants: [], approvals: state.approvals, drafts: {}, delegations: {}, livePages: {}, sel: "hob", jobs: { "t-1": { id: "t-1", title: "测试任务", status: state.status, statusReason: state.statusReason, sediment: state.sediment, assistantId: "hob", createdAt: "2026-01-01T00:00:00Z", stats: { reads: 0, commands: 0, edits: 0 } } } }),
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
  it("没沉淀出东西时卡片上也写", () => {
    state.sediment = { status: "empty", reason: "不需要" };
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try { expect(card()).toContain("没有要沉淀的"); }
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

  it("一张卡问几个问题：待答的默认选推荐，答过的标出推荐的是哪个", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    const questions: ApprovalQuestion[] = [
      { title: "筛选放在哪？", why: "决定改哪个页面。", options: [{ key: "A", label: "导出对话框" }, { key: "B", label: "页面上" }], recommended: "A" },
      { title: "默认导出哪段？", options: [{ key: "A", label: "当前月" }, { key: "B", label: "最近三月" }], recommended: "A" },
    ];
    const ask = (patch: Partial<Approval>): Approval => ({
      id: "q-1", assistantId: "hob", title: "导出加筛选，几处定一下", options: [], questions,
      status: "pending", source: "router", createdAt: "2026-01-01T00:00:00Z", ...patch,
    });
    const html = (approval: Approval) => {
      state.approvals = { "q-1": approval };
      return renderToStaticMarkup(<ItemList items={[{ kind: "question", id: "qi", at: "2026-01-01T00:00:00Z", approvalId: "q-1" }]} />);
    };

    const pending = html(ask({}));
    expect(pending).toContain("筛选放在哪？");
    expect(pending).toContain("决定改哪个页面。");
    expect(pending).toContain("推荐");
    expect(pending).toContain("自己写");
    // 每题都能自己写，卡上不另设补充框
    expect(pending).not.toContain("补充说明（可选）");
    // 推荐的那项默认选中（第一题 A「导出对话框」），另一题也是 A
    expect(pending).toContain('class="opt chosen"');
    expect(pending.match(/class="opt chosen"/g)).toHaveLength(2);

    const answered = html(
      ask({ status: "answered", answers: [{ key: "B" }, { text: "按季度给" }], answerText: "先按这个做" }),
    );
    expect(answered).toContain("B");
    expect(answered).toContain("页面上");
    expect(answered).toContain("推荐的是 A：导出对话框");
    expect(answered).toContain("按季度给");
    expect(answered).toContain("补充：先按这个做");
    expect(answered).not.toContain("补充说明（可选）");

    const expired = html(ask({ status: "expired" }));
    expect(expired).toContain("已结束");
    expect(expired).not.toContain("补充说明（可选）");
    state.approvals = {};
  });

  it("群管理提示是按钮，旧提示和普通提示仍是文字", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try {
      const at = "2026-01-01T00:00:00Z";
      const linked: Item = { kind: "note", id: "n1", at, icon: "info", text: "已修改群", targetGroupId: "g-1" };
      const legacy: Item = { kind: "note", id: "n2", at, icon: "info", text: "旧提示" };
      const ordinary: Item = { kind: "note", id: "n3", at, icon: "rule", text: "已修改规则" };
      const html = renderToStaticMarkup(<ItemList items={[linked, legacy, ordinary]} />);
      expect(html).toMatch(/<button class="sys-group"[^>]*>[\s\S]*?已修改群<\/button>/);
      expect(html).not.toMatch(/<button[^>]*>[^<]*旧提示/);
      expect(html).not.toMatch(/<button[^>]*>[^<]*已修改规则/);
      expect(html).toContain("旧提示");
      expect(html).toContain("已修改规则");
    } finally { vi.unstubAllGlobals(); }
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
