import { describe, expect, it, vi } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { makeHob } from "./helpers.ts";

function toolOf(hob: ReturnType<typeof makeHob>, name: string, groupId?: string) {
  const tool = buildRouterTools(hob.runtime, "hob", groupId).find((item) => item.name === name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  return tool;
}

describe("交接只使用助手写的说明", () => {
  it("start_job 的任务内容只有 note，附件只取 files", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const start = vi.spyOn(hob.runtime.jobs, "start").mockResolvedValue({ id: "t-test", title: "改第三章", status: "queued" } as never);
      const result = await toolOf(hob, "start_job").execute("c", {
        title: "改第三章",
        note: "用户要求：“只改第三章，图表别动，改完给我对比。”",
        files: ["/draft.md"],
      });
      expect(result.isError).toBeUndefined();
      expect(result.terminate).toBeUndefined();
      expect(start).toHaveBeenCalledWith("hob", expect.objectContaining({
        instruction: "用户要求：“只改第三章，图表别动，改完给我对比。”",
        files: ["/draft.md"],
      }));
      expect(start.mock.calls[0]![1].instruction).not.toContain("最近的对话");
      expect(start.mock.calls[0]![1].instruction).not.toContain("用户原话");
    } finally { hob.close(); }
  });

  it("note 必填、空白报错，长说明不再截断", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const start = vi.spyOn(hob.runtime.jobs, "start").mockResolvedValue({ id: "t-test", title: "测试", status: "queued" } as never);
      const missing = await toolOf(hob, "start_job").execute("c", { title: "测试" });
      expect(missing.isError).toBe(true);
      expect(missing.content[0]!.text).toContain("note 不能为空");
      const note = "字".repeat(401);
      await toolOf(hob, "start_job").execute("c", { title: "测试", note });
      expect(start.mock.calls[0]![1].instruction).toBe(note);
    } finally { hob.close(); }
  });

  it("转交给助手只传 note 和显式 files", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "ops", name: "服务器", primary: false });
      const delegation = vi.spyOn(hob.runtime.delegations, "start").mockResolvedValue({ id: "dg-test" } as never);
      const result = await toolOf(hob, "message_assistant").execute("c", { assistantId: "ops", note: "检查服务状态，失败时写清原因。", files: ["/check.txt"] });
      expect(result.terminate).toBe(true);
      expect(delegation).toHaveBeenCalledWith("hob", "ops", "检查服务状态，失败时写清原因。", ["/check.txt"]);
    } finally { hob.close(); }
  });

  it("交给群和 open_topic 也要求 note，并把它作为首条内容", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "ops", name: "服务器", primary: false });
      const group = hob.runtime.groups.create({ name: "协作", purpose: "处理资料", ownerId: "hob", members: ["hob", "ops"] });
      const result = await toolOf(hob, "message_group").execute("c", { groupId: group.id, title: "清理资料", note: "只处理重复文件，保留原始目录。", files: ["/index.txt"] });
      expect(result.terminate).toBe(true);
      const topic = hob.runtime.groups.topicsOf(group.id)[0]!;
      const first = hob.runtime.store.groupItems(topic.id).find((item) => item.kind === "user");
      expect(first).toMatchObject({ text: "只处理重复文件，保留原始目录。", files: ["/index.txt"], forwardedFrom: { assistantId: "hob" } });
    } finally { hob.close(); }
  });
});
