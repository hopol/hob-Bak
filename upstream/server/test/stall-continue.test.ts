import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { call, makeHob, text, waitFor } from "./helpers.ts";

describe("回复时的停滞处理", () => {
  it("命令指定较长 timeout 时不因对话看门狗中断", async () => {
    const hob = makeHob();
    hob.runtime.router.stallOverrideMs = 300;
    try {
      hob.faux.setResponses([call("bash", { command: "sleep 1; printf finished", timeout: 3 }), text("命令已完成。")]);
      await hob.runtime.router.send("hob", { text: "运行命令" });
      await waitFor(() => !hob.runtime.router.isBusy("hob"), 5000);
      const items = hob.runtime.router.items("hob").items;
      expect(items.some(item => item.kind === "assistant" && item.text === "命令已完成。")).toBe(true);
      expect(items.some(item => item.kind === "note" && item.text.includes("无响应，已停止"))).toBe(false);
    } finally { hob.close(); }
  }, 10000);

  it("安静命令超时后把已有输出交给模型并继续", async () => {
    const hob = makeHob();
    hob.runtime.router.stallOverrideMs = 300;
    try {
      hob.faux.setResponses([call("bash", { command: "printf started; sleep 2" }), text("命令已中止，继续处理。")]);
      await hob.runtime.router.send("hob", { text: "运行命令" });
      await waitFor(() => !hob.runtime.router.isBusy("hob"), 5000);
      const entries = readFileSync(join(hob.home, "assistants/hob/router.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      const result = entries.find(entry => entry.message?.role === "toolResult" && entry.message.toolName === "bash")?.message;
      expect(result.content.map((block: { text: string }) => block.text).join("\n")).toContain("started\n「bash」0.005 分钟没有结束，Hob 停掉了这次调用。到停下时的输出在上面。要跑得更久，调用时把 timeout 设成需要的秒数；不用等结果的，放到后台跑，把输出写进文件，之后再读。");
      expect(hob.runtime.router.items("hob").items.some(item => item.kind === "assistant" && item.text === "命令已中止，继续处理。")).toBe(true);
    } finally { hob.close(); }
  }, 10000);

  it("普通命令完成后照常回复", async () => {
    const hob = makeHob();
    hob.runtime.router.stallOverrideMs = 2000;
    try {
      hob.faux.setResponses([call("bash", { command: "printf ok" }), text("完成。")]);
      await hob.runtime.router.send("hob", { text: "运行命令" });
      await waitFor(() => !hob.runtime.router.isBusy("hob"), 5000);
      const entries = readFileSync(join(hob.home, "assistants/hob/router.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      const result = entries.find(entry => entry.message?.role === "toolResult" && entry.message.toolName === "bash")?.message;
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      expect(hob.runtime.router.items("hob").items.some(item => item.kind === "assistant" && item.text === "完成。")).toBe(true);
    } finally { hob.close(); }
  }, 10000);
});
