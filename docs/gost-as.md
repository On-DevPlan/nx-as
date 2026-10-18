# gost-as — 安全内网穿透基座（gost + nginx 鉴权 + nx-as 配置管理）

> 一句话：2c2g 服务器跑一个 `gost-as` 容器，本地一条 gost 命令就能把**未鉴权的本地服务**
> 0 感知发布到公网——外部访问必须先过 nginx 鉴权（登录页 / device token），数据直达本地服务。

## 1. 架构与可行性

```
外部用户                       47 服务器（host 网络，单容器 gost-as）                本地机器
   │                          ┌─────────────────────────────────────┐
   │  http://IP:<L>/          │  nginx :L（每隧道一个 server 块）      │
   ├─────────────────────────►│    │ auth_request ──► nx-as :7801    │
   │                          │    │   （登录页 / device token 鉴权）  │
   │                          │    ▼ proxy_pass                     │
   │                          │  gost 127.0.0.1:1L（rtcp 注册监听）   │
   │                          │    │                                │
   │                          │  gost :8442 ◄── relay 隧道 ──────────┤ gost 客户端
   │                          │         （认证 + bind=true）          │   │
   │                          └─────────────────────────────────────┘   ▼
   │                                                          本地服务 127.0.0.1:7877
   │                                                          （sql-harness / 任意 HTTP）
```

**理论可行性（已实测验证）**，四个关键点：

1. **gost relay 的远程端口注册**：服务端 `gost -L "relay+tcp://user:pass@:8442?bind=true"`，
   客户端 `gost -L "rtcp://127.0.0.1:17877/127.0.0.1:7877" -F "relay://user:pass@IP:8442"`
   → 服务端在 **127.0.0.1:17877** 开监听（实测确认支持 loopback 绑定），流量经 relay 回到客户端
   转发到本地 7877。
2. **0 感知**：外部路径、查询串、头部、cookie 全部原样（nginx 只做鉴权与代理）——与 nx-as
   基础镜像的「登录后零感知」同一哲学。服务端监听绑 loopback，公网**物理上**绕不过 nginx。
3. **动态可插拔**：每条隧道 = 一个 `http.d/nxas-tunnel-*.conf` server 块。注册动作走 nx-as
   的**配置文件管理器**管线（备份 → `nginx -t` 失败自动还原 → graceful reload），无需重启容器；
   host 网络下新端口即刻可达（零 ports 映射、零 compose 改动）。
4. **鉴权复用 nx-as**：`auth_request` 委托给容器内 nx-as（管理密钥 + device token 两级凭据、
   指数退避限流、审计）。登录 cookie 按 host 共享（不含端口）——**任一端口登录一次，全部隧道
   端口放行**。

## 2. 端口模型（约定）

| 端口 | 用途 | 公网 |
|---|---|---|
| `8090` | 面板/登录主入口（nginx → nx-as） | ✅ 安全组放行 |
| `8442` | gost relay 隧道入口（本地客户端连入，带认证） | ✅ 安全组放行 |
| `<L>` | 每条隧道一个公网端口（默认=本地服务端口），nginx 监听 | ✅ 按需放行 |
| `1<L>` | gost rtcp 注册监听，**绑定 127.0.0.1** | ❌ 公网不可达 |
| `7801` | nx-as 网关，**绑定 127.0.0.1** | ❌ 公网不可达 |

> 心智模型：**本地端口 = 公网端口**（`7877` 本地 → `IP:7877` 公网），隧道内部端口自动 `10000+`。

## 3. 部署（47 服务器已完成）

镜像构建与分发（本地构建，绕开 47 拉 GitHub 慢的问题）：

```bash
# 本地：构建 gost target（gost 3.2.6 + nginx + nx-as）
docker build --target gost -t gost-as:0.8.0 .
# 本地 → 47：流式传输（CI 同款管线）
docker save gost-as:0.8.0 | gzip -1 | ssh 2026aliyun "docker load"
```

