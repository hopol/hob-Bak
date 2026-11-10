#!/usr/bin/env node
// 票 55 登录保持测试用的本地小站点：/set 设置随机 cookie 并返回其值，/read 回显收到的 Cookie 头。
// 只在宿主上短期跑给容器里的 Chromium 访问（容器要加 --add-host=host.docker.internal:host-gateway）。
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 30298);
http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/set") {
      const v = crypto.randomBytes(8).toString("hex");
      res.writeHead(200, { "set-cookie": `hob=${v}; Path=/; Max-Age=3600`, "content-type": "text/plain" });
      res.end(v);
    } else if (u.pathname === "/read") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cookie: req.headers.cookie || "" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(PORT, "0.0.0.0", () => console.log(`cookieweb: 0.0.0.0:${PORT}`));
