import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { Item } from "../../shared/types.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const tooLong = "字".repeat(401);
const notes = (items: Item[]) => items.filter((item) => item.kind === "note" && item.text.includes("没有成功"));

describe("没办成的事留一行给用户", () => {
  it("一轮里开任务失败、后来没再开成：留一行「创建任务」没有成功，原因是工具报错的原文", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([call("start_job", { title: "查磁盘", note: tooLong }), text("我改一下再说。")]);
      await hob.runtime.router.send("hob", { text: "帮我查下磁盘" });
      await hob.runtime.router.waitIdle("hob");
      const left = notes(hob.runtime.router.items("hob").items);
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({ icon: "info", text: "「创建任务」没有成功" });
      expect((left[0] as { detail?: string }).detail).toBe("备注 401 字，最多 400 字。用户原话和最近的对话会自动带上，备注只写从原话里看不出的背景，改短后再调用一次。");
    } finally { hob.close(); }
  });

  it("失败以后又开成了：不留", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([
        call("start_job", { title: "查磁盘", note: tooLong }),
        call("start_job", { title: "查磁盘" }),
        call("report", { outcome: "done", result: "磁盘用了 40%" }),
        text("查到了。"),
      ]);
      await hob.runtime.router.send("hob", { text: "帮我查下磁盘" });
      await hob.runtime.router.waitIdle("hob");
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
      expect(notes(hob.runtime.router.items("hob").items)).toHaveLength(0);
    } finally { hob.close(); }
  });

  it("转交给 A 失败、转交给 B 成功：留一行（对象不同）", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const primary = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...primary, id: "ops", name: "运维", primary: false });
      vi.spyOn(hob.runtime.router, "relay").mockResolvedValue();
      hob.faux.setResponses([
        call("message_assistant", { assistantId: "nobody" }),
        call("message_assistant", { assistantId: "ops" }),
        text("已经转过去了。"),
      ]);
      await hob.runtime.router.send("hob", { text: "让运维查下磁盘" });
      await hob.runtime.router.waitIdle("hob");
      const left = notes(hob.runtime.router.items("hob").items);
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({ text: "「转交其他助手」没有成功" });
      expect((left[0] as { detail?: string }).detail).toBe("没有这个助手：nobody");
    } finally { hob.close(); }
  });

  it("同一个工具失败两次：只留一行，原因取最后一次", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([
        call("start_job", { title: "查磁盘", note: tooLong }),
        call("start_job", { title: "查磁盘", note: tooLong }),
        text("还是不行。"),
      ]);
      await hob.runtime.router.send("hob", { text: "帮我查下磁盘" });
      await hob.runtime.router.waitIdle("hob");
      expect(notes(hob.runtime.router.items("hob").items)).toHaveLength(1);
    } finally { hob.close(); }
  });

  it("只读的工具失败不留：读不到文件用不着告诉用户", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([call("read", { path: join(hob.home, "没有这个文件.txt") }), text("那个文件没找到。")]);
      await hob.runtime.router.send("hob", { text: "读一下那个文件" });
      await hob.runtime.router.waitIdle("hob");
      expect(notes(hob.runtime.router.items("hob").items)).toHaveLength(0);
    } finally { hob.close(); }
  });

  it("群和话题里一样：同一行落在群的时间线上，发言人是这个成员", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "运维组", purpose: "看机器", ownerId: "hob", members: ["hob"] });
      hob.faux.setResponses([call("start_job", { title: "查磁盘", note: tooLong }), text("我改一下再说。")]);
      await hob.runtime.groups.send(group.id, { text: "查下磁盘" });
      await waitFor(() => notes(hob.runtime.store.groupItems(group.id) as Item[]).length > 0);
      const left = notes(hob.runtime.store.groupItems(group.id) as Item[]);
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({ speaker: "hob", text: "「创建任务」没有成功" });
    } finally { hob.close(); }
  });
});