47 上的部署件（`/opt/gost-as/`，已就位）：

```yaml
# docker-compose.yml（节选）
services:
  gost-as:
    image: gost-as:0.8.0
    network_mode: host          # 动态端口注册零重启
    volumes: [ "./data:/data" ]
    environment:
      NX_AS_TOKEN: 管理密钥      # 见下方交付清单
      NXAS_LISTEN_PORT: "8090"
      NXAS_GOST_PORT:  "8442"
    restart: unless-stopped
```

容器内三进程（`docker/entrypoint-gost.sh`）：gost relay（前台）+ nx-as（127.0.0.1:7801，
`NXAS_GW_MODE=nginx`）+ nginx（8090 主入口 + 各隧道 server）。`docker/gost-init.mjs` 首启
把托管目录设为 `/etc/nginx/http.d`——**面板「配置文件管理器」直接管理隧道 server 块**。

## 4. 注册指令（发布一个本地服务）

### 第 1 步：服务器侧注册（在任意能访问 8090 的机器上）

```bash
cd nx-as 仓库
node scripts/nxas-tunnel.mjs add sqlh 7877 \
  --server http://47.110.80.47:8090/_nxas \
  --token <管理密钥>
# ✅ 隧道已注册并生效: sqlh（新建，nginx -t 通过 + reload）
# 公网入口:  http://<服务器IP>:7877/   （安全组需放行 7877）
```

其它子命令：`list`（隧道清单）、`remove <名称>`（删除并 reload）。
等价的手工方式：面板「nginx → 配置文件管理器」新建 `nxas-tunnel-<名>.conf`（模板见
`scripts/nxas-tunnel.mjs` 内的 `tunnelConf()`），保存即生效。

### 第 2 步：本地 gost 客户端常驻（Windows PowerShell / 任意 shell）

```bash
# 隧道凭据在服务器 /opt/gost-as/data/gost-auth.env（NXAS_GOST_USER / NXAS_GOST_PASS）
gost -L "rtcp://127.0.0.1:17877/127.0.0.1:7877" \
     -F "relay://gost:<隧道密码>@47.110.80.47:8442"
```

Windows 常驻（`schtasks` / NSSM / 计划任务开机启动任选，或最简单的隐藏窗口）：

```powershell
# gost 客户端参数可合并：一条命令注册多条隧道
gost -L "rtcp://127.0.0.1:17877/127.0.0.1:7877" `
     -L "rtcp://127.0.0.1:13000/127.0.0.1:3000" `
     -F "relay://gost:<隧道密码>@47.110.80.47:8442"
```

### 第 3 步：访问

- 浏览器打开 `http://47.110.80.47:7877/` → 跳登录页 → 粘贴 device token → 回原路径，
  **之后就是本地 sql-harness 的原样界面**（0 感知）
- 程序化访问：`curl -H "Authorization: Bearer <device token>" http://47.110.80.47:7877/...`

### 凭据与设备管理

| 凭据 | 位置/签发 | 用途 |
|---|---|---|
| 管理密钥 | 47 `/opt/gost-as/.env`（`NX_AS_TOKEN`） | 面板/CLI/注册 API |
| 隧道凭据 | 47 `/opt/gost-as/data/gost-auth.env` | 本地 gost 客户端连 relay |
| device token | `ssh 2026aliyun "docker exec gost-as nx-as device issue --name <名>"` | 外部访问隧道服务（可吊销） |

device token 只出现一次，交付给需要访问的设备；吊销：`docker exec gost-as nx-as device revoke <id>`
或面板「gateway」页。

## 5. 多端口（暴露多个本地服务）

每多一个服务 = 多一条注册 + 多一段 gost `-L`：

