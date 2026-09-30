---
name: nx-as
description: 当用户要"把 nx-as 作为鉴权网关跑 pi-web/管理设备 token/配置 Bearer 代理/给自有应用套鉴权容器"，或提到 nx-as、npx-ai-server、nx-apiserver、个人 agent 网关、pi-web 代理、device token、nx-as Docker 镜像、边车容器、FROM nx-as-base 时使用。nx-as 是 pi-web 云端个人 agent 的鉴权代理网关（nx-apiserver 语义）：CLI 与管理 API 同源。不适用于：与 nx-as 无关的通用编程问题、Claude Code 自身配置。
---

# nx-as — pi-web 鉴权代理网关（nx-apiserver）

pi-web（会话运行时核心，零改动）跑在 127.0.0.1:30141；nx-as 是它前面的**鉴权代理网关 + 安全启动器**：
手机/外部设备用**可吊销的 device token** 走 `/m/v1/*` 反代访问 pi-web；本机管理走 `/api/*` + Web 面板；
CLI 与管理 API 同源（一条 action 两端暴露）。

## 核心不变量

1. **一切通过 action 声明** — CLI 命令与 HTTP 路由来自同一张表。加功能 = 加一条 action
   （`modules/<域>/index.js`），不要在 api.js/cli.js 里散落写路由或命令。
2. **失败抛异常、业务结果返回 `{status}`** — 参数错抛 `INVALID_INPUT`；冲突抛 `CONFLICT`
   （HTTP 409，CLI 退出码 1）。
3. **两级凭据** — 管理面 `/api/*` 用单用户密钥（`Authorization: Bearer <token>`；token 来源：
   `--token` 参数 > `NX_AS_TOKEN` 环境变量 > serve 首次启动自动生成）；网关面 `/m/v1/*` 用
   **per-device token**（`nx-as device issue` 直接签发，可单独吊销）；pi-web 的 `PI_WEB_PASSWORD`
   由 serve 随机生成注入，永不出回环。

## 命令速查

| 命令 | 作用 |
|---|---|
| `nx-as serve [--port 7801] [--host 127.0.0.1] [--no-open] [--with-web]` | 起网关（`--with-web` 同时拉起 pi-web 并注入机机密码） |
| `nx-as web [--port 30141] [--no-open]` | 只拉起 pi-web（安全启动器：随机 PI_WEB_PASSWORD + PI_CODING_AGENT_DIR） |
| `nx-as device issue --name <设备名>` | 直接签发 device token（管理员线下交付） |
| `nx-as device list` / `device revoke <id>` | 设备清单 / 吊销（立即 401） |
| `nx-as auth status` / `auth rotate` | 管理密钥状态（掩码）/ 轮换 |
| `nx-as health` / `bootstrap --json` / `routes [--http "METHOD /path"]` | 排查 / 上下文 / 命令-路由对照 |
| `nx-as skill install [name] [--to DIR] [--force]` | 装 skill 到 ~/.claude/skills |
| `nx-as skill get [name] [ref] [--json]` | 导出 skill 上下文（外部 agent 自助获取） |

模型/插件/技能/prompt 的管理都在 **pi-web 自带设置页**（或直接编辑 `~/.nx-as/pi-agent/` 下文件）——nx-as 只管鉴权与转发。

## 场景路由

| 场景 | 读 |
|---|---|
| 手机/设备接入：token 签发、`/m/v1/*` API、SSE 短票 | [references/01-gateway.md](01-gateway.md) |
| Bearer 代理、装 pi 扩展/技能、权限扩展 | [references/03-extensions.md](03-extensions.md) |
| **Docker 边车容器：`FROM nx-as-base` 给自有应用套鉴权网关** | 独立 skill：`nx-as skill install nx-as-sidecar`（装后 agent 自动路由） |
| 改代码、加功能域、理解分层 | [references/00-design.md](00-design.md) |

## 什么时候不用

- 想跑**交互式结对编程** → 直接用 pi CLI 本体，不是 nx-as
- 多租户/公网多用户服务 → nx-as 是个人设计（少量自有设备），别硬改成多用户
