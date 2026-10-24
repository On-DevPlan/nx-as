#!/bin/sh
# gost-as entrypoint：gost(relay 隧道入口) + nginx(公网鉴权入口) + nx-as(鉴权决策+配置管理)
#
# 形态：host 网络（动态端口注册零重启；容器内监听端口 = 宿主端口）。
# 端口模型：
#   NXAS_LISTEN_PORT (默认 8090)  面板/登录主入口（nginx）
#   NXAS_GOST_PORT   (默认 8442)  gost relay 隧道入口（本地 gost 客户端连入）
#   <本地服务端口 L>               每条隧道一个 nginx server（配置文件管理器动态管理）
# 安全边界（公网唯一暴露面 = nginx）：
#   - nx-as 只绑 127.0.0.1（host 网络下绝不暴露公网）
#   - gost relay 本体只绑 127.0.0.1:INTERNAL；公网 :GOST_PORT 由 nginx stream（L4）反代——
#     gost 进程不持有任何公网 socket，绕过 nginx 的直连路径不存在
#   - gost rtcp 注册监听绑 127.0.0.1:1L（客户端注册时带 loopback 前缀）→ 公网只能走 nginx 鉴权
#   - 隧道流量路径：公网:L → nginx(auth_request SSO) → 127.0.0.1:1L → 隧道 → 本地服务:L
#   - relay 口的准入 = gost 自身账号口令（数据面鉴权是上面的 SSO；两层各管一段）
set -e

DATA=/data
mkdir -p "$DATA" /etc/nginx/http.d /etc/nginx/ssl

