import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { realApi } from "../src/api.ts";

const calls = { answer: 0, reply: 0, project: 0, mcp: 0, config: 0, oauth: 0, plugins: 0 };
window.cleanupCalls = calls;
realApi.answerApproval = async () => { calls.answer++; if (calls.answer === 1) throw new Error("测试失败"); };
realApi.replyJob = async () => { calls.reply++; throw new Error("测试失败"); };
realApi.sendGroupMessage = async () => { calls.project++; throw new Error("测试失败"); };
const plugin = { plugin: { id: "sample", version: "1.0", source: "custom", enabled: true, tools: {}, config: {} }, manifest: { name: "sample" }, config: { NAME: { type: "string", title: "名称", required: true }, SECRET: { type: "string", title: "密钥", sensitive: true, configured: true, required: true }, COUNT: { type: "number", title: "数量", min: 1, max: 10, value: 2 }, FLAG: { type: "boolean", title: "开关", value: true }, CHOICE: { type: "string", title: "选项", options: ["a", "b"], value: "a" }, FILE: { type: "file", title: "文件路径" }, DIR: { type: "directory", title: "目录路径" } }, missing: ["NAME"], services: [{ name: "sample", status: "pending_config", tools: [{ name: "read", toolName: "sample_read", enabled: true, exposure: "direct", inputSchema: {}, annotations: { readOnlyHint: true } }], oauth: { declared: true, loggedIn: false } }] };
realApi.plugins = async () => { calls.plugins++; return { plugins: [plugin], migrationErrors: [] }; };
realApi.pluginCatalog = async () => ({ plugins: [] });
realApi.savePluginConfig = async (_id, values) => { calls.config++; window.savedPluginValues = values; for (const [key, value] of Object.entries(values)) plugin.config[key].value = value; return plugin; };
realApi.startPluginOAuth = async () => { calls.oauth++; return { authorizationUrl: "https://auth.example.test/", callbackUrl: `${location.origin}/api/plugins/oauth/callback` }; };
realApi.patchPlugin = async (_id, patch) => { calls.mcp++; window.lastPluginPatch = patch; if (calls.mcp === 1) throw new Error("测试失败"); if (patch.enabled !== undefined && calls.mcp > 2) plugin.plugin.enabled = patch.enabled; if (patch.tools) { plugin.plugin.tools = patch.tools; plugin.services[0].tools[0].enabled = patch.tools.read?.enabled !== false; } if (patch.assistants) plugin.plugin.assistants = patch.assistants; if (patch.exposure) plugin.plugin.exposure = patch.exposure; return plugin; };
realApi.patchAssistant = async (id, patch) => {
  const saved = JSON.parse(localStorage.getItem("fixture.assistants") ?? "{}");
  saved[id] = patch.pinOrder;
  localStorage.setItem("fixture.assistants", JSON.stringify(saved));
  return {};
};
const store = await import("../src/store.ts");
const { QuestionCard, JobCard } = await import("../src/components/Items.tsx");
const { PluginDetail } = await import("../src/components/PluginDetail.tsx");
const { conversations, pinList } = await import("../src/home.ts");
const approval = { id: "approval", assistantId: "hob", title: "是否继续？", options: [{ key: "A", label: "继续" }, { key: "B", label: "暂停" }], status: "pending", source: "router", createdAt: "2026-01-01" };
store.getState().approvals = { approval };
const job = { id: "t-1", assistantId: "hob", title: "测试任务", instruction: "", status: "running", createdAt: "2026-01-01", stats: { reads: 0, edits: 0, commands: 0 }, activity: [] };
function Question() { const state = store.useApp(); return <QuestionCard approval={state.approvals.approval} fresh={false} />; }
const which = new URLSearchParams(location.search).get("fixture");
if (which === "mcp") store.getState().assistants = [{ id: "hob", name: "Hob" }, { id: "sample-a", name: "示例助手" }];
if (which === "pins") {
  const saved = JSON.parse(localStorage.getItem("fixture.assistants") ?? "{}");
  store.getState().assistants = ["a", "b"].map(id => ({ id, name: id, duty: "", pinned: true, hidden: false, createdAt: "2026-01-01", pinOrder: saved[id] }));
  store.getState().groups = [{ id: "g", name: "群", purpose: "", ownerId: "a", members: ["a"], busy: [], unread: 0, createdAt: "2026-01-01" }];
  if (!store.getState().groupPrefs.g) store.getState().groupPrefs.g = { pinned: true };
}
function Pins() { const state = store.useApp(); return <><button onClick={() => void store.savePinOrder(["g", "a", "b"])}>保存顺序</button><output>{pinList(conversations(state.assistants, state.groups, state.groupPrefs), "").map(row => row.id).join(",")}</output></>; }
createRoot(document.getElementById("root")).render(which === "pins" ? <Pins /> : which === "question" ? <Question /> : which === "job" ? <JobCard job={job} fresh={false} itemId="item" /> : which === "mcp" ? <PluginDetail id="sample" /> : <div className="older-messages">正在读取更早的消息…</div>);
