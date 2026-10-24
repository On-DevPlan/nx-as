# 01 · 网关：SSO 登录、/m/v1 API、SSE 短票

## 架构位置

```
手机 / PWA / curl
    │  SSO 会话（cookie 或 Bearer nxas_s2...）   ← go-ah 单点登录签发，7 天
    ▼
nx-as serve :7801（网关）
    │  /m/v1/*  鉴权（source-check → 节流 → 会话校验 → 审计）
    │  反代 127.0.0.1:30141，注入 Basic pi:<机机密码>（serve 启动时随机生成，仅内存）
    ▼
pi-web（零改动，锁版本）──▶ pi SDK + ~/.nx-as/pi-agent/extensions/ 注入的扩展
```

- 人的凭据唯一来源是 **go-ah OIDC 单点登录**：`/m/v1/*` 与管理面 `/api/*` 用**同一个**
  SSO 会话（`nxas_s2.<payload>.<HMAC>`，7 天；浏览器 cookie 与 CLI/脚本 Bearer 同一凭据）。
- 旧「管理面静态密钥 + per-device token」方案已废除；`auth rotate` 轮换签名密钥 = 全端下线。
- pi-web 的 `PI_WEB_PASSWORD`（machineSecret）由 serve 自动生成注入，只进上游请求头；
  公网流量物理上只能过网关。

## 登录链路（浏览器）

```
GET /login（旧路径，nginx error_page 兼容）
  → 302 /oidc/login → 302 go-ah /oauth2/auth（state + PKCE S256）
  → go-ah 登录/同意 → 302 /oidc/callback?code&state
  → code 换 token（back-channel）→ /oauth2/userinfo 取身份
  → 签 nx-as 会话 cookie（+ pi-web 会话 bootstrap 代签）→ 302 回 next
```

- redirect_uri：env `NXAS_OIDC_REDIRECT_URI`（公网部署精确匹配）优先；否则按请求动态构造
  （X-Forwarded-Proto + Host，nginx 模式补 `/_nxas` 前缀）。回环部署落在
  `http://127.0.0.1:<port>/oidc/callback`——go-ah 对回环注册项支持端口通配。
- refresh_token 一律不落地（go-ah 平台硬约束）：会话过期就重新走一遍 302 授权，
  go-ah 全局会话 30 天内是无感跳转（不输密码，点一次同意）。

## CLI / 脚本接入

```bash
nx-as login                    # 浏览器 SSO → 会话 token 落 ~/.nx-as/credentials.json（0600）
nx-as login --server http://47.110.80.47:8090/_nxas   # 远程 server 同理（回环 handoff）
# 之后所有 CLI（client 域）与 scripts/nxas-tunnel.mjs 自动使用；也可显式：
#   Authorization: Bearer <nxas_s2...>   或环境变量 NXAS_SESSION=<token>
```

## /m/v1 API 约定

所有请求带 SSO 会话（浏览器 cookie 自动携带；非浏览器 `Authorization: Bearer nxas_s2...`）；
响应为上游 pi-web 原样 JSON（网关只做鉴权与转发，不改包络）。

| 端点 | 上游（pi-web） | 说明 |
|---|---|---|
| `GET /m/v1/sessions` | `/api/sessions?summary=1` | 会话列表（侧栏元数据） |
| `POST /m/v1/agent/new` | `/api/agent/new` | 建会话/发首条 prompt |
| `POST /m/v1/agent/:id` | `/api/agent/:id` | 会话命令（prompt/steer/follow_up…） |
| `GET /m/v1/agent/:id/events` | `/api/agent/:id/events` | SSE 事件流；**见短票** |
| `GET /m/v1/sessions/:id` | `/api/sessions/:id` | 会话上下文/分页 |

## SSE 短票（EventSource 不能带自定义 header）

```bash
# 1. 用会话换一次性短票（60 秒有效）
curl -X POST https://your-server/_nxas/m/v1/sessions/<id>/ticket \
  -H "Authorization: Bearer $NXAS_SESSION"
# → {"url":"/_nxas/m/v1/agent/<id>/events?ticket=t1.<exp>.<nonce>.<sig>"}

# 2. EventSource 直连短票 URL（网关验签 + 一次性校验后透传流）
```

短票 HMAC 密钥为 serve 进程启动时随机生成的 serverSecret——重启后旧短票全部失效。

## 安全机制（对齐 pi-web proxy.ts 的模式）

| 机制 | 行为 |
|---|---|
| Host 白名单 | `GW_ALLOWED_HOSTS` 环境变量（逗号分隔域名）；默认仅 localhost/loopback/IP 直连 |
| Origin 校验 | 浏览器跨站写请求 403（非浏览器客户端无 Origin 放行） |
| 节流 | 认证失败按 sub∥IP 指数退避 1s→60s；429 带 Retry-After；封锁期正确会话同样 429 |
| 审计 | oidc.login/login_fail、gw.proxy、nginx 变更全落 `<store同级>/audit.jsonl` |
| state cookie | 授权跳转的 state+PKCE verifier 装签名短时 cookie（10 分钟），回调校验防 CSRF/重放 |
| email 白名单 | store.oidc.allowedEmails（空=放行全部 go-ah 用户） |

## 部署注意

- 公网部署：Caddy/Nginx 终结 TLS 后反代到网关 7801；`GW_ALLOWED_HOSTS` 设为你的域名；
  go-ah 侧 client 的 redirect_uris 要包含公网回调地址（`nx-as oidc register --redirect-uri` 补）
- **不要**把 pi-web 的 30141 端口暴露公网（终端/bash 等于 RCE）；它只听 127.0.0.1
- go-ah 不可达时无法新登录（已发会话不受影响）——这是「强依赖单点登录」的既定取舍
- pi-web 版本锁定：升级是显式动作（网关契约对 pi-web 内部协议做了收敛，升级前跑 smoke）
