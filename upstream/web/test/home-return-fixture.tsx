import { createRoot } from "react-dom/client";
import type { AssistantSummary, Job } from "../../shared/types.ts";
import { HomeSections } from "../src/components/HomeSections.tsx";
import { applyEvent, getState, start } from "../src/store.ts";
import "../src/styles.css";

const OLD = "2026-01-01T00:00:00.000Z";
const RECENT = "2026-01-01T00:01:00.000Z";
const QUIET = "2025-12-31T23:00:00.000Z";

type Scenario = "unread" | "replied" | "replying" | "visibility";
type Frame = { id: string; y: number }[];

function assistant(id: string, lastAt: string, unread = 0, busy = false): AssistantSummary {
  return {
    id,
    name: id,
    duty: "测试",
    sprite: "hob",
    primary: false,
    pinned: false,
    hidden: false,
    notify: true,
    createdAt: OLD,
    last: { text: "上一条消息", at: lastAt },
    unread,
    busy,
  };
}

function doneJob(): Job {
  return {
    id: "done-job",
    assistantId: "done",
    title: "已完成的工作",
    instruction: "完成一件工作",
    status: "done",
    createdAt: OLD,
    endedAt: RECENT,
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
  };
}

function seed(): void {
  const state = getState();
  Object.assign(state, {
    assistants: [assistant("done", OLD, 1), assistant("recent", RECENT), assistant("quiet", QUIET)],
    groups: [],
    jobs: { "done-job": doneJob() },
    approvals: {},
    delegations: {},
    routines: [],
    sel: null,
    gsel: null,
    page: "main",
    mobile: "list",
    query: "",
    homeFilter: "all",
    homeOrder: "recent",
  });
  // 通知 React：seed 过的数据已经是首页的第一份快照。
  applyEvent({ type: "assistant", assistant: assistant("quiet", QUIET) });
}

function update(id: string, patch: Partial<AssistantSummary>): void {
  const current = getState().assistants.find((item) => item.id === id);
  if (!current) throw new Error(`助手不存在：${id}`);
  applyEvent({ type: "assistant", assistant: { ...current, ...patch } });
}

function frame(): Frame {
  return [...document.querySelectorAll<HTMLElement>(".home-row[data-row]")].map((row) => ({
    id: row.dataset.row!,
    y: Math.round(row.getBoundingClientRect().top),
  }));
}

function visible(): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function run(scenario: Scenario): Promise<{ beforeReturn: Frame; frames: Frame[] }> {
  seed();
  if (scenario === "unread" || scenario === "visibility") {
    getState().sel = "done";
    getState().mobile = "chat";
    if (scenario === "unread") {
      update("done", { unread: 1 });
    } else {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      visible();
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  } else {
    update("done", { unread: 0 });
    getState().sel = "recent";
    getState().mobile = "chat";
    update("recent", { busy: true, last: { text: "正在回复", at: new Date().toISOString() } });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (scenario === "replied") {
      update("recent", { busy: false, last: { text: "已经回复", at: new Date().toISOString() } });
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  // 模拟点下返回：这次导航没有再改首页数据。
  getState().mobile = "list";
  update("quiet", { last: getState().assistants.find((item) => item.id === "quiet")!.last });
  const beforeReturn = frame();
  const frames: Frame[] = [];
  for (let i = 0; i < 21; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    frames.push(frame());
  }
  return { beforeReturn, frames };
}

await start();
seed();
(window as Window & { __homeReturn?: { run: (scenario: Scenario) => Promise<{ beforeReturn: Frame; frames: Frame[] }> } }).__homeReturn = { run };
createRoot(document.getElementById("root")!).render(<div className="mlist"><HomeSections size={36} /></div>);
