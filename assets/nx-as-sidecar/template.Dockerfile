# nx-as 边车镜像模板 —— 案例以 pi-web 作为主进程（最后一步启动它）
#
# 用法：
#   cp template.Dockerfile Dockerfile
#   cp template.compose.yml docker-compose.yml
#   docker compose up -d
#
# 换成你自己的应用：只改「STEP 1 / STEP 2」两处，STEP 3 保持不动。
# 若只是想跑 pi-web，无需本模板——直接用 ghcr.io/on-devplan/nx-as（full 镜像已内置）。

# ─────────────────────────────────────────────────────────────
# 基础镜像：nginx（公网入口）+ nx-as（鉴权网关），无主程序
# 锁版本（latest 会让 entrypoint/模板行为漂移——踩过重启循环的坑）
# ─────────────────────────────────────────────────────────────
FROM ghcr.io/on-devplan/nx-as-base:0.7.1

# ══ STEP 1：把主进程装进镜像 ═════════════════════════════════
# 案例是 pi-web（@agegr/pi-web）。三个要点：
#   a) 全局安装后必须软链到 /app/node_modules/@agegr —— nx-as 的 launcher 用
#      import.meta.resolve 找它，不认全局路径（NODE_PATH 也不读）
#   b) 锁版本（网关契约对 pi-web 内部协议做了收敛）
#   c) 换自己的应用时删掉这段 RUN，改用下方注释掉的 COPY 三行
RUN npm install -g @agegr/pi-web@0.9.3 --no-audit --no-fund \
    && mkdir -p /app/node_modules \
    && ln -s /usr/local/lib/node_modules/@agegr /app/node_modules/@agegr

# 换自己的应用时用这三行替代上面的 RUN：
# COPY myapp/ /app/myapp/
# WORKDIR /app/myapp
# RUN npm install --omit=dev --no-audit --no-fund

# ══ STEP 2：主进程接入参数（4 个变量 = 全部接入面）═══════════
#
#   NXAS_TARGET_CMD          主进程命令（sh -c 执行）。
#                            留空 = 纯权限壳：不启动主进程，catch-all 404，
#                            不报错不崩——容易误判为「部署好了」。
#   NXAS_TARGET_PORT         主进程监听端口（nginx 代理目标）。pi-web 是 30141；
#                            换应用记得改，默认 30141 会让受保护路径全部 502。
#   NXAS_PROTECT             需鉴权的路径（空格分隔）。/* 全鉴权；
#                            有公开路径（登录页等）的应用自己列白名单。
#   NXAS_TARGET_ENV_PIWEB    1=按 pi-web 注入机机密码 PI_WEB_PASSWORD。
#                            换自己的应用【必须设 0】。
#
ENV NXAS_TARGET_CMD="nx-as web --port 30141 --no-open" \
    NXAS_TARGET_PORT=30141 \
    NXAS_PROTECT="/*" \
    NXAS_TARGET_ENV_PIWEB=1

# ══ STEP 3：不要动 ═══════════════════════════════════════════
# 不写 CMD / ENTRYPOINT —— 主进程入口就是 NXAS_TARGET_CMD；
# 覆盖 entrypoint 会失去机机密码物化 / nginx 模板渲染 / nginx 前台。
