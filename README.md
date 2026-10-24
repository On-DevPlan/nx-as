# nx-as (nx-apiserver)

**nginx 配置文件管理器 + 鉴权网关基座**：一个自带专业控制面板的 nginx 运维工具——
浏览/编辑/新建/停用/删除 nginx 配置文件，每次变更自动 `nginx -t` 校验（失败还原）+
graceful reload + 滚动备份；在此之上是一层鉴权网关（**go-ah OIDC 单点登录**统一会话、
限流、审计），把任意目标进程安全地放到公网后面。

```
浏览器 ──► nx-as 控制面板（nginx 配置文件管理器 · 设备管理 · 证书 · 密钥）
              │
              ├─ nginx 配置管理：托管目录内 *.conf 全生命周期（-t 校验 / reload / 备份还原）
              ├─ 鉴权网关：/m/v1/* 反代（SSO 会话 + SSE 短票）/ nginx auth_request 委托
              └─ Docker 基座：FROM nx-as-base 给任意应用套上「登录 + nginx 入口」
```

包名/bin 仍为 `nx-as`；`nx-apiserver` 是它的语义名。CLI、Web 面板、管理 API 同一张 action 表。
另有 **direct 模式**（默认，`NXAS_GW_MODE` 未设）：不经 nginx，nx-as 进程内反代，一条命令本机全通。

## 快速开始（3 步完成内网穿透）

```bash
# ① 服务器上部署 gost-as 容器（完整 compose 见 docs/gost-as.md；三个 OIDC env 必填）
#    NXAS_OIDC_ISSUER=http://<go-ah>  NXAS_OIDC_CLIENT_ID=nx-as  NXAS_OIDC_ALLOWED_EMAILS=<你的邮箱>
docker compose -f docker-compose.gost-as.yml up -d        # 面板 http://服务器:8090
#    验证：浏览器打开 http://服务器:8090 → 应跳 go-ah 登录页，登录后进面板即部署成功

# ② 注册 OIDC client（一次性；go-ah 管理员账号）并验证
nx-as oidc register --username <管理员> --issuer http://<go-ah>   # 密码交互输入
nx-as oidc probe                                                  # 四段全过 = 配置就绪

# ③ 本机穿透一条龙（首次自动弹浏览器完成 go-ah 登录 → 注册隧道 → 拉起常驻 gost）
nx-as tunnel add sqlh 7877 --server http://服务器:8090/_nxas
# ✓ 输出：本地 :7877 → 公网 :7877；浏览器打开 http://服务器:7877 即用（跳 go-ah 登录）
```

日常只有三条命令：`tunnel add`（加）/ `tunnel list`（看）/ `tunnel remove`（删）。
本机调试面板（direct 模式）与更多用法见下方各节。

## nginx 配置文件管理

### 看板（面板主页，UI 表单 ↔ 配置文件）

面板 nginx 页的主体是一张**看板**：托管目录里每个 `*.conf` 一行——类型（站点/端口/网关/自定义）、
入口（域名或端口）、上游、特性徽标（TLS/WS/鉴权/表单）、启用状态与操作。两种「从 UI 生成配置文件」
的表单，保存即走同一条 **备份 → `nginx -t`（失败还原）→ graceful reload** 管线：

| 表单 | 生成 | 配置文件 |
|---|---|---|
| **添加反代站点** | 域名（多个）→ 上游，可选 WebSocket 升级、TLS（证书/私钥路径） | `nxas-site.<域名slug>.conf`（`server_name …` + `proxy_pass …`） |
| **添加端口转发** | 监听端口 → 上游（特殊端口反代），可选 TLS/WS | `nxas-port.<端口>.conf`（`listen <端口>` + `proxy_pass …`） |

- 表单生成的文件带 `# nxas-spec <json>` 头：看板「编辑」从 spec 回填表单，保存整体重渲染该文件；
  保存前有**实时预览**（400ms 防抖，直接渲染将要落盘的配置文本 + 即时校验报错）
- 没有 spec 头的文件（手写/历史配置）同样进看板：解析 server 块推断字段，只读展示，
  「配置」按钮跳原始编辑器；停用/删除/备份还原与文件管理器共用一套能力
- CLI 等价：`nginx hosts`（看板清单）/ `nginx host apply [--spec '<json>' | 拆开 flag]`（增改，
  `--preview` 只渲染不落盘）/ `nginx host remove <名>`（删除）

### 多文件管理器（宿主机模式）

