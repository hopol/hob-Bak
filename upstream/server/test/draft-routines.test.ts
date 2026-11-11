import { describe, expect, it, vi } from "vitest";
import type { Draft } from "../../shared/types.ts";
import { createFromDraft } from "../src/actions.ts";
import { makeHob } from "./helpers.ts";

function draft(routines: Draft["routines"]): Draft {
  return { id: "d-test", assistantId: "hob", status: "pending", name: "写作", sprite: "page", duty: "写作", dutyLong: "写作", routines, routinesText: "计划全部建好", askFirst: [], instructions: [], carry: { conversations: 0 }, createdAt: new Date().toISOString() };
}

describe("创建助手的定时", () => {
  it("定时无效时不创建任何东西并指出原因", async () => {
    const hob = makeHob();
    try {
      const value = draft([{ name: "有效", instruction: "写", schedule: "0 9 * * *" }, { name: "错误", instruction: "写", schedule: "bad cron" }]);
      hob.runtime.store.saveDraft(value);
      const assistantIds = hob.runtime.store.assistants().map((assistant) => assistant.id);
      const result = await createFromDraft(hob.runtime, value.id);
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.body)).toContain("错误");
      expect(hob.runtime.store.assistants().map((assistant) => assistant.id)).toEqual(assistantIds);
      expect(hob.runtime.store.routines()).toEqual([]);
      expect(hob.runtime.store.draft(value.id)?.status).toBe("pending");
    } finally { hob.close(); }
  });
  it("写入失败时只报告建好的定时并指出失败原因", async () => {
    const hob = makeHob();
    try {
      const value = draft([{ name: "成功", instruction: "写", schedule: "0 9 * * *" }, { name: "失败", instruction: "写", schedule: "0 10 * * *" }]);
      hob.runtime.store.saveDraft(value);
      const original = hob.runtime.routines.create.bind(hob.runtime.routines);
      vi.spyOn(hob.runtime.routines, "create").mockImplementation((input) => { if (input.name === "失败") throw new Error("磁盘写入失败"); return original(input); });
      const result = await createFromDraft(hob.runtime, value.id);
      expect(result.status).toBe(200);
      const response = JSON.stringify(result.body);
      expect(response).toContain("成功");
      expect(response).toContain("失败");
      expect(response).toContain("磁盘写入失败");
      const assistant = (result.body as { assistant: { id: string } }).assistant;
      const greeting = JSON.stringify(hob.runtime.router.items(assistant.id).items);
      expect(greeting).toContain("成功");
      expect(greeting).toContain("失败");
      expect(greeting).toContain("磁盘写入失败");
      expect(greeting).not.toContain("计划全部建好");
      expect(hob.runtime.store.routines().map((routine) => routine.name)).toEqual(["成功"]);
    } finally { hob.close(); }
  });
});
