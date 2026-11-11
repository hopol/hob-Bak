import { describe, expect, it } from "vitest";
import type { Job } from "../../shared/types.ts";
import { call, makeHob, text } from "./helpers.ts";

describe("用户直接对任务说的话", () => {
  it("记进助手的会话，任务交结果时助手看得到", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const job: Job = {
        id: "t-ctx", assistantId: "hob", title: "查订阅", instruction: "查订阅为什么没入库",
        status: "done", createdAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 }, activity: [],
        model: "hob-faux/faux-1", thinking: "off",
      };
      hob.runtime.store.saveJob(job);
      let seen = "";
      hob.faux.setResponses([
        call("report", { outcome: "done", result: "删好了" }),
        text("完成"),
        (context) => { seen = JSON.stringify(context.messages); return text("收到"); },
      ]);
      await hob.runtime.jobs.reply("t-ctx", "那些不是我订阅的，可以删了", "user");
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      expect(seen).toContain("用户给任务「查订阅」（t-ctx）追加了回复：那些不是我订阅的，可以删了");
    } finally { hob.close(); }
  });
});
