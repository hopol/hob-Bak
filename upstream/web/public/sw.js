// Hob 的 service worker（手写，无依赖）：只缓存界面壳和带哈希的静态文件，/api 一律走网络。
// 升级不打断用户：新版本装好后等页面提示「有新版本 · 刷新」，点了才 skipWaiting。
const CACHE = "hob-shell-v4"; // 图标或壳变了就加一，旧缓存在 activate 时删掉
// 图标和 manifest 不进缓存：系统添加到主屏幕时要拿到的是服务器上最新的那一份

self.addEventListener("install", (event) => {
  event.waitUntil(
    precache().then(() => {
      // 第一次装（之前没有 SW 在管）直接接管；已有旧版本就等用户点刷新
      if (!self.registration.active) return self.skipWaiting();
      return undefined;
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") void self.skipWaiting();
});

// 装的时候就把壳和构建产物一起缓存下来：构建后的文件名带哈希，从 index.html 里抠出来
async function precache() {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch("/", { cache: "reload" });
    if (!response.ok) return;
    const html = await response.clone().text();
    await cache.put("/", response.clone());
    const urls = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]));
    await Promise.all(
      [...urls].map(async (url) => {
        const asset = await fetch(url);
        if (asset.ok) await cache.put(url, asset);
      }),
    );
  } catch {
    // 离线时装不上就先有壳，等联网后再缓存
  }
}

function isStatic(pathname) {
  return (
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/fonts/")
  );
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// 导航：先走网络拿最新的 index.html，断网时用缓存里的界面壳
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put("/", response.clone());
    return response;
  } catch {
    const hit = (await cache.match(request)) || (await cache.match("/"));
    if (hit) return hit;
    return new Response("连不上 Hob，而且这台设备还没有缓存过界面。", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 一律不拦：接口要实时的，缓存了就是给用户看假数据
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isStatic(url.pathname)) event.respondWith(cacheFirst(request));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || "Hob";
  const target = payload.url || "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/favicon-32.png",
      data: { url: target },
      tag: target,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (!client.url.startsWith(self.location.origin)) continue;
        await client.focus();
        if (client.navigate) await client.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
