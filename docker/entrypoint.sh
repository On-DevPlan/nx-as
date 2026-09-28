#!/bin/sh
# nx-as 单容器 entrypoint：机机密码 → 自签证书 → nginx conf 渲染 → 进程拉起
#
# 进程编排：nx-as serve --with-web 负责拉起 pi-web 子进程（launcher 注入 PI_WEB_PASSWORD，
# 与 store.machineSecret 同源）+ nx-as 网关/面板；nginx 最后前台化。共三个进程。
set -e

DATA=/data
mkdir -p "$DATA" "$DATA/pi-agent/extensions" "$DATA/pi-agent/skills"

# ---------- 1. 机机密码（物化到 store，保证 nginx conf 与 launcher 读同一个值） ----------
export NX_AS_HOME=$DATA   # store = /data/store.json；Dockerfile 已设，这里显式兜底
# JS 独立成文件（docker/secret-init.mjs）：node -e 的多行脚本在 ash 下传递易被破坏
SECRET=$(node /app/docker/secret-init.mjs 2>/tmp/secret-init.err)
cat /tmp/secret-init.err >&2 2>/dev/null || true
if [ ${#SECRET} -ne 64 ]; then
  echo "[entrypoint] ERROR: machineSecret 异常（长度 ${#SECRET}，应为 64）——/data 是否可写？" >&2
  exit 1
fi

# ---------- 2. 自签证书（挂卷 /etc/nginx/ssl 可替换为正式证书） ----------
if [ ! -f /etc/nginx/ssl/cert.pem ]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout /etc/nginx/ssl/key.pem -out /etc/nginx/ssl/cert.pem \
    -subj "/CN=${NXAS_DOMAIN:-nx-as.local}" >/dev/null 2>&1
  echo "[entrypoint] 自签证书已生成（CN=${NXAS_DOMAIN:-nx-as.local}）"
fi

# ---------- 3. 渲染 nginx conf（Alpine 的 http 上下文 include 是 http.d/） ----------
# 注意：envsubst 只读「环境变量」，shell 里的普通赋值它看不见——两个变量都必须 export
export NXAS_MACHINE_B64=$(printf 'pi:%s' "$SECRET" | base64 | tr -d '\n')
export NXAS_LISTEN_PORT="${NXAS_LISTEN_PORT:-8443}"
envsubst '${NXAS_MACHINE_B64} ${NXAS_LISTEN_PORT}' < /etc/nginx/http.d/nx-as.conf.template > /etc/nginx/http.d/nx-as.conf
echo "[entrypoint] nginx conf 已渲染（listen :${NXAS_LISTEN_PORT}）"
nginx -t

# ---------- 4. nx-as serve --with-web（pi-web + 网关 + 面板，后台） ----------
NXAS_GW_MODE=nginx NXAS_SERVE_PARENT=1 nx-as serve --host 0.0.0.0 --port 7801 --with-web --no-open &
NXAS_PID=$!
echo "[entrypoint] nx-as 启动中 (pid $NXAS_PID)，pi-web 由 --with-web 拉起"

# 等 pi-web 就绪（30141 出现监听，最多 60s）
i=0
until wget -q -O /dev/null http://127.0.0.1:30141/api/web-auth 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 60 ] && echo "[entrypoint] WARN: pi-web 60s 未就绪，继续" && break
  sleep 1
done
echo "[entrypoint] pi-web 已就绪或超时跳过"

# ---------- 5. nginx 前台（ash 无 `wait -n`：轮询子进程存活） ----------
echo "[entrypoint] nginx 监听 :${NXAS_LISTEN_PORT}"
trap 'echo "[entrypoint] SIGTERM, shutting down"; kill $NXAS_PID 2>/dev/null; nginx -s quit 2>/dev/null; exit 0' TERM INT
nginx -g "daemon off;" &
NGINX_PID=$!
while kill -0 "$NXAS_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 5
done
echo "[entrypoint] 子进程退出（nxas=$NXAS_PID nginx=$NGINX_PID），容器结束"
kill $NXAS_PID 2>/dev/null || true
nginx -s quit 2>/dev/null || true
exit 0
