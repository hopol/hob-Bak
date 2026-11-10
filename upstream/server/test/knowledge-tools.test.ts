import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findKnowledgeTool } from "../src/knowledge-tools.ts";
import { activityLabel } from "../src/router-activity.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { monthDayTimeText } from "../src/time.ts";
import { call, makeHob, text } from "./helpers.ts";

describe("find_knowledge", () => {
  it("按关键词、类型和天数筛选并返回名称、来源、时间、路径及片段", async () => {
    const hob = makeHob();
    try {
      const oldPath = join(hob.home, "old.txt");
      writeFileSync(oldPath, "旧的中文资料");
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now - 3 * 86400_000);
      await hob.runtime.knowledge.collect({ origin: "output", path: oldPath, assistantId: "hob" });
      clock.mockRestore();
      const path = join(hob.home, "report.txt");
      writeFileSync(path, "第一行\n重要关键词资料\n最后一行");
      const entry = (await hob.runtime.knowledge.collect({ origin: "output", path, assistantId: "hob", description: "年度说明" }))!;
      const image = join(hob.home, "image.png");
      writeFileSync(image, "关键词图片");
      await hob.runtime.knowledge.collect({ origin: "chat", path: image, assistantId: "hob" });
      const tool = findKnowledgeTool(hob.runtime);
      const result = await tool.execute("x", { query: "关键词", type: "document", days: 1 });
      expect(result.content[0].text).toBe(`report.txt（文档，Hob，${monthDayTimeText("Asia/Shanghai", new Date(entry.updatedAt))}）：${entry.path}\n  第一行 重要关键词资料 最后一行`);
      expect((await tool.execute("x", { query: "年度说明" })).content[0].text).toContain("report.txt");
      expect((await tool.execute("x", { query: "report" })).content[0].text).toContain("report.txt");
      expect((await tool.execute("x", { query: "中文", days: 1 })).content[0].text).toBe("没有找到。");
      expect((await tool.execute("x", { type: "image" })).content[0].text).toContain("image.png（图片");
      expect((await tool.execute("x", { days: 0 })).isError).toBe(true);
      const read = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "read")!;
      expect((await read.execute("x", { path: entry.path })).content[0].text).toContain("重要关键词资料");
      expect(activityLabel("find_knowledge", { query: "关键词" })).toBe("正在找资料：关键词");
      expect(activityLabel("find_knowledge")).toBe("正在找资料");
    } finally { vi.restoreAllMocks(); hob.close(); }
  });

  it("最多返回 20 条，只有时间范围内确有更多才提示", async () => {
    const hob = makeHob();
    try {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now - 3 * 86400_000);
      const old = join(hob.home, "old.txt"); writeFileSync(old, "旧文件");
      await hob.runtime.knowledge.collect({ origin: "output", path: old, assistantId: "hob" });
      clock.mockRestore();
      for (let i = 0; i < 20; i++) {
        const path = join(hob.home, `${i}.txt`); writeFileSync(path, `文件内容 ${i}`);
        await hob.runtime.knowledge.collect({ origin: "output", path, assistantId: "hob" });
      }
      const tool = findKnowledgeTool(hob.runtime);
      const recent = (await tool.execute("x", { days: 1 })).content[0].text;
      expect(recent.split("\n")).toHaveLength(20);
      expect(recent).not.toContain("还有更多");
      const all = (await tool.execute("x", {})).content[0].text;
      expect(all.split("\n")).toHaveLength(21);
      expect(all.endsWith("还有更多，换个关键词或缩短时间。")).toBe(true);
    } finally { vi.restoreAllMocks(); hob.close(); }
  });

  it("Router 和 Worker 的实际会话都能调用", async () => {
    const hob = makeHob();
    try {
      const path = join(hob.home, "资料.txt"); writeFileSync(path, "用于会话检索的资料");
      const entry = (await hob.runtime.knowledge.collect({ origin: "output", path, assistantId: "hob" }))!;
      const router = await hob.runtime.router.ensure("hob");
      hob.faux.setResponses([call("find_knowledge", { query: "会话检索" }), text("找到了")]);
      await hob.runtime.router.send("hob", { text: "找资料" });
      await hob.runtime.router.waitIdle("hob");
      expect(JSON.stringify(router.session.messages)).toContain(entry.path);
      hob.faux.setResponses([call("find_knowledge", { query: "会话检索" }), call("report", { outcome: "done", result: "找到" }), text("好")]);
      const job = await hob.runtime.jobs.start("hob", { title: "找资料", instruction: "找资料" });
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.jobs.transcript(job.id)).toContainEqual(expect.objectContaining({ name: "find_knowledge", output: expect.stringContaining(entry.path) }));
      await hob.runtime.router.waitIdle("hob");
    } finally { hob.close(); }
  });
});
