# Hob 镜像：数据在 /data（HOB_HOME），任务的项目目录按需挂进来。
# 前端产物和架构无关，在构建机原生平台上打一次；生产依赖里有按平台分发的原生包，按目标架构单独装。
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
# 任务是带 bash 的编码 agent：给它常用命令行工具；rg/fd 预装，引擎就不用联网下载
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3 ripgrep fd-find procps tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir /data /shared && chown node:node /data /shared
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY bin ./bin
COPY server/src ./server/src
COPY shared ./shared
COPY vendor ./vendor
COPY --from=web /app/dist/web ./dist/web
ENV NODE_ENV=production HOB_HOME=/data HOB_HOST=0.0.0.0 HOB_PORT=30148
USER node
VOLUME /data
EXPOSE 30148
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD curl -fsS -o /dev/null http://127.0.0.1:30148/ || exit 1
ENTRYPOINT ["tini", "--"]
CMD ["node", "bin/hob.mjs"]
