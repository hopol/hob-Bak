import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../shared/types.ts";
import { makeHob, text, waitFor } from "./helpers.ts";

/** 助手一轮还没结束时，任务的结果事件排在 Hob 自己的队列里：排着的事件也算这个会话在忙。 */
function setup() {
  const hob = makeHob();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const job: Job = { id: "t-queued", assistantId: "hob", title: "查资料", instruction: "查资料", status: "done", summary: "查到了", createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
  hob.runtime.store.saveJob(job);
  hob.faux.setResponses([async () => { await gate; return text("先回这一句"); }, text("任务的结果收到了")]);
  const state = () => (hob.runtime.router as never as { routers: Map<string, object> }).routers.get("hob");
  const queueResult = async () => {
    void hob.runtime.router.send("hob", { text: "先处理这句" });
    await waitFor(() => hob.faux.state.callCount > 0);
    await hob.runtime.router.event("hob", "任务「查资料」（t-queued）已完成：查到了", { job: { id: job.id, round: 0, kind: "result" }, workDone: true });
  };
  const delivered = async () => (await hob.runtime.router.ensure("hob")).manager!.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "hob.event").length;
  return { hob, release: () => release(), state, queueResult, delivered };
}

describe("排队的任务事件", () => {
  it("这一轮结束时还有事件排着：完成通知等事件那一轮答完再推，只推一条", async () => {
    const { hob, release, queueResult, delivered } = setup();
    try {
      const push = vi.spyOn(hob.runtime.push, "send").mockResolvedValue({ sent: 1, removed: 0 });
      await queueResult();
      release();
      await hob.runtime.router.waitIdle("hob");
      expect(await delivered()).toBe(1);
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0]?.[0]).toMatchObject({ body: "任务的结果收到了" });
    } finally { release(); hob.close(); }
  });

  it("设置变了要释放会话时还有事件排着：等事件送完再释放，事件不丢", async () => {
    const { hob, release, queueResult, delivered } = setup();
    try {
      await queueResult();
      hob.runtime.router.releaseSessions();
      release();
      await hob.runtime.router.waitIdle("hob");
      expect(await delivered()).toBe(1);
      const items = hob.runtime.router.items("hob").items;
      expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "assistant", text: "任务的结果收到了" })]));
      expect(items.some((item) => item.kind === "note" && item.icon === "error")).toBe(false);
    } finally { release(); hob.close(); }
  });

  it("点停止时还有事件排着：停得下来就不丢会话，事件照常送到", async () => {
    const { hob, release, state, queueResult, delivered } = setup();
    try {
      await queueResult();
      const before = state();
      const stopping = hob.runtime.router.stop("hob");
      release();
      await stopping;
      await hob.runtime.router.waitIdle("hob");
      expect(state()).toBe(before);
      expect(await delivered()).toBe(1);
    } finally { release(); hob.close(); }
  });

  it("会话挂死停不下来被丢掉时还有事件排着：事件换到重新打开的会话里送到", async () => {
    const hob = makeHob();
    hob.runtime.router.stallReleaseMs = 50;
    try {
      hob.faux.setResponses([text("在。")]);
      await hob.runtime.router.send("hob", { text: "早" });
      await hob.runtime.router.waitIdle("hob");
      const session = (hob.runtime.router as never as { routers: Map<string, { session: { abort: () => Promise<void>; isStreaming: boolean } }> }).routers.get("hob")!.session;
      vi.spyOn(session, "abort").mockImplementation(() => new Promise<void>(() => undefined));
      hob.faux.setResponses([() => new Promise<never>(() => undefined)]);
      void hob.runtime.router.send("hob", { text: "在吗" });
      await waitFor(() => session.isStreaming);
      await hob.runtime.router.event("hob", "任务「查资料」已完成：查到了", { workDone: true });
      hob.faux.setResponses([text("任务的结果收到了")]);
      await hob.runtime.router.stop("hob");
      await waitFor(() => hob.runtime.router.items("hob").items.some((item) => item.kind === "assistant" && item.text === "任务的结果收到了"));
    } finally { hob.close(); }
  });
});