# ---------- 0. http.d 持久化（隧道 conf 不随容器重建丢失） ----------
# /etc/nginx/http.d → 符号链接到 /data/http.d：面板配置文件管理器写进来的
# nxas-tunnel-*.conf 落在数据卷上，重建容器自动回来。
# 模板（*.conf.template）不持久化——每次启动从镜像刷新，避免旧模板覆盖新镜像的修复。
if [ ! -L /etc/nginx/http.d ]; then
  mkdir -p "$DATA/http.d"
  for f in /etc/nginx/http.d/*.conf; do
    [ -e "$f" ] && cp -n "$f" "$DATA/http.d/" || true
  done
  rm -rf /etc/nginx/http.d
  ln -s "$DATA/http.d" /etc/nginx/http.d
fi
if [ -d /app/nginx-templates ]; then
  cp -f /app/nginx-templates/*.template /etc/nginx/http.d/ 2>/dev/null || true
fi

export NX_AS_HOME=/data
export NX_AS_STORE=/data/store.json
export NXAS_LISTEN_PORT="${NXAS_LISTEN_PORT:-8090}"   # 面板/登录主入口
export NXAS_API_PORT="${NXAS_API_PORT:-7801}"         # nx-as 网关（仅 loopback）
export NXAS_GOST_PORT="${NXAS_GOST_PORT:-8442}"       # gost relay 公网入口（nginx stream 监听）
export NXAS_GOST_INTERNAL_PORT="${NXAS_GOST_INTERNAL_PORT:-18442}"  # gost relay 本体只绑这个回环端口
export NXAS_NGINX_SUDO=0                              # 容器内 root 直跑 nginx

# ---------- 1. store 初始化（machineSecret + 托管目录指向 http.d） ----------
node /app/docker/gost-init.mjs

# ---------- 2. nginx 公共变量（隧道 server 的 WebSocket/SSE 兼容） ----------
cat > /etc/nginx/http.d/00-nxas-vars.conf <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      "";
}
EOF

# ---------- 3. 渲染主入口模板 ----------
envsubst '${NXAS_LISTEN_PORT} ${NXAS_API_PORT} ${NXAS_TLS_BLOCK}' \
  < /etc/nginx/http.d/gost-as.conf.template > /etc/nginx/http.d/gost-as.conf
echo "[gost-as] nginx 主入口 :${NXAS_LISTEN_PORT}（面板/登录）"

# ---------- 3b. stream（L4）：gost relay 的公网入口（gost 本体只绑回环） ----------
# stream{} 主块由 nginx-mod-stream 包自带 /etc/nginx/conf.d/stream.conf 提供
#（内含 include stream.d/*.conf）——这里只写 server，别再往 nginx.conf 追加 stream 块（会 duplicate）
mkdir -p /etc/nginx/stream.d
cat > /etc/nginx/stream.d/gost-relay.conf <<CONF
# nxas-stream: 公网 ${NXAS_GOST_PORT} → gost relay 回环 ${NXAS_GOST_INTERNAL_PORT}
# （gost 进程不绑公网；数据面鉴权在各隧道端口的 auth_request，这里只收敛入口）
server {
    listen ${NXAS_GOST_PORT};
    proxy_pass 127.0.0.1:${NXAS_GOST_INTERNAL_PORT};
    proxy_connect_timeout 5s;
}
CONF
echo "[gost-as] nginx stream :${NXAS_GOST_PORT} → 回环 :${NXAS_GOST_INTERNAL_PORT}（gost relay 入口）"
nginx -t

# ---------- 4. gost relay（隧道入口；bind=true 允许客户端注册远程端口） ----------
GOST_USER="${NXAS_GOST_USER:-gost}"
GOST_PASS="${NXAS_GOST_PASS:-}"
if [ -z "$GOST_PASS" ] && [ -f "$DATA/gost-auth.env" ]; then
  # shellcheck disable=SC1090
  . "$DATA/gost-auth.env"
  GOST_PASS="${NXAS_GOST_PASS:-}"
  GOST_USER="${NXAS_GOST_USER:-$GOST_USER}"
fi
if [ -z "$GOST_PASS" ]; then
  GOST_PASS=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  printf 'NXAS_GOST_USER=%s\nNXAS_GOST_PASS=%s\n' "$GOST_USER" "$GOST_PASS" > "$DATA/gost-auth.env"
  chmod 600 "$DATA/gost-auth.env"
  echo "[gost-as] 已生成隧道凭据 → $DATA/gost-auth.env（后续注册指令要用）"
fi
export NXAS_GOST_USER="$GOST_USER" NXAS_GOST_PASS="$GOST_PASS"
gost -L "relay+tcp://$GOST_USER:$GOST_PASS@127.0.0.1:${NXAS_GOST_INTERNAL_PORT}?bind=true" &
GOST_PID=$!
echo "[gost-as] gost relay 回环 :${NXAS_GOST_INTERNAL_PORT}（公网 :${NXAS_GOST_PORT} 经 nginx stream, pid $GOST_PID, 用户 $GOST_USER）"

# ---------- 5. nx-as 网关（host 网络 → 只绑 loopback，公网流量必须经 nginx） ----------
NXAS_GW_MODE=nginx NXAS_SERVE_PARENT=1 nx-as serve --host 127.0.0.1 --port "${NXAS_API_PORT}" --no-open &
NXAS_PID=$!
echo "[gost-as] nx-as 网关 127.0.0.1:${NXAS_API_PORT} (pid $NXAS_PID)"
i=0
until wget -q -O /dev/null "http://127.0.0.1:${NXAS_API_PORT}/api/auth/verify" 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 30 ] && echo "[gost-as] WARN: nx-as 30s 未就绪" >&2 && break
  sleep 1
done

# ---------- 5a. 未授权 bind 审计守卫（relay bind=true 允许凭据持有者开公网裸端口——
# gost v3.2.6 无白名单选项；每分钟扫描非 nginx 的公网监听并告警落审计） ----------
(
  while true; do
    node /app/docker/bind-audit.mjs 2>&1 | grep -v 'ok（无未授权' | sed 's/^/[gost-as] /'
    sleep 60
  done
) &

# ---------- 5b. SSO 一致性自检（discovery/client/生效回调；IdP 暂不可达不阻塞启动） ----------
nx-as oidc probe 2>&1 | sed 's/^/[gost-as][probe] /' || true

# ---------- 6. nginx 前台（容器生命周期跟随） ----------
trap 'kill $NXAS_PID $GOST_PID 2>/dev/null; nginx -s quit 2>/dev/null; exit 0' TERM INT
echo "[gost-as] 就绪：面板 http://0.0.0.0:${NXAS_LISTEN_PORT} · 隧道 :${NXAS_GOST_PORT}"
nginx -g "daemon off;" &
NGINX_PID=$!
while kill -0 "$NGINX_PID" 2>/dev/null && kill -0 "$NXAS_PID" 2>/dev/null && kill -0 "$GOST_PID" 2>/dev/null; do
  sleep 5
done
echo "[gost-as] 进程退出（nginx=$NGINX_PID nxas=$NXAS_PID gost=$GOST_PID），容器结束"
kill $NXAS_PID $GOST_PID 2>/dev/null || true
nginx -s quit 2>/dev/null || true
exit 0
