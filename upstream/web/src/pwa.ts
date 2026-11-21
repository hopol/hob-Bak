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
        // sw.js 每次构建都一样，浏览器查不出「有新版本」；手机主屏应用又能在内存里一挂好几天。
        // 所以回到前台时取一次服务器上的首页，入口脚本换了就提示刷新
        const current = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute("src") ?? "";
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState !== "visible") return;
          void fetch("/", { cache: "no-store" })
            .then((response) => (response.ok ? response.text() : ""))
            .then((html) => { if (newerBuild(html, current)) markUpdateReady(); })
            .catch(() => undefined);
        });
      })
      .catch(() => {
        // 注册失败就当普通网页用，不弹任何东西
      });
  });
}

/** 服务器上的首页引用的入口脚本和正在跑的不一样：有新构建了。 */
export function newerBuild(html: string, current: string): boolean {
  const latest = html.match(/<script[^>]*type="module"[^>]*src="([^"]*\/assets\/[^"]+)"/)?.[1];
  return !!latest && !!current && latest !== current;
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
