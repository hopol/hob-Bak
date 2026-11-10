import { defineConfig } from "vitest/config";

// 测试在仓库根跑（vite.config.ts 的 root 是 web，这里不跟着走）
export default defineConfig({
  test: {
    root: ".",
    include: ["server/test/**/*.test.ts", "web/test/**/*.test.ts", "web/src/**/*.test.tsx"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