```bash
# 服务器侧（可并列多条，互不影响）
node scripts/nxas-tunnel.mjs add web 3000  --server http://47.110.80.47:8090/_nxas --token <管理密钥>
node scripts/nxas-tunnel.mjs add api 9000 --public-port 9001 --server http://47.110.80.47:8090/_nxas --token <管理密钥>

# 本地 gost（一条命令全部注册；--public-port 非默认时 rtcp 端口跟随公网端口）
gost -L "rtcp://127.0.0.1:13000/127.0.0.1:3000" -L "rtcp://127.0.0.1:19001/127.0.0.1:9000" \
     -F "relay://gost:<隧道密码>@47.110.80.47:8442"
```

对应公网端口（3000/9001）需在阿里云安全组放行。隧道可临时停用：面板把
`nxas-tunnel-<名>.conf` 改名（停用）或 `remove` 删除（都有备份，可还原）。

## 6. 安全模型

- **公网唯一入口是 nginx**：nx-as（7801）与 gost rtcp 监听（1L）全部绑 127.0.0.1，
  host 网络下物理不可达；安全组只需开 8090 / 8442 / 各隧道公网端口
- **两级凭据互不相通**：管理面（注册/面板）用管理密钥；数据面（访问隧道服务）用可吊销的
  per-device token；relay 隧道入口另有 user/pass（防陌生人蹭隧道）
- **每条隧道的鉴权独立委托**（nginx `internal` 端点按 server 隔离），停用某条隧道不影响其它
- **变更管线安全**：注册/删除走备份 → `nginx -t` 失败自动还原 → reload；所有登录、
  nginx 变更落审计（`/data/audit.jsonl`）
- 登录接口指数退避限流（与网关共用 `ip:` 桶）；HTTPS 可后续在 nginx 模板加 TLS 块

## 7. 故障排查

| 现象 | 排查 |
|---|---|
| 公网端口连不通 | 阿里云安全组放行该端口；`ssh 2026aliyun "ss -tln | grep <端口>"` 确认 nginx 在听 |
| 隧道 502 | 本地 gost 客户端没跑/凭据错 → 看客户端日志；47 上 `ss -tln | grep 1<L>` 应有 loopback 监听 |
| 一直跳登录页 | device token 无效/过期 → 重新签发；或管理密钥登录面板核对设备清单 |
| 注册报 nginx -t 失败 | 错误原文会带出（配置语法错）；修内容重新 add 即可，上一版已自动还原 |
| 面板进不去 | `docker logs gost-as`；`curl 127.0.0.1:8090/_nxas/api/auth/verify`（47 本机） |

## 8. 与 nx-as 的关系

gost-as 是 nx-as 仓库的第三个 Docker target（`base` 纯权限壳 / `full` 带 pi-web / `gost`
穿透基座），复用同一套鉴权决策（`gateway/check.js`）、配置文件管理器（`nginx/files.js`）
与面板。相关源码：`docker/entrypoint-gost.sh`、`docker/gost-nginx.conf.template`、
`docker/gost-init.mjs`、`scripts/nxas-tunnel.mjs`、`docker-compose.gost-as.yml`。

## 9. 镜像发布（CI）

`.github/workflows/gost-as-image.yml` 在 `v*` tag 或 manual dispatch 时自动：

1. 构建 Dockerfile `gost` target（`gost relay + nginx + nx-as`）
2. 冒烟契约：起容器 30s 内 `nx-as 网关 127.0.0.1:7801` + `gost relay :8442` 同时就绪
3. 推送 `ghcr.io/on-devplan/gost-as:<version>` 与 `:latest`

手动触发：

```bash
gh workflow run "gost-as image"
# 拉取到 47：
ssh 47 "cd /opt/gost-as && docker compose pull && docker compose up -d"
```

需要同时推 Docker Hub：仓库加 secrets `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`，
在 workflow 的 build job 末尾加一段 `docker/login-action@v3` 登录 + 多加一个 tag 推送即可
（参考 `docker-image.yml` 的 `docker push` 步骤结构）。
