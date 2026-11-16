import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Brief, splitBrief } from "./Brief.tsx";

// 和 server/src/router.ts 的 originalWordsText 同一个格式：原话、最近的对话、附件、备注，段与段之间空一行
const brief = [
  "用户原话（11月13日 09:30）：\n把上周的报销单整理成表。",
  "最近的对话：\n用户（09:20）：上周出差了三天\n记账（09:21）：好的，我记下了。\n\n第二段话",
  "附件：/tmp/receipts.zip",
  "Hob 的备注：只整理，不提交。",
].join("\n\n");

describe("交给任务和转来的话", () => {
  it("最近的对话折起来，原话、附件、备注照常显示", () => {
    const { main, recent } = splitBrief(brief);
    expect(main).toBe("用户原话（11月13日 09:30）：\n把上周的报销单整理成表。\n\n附件：/tmp/receipts.zip\n\nHob 的备注：只整理，不提交。");
    // 段头去掉了；对话里自己带空行的那句也还在折叠里
    expect(recent).toBe("用户（09:20）：上周出差了三天\n记账（09:21）：好的，我记下了。\n\n第二段话");
  });

  it("转来的话里套着转来的话：两段最近的对话都折起来，外面那层的备注还在", () => {
    const nested = `Hob 转来（11月13日 09:40）：\n${brief}\n\n最近的对话：\n用户（09:39）：顺便看看发票\n\n记账 的备注：先不动原件。`;
    const { main, recent } = splitBrief(nested);
    expect(main).toContain("Hob 的备注：只整理，不提交。");
    expect(main).toContain("记账 的备注：先不动原件。");
    expect(main).not.toContain("最近的对话");
    expect(recent).toContain("上周出差了三天");
    expect(recent).toContain("顺便看看发票");
  });

  it("转交时带过去的待办也折起来", () => {
    const carried = `${brief}\n\n「Hob」转交前列过的待办，没做完的：\n· 整理成表\n· 挑出重复`;
    const { main, recent } = splitBrief(carried);
    expect(main).not.toContain("转交前列过的待办");
    expect(recent).toContain("「Hob」转交前列过的待办，没做完的：\n· 整理成表");
  });

  it("没有最近的对话就原样显示，不出折叠", () => {
    expect(renderToStaticMarkup(<Brief text="查一下磁盘还剩多少。" />)).toBe("查一下磁盘还剩多少。");
    const html = renderToStaticMarkup(<Brief text={brief} />);
    expect(html).toContain('<details class="brief-recent"><summary>附带的背景</summary>');
  });
});
