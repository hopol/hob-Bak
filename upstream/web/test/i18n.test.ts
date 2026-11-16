import { describe, expect, it } from "vitest";
import { currentLocale, localeFromBrowser, setLocale, t } from "../../shared/i18n.ts";

describe("翻译函数", () => {
  it("替换占位符并在缺少英文词条时回退中文", () => {
    setLocale("en");
    expect(t("有事跟{assistant}说，它来安排", { assistant: "Hob" })).toBe("Tell Hob what you need and it will arrange it");
    expect(t("未收录的中文 {name}", { name: "值" })).toBe("未收录的中文 值");
  });

  it("按 n 选择英文单复数", () => {
    setLocale("en");
    expect(t("{n} 次操作", { n: 1 })).toBe("1 action");
    expect(t("{n} 次操作", { n: 2 })).toBe("2 actions");
  });

  it("恢复默认语言后仍可输出中文", () => {
    setLocale("zh-CN");
    expect(currentLocale()).toBe("zh-CN");
    expect(t("保存")).toBe("保存");
  });

  it("浏览器语言只看首选", () => {
    expect(localeFromBrowser(["zh-CN", "en"])).toBe("zh-CN");
    expect(localeFromBrowser(["en-US", "zh-CN"])).toBe("en");
    expect(localeFromBrowser([])).toBe("en");
  });
});
