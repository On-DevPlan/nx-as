# nx-as 基础镜像（v0.6）：nginx（入口）+ nx-as（鉴权中间件）+ 默认主进程 pi-web
#
# 用法一（自带 pi-web）：
#   docker run -p 8080:8080 -v nxas-data:/data nx-as-sidecar:0.6
#
# 用法二（作为基础镜像，换主进程）：
#   FROM nx-as-sidecar:0.6
#   RUN apk add --no-cache python3 && pip3 install flask ...
#   ENV NXAS_TARGET_CMD="python3 /app/myapp.py" \
#       NXAS_TARGET_PORT=5000 \
#       NXAS_PROTECT="/api/* /admin/*"
#
# 多阶段构建：builder 装 devDeps + 构建面板 + 装 pi-web；runtime 只拷产物。
# 构建产物经 docker save 分发（不走 registry）。

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
# import.meta.resolve 不读 NODE_PATH，建软链让 /app/src 能找到全局的 @agegr
RUN npm install -g @agegr/pi-web@0.9.3 --no-audit --no-fund

# ── Stage 2: runtime ──────────────────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache nginx openssl tini gettext \
    && mkdir -p /run/nginx /etc/nginx/ssl /etc/nginx/http.d /data

# nx-as 产物（src + 已 prune 的 node_modules + bin + 面板 public + package.json）
COPY --from=builder /build/bin /app/bin
COPY --from=builder /build/src /app/src
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/assets /app/assets
COPY --from=builder /build/package.json /app/package.json

# 默认主进程 pi-web 全局包（软链到 /app/node_modules 供 import.meta.resolve 找到）
# 用户换主进程时这层仍保留（无害），只是不再被 NXAS_TARGET_CMD 调用
COPY --from=builder /usr/local/lib/node_modules/@agegr /app/node_modules/@agegr

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
    NXAS_PROTECT=/* \
    NXAS_TARGET_CMD="nx-as web --port 30141 --no-open"

# 作为基础镜像时的默认命令（用户覆盖 NXAS_TARGET_CMD 即可换主进程）
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
