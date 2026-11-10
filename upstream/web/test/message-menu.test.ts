import { describe, expect, it } from "vitest";
import { menuPosition, messageMenu, moveSwipe, swipeReply, type SwipeState } from "../src/message-menu.ts";

describe("消息长按菜单", () => {
  it("打开、切换和关闭", () => {
    expect(messageMenu(null, { type: "open", id: "a" })).toBe("a");
    expect(messageMenu("a", { type: "open", id: "b" })).toBe("b");
    expect(messageMenu("a", { type: "close" })).toBeNull();
  });

  it("点击菜单内部保留，点击外部关闭", () => {
    expect(messageMenu("a", { type: "outside", inside: true })).toBe("a");
    expect(messageMenu("a", { type: "outside", inside: false })).toBeNull();
  });
});

describe("长按菜单定位", () => {
  const area = { top: 50, bottom: 750, left: 0, right: 390 };
  it("优先贴在气泡下方，空间不足时放上方", () => {
    expect(menuPosition({ top: 200, bottom: 240, right: 250 }, area)).toEqual({ top: 248, left: 90 });
    expect(menuPosition({ top: 700, bottom: 740, right: 390 }, area)).toEqual({ top: 600, left: 222 });
  });
});

describe("滑动回复", () => {
  const start: SwipeState = { x: 100, y: 100, direction: "pending", distance: 0 };

  it("只识别向左且横向位移超过纵向 1.5 倍的手势", () => {
    expect(moveSwipe(start, 92, 100).direction).toBe("pending");
    expect(moveSwipe(start, 80, 90).direction).toBe("horizontal");
    expect(moveSwipe(start, 120, 100).direction).toBe("vertical");
    expect(moveSwipe(start, 90, 80).direction).toBe("vertical");
    expect(moveSwipe(start, 88, 90).direction).toBe("pending");
  });

  it("超过 48px 才回复，返回阈值内则取消", () => {
    const short = moveSwipe(start, 52, 100);
    expect(swipeReply(short)).toBe(false);
    const long = moveSwipe(short, 51, 100);
    expect(swipeReply(long)).toBe(true);
    expect(swipeReply(moveSwipe(long, 60, 100))).toBe(false);
  });
});
