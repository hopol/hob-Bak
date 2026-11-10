import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startHistory } from "./history.ts";
import { registerServiceWorker } from "./pwa.ts";
// 文件预览里的文档排版用 GitHub 的样式表；颜色在 styles.css 里换成 Hob 自己的
import "github-markdown-css/github-markdown.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

// 手机上侧滑 / 返回键退回上一层页面
startHistory();

// iOS Safari 不认 user-scalable=no：双指缩放在这里拦掉，页面像 App 一样固定
document.addEventListener("gesturestart", (event) => event.preventDefault());

// 只在生产构建里注册：开发时免得 Vite 的热更新被缓存的旧壳挡住
if (import.meta.env.PROD) registerServiceWorker();
