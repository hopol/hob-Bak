import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { realApi } from "../src/api.ts";

const calls = { answer: 0, reply: 0, project: 0, mcp: 0 };
window.cleanupCalls = calls;
realApi.answerApproval = async () => { calls.answer++; if (calls.answer === 1) throw new Error("测试失败"); };
realApi.replyJob = async () => { calls.reply++; throw new Error("测试失败"); };
realApi.sendGroupMessage = async () => { calls.project++; throw new Error("测试失败"); };
realApi.patchMcp = async (_name, patch) => { calls.mcp++; if (calls.mcp === 1) throw new Error("测试失败"); return { servers: [{ ...server, hiddenTools: calls.mcp === 2 ? [] : patch.hiddenTools }] }; };
realApi.patchAssistant = async (id, patch) => {
  const saved = JSON.parse(localStorage.getItem("fixture.assistants") ?? "{}");
  saved[id] = patch.pinOrder;
  localStorage.setItem("fixture.assistants", JSON.stringify(saved));
  return {};
};
const store = await import("../src/store.ts");
const { SingleQuestionCard, JobCard } = await import("../src/components/Items.tsx");
const { NoteBox } = await import("../src/components/Projects.tsx");
const { McpDetail } = await import("../src/components/Settings.tsx");
const { conversations, pinList } = await import("../src/home.ts");
const approval = { id: "approval", assistantId: "hob", title: "是否继续？", options: [{ key: "A", label: "继续" }, { key: "B", label: "暂停" }], status: "pending", source: "router", createdAt: "2026-01-01" };
store.getState().approvals = { approval };
const job = { id: "t-1", assistantId: "hob", title: "测试任务", instruction: "", status: "running", createdAt: "2026-01-01", stats: { reads: 0, edits: 0, commands: 0 }, activity: [] };
const project = { id: "p-1", title: "测试事项", groupId: "g-1", itemId: "item-1" };
const server = { name: "工具服务", valid: true, kind: "http", url: "http://localhost", enabled: true, exposure: "direct", hiddenTools: [] };
function Question() { const state = store.useApp(); return <SingleQuestionCard approval={state.approvals.approval} fresh={false} />; }
function Mcp() { const [view, setView] = useState({ servers: [server] }); return <McpDetail server={view.servers[0]} setView={setView} probe={{ state: "connected", tools: [{ name: "tool", description: "工具" }] }} onProbe={async () => {}} onDone={() => {}} />; }
const which = new URLSearchParams(location.search).get("fixture");
if (which === "pins") {
  const saved = JSON.parse(localStorage.getItem("fixture.assistants") ?? "{}");
  store.getState().assistants = ["a", "b"].map(id => ({ id, name: id, duty: "", pinned: true, hidden: false, createdAt: "2026-01-01", pinOrder: saved[id] }));
  store.getState().groups = [{ id: "g", name: "群", purpose: "", ownerId: "a", members: ["a"], busy: [], unread: 0, createdAt: "2026-01-01" }];
  if (!store.getState().groupPrefs.g) store.getState().groupPrefs.g = { pinned: true };
}
function Pins() { const state = store.useApp(); return <><button onClick={() => void store.savePinOrder(["g", "a", "b"])}>保存顺序</button><output>{pinList(conversations(state.assistants, state.groups, state.groupPrefs), "").map(row => row.id).join(",")}</output></>; }
createRoot(document.getElementById("root")).render(which === "pins" ? <Pins /> : which === "question" ? <Question /> : which === "job" ? <JobCard job={job} fresh={false} itemId="item" /> : which === "project" ? <NoteBox project={project} /> : which === "mcp" ? <Mcp /> : <div className="older-messages">正在读取更早的消息…</div>);
