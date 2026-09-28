# nx-as 单容器全内置：nginx（公网入口）+ nx-as（鉴权/面板）+ pi-web（会话运行时）
# 多阶段构建：builder 层装 devDeps + 跑面板 build + 装 pi-web；runtime 层只拷产物
# 构建产物经 docker save 分发（不走 registry）

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

# pi-web 全局装（Next.js 全家桶 ~200MB；锁版本保证 gateway 契约）
# import.meta.resolve 不读 NODE_PATH，建软链让 /app/src 能找到全局的 @agegr
RUN npm install -g @agegr/pi-web@0.9.3 --no-audit --no-fund

# ── Stage 2: runtime ──────────────────────────────────────────────────
# alpine 基础镜像含 nginx + openssl + tini + gettext（用于 envsubst）
# 不再装 npm/devDeps：nx-as runtime 只要 node + 全局 pi-web + 构建产物
FROM node:22-alpine

RUN apk add --no-cache nginx openssl tini gettext \
    && mkdir -p /run/nginx /etc/nginx/ssl /etc/nginx/http.d /data

# 拷贝 nx-as 构建产物（src + 已 prune 的 node_modules + bin + 面板 public）
COPY --from=builder /build/bin /app/bin
COPY --from=builder /build/src /app/src
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/assets /app/assets

# 软链 pi-web 全局包到 nx-as node_modules（import.meta.resolve 找祖先 node_modules）
COPY --from=builder /usr/local/lib/node_modules/@agegr /app/node_modules/@agegr

# 容器部署件
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/secret-init.mjs /app/docker/secret-init.mjs
COPY docker/nginx.conf.template /etc/nginx/http.d/nx-as.conf.template
RUN chmod +x /entrypoint.sh /app/bin/nx-as.mjs /app/docker/secret-init.mjs \
    && ln -sf /app/bin/nx-as.mjs /usr/local/bin/nx-as

VOLUME ["/data"]
EXPOSE 8443 7801

ENV NXAS_NGINX_SUDO=0 \
    NX_AS_HOME=/data \
    PI_CODING_AGENT_DIR=/data/pi-agent \
    NODE_ENV=production

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]