# gost-as — 安全内网穿透基座（gost + nginx 鉴权 + nx-as 配置管理）

> 一句话：2c2g 服务器跑一个 `gost-as` 容器，本地一条 gost 命令就能把**未鉴权的本地服务**
> 0 感知发布到公网——外部访问必须先过 nginx 鉴权（go-ah 单点登录），数据直达本地服务。

## 1. 架构与可行性

```
外部用户                       47 服务器（host 网络，单容器 gost-as）                本地机器
   │                          ┌─────────────────────────────────────┐
   │  http://IP:<L>/          │  nginx :L（每隧道一个 server 块）      │
   ├─────────────────────────►│    │ auth_request ──► nx-as :7801    │
   │                          │    │   （go-ah SSO 会话鉴权）         │
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
4. **鉴权复用 nx-as**：`auth_request` 委托给容器内 nx-as（go-ah OIDC 单点登录 + 邮箱白名单，
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
      NXAS_OIDC_ISSUER/CLIENT_ID/ALLOWED_EMAILS: ...   # 必填（见 docker-compose.gost-as.yml 注释）
      NXAS_LISTEN_PORT: "8090"
      NXAS_GOST_PORT:  "8442"
    restart: unless-stopped
```

容器内三进程（`docker/entrypoint-gost.sh`）：gost relay（前台）+ nx-as（127.0.0.1:7801，
`NXAS_GW_MODE=nginx`）+ nginx（8090 主入口 + 各隧道 server）。`docker/gost-init.mjs` 首启
把托管目录设为 `/etc/nginx/http.d`——**面板「配置文件管理器」直接管理隧道 server 块**。

## 4. 注册穿透（发布一个本地服务）——一条龙

```bash
# 本机执行（首次自动弹浏览器完成 go-ah 登录；注册隧道 + 自动拉起常驻 gost 全自动）
nx-as tunnel add sqlh 7877 --server http://47.110.80.47:8090/_nxas
# ✓ 隧道 sqlh：本地 :7877 → 公网 :7877
# ✓ gost：已拉起常驻进程
# 访问：http://47.110.80.47:7877/  （首次访问跳 go-ah 登录；安全组需放行 7877）

nx-as tunnel list               # 总览（本地 ∪ server 对账 + gost 状态）
nx-as tunnel remove sqlh        # 删除（server conf 有备份）
```

手工姿势（不想用一条龙时）：
- 本地面板 `nx-as client serve` → 「配对登录」→ 表单注册；
- 或 server 侧单独注册 conf：`nx-as nginx tunnel apply <名> --public-port <P>`（单一模板渲染），
  本地转发自己管（`gost -L "rtcp://127.0.0.1:1<P>/127.0.0.1:<P>" -F relay://...`，须常驻）。

### 附：手动常驻 gost（不用一条龙时；一条龙已自动处理）

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

- 浏览器打开 `http://47.110.80.47:7877/` → 跳 go-ah 登录（白名单邮箱）→ 回原路径，
  **之后就是本地服务的原样界面**（0 感知；同 IP 各端口共享登录态，登录一次全通）
- 程序化访问：`nx-as client login`（配对）后 `curl -H "Authorization: Bearer <会话>" http://47.110.80.47:7877/...`

### 凭据与设备管理

| 凭据 | 位置/签发 | 用途 |
|---|---|---|
| go-ah SSO 会话 | 浏览器登录（白名单邮箱）| 面板与全部隧道端口（nxas_session cookie / Bearer 双载体，7 天）|
| CLI 配对会话 | `nx-as client login` → ~/.nx-as/credentials.json | 本机脚本/注册隧道 |
| relay 口令 | 47 `/opt/gost-as/data/gost-auth.env`（首启生成）| 本地 gost 客户端连入 8442（nginx stream 收敛）|

会话 7 天有效，过期重新登录（go-ah 全局会话内免密）；全端下线：`nx-as auth rotate`。

## 5. 多端口（暴露多个本地服务）

每多一个服务 = 一条命令（gost 常驻进程会聚合全部隧道 -L，自动管理）：

```bash
nx-as tunnel add web 3000
nx-as tunnel add api 9000 --public-port 9001   # 公网端口与本地不同时给 --public-port
```

对应公网端口（3000/9001）需在阿里云安全组放行。临时停用：面板把 `nxas-tunnel-<名>.conf`
停用；删除有备份可还原。

## 6. 安全模型

- **公网唯一入口是 nginx**：nx-as（7801）与 gost rtcp 监听（1L）全部绑 127.0.0.1，
  host 网络下物理不可达；安全组只需开 8090 / 8442 / 各隧道公网端口
- **两层凭据各管一段**：数据面（隧道服务访问）= go-ah SSO 会话 + 邮箱白名单；
  relay 隧道入口另有 user/pass（防陌生人蹭隧道）
- **每条隧道的鉴权独立委托**（nginx `internal` 端点按 server 隔离），停用某条隧道不影响其它
- **变更管线安全**：注册/删除走备份 → `nginx -t` 失败自动还原 → reload；所有登录、
  nginx 变更落审计（`/data/audit.jsonl`）
- 登录接口指数退避限流（与网关共用 `ip:` 桶）；HTTPS 可后续在 nginx 模板加 TLS 块

## 7. 故障排查

| 现象 | 排查 |
|---|---|
| 公网端口连不通 | 阿里云安全组放行该端口；`ssh 2026aliyun "ss -tln | grep <端口>"` 确认 nginx 在听 |
| 隧道 502 | 本地 gost 客户端没跑/凭据错 → 看客户端日志；47 上 `ss -tln | grep 1<L>` 应有 loopback 监听 |
| 一直跳登录页 | 会话过期 → 重新登录（go-ah 全局会话内免密）；账号不在 NXAS_OIDC_ALLOWED_EMAILS 白名单则被 403 |
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
