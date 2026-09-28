#!/bin/sh
# nx-as 单容器 entrypoint：机机密码 → 自签证书 → nginx conf 渲染 → 进程拉起
#
# 进程编排：nx-as serve --with-web 负责拉起 pi-web 子进程（launcher 注入 PI_WEB_PASSWORD，
# 与 store.machineSecret 同源）+ nx-as 网关/面板；nginx 最后前台化。共三个进程。
set -e

DATA=/data
mkdir -p "$DATA" "$DATA/pi-agent/extensions" "$DATA/pi-agent/skills"

# ---------- 1. 机机密码（提前物化到 store，保证 nginx conf 与 launcher 同源） ----------
export NX_AS_HOME=$DATA   # store = /data/store.json；Dockerfile 已设，这里显式兜底
node --input-type=module -e "
const { loadStore, mutateStore } = await import('file:///app/src/core/store.js');
const s = await loadStore();
if (!s.machineSecret) {
  const { randomBytes } = await import('node:crypto');
  const secret = randomBytes(32).toString('hex');
  await mutateStore((st) => { st.machineSecret = secret; });
  console.log('generated');
} else {
  console.log('exists');
}
" > /tmp/.secret-check 2>/dev/null || echo "failed" > /tmp/.secret-check
cat /tmp/.secret-check

# 读出密码渲染 nginx（store 读不到时退化临时密码——nginx 与 pi-web 将不一致，仅弱降级）
SECRET=$(node --input-type=module -e "
const { loadStore } = await import('file:///app/src/core/store.js');
const s = await loadStore();
console.log(s.machineSecret || '');
" 2>/dev/null)
if [ -z "$SECRET" ]; then
  echo "[entrypoint] WARN: 无法读取 store，nginx Basic 用临时密码（pi-web 侧另随机）" >&2
  SECRET=$(openssl rand -hex 32)
fi

# ---------- 2. 自签证书（挂卷 /etc/nginx/ssl 可替换为正式证书） ----------
if [ ! -f /etc/nginx/ssl/cert.pem ]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout /etc/nginx/ssl/key.pem -out /etc/nginx/ssl/cert.pem \
    -subj "/CN=${NXAS_DOMAIN:-nx-as.local}" >/dev/null 2>&1
  echo "[entrypoint] 自签证书已生成（CN=${NXAS_DOMAIN:-nx-as.local}）"
fi

# ---------- 3. 渲染 nginx conf ----------
export NXAS_MACHINE_B64=$(printf 'pi:%s' "$SECRET" | base64 | tr -d '\n')
: "${NXAS_LISTEN_PORT:=8443}"
envsubst '${NXAS_MACHINE_B64} ${NXAS_LISTEN_PORT}' < /etc/nginx/conf.d/nx-as.conf.template > /etc/nginx/conf.d/nx-as.conf
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

# ---------- 5. nginx 前台 ----------
echo "[entrypoint] nginx 监听 :${NXAS_LISTEN_PORT}"
trap 'echo "[entrypoint] SIGTERM, shutting down"; kill $NXAS_PID 2>/dev/null; nginx -s quit 2>/dev/null; exit 0' TERM INT
nginx -g "daemon off;" &
NGINX_PID=$!
wait -n $NGINX_PID $NXAS_PID 2>/dev/null || wait
echo "[entrypoint] 子进程退出，容器结束"
