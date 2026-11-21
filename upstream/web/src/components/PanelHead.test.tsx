import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ page: "main", panelStack: [] as unknown[] }));
vi.mock("../store.ts", () => ({ useApp: () => state, backPanel: vi.fn(), closePanelPages: vi.fn(), closeSheet: vi.fn(), collapsePanel: vi.fn() }));
import { PanelHead } from "./PanelHead.tsx";

it("主界面叠层保留返回，隐藏旧关闭入口并在最后提供收起右栏", () => {
  state.page = "main";
  state.panelStack = [{ kind: "job" }, { kind: "file" }];
  const html = renderToStaticMarkup(<PanelHead close><button title="切换全宽" /></PanelHead>);
  expect(html.match(/aria-label="收起右栏"/g)).toHaveLength(1);
  expect(html).toContain('class="hob-icon-btn panel-close panel-legacy-close"');
  expect(html.indexOf('title="切换全宽"')).toBeLessThan(html.indexOf('aria-label="收起右栏"'));
});

it("设置页覆盖层保留原关闭按钮，不出现收起右栏", () => {
  state.page = "settings";
  state.panelStack = [{}, {}];
  const html = renderToStaticMarkup(<PanelHead close />);
  expect(html).toContain('title="关闭"');
  expect(html).not.toContain('收起右栏');
  expect(html).not.toContain('panel-legacy-close');
});
