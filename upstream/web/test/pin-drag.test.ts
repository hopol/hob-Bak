import { describe, expect, it } from "vitest";
import { dropIndex, moveItem, reorderAt, type Box } from "../src/pin-drag.ts";

/** 三列网格，每格 100×80：第 i 格的位置和界面量出来的一样。 */
function grid(count: number): Box[] {
  return Array.from({ length: count }, (_, i) => ({ left: (i % 3) * 100, top: Math.floor(i / 3) * 80, width: 100, height: 80 }));
}

/** 格子中心。 */
function center(boxes: Box[], i: number) {
  return { x: boxes[i].left + boxes[i].width / 2, y: boxes[i].top + boxes[i].height / 2 };
}

describe("换成新的先后", () => {
  it("往后挪：中间的依次往前让", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("往前挪：中间的依次往后让", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("挪到原处还回原数组", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 1, 1)).toBe(list);
  });

  it("越界停在两头，不丢东西", () => {
    expect(moveItem(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, -3)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 5, 0)).toEqual(["a", "b", "c"]);
  });
});

describe("指针落在哪一格", () => {
  const boxes = grid(5);

  it("指着哪格的中心就选哪格", () => {
    boxes.forEach((_, i) => {
      const { x, y } = center(boxes, i);
      expect(dropIndex(boxes, x, y)).toBe(i);
    });
  });

  it("过中线才算换到下一格", () => {
    const [left, right] = [center(boxes, 0), center(boxes, 1)];
    const mid = (left.x + right.x) / 2;
    expect(dropIndex(boxes, mid - 1, 40)).toBe(0);
    expect(dropIndex(boxes, mid + 1, 40)).toBe(1);
  });

  it("第二行也认得出来", () => {
    expect(dropIndex(boxes, 50, 120)).toBe(3);
    expect(dropIndex(boxes, 150, 120)).toBe(4);
  });

  it("没有格子时给 -1", () => {
    expect(dropIndex([], 10, 10)).toBe(-1);
  });
});

describe("拖动时换位", () => {
  const ids = ["a", "b", "c", "d"];

  it("拖到右边的格子上就换过去", () => {
    const boxes = grid(4);
    expect(reorderAt(ids, boxes, "a", center(boxes, 2).x, center(boxes, 2).y)).toEqual(["b", "c", "a", "d"]);
  });

  it("往回拖也成立", () => {
    const boxes = grid(4);
    expect(reorderAt(ids, boxes, "d", center(boxes, 0).x, center(boxes, 0).y)).toEqual(["d", "a", "b", "c"]);
  });

  it("还在自己这一格就不动", () => {
    const boxes = grid(4);
    expect(reorderAt(ids, boxes, "b", center(boxes, 1).x, center(boxes, 1).y)).toBe(ids);
  });

  it("拖的是不在这排里的助手就原样还回", () => {
    expect(reorderAt(ids, grid(4), "zz", 10, 10)).toBe(ids);
  });
});
