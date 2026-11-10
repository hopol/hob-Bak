import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../src/clipboard.ts";

// 带下划线的路径、代码、加粗、引用：复制时一个字符都不能删
const RAW = "**结论**\n\n- 看 `client/src/runtime/store.ts`\n- 路径 a_b_c 和 __init__.py\n- 提到 [文档](https://example.com/x_y)\n\n> 引用 #1";

afterEach(() => vi.unstubAllGlobals());

describe("复制", () => {
  it("复制的是原文，Markdown 标记和下划线一个字符不少", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText(RAW)).toBe(true);
    expect(writeText).toHaveBeenCalledWith(RAW);
  });

  it("没有剪贴板时返回 false", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyText(RAW)).toBe(false);
  });

  it("剪贴板拒绝写入时也返回 false", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText(RAW)).toBe(false);
  });
});
