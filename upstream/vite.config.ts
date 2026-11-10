import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// web 是前端根目录；开发时 /api 代理到 server（HOB_PORT，默认 30148）
export default defineConfig({
  root: "web",
  plugins: [react()],
  // 预打包依赖用 es2022：@novnc/novnc 顶层有 await，默认目标（chrome87 等）编不过
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  build: { outDir: "../dist/web", emptyOutDir: true, target: "es2022" },
  server: {
    port: Number(process.env.HOB_WEB_PORT ?? 5173),
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.HOB_PORT ?? 30148}`, changeOrigin: true } },
  },
});
