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

## 和 Hob 一起部署

在 Hob 根目录 `compose.yaml` 旁边的 `.env` 里写好 `HOB_PASSWORD`，一条命令同时启动 Hob 和云桌面：

```sh
docker compose --profile desktop up -d
```

桌面端口不映射到宿主机；Hob 从共享卷读取自动生成的令牌，设置 → 云桌面 显示「由部署配置」。时区和语言（`TZ`、`DESKTOP_LANG`）也写在这个 `.env` 里。不加 profile 时 Hob 单独运行，云桌面显示未配置。

单独部署（见上面的「起停」）时，在 Hob 的设置里填地址和令牌。没有启动 desktop profile、共享令牌文件不存在或为空时，Hob 用设置里填的云桌面；令牌文件出现后，以 Compose 部署为准。

- 每个助手的屏幕在第一次使用时启动，和它的任务共用浏览器登录状态；任务正在用浏览器时，助手会收到等待或协调的提示。
- 设置 → 云桌面 可以允许指定助手使用公共屏幕，默认谁都不能用。公共屏幕同一时间只给一个任务用，其他任务最多等 10 分钟。
- 登录 Hob 的人都能观看和接管任意一块屏幕。受 Google 限制，开了远程调试的浏览器目前登录不了 Google 账号。

Hob 前面有反向代理时，桌面画面需要 `/api/desktop/vnc` 支持 WebSocket 升级。nginx 示例：

```nginx
location = /api/desktop/vnc {
    proxy_pass http://127.0.0.1:30148;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

资源占用（桌面 v2，一台 amd64 机器上实测）：镜像占用 2.03 GB；不开屏幕时内存 23.5 MiB，一块 Chrome 屏幕打开 example.com 时 354.9 MiB，三块 Chrome 屏幕打开新标签页时 1017 MiB。实际占用随机器和页面而变。

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

**Running it with Hob.** With `HOB_PASSWORD` set in the `.env` next to Hob's root `compose.yaml`, `docker compose --profile desktop up -d` starts Hob and the desktop together. The desktop is not published to the host network; Hob reads the generated token from a shared volume and shows **由部署配置** in Settings → Cloud desktop. `TZ` and `DESKTOP_LANG` go in the same `.env`. Without the profile Hob runs alone and the desktop is unconfigured. For a separate deployment, enter the URL and token in Hob's settings; while the profile is not running and the shared token file is absent or empty, Hob uses the settings, and once the token file appears the Compose deployment takes precedence. Each assistant's screen starts on first use and shares its browser login state with that assistant's jobs; when a job is using the browser, the assistant is told to wait or coordinate. A public screen can be enabled for selected assistants in Settings → Cloud desktop (none by default); one job uses it at a time and others wait up to 10 minutes. Anyone signed into Hob can view and take over any screen. Google currently blocks Google account sign-in in a browser with remote debugging enabled. Behind a reverse proxy, Hob's desktop view needs WebSocket upgrades on `/api/desktop/vnc` (see the nginx example above). Measured for desktop v2 on an amd64 host: the image used 2.03 GB of disk; memory was 23.5 MiB with no screens, 354.9 MiB with one Chrome screen on example.com, and 1017 MiB with three Chrome screens on new tabs. Actual usage depends on the host and the pages.
