import { Type } from "typebox";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { limitToolCalls, pauseToolTimeoutForUser } from "../src/tool-timeout.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const fixture = (name: string, execute: ToolDefinition<any, any>["execute"]): ToolDefinition<any, any> => ({
  name, label: name, description: "fixture", parameters: Type.Object({ timeout: Type.Optional(Type.Number()) }), execute,
});

describe("工具调用时限", () => {
  it("停止无响应的单次调用并保留已经输出的内容", async () => {
    let aborted = false;
    const tool = fixture("search", async (_id, _args, signal, update) => {
      update?.({ content: [{ type: "text", text: "已找到一项" }], details: undefined });
      signal?.addEventListener("abort", () => { aborted = true; });
      return new Promise(() => {});
    });
    const result = await limitToolCalls([tool], () => 60)[0].execute("id", {}, undefined, undefined, {} as never);
    expect(aborted).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "已找到一项" }, { type: "text", text: "「search」0.001 分钟没有结束，Hob 停掉了这次调用。到停下时的输出在上面。" }]);
  });

  it("普通调用结果原样返回", async () => {
    const expected = { content: [{ type: "text" as const, text: "正常" }], details: { value: 42 } };
    const result = await limitToolCalls([fixture("search", async () => expected)], () => 1000)[0].execute("id", {}, undefined, undefined, {} as never);
    expect(result).toEqual(expected);
  });

  it("真实命令到时中止并交回已经输出的内容", async () => {
    const tool = limitToolCalls([createBashTool(process.cwd())], () => 120)[0];
    const result = await tool.execute("id", { command: "printf before; sleep 2" }, undefined, undefined, undefined as never);
    expect(result.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "「bash」0.002 分钟没有结束，Hob 停掉了这次调用。到停下时的输出在上面。要跑得更久，调用时把 timeout 设成需要的秒数；不用等结果的，放到后台跑，把输出写进文件，之后再读。" },
    ]);
  }, 5000);

  it("任意工具等待用户时暂停计时，答复后只用剩余时间", async () => {
    vi.useFakeTimers();
    try {
      let answerFirst!: () => void;
      let answerSecond!: () => void;
      const first = new Promise<void>(resolve => { answerFirst = resolve; });
      const second = new Promise<void>(resolve => { answerSecond = resolve; });
      const tool = fixture("custom_wait", async (_id, _args, signal) => {
        await new Promise(resolve => setTimeout(resolve, 40));
        const resumeFirst = pauseToolTimeoutForUser(signal);
        const resumeSecond = pauseToolTimeoutForUser(signal);
        await first;
        resumeFirst();
        resumeFirst();
        await second;
        resumeSecond();
        await new Promise(resolve => setTimeout(resolve, 70));
        return { content: [{ type: "text", text: "完成" }], details: undefined };
      });
      let settled = false;
      const pending = limitToolCalls([tool], () => 100)[0].execute("id", {}, undefined, undefined, {} as never);
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(40);
      await vi.advanceTimersByTimeAsync(500);
      answerFirst();
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);
      answerSecond();
      await vi.advanceTimersByTimeAsync(59);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect((await pending).content).toEqual([{ type: "text", text: "「custom_wait」0.0016666666666666668 分钟没有结束，Hob 停掉了这次调用。" }]);
    } finally { vi.useRealTimers(); }
  });

  it("等待用户期间仍可由调用方中止", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const tool = fixture("custom_wait", async (_id, _args, signal) => {
      release = pauseToolTimeoutForUser(signal);
      return new Promise(() => {});
    });
    const pending = limitToolCalls([tool], () => 100)[0].execute("id", {}, controller.signal, undefined, {} as never);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    release();
  });

  it("命令参数说明随当前时限更新", () => {
    let ms = 60_000;
    const tool = limitToolCalls([createBashTool(process.cwd())], () => ms)[0];
    expect(tool.parameters.properties.timeout.description).toBe("命令最多跑多少秒。不填是 1 分钟。构建、下载这类久的命令，填够时间。");
    ms = 120_000;
    expect(tool.parameters.properties.timeout.description).toBe("命令最多跑多少秒。不填是 2 分钟。构建、下载这类久的命令，填够时间。");
  });

  it("显式命令时限交给命令工具处理", async () => {
    let receivedSignal: AbortSignal | undefined;
    const tool = fixture("bash", async (_id, _args, signal) => {
      receivedSignal = signal;
      await new Promise(resolve => setTimeout(resolve, 80));
      return { content: [{ type: "text", text: "完成" }], details: undefined };
    });
    const signal = new AbortController().signal;
    const result = await limitToolCalls([tool], () => 20)[0].execute("id", { timeout: 1 }, signal, undefined, {} as never);
    expect(receivedSignal).toBe(signal);
    expect(result.content).toEqual([{ type: "text", text: "完成" }]);
  });
});
