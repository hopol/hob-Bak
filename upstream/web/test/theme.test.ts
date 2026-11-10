import { describe, expect, it } from "vitest";
import { resolveTheme, statusSurface } from "../src/theme.ts";

describe("主题和状态栏", () => {
  it.each([
    ["light", false, false, "#f6f6f4"],
    ["light", true, false, "#f6f6f4"],
    ["dark", false, true, "#1b1b1d"],
    ["dark", true, true, "#1b1b1d"],
    ["system", false, false, "#f6f6f4"],
    ["system", true, true, "#1b1b1d"],
  ] as const)("%s / 系统深色 %s", (theme, systemDark, dark, color) => {
    expect(resolveTheme(theme, systemDark)).toEqual({ dark, color });
  });

  it("根据页面、覆盖层和屏幕宽度选择顶栏颜色", () => {
    const main = { phase: "ready", page: "main", sheet: false, panelStack: [] } as const;
    expect(statusSurface(main, false)).toBe("side");
    expect(statusSurface(main, true)).toBe("bg");
    expect(statusSurface({ ...main, page: "settings" }, false)).toBe("bg");
    expect(statusSurface({ ...main, page: "settings" }, true)).toBe("bg");
    expect(statusSurface({ ...main, page: "knowledge" }, false)).toBe("bg");
    expect(statusSurface({ ...main, page: "knowledge", sheet: true }, true)).toBe("bg");
    expect(statusSurface({ ...main, sheet: true }, true)).toBe("panel");
    expect(statusSurface({ ...main, sheet: true, panelStack: [{ kind: "job" }] }, true)).toBe("bg");
    expect(statusSurface({ ...main, panelStack: [{ kind: "file", full: true }] }, false)).toBe("bg");
    expect(statusSurface({ ...main, phase: "loading" }, true)).toBe("bg");
    expect(statusSurface({ ...main, phase: "loading" }, false)).toBe("side");
  });
});
