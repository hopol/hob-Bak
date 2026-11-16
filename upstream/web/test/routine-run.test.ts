import { describe, expect, it } from "vitest";
import { routineRunUsage } from "../src/util.ts";

describe("定时运行记录", () => {
  it("显示用时、操作次数和 token，旧记录不补造数据", () => {
    const at = new Date().toISOString();
    expect(routineRunUsage({ jobId: "t-1", at, status: "done", durationMs: 372000, tools: 95, tokens: 198000 })).toBe("6 分 12 秒 · 95 次操作 · 198k token");
    expect(routineRunUsage({ jobId: "t-2", at, status: "done" })).toBe("");
  });

  it("英文的 token 按数量分单复数", () => {
    const at = new Date().toISOString();
    expect(routineRunUsage({ jobId: "t-3", at, status: "done", tokens: 1 }, "en")).toBe("1 token");
    expect(routineRunUsage({ jobId: "t-4", at, status: "done", tokens: 900 }, "en")).toBe("900 tokens");
    expect(routineRunUsage({ jobId: "t-5", at, status: "done", tokens: 198000 }, "en")).toBe("198k tokens");
  });
});
