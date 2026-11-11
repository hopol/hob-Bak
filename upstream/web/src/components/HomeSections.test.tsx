import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantSummary, JobStatus } from "../../../shared/types.ts";

const state = vi.hoisted(() => ({
  query: "",
  menu: null,
  assistants: [] as AssistantSummary[],
  jobs: {} as Record<string, { assistantId: string; status: JobStatus; endedAt?: string }>,
  approvals: {} as Record<string, { assistantId: string; status: string }>,
  delegations: {} as Record<string, { from: string; to: string; status: string; endedAt?: string }>,
}));
vi.mock("../store.ts", () => ({ useApp: () => state }));
vi.mock("./AssistantMenu.tsx", () => ({ useAssistantMenu: () => ({ handlers: {}, takeHeld: () => false }) }));
vi.mock("./Panel.tsx", () => ({ activityParts: () => [] }));

import { AssistantRow, Pin } from "./HomeSections.tsx";

const assistant = { id: "a", name: "助手", duty: "测试", sprite: "hob", unread: 1, busy: false } as AssistantSummary;
const render = (a = assistant) => [renderToStaticMarkup(<Pin a={a} />), renderToStaticMarkup(<AssistantRow a={a} />)];

describe("首页头像状态", () => {
  beforeEach(() => {
    state.assistants = [assistant];
    state.jobs = { done: { assistantId: "a", status: "done", endedAt: "2026-01-02" } };
    state.approvals = {};
    state.delegations = {};
  });

  it("最近结束的任务完成且有未读时显示 SVG 对勾", () => {
    for (const html of render()) expect(html).toMatch(/class="av-mark present done" aria-label="已完成，未读"[^>]*><span[^>]*><svg[^>]*><path/);
  });

  it("上次看过之前就结束的任务不挂标记，也没有数字角标", () => {
    state.jobs = { old: { assistantId: "a", status: "stuck", endedAt: "2026-01-02T01:00:00Z" } };
    const [pin] = render({ ...assistant, readAt: "2026-01-02T02:00:00Z" });
    expect(pin).not.toContain("av-mark present");
    expect(pin).not.toContain('class="badge"');
  });

  it("未读清零后不显示完成状态", () => {
    for (const html of render({ ...assistant, unread: 0 })) expect(html).not.toContain("av-mark present done");
  });

  it("忙碌时优先显示 busy", () => {
    const busy = { ...assistant, busy: true };
    state.assistants = [busy];
    const [pin, row] = render(busy);
    for (const html of [pin, row]) {
      expect(html).toContain('class="av-mark present busy"');
      expect(html).not.toContain('class="av-mark present done"');
    }
    expect(pin).not.toContain('class="badge"');
  });

  it("忙碌标记是三个独立的点，供依次跳动的动画使用", () => {
    const busy = { ...assistant, busy: true };
    state.assistants = [busy];
    for (const html of render(busy)) {
      const icon = html.slice(html.indexOf('class="av-mark present busy"'));
      expect(icon.match(/class="av-dot"/g)).toHaveLength(3);
    }
  });

  it("以最近结束任务为准，受阻优先于忙碌", () => {
    state.jobs.failed = { assistantId: "a", status: "failed", endedAt: "2026-01-03" };
    const busy = { ...assistant, busy: true };
    state.assistants = [busy];
    for (const html of render(busy)) expect(html).toContain('class="av-mark present stuck"');
  });

  it("任务提了问在等助手回，不算等你确认，算在办", () => {
    state.jobs.asking = { assistantId: "a", status: "waiting" };
    for (const html of render(assistant)) {
      expect(html).not.toContain('class="av-mark present ask"');
      expect(html).toContain('class="av-mark present busy"');
    }
  });

  it("转交出去的活还在对方那儿跑时，自己的头像不转圈", () => {
    state.jobs = {};
    state.delegations = { dg: { from: "a", to: "b", status: "running" } };
    for (const html of render()) {
      expect(html).not.toContain('class="av-mark present busy"');
      expect(html).not.toContain('class="av-mark present done"');
    }
  });

  it("自己转交的活干完且有未读时显示对勾", () => {
    state.jobs = {};
    state.delegations = { dg: { from: "a", to: "b", status: "done", endedAt: "2026-01-05" } };
    for (const html of render()) expect(html).toContain('class="av-mark present done"');
  });

  it("转交被退回或中断时显示受阻", () => {
    state.jobs = {};
    state.delegations = { dg: { from: "a", to: "b", status: "returned", endedAt: "2026-01-05" } };
    for (const html of render()) expect(html).toContain('class="av-mark present stuck"');
  });

  it("待确认优先于受阻和忙碌", () => {
    state.jobs.failed = { assistantId: "a", status: "stuck", endedAt: "2026-01-03" };
    state.approvals.ask = { assistantId: "a", status: "pending" };
    const busy = { ...assistant, busy: true };
    state.assistants = [busy];
    for (const html of render(busy)) expect(html).toContain('class="av-mark present ask"');
  });
});
