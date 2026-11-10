// 生产构建里注册 service worker：新版本装好后只提示，点了才接管并刷新。
import { markUpdateReady } from "./store.ts";

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        const watch = (worker: ServiceWorker | null) => {
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            // 已经有 SW 在管页面 = 这次是升级，等用户点「有新版本 · 刷新」
            if (worker.state === "installed" && navigator.serviceWorker.controller) markUpdateReady();
          });
        };
        watch(registration.installing);
        registration.addEventListener("updatefound", () => watch(registration.installing));
      })
      .catch(() => {
        // 注册失败就当普通网页用，不弹任何东西
      });
  });
}

/** 点了「刷新」：让新 SW 立刻接管，接管完刷新页面。 */
export async function applyUpdate(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    location.reload();
    return;
  }
  let reloaded = false;
  const reload = () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
  const registration = await navigator.serviceWorker.getRegistration();
  registration?.waiting?.postMessage("skip-waiting");
  // 有的浏览器接管了也不发 controllerchange：不能让「刷新」点了没反应
  setTimeout(reload, 1200);
}
