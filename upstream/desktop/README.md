# Hob 云桌面（hob-desktop）

Hob 的可选云桌面服务：一个容器按需为每个助手和公共屏幕 `public` 分别启动独立的 Xtigervnc、openbox、dock 和浏览器。浏览器登录状态保存在 `/data/profiles/<屏幕 id>`；容器启动时不预开屏幕。amd64 和 arm64 使用官方 Google Chrome；其他架构回退 Chromium，实际浏览器由 `/api/health` 报告。Hob 通过「地址 + 令牌」连接，观看画面也经 Hob 转发。

桌面带 dock：底部居中的 tint2 里有预装软件（浏览器 / 终端 / 文件 / 文本编辑 / 图片 / 计算器）、正在运行的窗口和时钟，背景是一张随镜像打包的壁纸，桌面上不放图标。

## 起停

```sh
cd desktop
docker compose up -d          # 默认只监听 127.0.0.1:6080
# 或不用 compose：
docker run -d --name hob-desktop -p 127.0.0.1:6080:6080 --shm-size=1g --stop-timeout=60 -v hob-desktop-data:/data ghcr.io/ffattiger/hob-desktop:latest
```

环境变量：`TZ`（IANA 时区名，默认 `UTC`）、`DESKTOP_LANG`（BCP 47 语言标签，默认 `zh-CN`，如 `en-US`、`ja-JP`）、`DESKTOP_RESOLUTION`（默认 `1280x800`）、`DESKTOP_TOKEN`（自定义令牌）、`DESKTOP_PORT`（容器内端口，默认 6080）、`DESKTOP_IDLE_MINUTES`（空闲回收分钟数，默认 30，允许小数）、`DESKTOP_MAX_SCREENS`（同时运行上限，默认 6）。时区、语言、分辨率一起决定桌面环境：网站会对照 IP 所在地、时区、语言和屏幕，出口不在国内就别把前三项留在默认值。`DESKTOP_LANG` 写法不合法，或镜像里做不出这个语言的 locale 时，容器启动就报错并说明原因，不会退回中文。有观看者或 CDP 连接的屏幕不会被回收；关闭屏幕保留登录数据。可用 `docker compose config` 检查配置。

## 令牌

首次启动自动生成（32 字节随机数，0600 存 `/data/token`）：

```sh
docker exec hob-desktop cat /data/token
```

在 Hob 的 设置 → 云桌面 里填：地址 `http://<这台机器>:6080` + 这个令牌。设了 `DESKTOP_TOKEN` 就以环境变量为准，`/data/token` 不再生成。

## 桌面

- dock（tint2）和壁纸由 desktopd 拉起：壁纸是一次性的 `hsetroot -fill`（按窗口比例裁切铺满，改分辨率也满屏），dock 挂了会在 2 秒后自动重启，都不是关键进程，不会让容器退出。配置在 `dock/` 和 `openbox/rc.xml`，随镜像走，不依赖 `/data/home` 里的用户配置。
- dock 的「浏览器」通过本机 desktopd 接口启动并置前当前屏幕的浏览器，复用相同 profile 和沙箱降级逻辑，不会创建另一份登录状态。
- 浏览器窗口类名为 `hob-<屏幕 id>`；标题定期补上「<屏幕 id> 的浏览器」，公共屏幕显示「公共浏览器」。
- 界面语言由 `DESKTOP_LANG` 定：dock、文件管理器、终端等所有程序的 `LANG`/`LANGUAGE`，浏览器界面语言（`--lang`），以及浏览器发给网站的 `Accept-Language` 和 `navigator.languages`（`--accept-lang`）。对应的 `xx_RR.UTF-8` 镜像里没有时，入口脚本启动时用 `localedef` 生成（要 root，生成完降回 `hob` 跑 desktopd）。已有的浏览器 profile 也按部署配置，用户在浏览器设置里自己改的语言会被盖掉。图标统一用 Adwaita。

## 安全

- 所有 HTTP / WebSocket 请求都要 `Authorization: Bearer <令牌>`（常量时间比较），不支持 URL 传令牌；VNC(5900) 和 CDP（随机端口）只监听容器内回环，不要映射它们。
- 令牌以明文走 HTTP，同一网络内可被嗅探：跨机器访问请走 HTTPS 反向代理或内网/隧道；默认端口只绑 `127.0.0.1`。
- 容器通过 Chromium 托管策略 `CommandLineFlagSecurityWarningsEnabled: false` 隐藏命令行安全提示条，策略只控制警告显示，不启用沙箱。某些宿主或容器策略不允许 Chromium 沙箱创建命名空间，服务会记录警告并退回 `--no-sandbox`；此时浏览器隔离只剩容器边界。建议在可信站点使用，敏感用途应部署在独立虚拟机或支持浏览器沙箱的宿主；不要用 privileged 或关闭 seccomp 来绕过。
- 关闭时须留足时间让浏览器保存登录态：Compose 已设置 60 秒，手动运行也要加 `--stop-timeout=60`。
- `/data` 里有浏览器登录态（cookie、密码管理器数据），和密码一样敏感：备份、迁移、删除卷时注意。
- 站点登录要由人在桌面里手动完成（Hob 的「打开桌面」）；agent 不代登、不做反检测。

## English

Hob's optional cloud desktop: one container creates a separate Xtigervnc, openbox, dock and browser on demand for each assistant and the `public` screen. No screens start at container boot. Official Google Chrome is used on amd64 and arm64; other architectures fall back to Chromium. `TZ` (IANA zone, default UTC) and `DESKTOP_LANG` (BCP 47 tag, default `zh-CN`) set the desktop's timezone and language, and `DESKTOP_RESOLUTION` sets the screen size: websites compare the IP's location with timezone, language and screen, so keep them consistent with the egress network. The language drives `LANG`/`LANGUAGE` of every desktop program, the browser UI language, and the `Accept-Language` / `navigator.languages` the browser sends. A missing `xx_RR.UTF-8` locale is generated when the container starts (that step needs root, then desktopd runs as `hob`); an invalid value stops the container with the reason instead of falling back. Existing browser profiles follow the deployment setting, so a language picked in browser settings gets overridden. `DESKTOP_IDLE_MINUTES` (default 30, fractional values allowed) controls idle reclamation and `DESKTOP_MAX_SCREENS` (default 6) limits concurrent screens. Connected viewers or CDP clients prevent reclamation, and browser profiles persist under `/data/profiles/<screen-id>`. `desktopd` exposes one token-protected HTTP/WS port (default 6080). The desktop comes with a bottom dock (tint2: launchers for browser / terminal / files / text editor / images / calculator, plus running windows and a clock) and a bundled wallpaper; desktopd starts both and restarts the dock if it dies. Deploy it on any Docker host (amd64/arm64) with `docker compose up -d` or `docker run -d --name hob-desktop -p 127.0.0.1:6080:6080 --shm-size=1g --stop-timeout=60 -v hob-desktop-data:/data ghcr.io/ffattiger/hob-desktop:latest`. Every request (including WebSocket upgrades) must carry `Authorization: Bearer <token>`; the token is auto-generated on first start — read it with `docker exec hob-desktop cat /data/token` — or set your own via `DESKTOP_TOKEN`. VNC (5900) and CDP (random port) bind to the container's loopback only and must never be published. The token travels in cleartext over HTTP, so use an HTTPS reverse proxy or a private network for cross-machine access; keep the default loopback binding otherwise. `/data` holds browser login state (cookies) and is as sensitive as a password. Log into websites manually via Hob's desktop view — the agent never drives logins.
