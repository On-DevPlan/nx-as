#!/bin/sh
# nx-as 基础镜像 entrypoint（v0.7）
#
# 设计：nx-as + nginx 是「权限中间件底座」，主进程可替换。
#   base 镜像：纯权限壳（NXAS_TARGET_CMD 为空，只跑 nx-as 网关 + nginx）
#   full 镜像：ENV 默认 NXAS_TARGET_CMD = pi-web
#   派生镜像：FROM base 后设 NXAS_TARGET_CMD / NXAS_TARGET_PORT / NXAS_PROTECT 接入自有应用
#
# 进程编排：
#   1. 物化机机密码（store.machineSecret，与 pi-web PI_WEB_PASSWORD 同源）
#   2. 渲染 nginx.conf（NXAS_PROTECT → auth_request 路径 / catch-all 是否鉴权）
#   3. 启动 nx-as 网关（鉴权决策 + 管理面）
#   4. 启动主进程（NXAS_TARGET_CMD；为空则跳过——base 形态）
#   5. nginx 前台（容器生命周期跟随）
set -e

DATA=/data
mkdir -p "$DATA" "$DATA/pi-agent/extensions" "$DATA/pi-agent/skills" /etc/nginx/ssl

# ---------- 配置（环境变量，全部有默认值） ----------
export NX_AS_HOME=/data
export NX_AS_STORE=/data/store.json
# pi 的 agent dir：显式指向挂载卷（paths.js 与 launcher 都优先读这个环境变量）
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-/data/pi-agent}"
export NXAS_LISTEN_PORT="${NXAS_LISTEN_PORT:-8080}"     # 对外端口（nginx）
export NXAS_API_PORT="${NXAS_API_PORT:-7801}"           # nx-as 网关端口（内部）
export NXAS_TARGET_PORT="${NXAS_TARGET_PORT:-30141}"    # 主进程端口（默认 pi-web）
export NXAS_PROTECT="${NXAS_PROTECT:-/*}"               # 需鉴权的路径（空格分隔；默认全部）
# 主进程命令：base 镜像为空（纯权限壳，无主进程）；full 镜像 ENV 给了 pi-web 默认值；
# 派生镜像用 ENV NXAS_TARGET_CMD 指向自己的应用
export NXAS_TARGET_CMD="${NXAS_TARGET_CMD:-}"
export NXAS_TARGET_AUTH_HEADER="${NXAS_TARGET_AUTH_HEADER:-}"  # 上游需 Basic 时填（pi-web 由 launcher 注入，这里留空）
export NXAS_TARGET_ENV_PIWEB="${NXAS_TARGET_ENV_PIWEB:-1}"     # 1=pi-web 模式（机机密码注入）；非 pi-web 主进程设 0

