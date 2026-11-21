import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Brief, splitBrief } from "./Brief.tsx";

describe("交接说明展示", () => {
  it("完整保留助手写的说明，不自动折叠任何段落", () => {
    const text = "要办成什么：整理第三章\n背景：已经查过目录\n用户的要求：“图表别动。”";
    expect(splitBrief(text)).toEqual({ main: text, recent: "" });
    expect(renderToStaticMarkup(<Brief text={text} />)).toBe(text);
  });

  it("长说明也原样显示", () => {
    const text = "背景：" + "字".repeat(500);
    expect(renderToStaticMarkup(<Brief text={text} />)).toBe(text);
  });
});
