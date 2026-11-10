import { describe, expect, it } from "vitest";
import { routineRunUsage } from "../src/util.ts";

describe("定时运行记录", () => {
  it("显示用时、操作次数和 token，旧记录不补造数据", () => {
    const at = new Date().toISOString();
    expect(routineRunUsage({ jobId: "t-1", at, status: "done", durationMs: 372000, tools: 95, tokens: 198000 })).toBe("6 分 12 秒 · 95 次操作 · 198k token");
    expect(routineRunUsage({ jobId: "t-2", at, status: "done" })).toBe("");
  });
});