管理 **托管目录**（`managedPath` 所在目录，默认 `/etc/nginx/conf.d`）内的全部 `*.conf`：

| 操作 | 命令 | 面板 |
|---|---|---|
| 清单 | `nx-as nginx files` | 文件列表（启用态/大小/备份计数/写权） |
| 读 | `nx-as nginx file get <名>` | 点击文件 → 编辑器 |
| 写/新建 | `nx-as nginx file put <名> --from <文件>` | 编辑器「保存并生效」/「新建」 |
| 删除 | `nx-as nginx file delete <名>` | 「删除」（先备份） |
| 停用/启用 | `nx-as nginx file toggle <名>` | 「停用/启用」（`.conf` ↔ `.conf.disabled`，改名即不加载/加载） |
| 备份清单 | `nx-as nginx file backups <名>` | 「备份历史」 |
| 还原 | `nx-as nginx file restore <名> --ts <时间戳>` | 备份行「还原」 |

每次变更的固定管线：**变更前自动备份 → `nginx -t`（失败自动还原原文并报错原文）→ graceful reload**。
备份落在 `~/.nx-as/nginx-backups/<文件名>/<时间戳>.conf`，每文件滚动保留 10 份（不在 nginx 目录里留垃圾）。

### 安全边界（与单文件托管同一红线）

- 只操作托管目录内的**平铺 `*.conf` 文件**：文件名白名单、拒绝路径穿越与符号链接；
  主 `nginx.conf` 与托管目录之外的文件**任何情况下不可写**
- sudoers 白名单仍然只有两条命令：`nginx -t` / `nginx -s reload`（`nx-as nginx setup` 生成）
- 目录级操作（新建/删除/停用）需要目录写权限——`nginx status` 探测并展示 `dirWritable`，
  未授权时面板禁用对应按钮。`nginx setup` 输出两档授权：
  1. **基础**（默认）：托管单文件可写（664），面板可编辑其内容
  2. **完整管理**（推荐给专用服务器）：`chgrp nxas <托管目录> && chmod 775` → 目录内
     配置文件的新建/删除/停用全部可用

### 托管单文件（引导配置）

`nx-as nginx apply --domain ... --cert-path ... --key-path ...` 渲染反代引导配置到托管单文件
（表单或 `--preview` 预览），Apply 自动 `nginx -t`、失败回滚、成功 reload；「轮换机机密码」
一键原子轮换。它是初次部署/换域名证书的引导流程；日常站点配置用多文件管理器。

### 容器模式

`NXAS_NGINX_SUDO=0`（容器内）时面板切换为**模板编辑器**：直接编辑生效模板 → 渲染 →
`nginx -t`（失败回滚）→ reload；模板经卷挂载持久化。

## /m/v1 网关 API

响应是上游原样 JSON（网关只做鉴权转发，不改包络）。pi-web 场景的路由表：

| 网关路由 | 上游 | 说明 |
|---|---|---|
| `GET /m/v1/sessions` | `/api/sessions` | 会话列表 |
| `POST /m/v1/agent/new` | `/api/agent/new` | 建会话/发首条 prompt |
| `POST /m/v1/agent/:id` | `/api/agent/:id` | 会话命令（prompt/steer/follow_up…） |
| `GET /m/v1/agent/:id/events` | `/api/agent/:id/events` | SSE 事件流（支持短票） |
| `POST /m/v1/sessions/:id/ticket` | —（网关本地） | Bearer 换 60 秒一次性 SSE 短票 |

SSE 用 EventSource 时不能带 header：先 `POST /m/v1/sessions/:id/ticket`（带 Bearer）换
短票 URL（票与会话绑定、一次性消费），再 `new EventSource(url)`。

## 管理命令

