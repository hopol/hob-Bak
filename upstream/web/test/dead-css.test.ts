import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("不保留已经移除控件的选择器", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  expect(css).not.toMatch(/sidebar-more|select\.pick|\.sched-edit select|\.when select/);
});
