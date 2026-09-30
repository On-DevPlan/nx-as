---
name: nx-as-sidecar
description: 当用户要"给自己的应用套上鉴权网关容器"或提到 nx-as Docker、边车容器、sidecar、FROM nx-as-base、基础镜像、鉴权中间件底座、nginx+nx-as、登录后零感知、NXAS_TARGET_CMD 时使用。指导从 ghcr.io/on-devplan/nx-as-base（nginx + nx-as 纯权限壳）派生 Dockerfile，把自己的应用作为主进程接入鉴权网关；应用在登录之后一切不变（路径/头部/cookie 全原样）。不适用于：跑 pi-web 本体（用 nx-as 镜像即可）、与 nx-as 无关的通用 Docker 问题。
---

# nx-as-sidecar — 基于 nx-as-base 的鉴权边车容器

`ghcr.io/on-devplan/nx-as-base` 是**纯权限壳**：nginx（公网入口）+ nx-as（鉴权中间件），
不含任何主程序。`FROM` 它、设 4 个环境变量，你的应用就成了带鉴权网关的容器——
登录之后一切不变：路径、头部、cookie 与直跑完全一致（零感知）。

```
                     ┌─ /_nxas/* ──→ nx-as :7801（登录页/管理面/手机 API/鉴权决策）
用户 ──→ nginx :8080 ─┤
                     └─ 其余路径 ──→ 你的主进程（auth_request 鉴权后直代；无主进程时 404）
```

## 核心不变量

1. **不覆盖 ENTRYPOINT/CMD** —— 主进程入口是 `NXAS_TARGET_CMD` 环境变量，不是 Dockerfile 的
   CMD。覆盖了就没有机机密码物化、模板渲染、nginx 前台，容器起不来或鉴权形同虚设。
2. **唯一入口 nginx :8080** —— `EXPOSE` 之外不开第二个映射端口。7801（网关）与主进程端口
   只在容器内；调试端口要 -p 映射出去时，知道那是在绕过鉴权。
3. **`/data` 卷必须挂** —— store.json（设备/密钥/审计/证书元数据）都在里面。不挂卷 =
   重建容器全部 device token 作废、面板重新初始化。
4. **锁版本 FROM** —— `FROM ghcr.io/on-devplan/nx-as-base:0.7.1`，不用 latest
   （entrypoint/模板行为会漂移——47 服务器踩过：旧 entrypoint 渲不了新模板 → 重启循环）。

## 快速上手：直接用模板（含 pi-web 案例）

skill 目录里有两个**开箱即用**的模板，以 pi-web 为主进程案例（换自己的应用只改标注的 STEP 1/2）：

| 文件 | 用法 |
|---|---|
| `template.Dockerfile` | `cp template.Dockerfile Dockerfile` —— 含全部默认参数注释、pi-web 安装（含 @agegr 软链坑）、换自用应用的替代段 |
| `template.compose.yml` | `cp template.compose.yml docker-compose.yml` —— 端口/卷/内存/日志轮转默认值齐备 |

```bash
cp template.Dockerfile Dockerfile && cp template.compose.yml docker-compose.yml
docker compose up -d
# 验证三件套：
curl -s http://localhost:8080/_nxas/api/auth/verify   # → {"valid":false,"version":"..."}
curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: text/html' http://localhost:8080/   # → 302
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/_nxas/m/v1/sessions       # → 401
```

## 最小可用 Dockerfile（模板的精简版，理解用）

```dockerfile
FROM ghcr.io/on-devplan/nx-as-base:0.7.1

# 你的应用放哪都行，惯例放 /app/myapp
COPY myapp/ /app/myapp/
WORKDIR /app/myapp
RUN npm install --omit=dev --no-audit --no-fund

# 接入点：告诉基础镜像怎么拉起你的进程（全部接入面就这 4 个变量）
ENV NXAS_TARGET_CMD="node /app/myapp/server.js" \
    NXAS_TARGET_PORT=5000 \
    NXAS_PROTECT="/*" \
    NXAS_TARGET_ENV_PIWEB=0
```

| 变量 | 语义 | 不设会怎样 |
|---|---|---|
| `NXAS_TARGET_CMD` | 主进程启动命令（sh -c 执行） | **空 = 纯权限壳**：不启动主进程，catch-all 返回 404——不报错不崩，容易误判为「部署好了」 |
| `NXAS_TARGET_PORT` | 主进程监听端口（nginx 代理目标） | 默认 30141 → 你的应用不在那 → 网关照常起、受保护路径全部 502 |
| `NXAS_TARGET_ENV_PIWEB` | 1=按 pi-web 注入机机密码 | 非 pi-web 主进程**必须设 0**（否则 entrypoint 塞一个无用的 PI_WEB_PASSWORD） |
| `NXAS_PROTECT` | 需鉴权的路径（空格分隔） | 默认 `/*` 全鉴权；有公开路径（如登录页）的应用改它 |

## 构建 / 运行 / 验证

```bash
docker build -t myapp-nxas:0.1.0 .
docker run -d --name myapp-nxas -p 8080:8080 -v nxas-data:/data myapp-nxas:0.1.0

# 验证三件套（网关就绪 / 登录引导 / API 保护）
curl -s http://localhost:8080/_nxas/api/auth/verify     # → {"valid":false,"version":"..."}
curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: text/html' http://localhost:8080/   # → 302
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/_nxas/m/v1/sessions       # → 401
```

## 登录与设备 token

```bash
# 1. 签发 token（容器内 CLI 或面板 http://<host>:8080/_nxas/panel）
docker exec myapp-nxas nx-as device issue --name "my-phone"
# → nxas_d1.<id>.<secret>   secret 只出现这一次，泄露即吊销重签

# 2. 浏览器访问任意受保护路径 → 302 到 /_nxas/login → 粘贴 token → 回原路径（零感知）
# 3. API/脚本：直接 Bearer
curl -H "Authorization: Bearer nxas_d1..." http://localhost:8080/<你的应用路径>
```

## 常见坑

| 坑 | 后果 | 正确做法 |
|---|---|---|
| 用 `latest` FROM | 基础镜像行为漂移（entrypoint/模板可能变） | 锁版本 tag |
| 覆盖 CMD/ENTRYPOINT | 绕过 entrypoint → 无机机密码物化/模板渲染/nginx 前台 | 主进程入口是 `NXAS_TARGET_CMD` |
| 不挂 `/data` 卷 | 重建容器全部 token 作废 | `-v <卷或目录>:/data` |
| `NXAS_TARGET_CMD` 留空 | 纯权限壳 404，误以为部署好了 | 设主进程命令；网关日志看「启动主进程」 |
| 主进程不是 pi-web 却留 `NXAS_TARGET_ENV_PIWEB=1` | 注入无用变量（不崩但语义脏） | 明确设 0 |
| `NXAS_PROTECT="/api/*"` 担心 `/api` 精确路径漏 | render-protect 已同时渲染 `/api` 与 `/api/`（精确+前缀） | 直接用，无需补 |

## 什么时候不用

- 跑 **pi-web** 本体 → 直接用 `ghcr.io/on-devplan/nx-as`（full 镜像，pi-web 已内置）
- 只要 nx-as 网关本身（无应用）→ base 直接跑也行（catch-all 404）
- 与 nx-as 无关的容器需求 → 通用 Docker 知识，不是本 skill 场景
