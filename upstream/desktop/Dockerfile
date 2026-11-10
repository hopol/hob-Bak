# hob-desktop：Hob 的云桌面（Xtigervnc + openbox + tint2 dock + Chromium + desktopd）。
# 单个 Node 22 进程（desktopd）监督 X 和窗口管理器，对外只开 6080 一个要令牌的端口。
# VNC(5900) / CDP(随机) 只监听容器内回环，不 EXPOSE。数据（profile、令牌）在 /data。
FROM node:22-bookworm-slim AS node

FROM node:22-bookworm-slim AS deps
WORKDIR /dd
COPY desktopd/package.json desktopd/package-lock.json ./
RUN npm ci --omit=dev

FROM debian:bookworm-slim
ARG TARGETARCH
# debian:slim 的 dpkg 配置排掉了 /usr/share/locale（镜像瘦身），这里把中文翻译放回来；
# 不这样做 dock 和所有程序的界面都是英文（包里明明带了 zh_CN 的 .mo）。
RUN printf '%s\n' 'path-include /usr/share/locale/zh_CN/*' 'path-include /usr/share/locale/zh/*' > /etc/dpkg/dpkg.cfg.d/hob-zh-locale
# locales + localedef：dock、文件管理器、终端等 GTK 程序的界面文字要中文，默认语言 zh_CN 先编进镜像；
# DESKTOP_LANG 换成别的语言时，desktopd 启动时用 localedef 补编（见 desktopd/locale.mjs）。
# localedef 要写 /usr/lib/locale，这个目录归 hob（容器里只有这一个普通用户），才能非 root 生成。
# tint2 + hsetroot = dock 和壁纸；lxterminal/pcmanfm/mousepad/ristretto/galculator = dock 上的预装软件
# adwaita-icon-theme 提供 dock 和程序用的图标（统一的图标主题）
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg tini tzdata locales \
    tigervnc-standalone-server \
    openbox \
    xdotool xclip scrot x11-utils \
    tint2 hsetroot \
    lxterminal pcmanfm mousepad ristretto galculator \
    adwaita-icon-theme \
    fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
  && case "$TARGETARCH" in amd64|arm64) \
       curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg; \
       echo "deb [arch=$TARGETARCH signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
       apt-get update && apt-get install -y --no-install-recommends google-chrome-stable ;; \
     *) apt-get install -y --no-install-recommends chromium chromium-l10n ;; esac \
  && rm -rf /var/lib/apt/lists/* \
  && localedef -i zh_CN -f UTF-8 zh_CN.UTF-8 \
  && useradd -u 1000 -m -d /data/home -s /usr/sbin/nologin hob \
  && mkdir -p /data/profiles && chown -R hob:hob /data /usr/lib/locale
RUN mkdir /shared && chown hob:hob /shared
# hob 用户的登录 shell 是 nologin（不要让 VNC 能登），但终端要能开壳：VTE 按 $SHELL 起 shell，
# 不设的话 lxterminal 一开就跟着 /usr/sbin/nologin 退出（窗口一闪就没）
# 镜像里的默认语言（= DESKTOP_LANG 的默认值）；desktopd 给自己拉起的程序另按 DESKTOP_LANG 设
ENV LANG=zh_CN.UTF-8 LANGUAGE=zh_CN:zh SHELL=/bin/bash
COPY chromium-policies.json /etc/chromium/policies/managed/hob.json
COPY chromium-policies.json /etc/opt/chrome/policies/managed/hob.json
COPY openbox/rc.xml /etc/xdg/openbox/rc.xml
COPY wallpaper.png /app/desktop/wallpaper.png
COPY dock /app/desktop/dock
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /dd/node_modules ./desktopd/node_modules
COPY desktopd ./desktopd
ENV NODE_ENV=production HOME=/data/home
RUN if command -v google-chrome-stable >/dev/null; then echo chrome > /app/browser-kind; else echo chromium > /app/browser-kind; fi
USER hob
VOLUME /data
EXPOSE 6080
ENTRYPOINT ["tini", "--"]
CMD ["node", "desktopd/server.mjs"]
