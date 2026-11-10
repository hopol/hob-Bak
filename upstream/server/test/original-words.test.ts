import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { buildWorkerPrompt } from "../src/prompt.ts";
import { monthDayTimeText } from "../src/time.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

describe("派活带上原话", () => {
  it("真实回合传原话、引用、附件和最多六条截断后的最近对话", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const long = "长".repeat(1501);
      hob.faux.setResponses([text("答一"), text("答二"), text("答三"), text("答四"), call("start_job", { title: "查磁盘", note: "需要统计" , files: ["/extra.txt", "/a.txt"] }), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      for (const message of ["旧消息", long, "第三句", "第四句"]) {
        await hob.runtime.router.send("hob", { text: message });
        await hob.runtime.router.waitIdle("hob");
      }
      const user = await hob.runtime.router.send("hob", { text: "帮我查下磁盘", quote: { itemId: "a-1", text: "之前的话" }, files: ["/a.txt"] });
      await waitFor(() => hob.runtime.store.jobs().length > 0);
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      const job = hob.runtime.store.jobs()[0];
      const time = monthDayTimeText("Asia/Shanghai", new Date(user.at));
      expect(job.instruction).toContain(`用户原话（${time}）：\n帮我查下磁盘\n（引用：「之前的话」）`);
      expect(job.instruction).toContain(`用户（`);
      expect(job.instruction).toContain(`${"长".repeat(1500)}…`);
      expect(job.instruction).not.toContain(long);
      expect(job.instruction).not.toContain("旧消息");
      expect(job.instruction.split("最近的对话：\n")[1].split("\n\n")[0].split("\n")).toHaveLength(6);
      expect(job.instruction).toContain("附件：/a.txt、/extra.txt\n\nHob 的备注：需要统计");
      expect(job.inputs).toEqual(["/a.txt", "/extra.txt"]);
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const prompt = buildWorkerPrompt(hob.runtime.store, job.id, { timezone, aboutYou, memory: "off" });
      expect(prompt).not.toContain("## 任务：");
      expect(prompt).not.toContain("## 你收到的文件");
      expect(prompt).not.toContain("帮我查下磁盘");
    } finally { hob.close(); }
  });

  it("备注超过 200 字时两种工具都返回明确错误", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const primary = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...primary, id: "ops", name: "服务器", primary: false });
      for (const name of ["start_job", "message_assistant"]) {
        const tool = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === name)!;
        const result = await tool.execute("id", { title: "测试", assistantId: "ops", note: "字".repeat(201) });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe("备注最多 200 字；用户原话和最近的对话会自动带上，备注只写从原话里看不出的背景。");
      }
    } finally { hob.close(); }
  });

  it("所有入口拒绝数据目录、子目录及符号链接，允许外部目录", async () => {
    const hob = makeHob({}, { memory: "off" });
    const outside = mkdtempSync(join(tmpdir(), "hob-cwd-"));
    try {
      symlinkSync(hob.home, join(outside, "alias"));
      for (const cwd of [hob.home, join(hob.home, "assistants", "hob", "jobs", "new"), join(outside, "alias", "new")]) {
        await expect(hob.runtime.jobs.start("hob", { title: "测试", instruction: "测试", cwd })).rejects.toThrow("不能在 Hob 的数据目录里干活；不填 cwd 就在任务自己的目录里做。");
      }
      hob.faux.setResponses([call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const job = await hob.runtime.jobs.start("hob", { title: "测试", instruction: "测试", cwd: outside });
      expect(job.cwd).toBe(outside);
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
    } finally { hob.close(); rmSync(outside, { recursive: true, force: true }); }
  });

  it("事件回合取最后用户消息", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([text("收到"), call("start_job", { title: "查磁盘" }), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      const user = await hob.runtime.router.send("hob", { text: "帮我查下磁盘" });
      await hob.runtime.router.waitIdle("hob");
      await hob.runtime.router.event("hob", "任务结束");
      await waitFor(() => hob.runtime.store.jobs().length > 0);
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.store.jobs()[0].instruction).toContain(`用户原话（${monthDayTimeText("Asia/Shanghai", new Date(user.at))}）：\n帮我查下磁盘`);
    } finally { hob.close(); }
  });

  it("转交续办事件仍取最近的用户消息，而不是之前转来的消息", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const primary = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...primary, id: "ops", name: "服务器", primary: false });
      await hob.runtime.router.addForwarded("ops", "旧转交", "dg-test");
      hob.faux.setResponses([text("收到"), call("start_job", { title: "续办" })]);
      await hob.runtime.router.send("ops", { text: "新要求" });
      await hob.runtime.router.waitIdle("ops");
      const start = vi.spyOn(hob.runtime.jobs, "start").mockResolvedValue({ id: "t-test", title: "续办", status: "queued" } as never);
      await hob.runtime.router.relay("ops", "任务结果", "dg-test");
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0][1].instruction).toMatch(/^用户原话（.+）：\n新要求/);
    } finally { hob.close(); }
  });

  it("转交保留原话和附件，目标助手派活时使用转来的消息", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const primary = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...primary, id: "ops", name: "服务器", primary: false });
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("message_assistant", { assistantId: "ops", note: "连接信息在记忆里" }), call("start_job", { title: "查磁盘", note: "看日志" }), call("report", { outcome: "done", result: "完成" })]);
      const user = await hob.runtime.router.send("hob", { text: "查磁盘", quote: { itemId: "a", text: "服务器" }, files: ["/disk.txt"] });
      await waitFor(() => hob.runtime.store.jobs().length > 0);
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("ops");
      const delegation = hob.runtime.store.delegations()[0];
      expect(delegation.text).toBe(`用户原话（${monthDayTimeText("Asia/Shanghai", new Date(user.at))}）：\n查磁盘\n（引用：「服务器」）\n\n附件：/disk.txt\n\nHob 的备注：连接信息在记忆里`);
      const forwarded = hob.runtime.router.items("ops").items.find((item) => item.kind === "user" && item.from);
      expect(forwarded).toMatchObject({ text: delegation.text, files: ["/disk.txt"] });
      const job = hob.runtime.store.jobs()[0];
      expect(job.instruction).toContain(`Hob 转来（${monthDayTimeText("Asia/Shanghai", new Date(forwarded!.at))}）：\n${delegation.text}`);
      expect(job.instruction).toContain("服务器 的备注：看日志");
      expect(job.inputs).toEqual(["/disk.txt"]);
    } finally { hob.close(); }
  });
});
