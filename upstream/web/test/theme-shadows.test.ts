import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("浅色与深色各自保留输入框和跳转按钮的阴影颜色", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  expect(css).toMatch(/--composer-shadow:\s*rgba\(0,\s*0,\s*0,\s*0\.08\)/);
  expect(css).toMatch(/--composer-shadow:\s*rgba\(0,\s*0,\s*0,\s*0\.45\)/);
  expect(css).toMatch(/--jump-shadow:\s*rgba\(0,\s*0,\s*0,\s*0\.12\)/);
  expect(css).toMatch(/--jump-shadow:\s*rgba\(0,\s*0,\s*0,\s*0\.5\)/);
});
