# 01 · 网关：设备接入、/m/v1 API、SSE 短票

## 架构位置

```
手机 / PWA / curl
    │  Bearer <device token>        ← nx-as device issue 签发，可吊销
    ▼
nx-as serve :7801（网关）
    │  /m/v1/*  鉴权（source-check → 节流 → device-auth → 审计）
    │  反代 127.0.0.1:30141，注入 Basic pi:<机机密码>（serve 启动时随机生成，仅内存）
    ▼
pi-web（零改动，锁版本）──▶ pi SDK + ~/.nx-as/pi-agent/extensions/ 注入的扩展
```

- 管理面 `/api/*`（Web 面板 + CLI）走单用户密钥，与网关面 `/m/v1/*`（device token）互不相通。
- pi-web 的 `PI_WEB_PASSWORD` 由 serve 自动生成注入；公网流量物理上只能过网关。

## 设备接入（token 直接签发）

```bash
# 管理员：直接签发 token（SSH 到服务器执行）
nx-as device issue --name "我的手机"
# → token: nxas_d1.<id>.<secret 64hex>
#   secret 只出现这一次，经安全渠道交付给设备（加密消息/密码管理器）
#   泄露即吊销：nx-as device revoke dev_xxx，重签一个即可
```

```bash
nx-as device list            # 设备清单（last_used 掩码显示）
nx-as device revoke dev_xxx  # 吊销，下一次请求即 401
```

## /m/v1 API 约定

所有请求带 `Authorization: Bearer nxas_d1...`；响应为上游 pi-web 原样 JSON（网关只做鉴权与转发，不改包络）。

| 端点 | 上游（pi-web） | 说明 |
|---|---|---|
| `GET /m/v1/sessions` | `/api/sessions?summary=1` | 会话列表（侧栏元数据） |
| `POST /m/v1/agent/new` | `/api/agent/new` | 建会话/发首条 prompt |
| `POST /m/v1/agent/:id` | `/api/agent/:id` | 会话命令（prompt/steer/follow_up…） |
| `GET /m/v1/agent/:id/events` | `/api/agent/:id/events` | SSE 事件流；**见短票** |
| `GET /m/v1/sessions/:id` | `/api/sessions/:id` | 会话上下文/分页 |

## SSE 短票（EventSource 不能带自定义 header）

```bash
# 1. 用 Bearer 换一次性短票（60 秒有效）
curl -X POST https://your-server:7801/m/v1/sessions/<id>/ticket \
  -H "Authorization: Bearer $DEVICE_TOKEN"
# → {"url":"/m/v1/agent/<id>/events?ticket=t1.<exp>.<nonce>.<sig>"}

# 2. EventSource 直连短票 URL（网关验签 + 一次性校验后透传流）
```

短票 HMAC 密钥为 serve 进程启动时随机生成的 serverSecret——重启后旧短票全部失效。

## 安全机制（对齐 pi-web proxy.ts 的模式）

| 机制 | 行为 |
|---|---|
| Host 白名单 | `GW_ALLOWED_HOSTS` 环境变量（逗号分隔域名）；默认仅 localhost/loopback/IP 直连 |
| Origin 校验 | 浏览器跨站写请求 403（非浏览器客户端无 Origin 放行） |
| 节流 | 认证失败按 tokenId∥IP 指数退避 1s→60s；429 带 Retry-After；封锁期正确 token 同样 429 |
| 审计 | 全部 /m/v1 请求落 `<store同级>/audit.jsonl`（deviceId/method/path/ts） |
| cwd 白名单 | （规划中）agent/new 的 cwd 先过白名单再转发 |

## 部署注意

- 公网部署：Caddy/Nginx 终结 TLS 后反代到网关 7801；`GW_ALLOWED_HOSTS` 设为你的域名
- **不要**把 pi-web 的 30141 端口暴露公网（终端/bash 等于 RCE）；它只听 127.0.0.1
- pi-web 版本锁定：升级是显式动作（网关契约对 pi-web 内部协议做了收敛，升级前跑 smoke）
