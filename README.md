# nx-as (nx-apiserver)

[pi-web](https://github.com/agegr/pi-web)（pi coding agent 的 Web UI）的**鉴权服务 + 安全启动器 + nginx 管理面板**：
pi-web 跑在云端作为你的个人 agent 会话运行时（零改动），公网入口由 **nginx** 直代（数据路径），
每个请求经 `auth_request` **委托 nx-as 做鉴权**——设备级 token、配对签发、限流、审计，全部独立在网关层。

```
公网 :443
   ▼
nginx ─── /m/v1/pair、/ticket ─────────► nx-as :7801（签发类端点）
   │
   ├──── /m/v1/* ── auth_request 子请求 ► nx-as /auth/check（只问"行不行"）
   │            └── proxy_pass ────────► pi-web :30141（SSE 直通，数据不过 nx-as）
   │
   └──── / ────────────────────────────► nx-as 管理面板（设备 + nginx 托管）
```

包名/bin 仍为 `nx-as`；`nx-apiserver` 是它的语义名。CLI、Web 面板、管理 API 同一张 action 表。
另有 **direct 模式**（默认，`NXAS_GW_MODE` 未设）：不经 nginx，nx-as 进程内反代，一条命令本机全通。

## 快速开始

```bash
# 本地（direct 模式，无需 nginx）
pnpm install && pnpm build
nx-as serve --with-web           # 网关 :7801 + pi-web :30141 一起拉起

# 云服务器（nginx 拓扑，见下节「部署」）
export NX_AS_TOKEN=管理密钥
```

手机端三个动作就够：

```bash
# 1. 服务器上生成配对码（5 分钟有效、单次）
nx-as device pair --name "我的手机"

# 2. 手机用配对码兑换长期 device token（唯一免鉴权的网关路由）
curl -X POST https://your-server/m/v1/pair -H "Content-Type: application/json" \
  -d '{"code":"12345678"}'
# → {"token":"nxas_d1.<id>.<secret>","device":{...}}   secret 只出现这一次

# 3. 之后所有请求带 Bearer token，透明反代 pi-web
curl -H "Authorization: Bearer nxas_d1..." https://your-server/m/v1/sessions
```

## /m/v1 网关 API

响应是 pi-web 原样 JSON（网关只做鉴权转发，不改包络）；pi-web 内部协议由网关隔离，
升级 pi-web 只需过网关冒烟。

| 网关路由 | 上游（pi-web） | 说明 |
|---|---|---|
| `POST /m/v1/pair` | —（网关本地） | 配对码兑 device token（免 Bearer，受限流保护） |
| `GET /m/v1/sessions` | `/api/sessions` | 会话列表 |
| `POST /m/v1/agent/new` | `/api/agent/new` | 建会话/发首条 prompt |
| `POST /m/v1/agent/:id` | `/api/agent/:id` | 会话命令（prompt/steer/follow_up…） |
| `GET /m/v1/agent/:id/events` | `/api/agent/:id/events` | SSE 事件流（支持短票，见下） |
| `POST /m/v1/sessions/:id/ticket` | —（网关本地） | Bearer 换 60 秒一次性 SSE 短票 |

SSE 用 EventSource 连接时不能带自定义 header：先 `POST /m/v1/sessions/:id/ticket`
（带 Bearer）换短票 URL，再 `new EventSource(url)`。

## 管理命令

| 命令 | 作用 |
|---|---|
| `nx-as serve [--port 7801] [--host] [--with-web] [--web-port]` | 起网关 + 面板；`--with-web` 同时拉起 pi-web 并注入随机 `PI_WEB_PASSWORD` |
| `nx-as web [--port 30141]` | 只拉起 pi-web（安全启动器，本机调试用） |
| `nx-as device pair --name <设备名>` | 生成配对码 |
| `nx-as device list` / `device revoke <id>` | 设备清单 / 吊销（下一次请求即 401） |
| `nx-as nginx status` / `config [--preview]` / `apply` / `rollback` / `setup` / `rotate-secret` | nginx 托管：状态/配置/应用（nginx -t+reload）/回滚/部署引导/轮换机机密码 |
| `nx-as settings get/set` | Bearer 代理配置（物化为 pi 扩展） |
| `nx-as auth status/rotate` | 管理密钥 |
| `nx-as health` / `bootstrap --json` / `routes` / `help [主题]` | 排查与自省 |
| `nx-as skill install` / `skill get` | 给 agent 装/导出使用文档 |

完整 agent 使用文档：`nx-as skill get nx-as`。

## 安全模型

两级凭据，互不相通：

| 面 | 凭据 | 特性 |
|---|---|---|
| 网关 `/m/v1/*`（手机/外部设备） | per-device token | 可单独吊销、last_used 可审计 |
| 管理面 `/api/*`（本机面板/CLI） | 单用户密钥 | `NX_AS_TOKEN` 或自动生成 |
| pi-web（回环） | 机机 Basic | serve 启动随机生成，不落盘不打印，人工密码消失 |

机制（对齐 pi-web 自身 proxy 的模式，参数同款）：timing-safe 比较、认证失败指数退避
（1s→60s，5 分钟静默清零，429 + Retry-After）、Host 白名单（`GW_ALLOWED_HOSTS`）+ Origin
跨站校验、全量审计落 `~/.nx-as/audit.jsonl`。

**部署红线**：pi-web 的 30141 只听 127.0.0.1，绝不暴露公网（其终端/bash 等于 RCE）；
nginx 模式下公网流量全部经 nginx 直代，nx-as 只接 loopback。

## 部署（nginx 拓扑，Linux 服务器）

```bash
# 1. 基础（Node 22+；pi-web 重依赖约 200MB）
npm install -g @agegr/pi-web
cd nx-as && pnpm install && pnpm build && npm link

# 2. 一次性授权（root 执行）：sudoers 白名单（只有 nginx -t / -s reload）+ 托管文件初始化
nx-as nginx setup                # 打印精确命令，照抄执行

# 3. 填 domain 与证书路径 → Apply（渲染模板 → nginx -t → graceful reload）
nx-as nginx apply --domain agent.example.com \
  --cert-path /etc/letsencrypt/live/agent.example.com/fullchain.pem \
  --key-path  /etc/letsencrypt/live/agent.example.com/privkey.pem

# 4. 常驻（nginx 模式：数据路径归 nginx，nx-as 只做鉴权/签发/面板）
NXAS_GW_MODE=nginx NX_AS_TOKEN=管理密钥 nx-as serve --with-web --no-open
# systemd unit 同前；TLS 证书由 certbot 管理
```

之后所有 nginx 配置变更在**面板「nginx」页**完成：表单或高级编辑（托管单文件 textarea），
Apply 自动 `nginx -t`、失败回滚、成功 graceful reload；「轮换机机密码」一键原子轮换（store → 模板 → reload）。

**direct 模式**（默认；Windows/本机开发/无 nginx）：`nx-as serve --with-web` 即可，
进程内反代 `/m/v1/*`，鉴权行为与 nginx 模式完全一致（同一套决策逻辑 `gateway/check.js`）。

## pi 扩展与模型配置

- pi-web 会话读取 `~/.nx-as/pi-agent/`（`PI_CODING_AGENT_DIR` 隔离，与用户 `~/.pi` 互不干扰）：
  扩展、技能、`models.json`、会话 JSONL 都在这里
- **模型/插件/技能管理全在 pi-web 自带设置页**（浏览器打开 pi-web 或经网关 Web UI 入口），nx-as 不重复建设
- Bearer 代理（MiniMax 等 Anthropic 兼容端点）是网关代管的唯一模型配置：面板「设置」或
  `nx-as settings set --bearer-base-url ... --bearer-token ... --bearer-models ...`
  —— 每次启动自动生成 `nx-as-bearer-anthropic` 扩展注入 pi
- pi **没有 MCP 支持**；工具接入走 pi 扩展的 `registerTool()`（LLM 可直接调用，
  且自动被 `tool_call` 权限拦截覆盖）

## 存储布局

```
~/.nx-as/
  store.json        设置/管理密钥/设备 token hash（原子写）
  audit.jsonl       网关审计（append-only）
  pi-agent/         pi 的 agent dir（会话 JSONL/extensions/models.json，与 ~/.pi 隔离）
```

测试/多实例用 `NX_AS_STORE` 环境变量重定向；管理密钥可用 `NX_AS_TOKEN` 注入。

## 开发

```bash
pnpm install
pnpm run dev        # vite(5180) + serve(7801) 双进程，热更新
pnpm test           # lint + build + smoke + unit（含 gateway 鉴权单测）
pnpm start          # prod：build + serve
```

分层：`core ← modules ← runtime`；CLI 与 API 同源（action 表）；模块互依由 eslint 枚举禁列
强制（加模块必须补禁列与两处注册表，见 `assets/nx-as/references/00-design.md`）。

## License

MIT