| 命令 | 作用 |
|---|---|
| `nx-as serve [--port 7801] [--host] [--no-open] [--with-web] [--web-port]` | 起网关 + 面板；`--with-web` 同时拉起 pi-web 并注入随机 `PI_WEB_PASSWORD`；端口被占时见下方「端口占用」 |
| `nx-as web [--port 30141]` | 只拉起 pi-web（安全启动器，本机调试用） |
| `nx-as nginx hosts / host apply / host remove` | **看板**（见上节）：清单 / 表单增改（`--spec` JSON 或拆开 flag，`--preview` 只渲染）/ 删除 |
| `nx-as nginx files / file get\|put\|delete\|toggle\|backups\|restore` | **配置文件管理器**（原始编辑兜底，见上节） |
| `nx-as nginx status` / `config [--preview]` / `apply` / `rollback` / `setup` / `rotate-secret` | 托管状态（版本/目录写权/漂移/sudoers）/引导配置/回滚/部署引导/轮换机机密码 |
| `nx-as login [--server <url>]` / `logout` | 浏览器 SSO 登录（会话 token 落 credentials.json）/ 清除本地凭据 |
| `nx-as auth status` / `auth me` | SSO 接入状态 / 当前登录身份 |
| `nx-as auth rotate` | 轮换会话签名密钥（= 全端下线） |
| `nx-as oidc config set / probe / register` | OIDC 配置 / 零凭据探测 / 注册 client |
| `nx-as health` / `bootstrap --json` / `routes` / `help [主题]` | 排查与自省 |
| `nx-as skill install` / `skill get` | 给 agent 装/导出使用文档 |

完整 agent 使用文档：`nx-as skill get nx-as`。

### 端口占用

`serve` 启动时端口已被占用，会先探一下占用者是谁：

- 占用者就是**本面板**（另一个 `nx-as serve`）→ 不重复启动，直接打开浏览器指向它；
- 占用者是别的服务 → 顺延到**下一个空闲端口**起自己的面板，并打开浏览器指向新面板。

两种情况都会自动开浏览器。用 `--no-open`（只影响这一次）或环境变量
`NX_SERVE_NO_OPEN=1`（所有 nx-xx 项目通用的同一个变量名）可以关掉自动开浏览器。

## 安全模型

**人的凭据唯一来源是 go-ah 认证中心的 OIDC 单点登录**（issuer 如 `http://47.110.80.47:8082`，
public client + PKCE，refresh_token 不落地）；旧「单用户静态密钥 + device token」方案已废除。

| 面 | 凭据 | 特性 |
|---|---|---|
| 人的访问（面板 / 网关 / 手机 / CLI） | go-ah SSO → nx-as 统一会话 | `nxas_s2` HMAC 会话 7 天；浏览器 cookie 与 CLI Bearer 同一凭据；`auth rotate` 全端下线 |
| 上游（pi-web 回环） | 机机 Basic | serve 启动随机生成，与 SSO 正交，不落公网 |

机制：state+PKCE（授权跳转防 CSRF/拦截，state 装签名短时 cookie）、认证失败指数退避
（1s→60s，5 分钟静默清零，**登录与网关共用同一节流桶**）、同源 Origin 校验
（`Sec-Fetch-Site` + Origin↔Host 同源判定）、HTTPS 反代下会话 cookie 自动加 `Secure`、
email 白名单（`store.oidc.allowedEmails`，空=放行全部 go-ah 用户）、全量审计落
`~/.nx-as/audit.jsonl`（oidc.login / gw.proxy / nginx 文件变更）。

**部署红线**：主进程（pi-web）只听 127.0.0.1，绝不暴露公网（其终端/bash 等于 RCE）；
nginx 模式下公网流量全部经 nginx 直代，nx-as 只接 loopback。

## Docker 镜像（三个 target）

CI 同时构建并推送到 GHCR 两个镜像，**同一个 Dockerfile 的多个 target**（层共享）：

| 镜像 | 内容 | 用途 |
|---|---|---|
| `ghcr.io/on-devplan/nx-as-base` | nginx + nx-as，**无主程序** | 权限中间件底座，`FROM` 它派生自己的应用 |
| `ghcr.io/on-devplan/nx-as` | base + pi-web | 直接运行（开箱即用的个人 agent server） |
| `gost-as`（target `gost`） | base + gost relay | **安全内网穿透基座**：本地一条 gost 命令 0 感知发布本地服务，公网访问必须过 nginx 鉴权（见 [docs/gost-as.md](docs/gost-as.md)） |

```bash
# 开箱即用（带 pi-web）
docker run -d -p 8080:8080 -v nxas-data:/data ghcr.io/on-devplan/nx-as:0.8.0

# 作为基础镜像：给自有应用套上鉴权网关
# FROM ghcr.io/on-devplan/nx-as-base:0.8.0
# COPY myapp /app/myapp
# ENV NXAS_TARGET_CMD="node /app/myapp/server.js" \
#     NXAS_TARGET_PORT=5000 \
#     NXAS_PROTECT="/api/* /admin/*" \
#     NXAS_TARGET_ENV_PIWEB=0
```

