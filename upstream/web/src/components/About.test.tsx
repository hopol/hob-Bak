import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// 关于页只读 /api/about，渲染时不需要真的 store
vi.mock("../store.ts", () => ({ loadAbout: vi.fn() }));
vi.mock("./Markdown.tsx", () => ({ Markdown: () => null }));

import { AboutView } from "./Settings.tsx";

const page = () => renderToStaticMarkup(<AboutView about={{ version: "1.5.0", home: "/data" }} />);

describe("设置页的关于", () => {
  it("带一个指向仓库的 GitHub 入口，点击在新窗口打开", () => {
    const html = page();
    expect(html).toContain('href="https://github.com/FFatTiger/hob"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain(">GitHub</span>");
    expect(html).toContain("FFatTiger/hob");
  });

  it("图标是内联 SVG，除了仓库地址不再引用外部资源", () => {
    const html = page();
    expect(html).not.toContain("<img");
    expect(html).toContain('<path fill="currentColor" stroke="none"');
    expect(html.match(/https?:\/\//g)).toHaveLength(1);
  });

  it("版本信息未读取到时只显示提示，不显示入口", () => {
    const html = renderToStaticMarkup(<AboutView about={null} />);
    expect(html).toContain("正在读取版本信息");
    expect(html).not.toContain("github.com");
  });
});
