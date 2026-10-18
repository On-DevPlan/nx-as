---
name: nx-as
description: 当用户要"管理 nginx 配置文件（多文件编辑/停用/备份还原）、把 nx-as 作为鉴权网关跑 pi-web/管理设备 token/给自有应用套鉴权容器"，或提到 nx-as、npx-ai-server、nx-apiserver、nginx 配置管理、个人 agent 网关、pi-web 代理、device token、nx-as Docker 镜像、边车容器、FROM nx-as-base 时使用。nx-as 是 nginx 配置文件管理器 + 鉴权代理网关（nx-apiserver 语义）：CLI 与管理 API 同源。不适用于：与 nx-as 无关的通用编程问题、Claude Code 自身配置。
---

# nx-as — nginx 配置文件管理器 + pi-web 鉴权代理网关（nx-apiserver）

nx-as 的本职是 **nginx 配置文件管理器**：托管目录（默认 `/etc/nginx/conf.d`）内 `*.conf`
的浏览/编辑/新建/停用/删除/备份还原，每次变更自动 `nginx -t`（失败还原）+ graceful reload。
在此之上是 pi-web（会话运行时核心，零改动）的**鉴权代理网关 + 安全启动器**：
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
| `nx-as nginx files` | 托管目录内配置文件清单（启用态/大小/备份/目录写权） |
| `nx-as nginx file get <名>` / `file put <名> --from <文件>` | 读 / 写（新建或更新；备份→-t 失败还原→reload） |
| `nx-as nginx file delete <名>` / `file toggle <名>` | 删除（先备份）/ 停用启用（.conf ↔ .conf.disabled） |
| `nx-as nginx file backups <名>` / `file restore <名> --ts <时间戳>` | 备份清单 / 还原（当前内容先再备份） |
| `nx-as nginx status` / `config [--preview]` / `apply` / `rollback` / `setup` / `rotate-secret` | 托管状态/引导配置（domain+证书）/回滚/部署引导（两档授权）/轮换机机密码 |
| `nx-as web [--port 30141] [--no-open]` | 只拉起 pi-web（安全启动器：随机 PI_WEB_PASSWORD + PI_CODING_AGENT_DIR） |
| `nx-as device issue --name <设备名> [--scope admin\|client]` | 直接签发 device token（管理员线下交付；面板可查看与吊销） |
| `nx-as device list` / `device revoke <id>` / `device revoke-all` | 设备清单 / 吊销（已发会话立即失效）/ 全部吊销（应急） |
| `nx-as auth status` / `auth rotate` | 管理密钥状态（掩码）/ 轮换 |
| `nx-as health` / `bootstrap --json` / `routes [--http "METHOD /path"]` | 排查 / 上下文 / 命令-路由对照 |
| `nx-as audit [--limit 200]` | 审计日志（只读，新→旧；登录/网关/nginx 变更全落审计） |
| `nx-as client serve [--port 7890]` | **本地 client 管理面**（127.0.0.1，连接 server / 注册穿透 / 对账清单；仅协调 gost，不代劳 server 面板） |
| `nx-as client config set --server <api> --token <tok> --relay <url>` | client 连接配置（`~/.nx-as/client.json`） |
| `nx-as client register <名> <本地端口> [--public-port P]` / `unregister <名>` | 一键注册/注销穿透（server conf + 本地 gost -L 同时生效） |
| `nx-as client list` / `remote-list` / `start` / `stop` / `doctor` | 本地清单（gost 进程）/ server 侧对账 / gost 启停 / 自检 |
| `nx-as skill install [name] [--to DIR] [--force]` | 装 skill 到 ~/.claude/skills（无参=默认 nx-as） |
| `nx-as skill install --group <g>` | 一键装一组（sidecar=边车容器指南；清单 assets/groups.json） |
| `nx-as skill list` | 可装 skill/group 清单（标默认；source=manifest\|assets-dirs） |
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
