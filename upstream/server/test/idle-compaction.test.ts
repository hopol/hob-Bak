import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Approval, Job } from "../../shared/types.ts";
import { IDLE_COMPACTION_IDLE_MS, IDLE_COMPACTION_TOKEN_THRESHOLD } from "../src/router.ts";
import { makeHob, text, waitFor } from "./helpers.ts";

const context = { tokens: IDLE_COMPACTION_TOKEN_THRESHOLD + 1, contextWindow: 1_000_000, percent: 15 };

async function openIdleConversation(hob: ReturnType<typeof makeHob>, groupId?: string) {
  hob.faux.setResponses([text("旧回复")]);
  if (groupId) {
    await hob.runtime.groups.send(groupId, { text: "旧消息" });
    await hob.runtime.router.waitIdle("hob", 15_000, groupId);
  } else {
    await hob.runtime.router.send("hob", { text: "旧消息" });
    await hob.runtime.router.waitIdle("hob");
  }
  const state = await hob.runtime.router.ensure("hob", groupId);
  vi.spyOn(state.session!, "getContextUsage").mockReturnValue(context);
  return state;
}

function activeJob(id: string, status: Job["status"], groupId?: string): Job {
  return {
    id,
    assistantId: "hob",
    title: id,
    instruction: "测试任务",
    status,
    createdAt: new Date().toISOString(),
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
    ...(groupId ? { groupId } : {}),
  };
}

/** 把会话文件改成 6 小时以前结束的样子：助手消息的时间和文件修改时间都往前拨。 */
function ageSession(file: string) {
  const old = new Date(Date.now() - IDLE_COMPACTION_IDLE_MS - 1_000);
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    const entry = JSON.parse(line) as { type?: string; timestamp?: string; message?: { role?: string } };
    return entry.type === "message" && entry.message?.role === "assistant" ? JSON.stringify({ ...entry, timestamp: old.toISOString() }) : line;
  });
  writeFileSync(file, `${entries.join("\n")}\n`);
  utimesSync(file, old, old);
}

/** 之后打开的会话：上下文超过阈值，compact 换成假的。 */
function mockOpenedSessions(hob: ReturnType<typeof makeHob>) {
  const originalOpen = hob.runtime.pi.open.bind(hob.runtime.pi);
  return vi.spyOn(hob.runtime.pi, "open").mockImplementation(async (options) => {
    const result = await originalOpen(options);
    vi.spyOn(result.session, "getContextUsage").mockReturnValue(context);
    vi.spyOn(result.session, "compact").mockResolvedValue(undefined as never);
    return result;
  });
}

