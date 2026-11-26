// 假云桌面：desktopd 的 HTTP / WebSocket 接口里 Hob 真正会用到的那几个，CDP 连接转给一个本机 Chrome 的调试口。
// 浏览器由调用方自己起（google-chrome --remote-debugging-port=… --user-data-dir=$(mktemp -d) …），这里不启动、不关闭它。
// 用法：node fake-desktopd.mjs --port 31883 --cdp http://127.0.0.1:31881 --token <令牌>
// 或 import { startFakeDesktopd } 后 await startFakeDesktopd({ cdp, token })。
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

/** 和 desktopd 的 /api/health、/api/events 一样的屏幕快照。 */
function screenList(screens) {
  return screens.map((id) => ({ id, running: true, browserRunning: true, viewers: 0, lastActiveAt: new Date().toISOString() }));
}

export async function startFakeDesktopd({ port = 0, host = "127.0.0.1", cdp, token, screens = ["hob"] } = {}) {
  if (!cdp || !token) throw new Error("startFakeDesktopd 需要 cdp（Chrome 调试口地址）和 token");
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: { code: "unauthorized", message: "缺 Bearer 令牌" } });
    if (req.method === "GET" && pathname === "/api/health") {
      return json(res, 200, { version: "fake", display: { width: 1280, height: 800 }, browser: "chrome", screens: screenList(screens) });
    }
    const route = /^\/api\/screens\/([a-z0-9-]{1,64})\/(start|stop|browser\/(?:start|stop|focus|sync))$/.exec(pathname);
    if (route && req.method === "POST") {
      const [, id, action] = route;
      if (action === "browser/start") return json(res, 200, { cdp: `/cdp/${id}` });
      return json(res, 200, {});
    }
    return json(res, 404, { error: { code: "not_found", message: `假云桌面没有这个接口：${req.method} ${pathname}` } });
  });
  server.on("upgrade", (req, socket, head) => {
    const deny = (status, message) => {
      if (socket.destroyed) return;
      socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (req.headers.authorization !== `Bearer ${token}`) return deny(401, "Unauthorized");
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/events") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: "screens", screens: screenList(screens) }));
        ws.on("error", () => {});
      });
      return;
    }
    const match = /^\/cdp\/([a-z0-9-]{1,64})$/.exec(pathname);
    if (!match) return deny(404, "Not Found");
    // 和 desktopd 一样：/cdp/<屏幕> 整条转给浏览器的调试 WebSocket（Playwright 的 connectOverCDP 要浏览器级端点）
    fetch(`${cdp}/json/version`).then((response) => response.json()).then((version) => {
      if (socket.destroyed) return;
      if (typeof version.webSocketDebuggerUrl !== "string") return deny(502, "Bad Gateway");
      const upstream = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
      upstream.once("error", () => deny(502, "Bad Gateway"));
      upstream.once("open", () => {
        if (socket.destroyed) { upstream.close(); return; }
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("message", (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); });
          upstream.on("message", (data, binary) => { if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary }); });
          const close = () => { ws.close(); upstream.close(); };
          ws.once("close", close);
          ws.once("error", close);
          upstream.once("close", close);
          upstream.once("error", close);
        });
      });
    }).catch(() => deny(502, "Bad Gateway"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "31883" }, cdp: { type: "string", default: "http://127.0.0.1:31881" }, token: { type: "string", default: "fake-desktop-token" } } });
  const { url } = await startFakeDesktopd({ port: Number(values.port), cdp: values.cdp, token: values.token });
  console.log(`假云桌面 ${url} → CDP ${values.cdp}`);
}
