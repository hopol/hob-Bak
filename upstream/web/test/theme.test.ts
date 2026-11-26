import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTheme, statusSurface, updateManifest, updateStatusColor } from "../src/theme.ts";

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

  it("配色切换时状态栏取当前底色，不读过渡中的旧背景", () => {
    const meta = { getAttribute: () => "#151113", setAttribute: vi.fn() };
    const vars = new Map<string, string>();
    const root = { style: { setProperty: vi.fn((name: string, value: string) => vars.set(name, value)), getPropertyValue: (name: string) => vars.get(name) ?? "" }, classList: { contains: () => true }, getAttribute: () => "rose" };
    vi.stubGlobal("document", { documentElement: root, querySelector: () => meta });
    const computed = vi.fn(() => ({
      getPropertyValue: (name: string) => name === "--bg" ? "#121117" : "rgb(18, 17, 23)",
      backgroundColor: "rgb(18, 17, 23)",
    }));
    vi.stubGlobal("getComputedStyle", computed);
    updateStatusColor({ phase: "ready", page: "settings", sheet: false, panelStack: [] }, true);
    expect(meta.setAttribute).toHaveBeenCalledWith("content", "#121117");
    // 底色、深浅、配色都没变：不再写根元素变量，也不逼浏览器重算整页样式
    updateStatusColor({ phase: "ready", page: "settings", sheet: false, panelStack: [{ kind: "job" }] }, true);
    expect(root.style.setProperty).toHaveBeenCalledTimes(1);
    expect(computed).toHaveBeenCalledTimes(1);
  });

  it("按深浅主题换 manifest：iOS 的启动屏和状态栏颜色只认它", () => {
    const link = { setAttribute: vi.fn() };
    vi.stubGlobal("document", { getElementById: () => link });
    updateManifest(true);
    expect(link.setAttribute).toHaveBeenCalledWith("href", "/manifest-dark.webmanifest?v=4");
    updateManifest(false);
    expect(link.setAttribute).toHaveBeenCalledWith("href", "/manifest.webmanifest?v=4");
  });

  it("页面上没有 manifest 链接时不出错", () => {
    vi.stubGlobal("document", { getElementById: () => null });
    expect(() => updateManifest(true)).not.toThrow();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("toHex", () => {
  it("theme-color 写成 #rrggbb（iPhone 主屏应用认不了 rgb()）", async () => {
    const { toHex } = await import("../src/theme.ts");
    expect(toHex("rgb(21, 21, 22)")).toBe("#151516");
    expect(toHex("rgba(255, 255, 255, 1)")).toBe("#ffffff");
    expect(toHex("#1b1b1d")).toBe("#1b1b1d");
  });
});

describe("isNarrow", () => {
  it("iPhone 冷启动时 innerWidth 还是 980，按屏幕宽度认成手机", async () => {
    const { isNarrow } = await import("../src/theme.ts");
    vi.stubGlobal("window", { innerWidth: 980, screen: { width: 402 } });
    expect(isNarrow()).toBe(true);
    vi.stubGlobal("window", { innerWidth: 1280, screen: { width: 1440 } });
    expect(isNarrow()).toBe(false);
    vi.unstubAllGlobals();
  });
});
