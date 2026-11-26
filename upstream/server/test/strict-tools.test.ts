import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { strictTools } from "../src/pi.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { makeHob } from "./helpers.ts";

const check = (tool: any, args: Record<string, unknown>) => validateToolArguments(tool, { type: "toolCall", id: "t", name: tool.name, arguments: args as never });

it("Hob 自己的工具拒绝没声明的参数：检查脚本写在 create_routine 顶层不会悄悄建成没有检查的定时任务", () => {
  const hob = makeHob();
  try {
    const [tool] = strictTools(buildRouterTools(hob.runtime, "hob").filter((item) => item.name === "create_routine"));
    const base = { name: "新 PR 检查", instruction: "有新 PR 告诉用户", schedules: ["*/10 * * * *"] };
    expect(() => check(tool, { ...base, script: "echo hi", then: "notify" })).toThrow(/script: unknown field/);
    expect(() => check(tool, { ...base, check: { script: "echo hi", then: "notify", extra: 1 } })).toThrow();
    expect(check(tool, { ...base, check: { script: "echo hi", then: "notify" } })).toMatchObject({ check: { script: "echo hi" } });
  } finally { hob.close(); }
});

it("插件工具（带 namespace）用服务自己的 schema，不加限制", () => {
  const plugin = { name: "demo_echo", label: "demo", description: "", namespace: { name: "demo" }, parameters: Type.Object({ message: Type.String() }), execute: async () => ({ content: [], details: undefined }) };
  const [tool] = strictTools([plugin as never]);
  expect(tool).toBe(plugin);
  expect(check(tool, { message: "a", extra: 1 })).toMatchObject({ message: "a" });
});