describe("Router 闲置会话整理", () => {
  it("满 6 小时且上下文超过阈值时只整理一次，分页条目保持完整", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const state = await openIdleConversation(hob);
      const compact = vi.spyOn(state.session!, "compact").mockResolvedValue(undefined as never);
      const before = hob.runtime.router.items("hob").items;

      await hob.runtime.router.compactIdleSessions(Date.now() + IDLE_COMPACTION_IDLE_MS);
      await hob.runtime.router.compactIdleSessions(Date.now() + IDLE_COMPACTION_IDLE_MS);

      expect(compact).toHaveBeenCalledTimes(1);
      expect(hob.runtime.router.items("hob").items).toEqual(before);
    } finally {
      hob.close();
    }
  });

  it("不到闲置时间或上下文没有超过阈值都不整理", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const state = await openIdleConversation(hob);
      const compact = vi.spyOn(state.session!, "compact").mockResolvedValue(undefined as never);
      await hob.runtime.router.compactIdleSessions(Date.now() + IDLE_COMPACTION_IDLE_MS / 2);
      expect(compact).not.toHaveBeenCalled();

      vi.spyOn(state.session!, "getContextUsage").mockReturnValue({ ...context, tokens: IDLE_COMPACTION_TOKEN_THRESHOLD });
      await hob.runtime.router.compactIdleSessions(Date.now() + IDLE_COMPACTION_IDLE_MS);
      expect(compact).not.toHaveBeenCalled();
    } finally {
      hob.close();
    }
  });

  it.each(["running", "queued", "waiting"] as const)("有 %s 任务时不整理", async (status) => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const state = await openIdleConversation(hob);
      const compact = vi.spyOn(state.session!, "compact").mockResolvedValue(undefined as never);
      hob.runtime.store.saveJob(activeJob(`job-${status}`, status));
      await hob.runtime.router.compactIdleSessions(Date.now() + IDLE_COMPACTION_IDLE_MS);
      expect(compact).not.toHaveBeenCalled();
    } finally {
      hob.close();
    }
  });

  it("有进行中的转交或待答问题时不整理", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const state = await openIdleConversation(hob);
      const compact = vi.spyOn(state.session!, "compact").mockResolvedValue(undefined as never);
      const now = new Date().toISOString();
      hob.runtime.store.saveDelegation({ id: "dg-idle", from: "hob", to: "other", text: "交接", createdAt: now, status: "running", jobIds: [] });
      await hob.runtime.router.compactIdleSessions(Date.now() + IDLE_COMPACTION_IDLE_MS);
      expect(compact).not.toHaveBeenCalled();

      hob.runtime.store.saveDelegation({ id: "dg-idle", from: "hob", to: "other", text: "交接", createdAt: now, status: "done", jobIds: [], endedAt: now });
      const approval: Approval = {
        id: "approval-idle",
        assistantId: "hob",
        title: "要继续吗？",
        options: [{ key: "A", label: "继续" }],
        status: "pending",
        source: "router",
        createdAt: now,
      };
      hob.runtime.store.saveApproval(approval);
      await hob.runtime.router.compactIdleSessions(Date.now() + IDLE_COMPACTION_IDLE_MS);
      expect(compact).not.toHaveBeenCalled();
    } finally {
      hob.close();
    }
  });

  it("群会话只看本群的任务，不受助手单聊任务影响", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "测试群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const single = await openIdleConversation(hob);
      const member = await openIdleConversation(hob, group.id);
      const singleCompact = vi.spyOn(single.session!, "compact").mockResolvedValue(undefined as never);
      const memberCompact = vi.spyOn(member.session!, "compact").mockResolvedValue(undefined as never);
      const future = Date.now() + IDLE_COMPACTION_IDLE_MS;

      hob.runtime.store.saveJob(activeJob("single-job", "running"));
      await hob.runtime.router.compactIdleSessions(future);
      expect(singleCompact).not.toHaveBeenCalled();
      expect(memberCompact).toHaveBeenCalledTimes(1);

      hob.runtime.store.saveJob({ ...activeJob("single-job", "done"), endedAt: new Date().toISOString() });
      hob.runtime.store.saveJob(activeJob("group-job", "running", group.id));
      await hob.runtime.router.compactIdleSessions(future);
      expect(singleCompact).toHaveBeenCalledTimes(1);
      expect(memberCompact).toHaveBeenCalledTimes(1);
    } finally {
      hob.close();
    }
  });

  it("整理进行中收到新消息时等待整理完成，消息不丢", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const state = await openIdleConversation(hob);
      let release!: () => void;
      const compact = vi.spyOn(state.session!, "compact").mockImplementation(() => new Promise((resolve) => { release = () => resolve(undefined as never); }));
      const scan = hob.runtime.router.compactIdleSessions(Date.now() + IDLE_COMPACTION_IDLE_MS);
      await waitFor(() => compact.mock.calls.length === 1);

      hob.faux.setResponses([text("新回复")]);
      const send = hob.runtime.router.send("hob", { text: "整理期间的新消息" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(hob.faux.getPendingResponseCount()).toBe(1);
      release();
      await scan;
      await send;
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.router.items("hob").items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "user", text: "整理期间的新消息" }),
        expect.objectContaining({ kind: "assistant", text: "新回复" }),
      ]));
    } finally {
      hob.close();
    }
  });

  it("重启后第一次打开闲置会话时先整理再处理消息", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await openIdleConversation(hob);
      ageSession(hob.runtime.store.routerFile("hob"));
      hob.runtime.router.disposeAll();
      const open = mockOpenedSessions(hob);
      hob.faux.setResponses([text("重启后的回复")]);
      const state = await hob.runtime.router.ensure("hob");
      expect(open).toHaveBeenCalledTimes(1);
      expect(state.session!.compact).toHaveBeenCalledTimes(1);
      await hob.runtime.router.send("hob", { text: "重启后的消息" });
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.router.items("hob").items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", text: "重启后的回复" }),
      ]));
    } finally {
      hob.close();
    }
  });

  it("已经从内存里放掉的会话，定时检查按会话文件找到并整理；文件没变不再打开", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = hob.runtime.groups.create({ name: "测试群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      await openIdleConversation(hob);
      await openIdleConversation(hob, group.id);
      ageSession(hob.runtime.store.routerFile("hob"));
      ageSession(hob.runtime.store.groupMemberFile(group.id, "hob"));
      hob.runtime.router.disposeAll();
      const open = mockOpenedSessions(hob);

      await hob.runtime.router.compactIdleSessions();
      expect(open).toHaveBeenCalledTimes(2);
      expect((await hob.runtime.router.ensure("hob")).session!.compact).toHaveBeenCalledTimes(1);
      expect((await hob.runtime.router.ensure("hob", group.id)).session!.compact).toHaveBeenCalledTimes(1);

      hob.runtime.router.disposeAll();
      await hob.runtime.router.compactIdleSessions();
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      hob.close();
    }
  });
});
