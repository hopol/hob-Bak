import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_PALETTE, PALETTE_IDS, PALETTE_SWATCHES, isPalette, paletteAttr, paletteOf } from "../src/palette.ts";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/**
 * 取某个选择器块里的 --变量，用来比对「代码里的色卡」和「样式表里的颜色」。
 * 同一个选择器可能出现不止一次（:root 开头还有一小块 --sidebar-inset），
 * 所以取带 --bg 的那一块，也就是定义整套颜色的那块。
 */
function block(selector: string): Record<string, string> {
  const escaped = selector.replace(/[[\]"]/g, (ch) => `\\${ch}`);
  const blocks = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))];
  const body = blocks.map((match) => match[1]).find((text) => /(^|[\s;])--bg\s*:/.test(text));
  if (!body) throw new Error(`样式表里找不到 ${selector} 的颜色块`);
  const vars: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const hit = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line);
    if (hit) vars[hit[1].slice(2)] = hit[2].trim();
  }
  return vars;
}

describe("配色主题", () => {
  it("默认配色不挂属性，其余每套都挂", () => {
    expect(paletteAttr("default")).toBeNull();
    for (const id of PALETTE_IDS.filter((entry) => entry !== "default")) expect(paletteAttr(id)).toBe(id);
  });

  it("存坏了或老设置没有这一项，都退回默认", () => {
    expect(paletteOf(undefined)).toBe(DEFAULT_PALETTE);
    expect(paletteOf("purple-nope")).toBe(DEFAULT_PALETTE);
    expect(paletteOf(42)).toBe(DEFAULT_PALETTE);
    expect(paletteOf("ocean")).toBe("ocean");
    expect(isPalette("rose")).toBe(true);
    expect(isPalette("default ")).toBe(false);
  });

  it("每套配色的浅色、深色在样式表里都写全了同一批变量", () => {
    const lightTokens = Object.keys(block(":root")).filter((name) => !name.startsWith("t-") && !name.startsWith("ease-"));
    const darkTokens = Object.keys(block(".dark"));
    for (const id of PALETTE_IDS.filter((entry) => entry !== "default")) {
      const light = block(`html[data-palette="${id}"]`);
      const dark = block(`html.dark[data-palette="${id}"]`);
      expect(Object.keys(light).sort(), `${id} 浅色少了变量`).toEqual(lightTokens.sort());
      expect(Object.keys(dark).sort(), `${id} 深色少了变量`).toEqual(darkTokens.sort());
    }
  });

  it("色卡上的两颗色点就是各套配色自己的 --accent", () => {
    const light0 = block(":root");
    for (const swatch of PALETTE_SWATCHES) {
      const dark = block(swatch.id === "default" ? ".dark" : `html.dark[data-palette="${swatch.id}"]`);
      // .dark 不重复写 --accent 时是沿用 :root 那个（默认配色就是这样）
      expect(dark.accent ?? light0.accent, `${swatch.id} 深色强调色对不上`).toBe(swatch.dark);
      const light = swatch.id === "default" ? light0 : block(`html[data-palette="${swatch.id}"]`);
      expect(light.accent, `${swatch.id} 浅色强调色对不上`).toBe(swatch.light);
    }
  });

  it("每套配色的正文字色和底色都拉开了对比", () => {
    // 正文和底色至少差 4.5:1（WCAG AA），免得某套配色在浅色下看不清字
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (x + 0.05) / (y + 0.05);
    };
    for (const id of PALETTE_IDS) {
      for (const [mode, vars] of [
        ["浅色", block(id === "default" ? ":root" : `html[data-palette="${id}"]`)],
        ["深色", block(id === "default" ? ".dark" : `html.dark[data-palette="${id}"]`)],
      ] as const) {
        expect(ratio(vars.text, vars.bg), `${id} ${mode} 正文字色太浅`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(vars.text2, vars.bg), `${id} ${mode} 次要字色太浅`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("换主题的过渡只在切换那一刻打开，系统要求少动效时直接关掉", () => {
    expect(css).toMatch(/html\.theme-switching[\s\S]*?transition:[\s\S]*?background-color 180ms/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]{0,400}?html\.theme-switching[\s\S]{0,200}?transition: none !important/);
  });
});
