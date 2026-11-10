// 临时验收代理：只在测试容器内运行，给 noVNC 注入桌面令牌。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const { WebSocket, WebSocketServer } = createRequire("/app/desktopd/package.json")("ws");
const root = "/novnc";
const token = process.env.DESKTOP_TOKEN || fs.readFileSync("/data/token", "utf8").trim();
const screen = process.env.HOBDESK_PROFILE || "a1";
const html = `<div id="wrap"><div id="screen"></div></div><script type="module">
import RFB from '/core/rfb.js';
const rfb = new RFB(document.getElementById('screen'), 'ws://' + location.host + '/vnc');
window.state = 'connecting';
rfb.addEventListener('connect', () => window.state = 'connected');
rfb.addEventListener('disconnect', e => { window.state = 'disconnected'; window.reason = JSON.stringify(e.detail); });
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === "/") return res.end(html);
  const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
  if (!file.startsWith(root + "/") || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": file.endsWith(".js") ? "application/javascript" : "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const upstream = new WebSocket(`ws://127.0.0.1:6080/vnc/${screen}`,  { headers: { Authorization: `Bearer ${token}` } });
  upstream.on("error", () => socket.destroy());
  upstream.on("open", () => wss.handleUpgrade(req, socket, head, client => {
    client.on("message", (data, binary) => upstream.send(data, { binary }));
    upstream.on("message", (data, binary) => client.send(data, { binary }));
    client.on("error", () => upstream.terminate());
    upstream.on("close", () => client.close());
    client.on("close", () => upstream.close());
  }));
});
server.listen(30196, "0.0.0.0");
