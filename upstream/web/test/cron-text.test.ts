import { describe, expect, it } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import { cronListText, cronText, timePointText } from "../src/util.ts";

describe("执行时间的显示", () => {
  it("具体时间点说成「11月8日 09:00（一次）」，跨年的带年份", () => {
    const year = new Date().getFullYear();
    expect(cronText(`${year}-11-08T09:00`)).toBe("11月8日 09:00（一次）");
    expect(cronText(`${year + 1}-01-08T09:30`)).toBe(`${year + 1}年1月8日 09:30（一次）`);
    expect(timePointText(`${year}-11-08T09:00:30`)).toBe("11月8日 09:00");
    expect(cronText("0 9 * * *")).toBe("每天 09:00");
  });

  it("英文按 24 小时制显示", () => {
    setLocale("en");
    const year = new Date().getFullYear();
    expect(cronText(`${year}-11-08T09:00`)).toBe("Nov 8 09:00 (once)");
    expect(cronText("0 9 * * *")).toBe("Daily 09:00");
    expect(cronText("30 17 * * 5")).toBe("Fridays 17:30");
    expect(cronText("0 9 28 * *")).toBe("Monthly on the 28th 09:00");
    expect(cronText("*/15 * * * *")).toBe("Every 15 min");
    setLocale("zh-CN");
  });

  it("时间点和 cron 混着列出来", () => {
    const year = new Date().getFullYear();
    expect(cronListText([`${year}-11-08T09:00`, "0 21 * * *"])).toBe("11月8日 09:00（一次）、每天 21:00");
  });
});
