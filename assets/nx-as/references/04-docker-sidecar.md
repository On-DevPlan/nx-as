# 04 · Docker 边车容器（基于 nx-as-base 基础镜像）

> 场景：把**你自己的应用**（不是 pi-web）套上 nx-as 的鉴权网关——nginx 终结流量 + nx-as 鉴权，
> 你的进程作为「主进程」被网关保护。应用在登录之后一切不变（路径、头部、cookie 全原样）。

## 基础镜像是什么

`ghcr.io/on-devplan/nx-as-base` = **纯权限壳**：nginx（公网入口）+ nx-as（鉴权中间件），
不含任何主程序。它是同一个 Dockerfile 的 `base` target（`nx-as` 镜像是 `full` target = base + pi-web）。

```
                     ┌─ /_nxas/* ──→ nx-as :7801（登录页/管理面/手机 API/鉴权决策）
用户 ──→ nginx :8080 ─┤
                     └─ 其余路径 ──→ 你的主进程（auth_request 鉴权后直代，或无 NXAS_TARGET_CMD 时 404）
```

- 登录一次（device token 兑换 7 天会话 cookie + 上游会话代签），之后**零感知**：
  你的应用收到的路径/头部/cookie 与直跑完全一致。
- `NXAS_PROTECT` 命中的路径走 auth_request 鉴权；未命中的公开直通。

## 什么时候用 base 而不是 full

| 你要的 | 用 |
|---|---|
| 跑 pi-web（个人 agent server） | `ghcr.io/on-devplan/nx-as`（full，开箱即用） |
| 跑**自己的应用** + 鉴权网关 | `FROM ghcr.io/on-devplan/nx-as-base`（本篇） |
| 只要 nx-as 网关本身（无应用） | base 直接跑也行（catch-all 返回 404，网关照常工作） |

## 派生 Dockerfile（最小可用）

```dockerfile
FROM ghcr.io/on-devplan/nx-as-base:0.7.1

# 你的应用放哪都行，惯例放 /app/myapp
COPY myapp/ /app/myapp/
WORKDIR /app/myapp
RUN npm install --omit=dev --no-audit --no-fund

# 接入点：告诉基础镜像怎么拉起你的进程
ENV NXAS_TARGET_CMD="node /app/myapp/server.js" \
    NXAS_TARGET_PORT=5000 \
    NXAS_PROTECT="/*" \
    NXAS_TARGET_ENV_PIWEB=0
```

四行 ENV 是全部接入面（缺一不可的只有前两个）：

| 变量 | 语义 | 不设会怎样 |
|---|---|---|
| `NXAS_TARGET_CMD` | 主进程启动命令（sh -c 执行） | **空 = 纯权限壳**：不启动主进程，catch-all 返回 404（不报错、不崩，容易误判为「部署好了」） |
| `NXAS_TARGET_PORT` | 主进程监听端口（nginx 代理目标） | 默认 30141 → 你的应用不在那 → 网关照常起、所有受保护路径 502 |
| `NXAS_TARGET_ENV_PIWEB` | 1=按 pi-web 注入机机密码 | 非确认自己的主进程是 pi-web 时**必须设 0**，否则 entrypoint 会尝试往环境里塞 PI_WEB_PASSWORD |
| `NXAS_PROTECT` | 需鉴权的路径（空格分隔） | 默认 `/*`（全鉴权）；只要登录页可公开访问的应用记得加白名单 |

## 构建与运行

```bash
docker build -t myapp-nxas:0.1.0 .
docker run -d --name myapp-nxas \
  -p 8080:8080 \
  -v nxas-data:/data \
  myapp-nxas:0.1.0
```

- `-v <卷或目录>:/data` **必须有**：store.json（设备/密钥/审计/证书元数据）与 pi-agent 目录都在里面，
  不挂卷则每次重建容器全部设备 token 作废、面板要重新初始化。
- 端口只有一个：`NXAS_LISTEN_PORT`（默认 8080）。7801（网关）与主进程端口都只在容器内。

## 登录与设备 token

```bash
# 1. 容器里签发 device token（或用面板：http://<host>:8080/_nxas/panel）
docker exec <容器> nx-as device issue --name "my-phone"
# → nxas_d1.<id>.<secret>   secret 只出现这一次

# 2. 浏览器访问任意受保护路径 → 302 到 /_nxas/login → 粘贴 token → 回原路径（零感知）
# 3. API/脚本：直接 Bearer
curl -H "Authorization: Bearer nxas_d1..." http://localhost:8080/<你的应用路径>
```

## 常见坑（改 Dockerfile 前先读）

| 坑 | 后果 | 正确做法 |
|---|---|---|
| 用 `latest` tag FROM | 基础镜像行为漂移（entrypoint/模板可能变） | 锁版本：`FROM ghcr.io/on-devplan/nx-as-base:0.7.1` |
| 自己 `CMD`/`ENTRYPOINT` 覆盖 | 绕过 entrypoint → 没有机机密码物化/模板渲染/nginx 前台 | 不要覆盖；主进程入口是 `NXAS_TARGET_CMD`，不是 CMD |
| 主进程写日志到容器层 | 重建容器丢日志 | 应用日志写 /data/ 下或 stdout（docker logs） |
| `NXAS_PROTECT="/api/*"` 时 `/api` 不带斜杠的精确路径漏鉴权 | render-protect 已同时渲染 `/api` 与 `/api/` 两条 location（精确+前缀） | 直接用；无需自己补 `/api` |
| 主进程不是 pi-web 却留 `NXAS_TARGET_ENV_PIWEB=1` | entrypoint 无害地注入 PI_WEB_PASSWORD 环境变量（不崩，但多余） | 明确设 0，语义干净 |
| 只开一个 `EXPOSE` 之外的端口 | EXPOSE 只是文档；真正入口只有 nginx :8080 | 保持单入口；调试端口映射出去要自己 -p 且知道绕过了鉴权 |
