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

  it("有新版本时在 Hob 版本下面显示提示和 Release 链接", () => {
    const html = renderToStaticMarkup(
      <AboutView about={{ version: "1.14.0", home: "/data", update: { status: "available", latest: "1.15.0" } }} />,
    );
    expect(html).toContain("有新版本 1.15.0");
    expect(html).toContain("查看更新内容");
    expect(html).toContain('href="https://github.com/FFatTiger/hob/releases/tag/v1.15.0"');
    expect(html.indexOf(">Hob 版本<")).toBeLessThan(html.indexOf("有新版本 1.15.0"));
    expect(html.indexOf("有新版本 1.15.0")).toBeLessThan(html.indexOf(">数据目录<"));
  });

  it("已是最新时显示已是最新版本，不出现更新链接", () => {
    const html = renderToStaticMarkup(
      <AboutView about={{ version: "1.14.0", home: "/data", update: { status: "up-to-date", latest: "1.14.0" } }} />,
    );
    expect(html).toContain("已是最新版本");
    expect(html).not.toContain("查看更新内容");
    expect(html).not.toContain("releases/tag");
  });

  it("检查失败时如实显示原因，不冒充成最新", () => {
    const html = renderToStaticMarkup(
      <AboutView about={{ version: "1.14.0", home: "/data", update: { status: "error", error: "请求超时" } }} />,
    );
    expect(html).toContain("检查更新失败：请求超时");
    expect(html).not.toContain("已是最新版本");
    expect(html).not.toContain("查看更新内容");
  });
});
