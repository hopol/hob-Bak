import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { toolFailureText } from "../src/pi.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

/** 会话文件里模型看得到的工具结果（toolResult 那一行的文字和 isError）。 */
function toolResults(file: string): { name: string; text: string; isError: boolean }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; toolName?: string; isError?: boolean; content?: { type: string; text?: string }[] } };
      if (entry.type !== "message" || entry.message?.role !== "toolResult") return [];
      const blocks = entry.message.content ?? [];
      return [{
        name: entry.message.toolName ?? "",
        text: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
        isError: Boolean(entry.message.isError),
      }];
    });
}

const tooLong = "字".repeat(401);

describe("工具失败的说法", () => {
  it("对话里的自定义工具报错：模型收到的文字以「调用失败：」开头", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([call("start_job", { title: "查磁盘", note: tooLong }), text("我改一下再说。")]);
      await hob.runtime.router.send("hob", { text: "帮我查下磁盘" });
      await hob.runtime.router.waitIdle("hob");
      const failed = toolResults(join(hob.home, "assistants", "hob", "router.jsonl")).find((item) => item.name === "start_job")!;
      expect(failed.isError).toBe(true);
      expect(failed.text).toBe(`调用失败：备注 401 字，最多 400 字。用户原话和最近的对话会自动带上，备注只写从原话里看不出的背景，改短后再调用一次。`);
    } finally { hob.close(); }
  });

  it("群里成员的自定义工具报错：同样是「调用失败：」", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "内容组", purpose: "写稿", ownerId: "hob", members: ["hob"] });
      hob.faux.setResponses([call("start_job", { title: "写稿", note: tooLong }), text("我改一下再说。")]);
      const file = join(hob.home, "groups", group.id, "members", "hob.jsonl");
      await hob.runtime.groups.send(group.id, { text: "写一篇稿子" });
      await waitFor(() => existsSync(file) && toolResults(file).some((item) => item.name === "start_job"));
      const failed = toolResults(file).find((item) => item.name === "start_job")!;
      expect(failed.isError).toBe(true);
      expect(failed.text.startsWith("调用失败：")).toBe(true);
    } finally { hob.close(); }
  });

  it("任务里的自定义工具报错加「调用失败：」，引擎自带工具和成功的结果不加", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([
        call("report", { outcome: "不知道", result: "完成" }),
        call("read", { path: join(hob.home, "没有这个文件.txt") }),
        call("report", { outcome: "done", result: "完成" }),
        text("做完了。"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "试一下", instruction: "试一下" });
      await hob.runtime.jobs.waitIdle();
      const results = toolResults(join(hob.home, "assistants", "hob", "jobs", job.id, "worker.jsonl"));
      const failed = results.filter((item) => item.name === "report")[0]!;
      expect(failed.isError).toBe(true);
      expect(failed.text).toBe("调用失败：outcome 只能是 done、stuck 或 need_approval，请重新调用 report。");
      const read = results.find((item) => item.name === "read")!;
      expect(read.isError).toBe(true);
      expect(read.text.startsWith("调用失败：")).toBe(false);
      const report = results.find((item) => item.name === "report" && !item.isError)!;
      expect(report.isError).toBe(false);
      expect(report.text.startsWith("调用失败：")).toBe(false);
    } finally { hob.close(); }
  });

  it("读文件的工具出错不加开头：文件不存在就是文件不存在", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([call("read", { path: join(hob.home, "没有这个文件.txt") }), text("找不到就算了。")]);
      await hob.runtime.router.send("hob", { text: "读一下那个文件" });
      await hob.runtime.router.waitIdle("hob");
      const read = toolResults(join(hob.home, "assistants", "hob", "router.jsonl")).find((item) => item.name === "read")!;
      expect(read.isError).toBe(true);
      expect(read.text.startsWith("调用失败：")).toBe(false);
    } finally { hob.close(); }
  });

  it("工具自己抛异常（不返回 isError）：接住，模型收到的文字同样以「调用失败：」开头", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { session } = await hob.runtime.pi.open({
        file: join(hob.home, "boom.jsonl"), cwd: hob.home, model: "hob-faux/faux-1", thinking: "off", memory: "off",
        systemPrompt: () => "测试", tools: ["boom"], customTools: [{
          name: "boom", label: "boom", description: "测试", parameters: Type.Object({}),
          execute: async () => { throw new Error("磁盘满了"); },
        }],
      });
      hob.faux.setResponses([call("boom", {}), text("好")]);
      await session.prompt("试一下");
      const result = session.messages.find((message) => message.role === "toolResult")!;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("调用失败：磁盘满了");
      session.dispose();
    } finally { hob.close(); }
  });

  it("只加一次开头，图片等其他内容原样留着", async () => {
    const tool = toolFailureText([{
      name: "sample", label: "sample", description: "测试", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "没办成" }, { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }], details: undefined, isError: true }),
    }]);
    const result = await tool[0]!.execute("call", {}, undefined);
    expect(result.content[0]).toEqual({ type: "text", text: "调用失败：没办成" });
    expect(result.content[1]).toMatchObject({ type: "image" });
    expect(result.isError).toBe(true);
  });
});
