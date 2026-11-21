import { describe, expect, it, vi } from "vitest";

vi.mock("../src/store.ts", () => ({ markUpdateReady: () => undefined }));
const { newerBuild } = await import("../src/pwa.ts");

describe("newerBuild", () => {
  const page = (src: string) => `<head><script type="module" crossorigin src="${src}"></script></head>`;
  it("服务器上的入口脚本换了才算有新构建", () => {
    expect(newerBuild(page("/assets/index-B.js"), "/assets/index-A.js")).toBe(true);
    expect(newerBuild(page("/assets/index-A.js"), "/assets/index-A.js")).toBe(false);
  });
  it("取不到首页或者自己不是构建出来的页面，不提示", () => {
    expect(newerBuild("", "/assets/index-A.js")).toBe(false);
    expect(newerBuild(page("/assets/index-B.js"), "")).toBe(false);
  });
});
