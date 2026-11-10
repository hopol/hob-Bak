import { describe, expect, it } from "vitest";
import { plainText } from "../../shared/plain-text.ts";

describe("Markdown 收成一行纯文字", () => {
  it.each([
    ["好的，这桌像**长沙风味的湘菜**。", "好的，这桌像长沙风味的湘菜。"],
    ["## 结论\n\n- 第一条\n- 第二条", "结论 第一条 第二条"],
    ["1. **两层架构。** Router 长期在线\n2. 全双工", "两层架构。 Router 长期在线 全双工"],
    ["把同步 `run()` 换成 `start()`", "把同步 run() 换成 start()"],
    ["看 [文档](https://example.com) 和 ![图](a.png)", "看 文档 和 图"],
    ["> 引用的话\n正文", "引用的话 正文"],
    ["*斜体* 和 _也是斜体_ 还有 ~~删掉~~", "斜体 和 也是斜体 还有 删掉"],
    ["| 方式 | 能改 |\n| --- | --- |\n| 文件 | 能 |", "方式 能改 文件 能"],
    ["```js\nconst a = 1;\n```", "const a = 1;"],
    ["- [x] 已完成\n- [ ] 没做", "已完成 没做"],
    ["上面\n\n---\n\n下面", "上面 下面"],
  ])("%s", (md, text) => {
    expect(plainText(md)).toBe(text);
  });

  it("不在词边上的记号不动：snake_case、乘号、价格", () => {
    expect(plainText("改 user_id 和 max_size")).toBe("改 user_id 和 max_size");
    expect(plainText("3 * 4 = 12")).toBe("3 * 4 = 12");
    expect(plainText("价格是 $5 和 $10")).toBe("价格是 $5 和 $10");
  });
});
