import { describe, expect, it } from "vitest";
import { isSentAs, pendingItem, type PendingMessage } from "../src/outbox.ts";

const base: PendingMessage = {
  localId: "local-1",
  assistantId: "hob",
  at: "2026-11-03T04:00:00.000Z",
  text: "我吃的啥",
  attachments: [
    { id: "a1", name: "饭.jpg", status: "uploading" },
    { id: "a2", name: "报告.pdf", path: "/h/uploads/u-abcdef-报告.pdf", status: "done" },
  ],
  status: "sending",
};

describe("发件箱", () => {
  it("待发消息画成用户消息：没传好的附件用带原名的占位路径", () => {
    expect(pendingItem(base)).toEqual({
      kind: "user",
      id: "local-1",
      at: base.at,
      text: "我吃的啥",
      files: ["pending/a1/饭.jpg", "/h/uploads/u-abcdef-报告.pdf"],
    });
    expect(pendingItem({ ...base, attachments: [] }).files).toBeUndefined();
  });

  it("服务端推来同一条（字和附件都一样）才算发出去了", () => {
    const sent = { ...base, attachments: base.attachments.map((a, i) => ({ ...a, path: `/h/uploads/${i}`, status: "done" as const })) };
    const item = { kind: "user" as const, id: "e1", at: base.at, text: "我吃的啥", files: ["/h/uploads/0", "/h/uploads/1"] };
    expect(isSentAs(sent, item)).toBe(true);
    expect(isSentAs(sent, { ...item, text: "别的" })).toBe(false);
    expect(isSentAs(sent, { ...item, files: ["/h/uploads/0"] })).toBe(false);
    // 已经标了未送达的不再被顶替；还没传完的附件对不上
    expect(isSentAs({ ...sent, status: "failed" }, item)).toBe(false);
    expect(isSentAs(base, item)).toBe(false);
  });
});
