import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider, Type } from "@earendil-works/pi-ai";
import { PiHost } from "../src/pi.ts";
import { call, makeHob, text } from "./helpers.ts";

describe("Router 上下文边界", () => {
  it("仅 Router 对大工具结果落盘，保留图片和错误状态；read 和小结果不截", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const full = "甲".repeat(6000) + "乙".repeat(4000);
      const dir = join(hob.home, "spill");
      const file = join(hob.home, "read.txt");
      writeFileSync(file, full);
      const tool = {
        name: "large", label: "large", description: "test", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: full.slice(0, 6000) }, { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }, { type: "text" as const, text: full.slice(6000) }], details: {} }),
      };
      const run = async (name: string, spillDir?: string) => {
        const opened = await hob.runtime.pi.open({ file: join(hob.home, `${name}.jsonl`), cwd: hob.home, model: "hob-faux/faux-1", thinking: "off", memory: "off", systemPrompt: () => "测试", tools: ["large", "read"], customTools: [tool], spillDir });
        return opened.session;
      };
      const router = await run("router", dir);
      hob.faux.setResponses([call("large", {}), text("好")]);
      await router.prompt("开始");
      const result = router.messages.find((m) => m.role === "toolResult");
      expect(result?.role).toBe("toolResult");
      if (!result || result.role !== "toolResult") throw new Error("工具未执行");
      const first = result.content[0];
      expect(first.type).toBe("text");
      if (first.type !== "text") throw new Error("结果不是文字");
      expect(first.text).toMatch(/^甲{4000}\n\n（共 10000 字，这里是前 4,000 字；全文：.*\.txt）$/);
      const path = first.text.match(/全文：(.*)）$/)![1];
      expect(readFileSync(path, "utf8")).toBe(full);
      expect(result.content[1]).toMatchObject({ type: "image", data: "aGVsbG8=" });
      expect(result.isError).toBe(false);
      hob.faux.setResponses([call("read", { path: file }), text("好")]);
      await router.prompt("读文件");
      const read = router.messages.filter((m) => m.role === "toolResult").at(-1)!;
      expect(JSON.stringify(read.content)).toContain(full);
      const worker = await run("worker");
      hob.faux.setResponses([call("large", {}), text("好")]);
      await worker.prompt("开始");
      const workerResult = worker.messages.find((m) => m.role === "toolResult")!;
      expect(JSON.stringify(workerResult.content)).toContain("甲".repeat(6000));
      router.dispose(); worker.dispose();
    } finally { hob.close(); }
  });

  it("短结果不落盘，写盘失败保留原结果并报告错误", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const dir = join(hob.home, "spill");
      let value = "短".repeat(4000);
      const tool = { name: "sample", label: "sample", description: "test", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: value }], details: {} }) };
      const { session } = await hob.runtime.pi.open({ file: join(hob.home, "test.jsonl"), cwd: hob.home, model: "hob-faux/faux-1", thinking: "off", memory: "off", systemPrompt: () => "测试", tools: ["sample"], customTools: [tool], spillDir: dir });
      hob.faux.setResponses([call("sample", {}), text("好")]);
      await session.prompt("短结果");
      expect(existsSync(dir)).toBe(false);
      expect(JSON.stringify(session.messages.find((m) => m.role === "toolResult")?.content)).toContain(value);
      writeFileSync(dir, "不是目录");
      value = "长".repeat(10000);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      hob.faux.setResponses([call("sample", {}), text("好")]);
      await session.prompt("写盘失败");
      expect(JSON.stringify(session.messages.filter((m) => m.role === "toolResult").at(-1)?.content)).toContain(value);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
      session.dispose();
    } finally { hob.close(); }
  });

  it("对话和任务一样，接近模型上下文上限才压缩", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const faux = fauxProvider({ provider: "budget", models: [{ id: "large", contextWindow: 1_000_000 }] });
      const host = new PiHost({ engineDir: join(hob.home, "budget-engine"), nativeProviders: [faux.provider] });
      const options = { cwd: hob.home, model: "budget/large", thinking: "off" as const, memory: "off" as const, systemPrompt: () => "测试", tools: [], customTools: [] };
      const router = await host.open({ ...options, file: join(hob.home, "budget-router.jsonl"), spillDir: join(hob.home, "spill") });
      const worker = await host.open({ ...options, file: join(hob.home, "budget-worker.jsonl") });
      const large = (await host.runtime()).getModel("budget", "large")!;
      expect(router.session.settingsManager.getCompactionSettings(large)).toEqual(worker.session.settingsManager.getCompactionSettings(large));
      expect(router.session.settingsManager.getCompactionSettings(large).reserveTokens).toBeLessThan(100_000);
      router.session.dispose(); worker.session.dispose();
    } finally { hob.close(); }
  });
});
