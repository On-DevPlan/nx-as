# nx-as 单容器全内置：nginx（公网入口）+ nx-as（鉴权/面板）+ pi-web（会话运行时）
# 构建产物经 docker save 分发（不走 registry）
FROM node:22-alpine

# nginx + openssl（自签证书）+ tini（PID 1 信号转发）+ gettext（envsubst）
RUN apk add --no-cache nginx openssl tini gettext ca-certificates \
    && mkdir -p /run/nginx /etc/nginx/ssl /data /etc/nginx/conf.d

WORKDIR /app

# nx-as 本体：源码 → 全量依赖 → 构建面板 → 剔除 devDeps
COPY package.json pnpm-lock.yaml* ./
COPY . .
RUN npm install --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev

# pi-web 固定版本装进全局（Next.js 全家桶 ~200MB，锁版本保证 gateway 契约）
RUN npm install -g @agegr/pi-web@0.9.3 --no-audit --no-fund

# 容器部署件
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/nginx.conf.template /etc/nginx/conf.d/nx-as.conf.template
RUN chmod +x /entrypoint.sh && ln -sf /app/bin/nx-as.mjs /usr/local/bin/nx-as

# 数据卷：store.json / audit.jsonl / pi-agent（会话+扩展+凭据）
VOLUME ["/data"]

# 8443 = nginx 公网入口（TLS）；7801 = nx-as 管理面（容器网络内；调试 ssh -L 映射）
EXPOSE 8443 7801

ENV NXAS_NGINX_SUDO=0 \
    NX_AS_HOME=/data \
    PI_CODING_AGENT_DIR=/data/pi-agent \
    NODE_ENV=production

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
