# nx-as 基础镜像（v0.7.1）：nginx（入口）+ nx-as（权限中间件）双目标
#
# 两个 target（同一个 Dockerfile，层共享）：
#   base —— 纯权限壳：nginx + nx-as，**不含任何主程序**。
#            供他人 `FROM ghcr.io/on-devplan/nx-as-base` 封装自有应用：
#              FROM ghcr.io/on-devplan/nx-as-base:0.7.1
#              COPY myapp /app/myapp
#              ENV NXAS_TARGET_CMD="node /app/myapp/server.js" \
#                  NXAS_TARGET_PORT=5000 \
#                  NXAS_PROTECT="/api/* /admin/*"
#            （不加主进程也能跑：只提供 nginx 入口 + nx-as 的 /_nxas/* 鉴权面）
#   full —— 默认产品形态：FROM base + 内嵌 pi-web 作为主进程（会话运行时）。
#
# 构建：
#   docker build --target base -t nx-as-base:local .
#   docker build --target full -t nx-as:local .
#
# 多阶段：builder 装 devDeps + 构建面板 +（仅 full 需要）装 pi-web；runtime 只拷产物。

# ── Stage 1: builder ──────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN apk add --no-cache gettext ca-certificates

WORKDIR /build
COPY package.json pnpm-lock.yaml* ./
COPY . .

# nx-as：全量依赖 → 构建面板 → 剔除 devDeps
RUN npm install --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev

# 默认主进程 pi-web（Next.js 全家桶 ~200MB；锁版本保证 gateway 契约）
# 仅 full 目标会 COPY 这层——base 目标不引用它，构建 base 时不产生额外下载成本
# （buildx 报 unused stage 属正常，不影响产物）
FROM node:22-alpine AS builder-web
RUN npm install -g @agegr/pi-web@0.9.3 --no-audit --no-fund

# ── Stage 2: runtime 公共层（nginx + nx-as）────────────────────────────
FROM node:22-alpine AS runtime-common

RUN apk add --no-cache nginx openssl tini gettext \
    && mkdir -p /run/nginx /etc/nginx/ssl /etc/nginx/http.d /data

# nx-as 产物（src + 已 prune 的 node_modules + bin + 面板 public + package.json）
COPY --from=builder /build/bin /app/bin
COPY --from=builder /build/src /app/src
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/assets /app/assets
COPY --from=builder /build/package.json /app/package.json

# 容器部署件
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/secret-init.mjs /app/docker/secret-init.mjs
COPY docker/render-protect.mjs /app/docker/render-protect.mjs
COPY docker/nginx.conf.template /etc/nginx/http.d/nx-as.conf.template
RUN chmod +x /entrypoint.sh /app/bin/nx-as.mjs /app/docker/*.mjs \
    && ln -sf /app/bin/nx-as.mjs /usr/local/bin/nx-as

VOLUME ["/data"]

# 对外端口（nginx）；7801/30141 仅在容器内
EXPOSE 8080

ENV NXAS_NGINX_SUDO=0 \
    NX_AS_HOME=/data \
    NX_AS_STORE=/data/store.json \
    PI_CODING_AGENT_DIR=/data/pi-agent \
    NODE_ENV=production \
    NXAS_LISTEN_PORT=8080 \
    NXAS_API_PORT=7801 \
    NXAS_TARGET_PORT=30141 \
    NXAS_PROTECT=/*

# ── Target: base —— 纯权限壳（无主进程）────────────────────────────────
# 不设 NXAS_TARGET_CMD：entrypoint 跳过主进程，只跑 nx-as 网关 + nginx。
# 派生镜像用 ENV NXAS_TARGET_CMD / NXAS_TARGET_PORT / NXAS_PROTECT 定制。
FROM runtime-common AS base

# 该变量在运行时为空 → base 是「待接入主进程」形态；派生镜像覆盖它
ENV NXAS_TARGET_CMD=""

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]

# ── Target: full —— base + pi-web 主进程（默认产品形态）────────────────
FROM base AS full

# pi-web 全局包（软链到 /app/node_modules 供 import.meta.resolve 找到）
COPY --from=builder-web /usr/local/lib/node_modules/@agegr /app/node_modules/@agegr

# nx-as web 启动器默认值：拉起 pi-web
ENV NXAS_TARGET_CMD="nx-as web --port 30141 --no-open"
