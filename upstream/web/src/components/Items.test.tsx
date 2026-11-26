import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Approval, ApprovalQuestion, Draft, Item, JobStatus, SedimentStatus } from "../../../shared/types.ts";
import { ROUTINE_DUE_TEXT_LEGACY } from "../../../shared/routine-note.ts";

const state = vi.hoisted(() => ({ sediment: undefined as SedimentStatus | undefined, status: "done" as JobStatus, statusReason: undefined as string | undefined, approvals: {} as Record<string, Approval>, drafts: {} as Record<string, Draft> }));

vi.mock("../store.ts", () => ({
  useApp: () => ({ assistants: [], approvals: state.approvals, drafts: state.drafts, delegations: {}, livePages: {}, sel: "hob", jobs: { "t-1": { id: "t-1", title: "测试任务", status: state.status, statusReason: state.statusReason, sediment: state.sediment, assistantId: "hob", createdAt: "2026-01-01T00:00:00Z", stats: { reads: 0, commands: 0, edits: 0 } } } }),
  photoUrl: (path: string) => path, fileUrl: (path: string) => path,
}));
vi.mock("./ImageGen.tsx", () => ({ ImageGenCard: ({ itemId }: { itemId: string }) => <div data-item-id={itemId}>生成的图片</div> }));
vi.mock("./Markdown.tsx", () => ({ Markdown: () => null }));

import { ItemList, visibleItems } from "./Items.tsx";

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

  it("一张卡问几个问题：用卡片组件渲染，待答的默认选推荐，答过和过期按卡片状态锁住", () => {
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
    expect(pending).toContain("b q hc");
    expect(pending).toContain("筛选放在哪？");
    expect(pending).toContain("决定改哪个页面。");
    expect(pending).toContain("自己写");
    // 每题都能自己写，卡上不另设补充框
    expect(pending).not.toContain("补充说明（可选）");
    // 推荐的那项默认选中（两题默认均选中 A）
    expect(pending.match(/class="hc-option active"/g)).toHaveLength(2);

    const answered = html(
      ask({ status: "answered", answers: [{ key: "B" }, { text: "按季度给" }], answerText: "先按这个做" }),
    );
    expect(answered).toContain("hc-disabled");
    expect(answered).toContain("hc-result-list");
    expect(answered).toContain("页面上");
    expect(answered).toContain("按季度给");
    expect(answered).toContain("先按这个做");
    expect(answered).not.toContain("补充说明（可选）");

    const expired = html(ask({ status: "expired" }));
    expect(expired).toContain("hc-disabled");
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

  it("定时任务到执行时间那一行：新记录按 routineId 认，老记录按文字认，检查到的内容不显示", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try {
      const at = "2026-01-01T00:00:00Z";
      const fresh: Item = { kind: "note", id: "r1", at, icon: "routine", text: "定时任务「每日检查」已到执行时间", routineId: "r-1" };
      const legacy: Item = { kind: "note", id: "r2", at, icon: "routine", text: `定时任务「每日检查」${ROUTINE_DUE_TEXT_LEGACY}，检查到：\n问题一：登录异常` };
      const html = renderToStaticMarkup(<ItemList items={[fresh, legacy]} />);
      expect(html.match(/routine-note/g)).toHaveLength(2);
      expect(html).toContain("定时任务「每日检查」已到执行时间");
      expect(html).toContain(`定时任务「每日检查」${ROUTINE_DUE_TEXT_LEGACY}`);
      expect(html).not.toContain("问题一：登录异常");
      const other = renderToStaticMarkup(<ItemList items={[{ kind: "note", id: "r3", at, icon: "routine", text: "定时任务已停止" }]} />);
      expect(other).not.toContain("routine-note");
    } finally { vi.unstubAllGlobals(); }
  });

  it("没办成的提示点开才看原因：一行文字，原因是工具报错的原文", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try {
      const at = "2026-01-01T00:00:00Z";
      const failed: Item = { kind: "note", id: "n4", at, icon: "info", text: "「创建任务」执行失败", detail: "备注 401 字，最多 400 字。" };
      const html = renderToStaticMarkup(<ItemList items={[failed]} />);
      expect(html).toContain('<div class="why">备注 401 字，最多 400 字。</div>');
      expect(html).not.toContain('<details>');
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

  it("草稿卡仅在绑定了工作目录时只读展示，未绑定不渲染", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    const at = "2026-01-01T00:00:00Z";
    const base: Draft = {
      id: "d-1",
      assistantId: "hob",
      status: "pending",
      name: "前端助手",
      sprite: "page",
      duty: "负责前端开发",
      dutyLong: "负责前端开发与单测",
      routines: [],
      routinesText: "",
      askFirst: [],
      createdAt: at,
    };
    try {
      state.drafts = { "d-1": { ...base, cwd: "/workspace/hob-web" } };
      const bound = renderToStaticMarkup(<ItemList items={[{ kind: "draft", id: "di-1", at, draftId: "d-1" }]} />);
      expect(bound).toContain("工作目录");
      expect(bound).toContain("/workspace/hob-web");
      expect(bound).not.toContain("<input");

      state.drafts = { "d-1": base };
      const unbound = renderToStaticMarkup(<ItemList items={[{ kind: "draft", id: "di-2", at, draftId: "d-1" }]} />);
      expect(unbound).not.toContain("工作目录");
    } finally {
      state.drafts = {};
      vi.unstubAllGlobals();
    }
  });
});

describe("对话里只放用户要看的", () => {
  const at = "2026-01-01T00:00:00Z";
  it("记忆写入、技能沉淀和改版的老记录滤掉；删技能这类回执和其他提示行留着", () => {
    const items: Item[] = [
      { kind: "note", id: "m", at, icon: "memory", text: "记忆已更新 · 不看体育新闻" },
      { kind: "note", id: "s", at, icon: "skill", text: "已沉淀技能「周报」", path: "/x/SKILL.md" },
      { kind: "note", id: "d", at, icon: "skill", text: "已删除技能「旧周报」" },
      { kind: "note", id: "r", at, icon: "rule", text: "已记入规则 · 发邮件前先问" },
    ];
    expect(visibleItems(items).map((item) => item.id)).toEqual(["d", "r"]);
  });

  it("同一个任务续做几轮只留最新那一轮的卡，别的任务不受影响", () => {
    const items: Item[] = [
      { kind: "job", id: "a0", at, jobId: "t-a" },
      { kind: "job", id: "b0", at, jobId: "t-b" },
      { kind: "user", id: "u", at, text: "再改一下" },
      { kind: "job", id: "a1", at, jobId: "t-a", round: 1 },
      { kind: "job", id: "a2", at, jobId: "t-a", round: 2 },
    ];
    expect(visibleItems(items).map((item) => item.id)).toEqual(["b0", "u", "a2"]);
  });
});