# ---------- 1. 机机密码 ----------
SECRET=$(node /app/docker/secret-init.mjs 2>/tmp/secret-init.err)
cat /tmp/secret-init.err >&2 2>/dev/null || true
if [ ${#SECRET} -ne 64 ]; then
  echo "[entrypoint] ERROR: machineSecret 异常（长度 ${#SECRET}，应为 64）——/data 是否可写？" >&2
  exit 1
fi
export NXAS_MACHINE_B64=$(printf 'pi:%s' "$SECRET" | base64 | tr -d '\n')

# ---------- 2. TLS 块（默认空 = HTTP；NXAS_TLS_PORT + /etc/nginx/ssl/ 证书才启用） ----------
export NXAS_TLS_BLOCK=""
if [ -n "${NXAS_TLS_PORT:-}" ]; then
  if [ -f /etc/nginx/ssl/cert.pem ] && [ -f /etc/nginx/ssl/key.pem ]; then
    export NXAS_TLS_BLOCK="listen ${NXAS_TLS_PORT} ssl;
    http2 on;
    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;"
    echo "[entrypoint] HTTPS 启用（listen :${NXAS_TLS_PORT}）"
  else
    echo "[entrypoint] WARN: NXAS_TLS_PORT 已设但证书缺失，回退 HTTP" >&2
    unset NXAS_TLS_PORT
  fi
fi

# ---------- 3. 渲染 NXAS_PROTECT → location 块 ----------
node /app/docker/render-protect.mjs
export NXAS_PROTECT_BLOCKS=$(cat /tmp/nxas-protect-blocks.conf)
CATCHALL_AUTH=$(cat /tmp/nxas-catchall-auth.txt)

if [ "$CATCHALL_AUTH" = "1" ]; then
  if [ -z "$NXAS_TARGET_CMD" ]; then
    # 纯权限壳（base 镜像）：没有主进程可代理。catch-all 直接 404，而不是 502——
    # 502 会让"忘了设 NXAS_TARGET_CMD"看起来像故障，404 是明确的"这里没应用"。
    export NXAS_CATCHALL_BODY='        return 404;'
    echo "[entrypoint] 纯权限壳：catch-all 返回 404（派生镜像设 NXAS_TARGET_CMD 后自动代理主进程）"
  else
    export NXAS_CATCHALL_BODY='        auth_request /_nxas/auth-internal;
        auth_request_set $nxas_device $upstream_http_x_device_id;
        auth_request_set $nxas_cred $upstream_http_x_auth_cred;
        error_page 401 = @nxas_login;
        proxy_pass http://127.0.0.1:__TARGET_PORT__;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Auth-Cred $nxas_cred;
        add_header X-Nxas-Device $nxas_device always;'
  fi
else
  export NXAS_CATCHALL_BODY='        proxy_pass http://127.0.0.1:__TARGET_PORT__;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header X-Forwarded-For $remote_addr;'
fi
# 端口占位符二次替换（避免与 envsubst 的 nginx $变量 冲突）
NXAS_CATCHALL_BODY=$(printf '%s' "$NXAS_CATCHALL_BODY" | sed "s/__TARGET_PORT__/${NXAS_TARGET_PORT}/g")
export NXAS_CATCHALL_BODY

envsubst '${NXAS_LISTEN_PORT} ${NXAS_API_PORT} ${NXAS_TLS_BLOCK} ${NXAS_PROTECT_BLOCKS} ${NXAS_CATCHALL_BODY}' \
  < /etc/nginx/http.d/nx-as.conf.template > /etc/nginx/http.d/nx-as.conf
echo "[entrypoint] nginx conf 已渲染（listen :${NXAS_LISTEN_PORT}；NXAS_PROTECT=${NXAS_PROTECT}；catch-all 鉴权=${CATCHALL_AUTH}）"
nginx -t

# ---------- 4. nx-as 网关（鉴权 + 管理面 + 配对） ----------
NXAS_GW_MODE=nginx NXAS_SERVE_PARENT=1 nx-as serve --host 0.0.0.0 --port "${NXAS_API_PORT}" --no-open &
NXAS_PID=$!
echo "[entrypoint] nx-as 网关启动 (pid $NXAS_PID, :${NXAS_API_PORT})"

# 等网关就绪
i=0
until wget -q -O /dev/null "http://127.0.0.1:${NXAS_API_PORT}/api/auth/verify" 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 30 ] && echo "[entrypoint] WARN: nx-as 网关 30s 未就绪" >&2 && break
  sleep 1
done

# ---------- 5. 主进程（full=pi-web；base 为空；派生镜像指向自有应用） ----------
TARGET_PID=""
if [ -n "$NXAS_TARGET_CMD" ]; then
  if [ "$NXAS_TARGET_ENV_PIWEB" = "1" ]; then
    # pi-web 模式：PI_WEB_PASSWORD 与 store.machineSecret 同源（nx-as launcher 会注入；这里兜底）
    export PI_WEB_PASSWORD="${PI_WEB_PASSWORD:-$SECRET}"
  fi
  echo "[entrypoint] 启动主进程: ${NXAS_TARGET_CMD}  (port ${NXAS_TARGET_PORT})"
  sh -c "$NXAS_TARGET_CMD" &
  TARGET_PID=$!
else
  echo "[entrypoint] NXAS_TARGET_CMD 为空——纯权限壳模式（base 镜像），不启动主进程"
  echo "[entrypoint]   作为基础镜像：FROM ... 后设 ENV NXAS_TARGET_CMD + NXAS_TARGET_PORT"
fi

# ---------- 6. nginx 前台 ----------
trap '[ -n "$TARGET_PID" ] && kill $TARGET_PID 2>/dev/null; kill $NXAS_PID 2>/dev/null; nginx -s quit 2>/dev/null; exit 0' TERM INT
echo "[entrypoint] nginx 监听 :${NXAS_LISTEN_PORT}"
nginx -g "daemon off;" &
NGINX_PID=$!
while kill -0 "$NGINX_PID" 2>/dev/null && kill -0 "$NXAS_PID" 2>/dev/null; do
  sleep 5
done
echo "[entrypoint] 进程退出（nginx=$NGINX_PID nxas=$NXAS_PID target=${TARGET_PID:-无}），容器结束"
[ -n "$TARGET_PID" ] && kill $TARGET_PID 2>/dev/null
kill $NXAS_PID 2>/dev/null || true
nginx -s quit 2>/dev/null || true
exit 0
