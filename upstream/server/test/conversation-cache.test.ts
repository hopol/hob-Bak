import { appendFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeHob } from "./helpers.ts";

const entry = (id: string, text: string) => JSON.stringify({ type: "custom", id, parentId: null, timestamp: new Date().toISOString(), customType: "hob.item", data: { kind: "note", icon: "info", text } }) + "\n";

describe("对话缓存", () => {
  it("未打开会话时复用结果，文件变动后刷新", () => {
    const hob = makeHob();
    try {
      const router = hob.runtime.router;
      const file = hob.runtime.store.routerFile("hob");
      writeFileSync(file, entry("1", "第一条"));
      const first = router.items("hob").items;
      expect(router.items("hob").items[0]).toBe(first[0]);
      appendFileSync(file, entry("2", "第二条"));
      expect(router.items("hob").items.map((item) => item.id)).toEqual(["1", "2"]);
    } finally { hob.close(); }
  });

  it("打开会话时不重复取条目，追加后失效；分页只读取引用任务", async () => {
    const hob = makeHob();
    try {
      const state = await hob.runtime.router.ensure("hob");
      const getEntries = vi.spyOn(state.manager!, "getEntries");
      const jobs = vi.spyOn(hob.runtime.store, "jobs");
      await hob.runtime.router.addItem("hob", {kind: "job", jobId: "missing"});
      const page = hob.runtime.router.items("hob");
      const calls = getEntries.mock.calls.length;
      hob.runtime.router.items("hob");
      hob.runtime.router.last("hob");
      expect(getEntries).toHaveBeenCalledTimes(calls);
      expect(jobs).not.toHaveBeenCalled();
      expect(page.items).toHaveLength(1);
      await hob.runtime.router.addItem("hob", {kind: "note", icon: "info", text: "追加"});
      expect(hob.runtime.router.items("hob").items).toHaveLength(2);
      expect(getEntries.mock.calls.length).toBeGreaterThan(calls);
    } finally { hob.close(); }
  });
});