**登录后零感知**：nx-as 只占 `/_nxas/*` 一个命名空间；主程序的路径、头部、cookie 全部原样
（`NXAS_PROTECT` 外的路径公开直通，命中路径走 auth_request 鉴权后直代主进程）。
不设 `NXAS_TARGET_CMD` 时就是纯权限壳（只跑网关 + nginx）。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `NXAS_TARGET_CMD` | full 镜像=`nx-as web --port 30141 --no-open`；base 镜像=空 | 主进程命令；空=纯权限壳 |
| `NXAS_TARGET_PORT` | `30141` | 主进程监听端口 |
| `NXAS_PROTECT` | `/*` | 需鉴权的路径（空格分隔）；其余公开直通 |
| `NXAS_LISTEN_PORT` | `8080` | 对外端口（nginx） |
| `NXAS_TARGET_ENV_PIWEB` | `1` | 1=按 pi-web 注入机机密码；自有应用设 `0` |

## 部署（nginx 拓扑，Linux 服务器）

```bash
# 1. 基础（Node 22+）
cd nx-as && pnpm install && pnpm build && npm link

# 2. 一次性授权（root 执行）：sudoers 白名单（只有 nginx -t / -s reload）+ 托管文件初始化
#    需要多文件管理（新建/删除/停用）再照 stepsFullManage 授目录写权
nx-as nginx setup                # 打印精确命令，照抄执行

# 3. 填 domain 与证书路径 → Apply（渲染模板 → nginx -t → graceful reload）
nx-as nginx apply --domain agent.example.com \
  --cert-path /etc/letsencrypt/live/agent.example.com/fullchain.pem \
  --key-path  /etc/letsencrypt/live/agent.example.com/privkey.pem

# 4. 常驻（nginx 模式：数据路径归 nginx，nx-as 只做鉴权/签发/面板）
NXAS_GW_MODE=nginx NXAS_OIDC_ISSUER=http://47.110.80.47:8082 NXAS_OIDC_CLIENT_ID=nx-as nx-as serve --with-web --no-open
```

之后 nginx 配置变更全部在**面板「nginx」页**完成（站点/端口看板 + 网关入口表单 + 原始文件管理器 + 备份还原）。

**direct 模式**（默认；Windows/本机开发/无 nginx）：`nx-as serve --with-web` 即可，
进程内反代 `/m/v1/*`，鉴权行为与 nginx 模式完全一致（同一套决策逻辑 `gateway/check.js`）。

## pi 扩展与模型配置

- pi-web 会话读取 `~/.nx-as/pi-agent/`（`PI_CODING_AGENT_DIR` 隔离，与用户 `~/.pi` 互不干扰）：
  扩展、技能、`models.json`、会话 JSONL 都在这里
- **模型/插件/技能管理全在 pi-web 自带设置页**（浏览器打开 pi-web 或经网关 Web UI 入口），nx-as 不重复建设
- pi **没有 MCP 支持**；工具接入走 pi 扩展的 `registerTool()`（LLM 可直接调用，
  且自动被 `tool_call` 权限拦截覆盖）

## 存储布局

```
~/.nx-as/
  store.json          OIDC 接入配置/会话签名密钥/机机密码/nginx 托管配置（原子写）
  credentials.json    CLI 会话 token（nx-as login 落盘，0600；7 天）
  client.json         本地 client 连接配置（server/relay/隧道清单）
  audit.jsonl         审计（append-only：SSO 登录、网关、nginx 文件变更）
  nginx-backups/      配置文件管理器的滚动备份（<文件名>/<时间戳>.conf，每文件 10 份）
  pi-agent/           pi 的 agent dir（会话 JSONL/extensions/models.json，与 ~/.pi 隔离）
```

测试/多实例用 `NX_AS_STORE` 环境变量重定向；SSO 配置可用 env
`NXAS_OIDC_ISSUER/CLIENT_ID/REDIRECT_URI` 覆盖（容器部署用）。

## 开发

```bash
pnpm install
pnpm run dev        # vite(5180) + serve(7801) 双进程，热更新
pnpm test           # lint + build + smoke + unit（鉴权加固/文件管理器/网关/一致性对账）
pnpm start          # prod：build + serve
```

分层：`core ← modules ← runtime`；CLI 与 API 同源（action 表）；模块互依由 eslint 枚举禁列
强制（加模块必须补禁列与两处注册表，见 `assets/nx-as/references/00-design.md`）。
面板构建产物在仓库根 `public/`（git 不入库，`pnpm build` 重新生成；npm 包与镜像各自携带）。

## License

MIT
