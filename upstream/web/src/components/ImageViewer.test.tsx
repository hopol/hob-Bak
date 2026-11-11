import { describe, expect, it } from "vitest";
import { clampView, fitScale } from "./ImageViewer.tsx";

const area = { w: 1000, h: 800 };

describe("看大图的铺开和边界", () => {
  it("整张放进屏幕，小图最多放大两倍，长图按宽度铺开", () => {
    expect(fitScale({ w: 4000, h: 3000 }, area)).toBeCloseTo(968 / 4000);
    expect(fitScale({ w: 100, h: 50 }, area)).toBe(2);
    expect(fitScale({ w: 900, h: 9000 }, area)).toBe(1);
  });

  it("比屏幕小的方向居中，比屏幕大的方向不拖出空白", () => {
    expect(clampView({ s: 1, x: 300, y: 50 }, { w: 400, h: 2000 }, area)).toEqual({ s: 1, x: 300, y: 0 });
    expect(clampView({ s: 1, x: 0, y: -5000 }, { w: 400, h: 2000 }, area)).toEqual({ s: 1, x: 300, y: -1200 });
  });
});
