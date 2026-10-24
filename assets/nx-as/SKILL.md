---
name: nx-as
description: 当用户要"管理 nginx 配置文件（多文件编辑/停用/备份还原）、把 nx-as 作为鉴权网关跑 pi-web/接入 go-ah 单点登录/给自有应用套鉴权容器"，或提到 nx-as、npx-ai-server、nx-apiserver、nginx 配置管理、个人 agent 网关、pi-web 代理、OIDC SSO、device token（已废除）、nx-as Docker 镜像、边车容器、FROM nx-as-base 时使用。nx-as 是 nginx 配置文件管理器 + 鉴权代理网关（nx-apiserver 语义）：CLI 与管理 API 同源。不适用于：与 nx-as 无关的通用编程问题、Claude Code 自身配置。
---

# nx-as — nginx 配置文件管理器 + pi-web 鉴权代理网关（nx-apiserver）

nx-as 的本职是 **nginx 配置文件管理器**：托管目录（默认 `/etc/nginx/conf.d`）内 `*.conf`
的浏览/编辑/新建/停用/删除/备份还原，每次变更自动 `nginx -t`（失败还原）+ graceful reload。
在此之上是 pi-web（会话运行时核心，零改动）的**鉴权代理网关 + 安全启动器**：
人的访问一律走 **go-ah 认证中心的 OIDC 单点登录**（issuer 如 `http://47.110.80.47:8082`，
public client + PKCE；gost-as 部署必须设 `NXAS_OIDC_ALLOWED_EMAILS` 登录白名单，未设拒绝启动）：浏览器打开面板即 302 去登录，回来拿到 7 天会话（cookie / Bearer 双载体）；
本机管理走 `/api/*` + Web 面板；CLI 与管理 API 同源（一条 action 两端暴露）。

## 核心不变量

1. **一切通过 action 声明** — CLI 命令与 HTTP 路由来自同一张表。加功能 = 加一条 action
   （`modules/<域>/index.js`），不要在 api.js/cli.js 里散落写路由或命令。
2. **失败抛异常、业务结果返回 `{status}`** — 参数错抛 `INVALID_INPUT`；冲突抛 `CONFLICT`
   （HTTP 409，CLI 退出码 1）。
3. **SSO 会话唯一、机机信任正交** — 人的凭据只有 go-ah SSO 签发的统一会话
   （`nxas_s2.<payload>.<HMAC>`，7 天；浏览器 cookie 与 CLI/脚本 `Bearer` 同一凭据；
   `auth rotate` 轮换签名密钥 = 全端下线）。旧「单用户静态密钥 + device token」方案已废除。
   pi-web 的 `PI_WEB_PASSWORD`（machineSecret）是 nx-as↔pi-web 的内部机机信任，与 SSO 正交，保留。

## 命令速查

| 命令 | 作用 |
|---|---|
| `nx-as tunnel add <名> <本地端口> [--public-port P] [--server <url>]` | **穿透一条龙**：首次自动浏览器 SSO 登录 → 注册隧道（server conf + 本地清单）→ 自动拉起常驻 gost |
| `nx-as tunnel list` / `tunnel remove <名>` | 穿透总览（对账 + gost 状态）/ 删除穿透 |
| `nx-as serve [--port 7801] [--host 127.0.0.1] [--no-open] [--with-web]` | 起网关（`--with-web` 同时拉起 pi-web 并注入机机密码）；端口被占时见下方「端口占用」 |
| `nx-as login [--server <url>] [--no-open]` | 浏览器 SSO 登录（go-ah 单点登录；会话 token 落 `~/.nx-as/credentials.json` 供 CLI/脚本/远程 client 用） |
| `nx-as logout` | 清除本地会话凭据（全端下线用 `auth rotate`） |
| `nx-as oidc config set --issuer <url> --client-id <id> [--redirect-uri u] [--allowed-emails a,b]` | 写入 OIDC 接入配置（env `NXAS_OIDC_ISSUER/CLIENT_ID/REDIRECT_URI` 可覆盖，容器部署用） |
| `nx-as oidc probe` | 零凭据探测：发现文档可达 + client 是否已注册 + 白名单生效 |
| `nx-as oidc register --username <u> --password <p> --issuer <url> [--redirect-uri 逗号分隔]` | 一次性：登录 go-ah 管理员并注册 client_id=nx-as（public+PKCE；缺省回环端口通配 + 指定公网地址） |
| `nx-as nginx hosts` | **看板清单**：托管目录内条目（kind=site/port/gateway/custom + 域名/端口/上游/TLS/WS，带 spec 的面板可表单编辑） |
| `nx-as nginx host apply [--spec '<json>']` | **看板保存**：站点反代/端口转发表单 → 渲染成 conf 落盘（备份→-t 失败还原→reload）；CLI 也可用 `--kind site --domains a.com,b.com --upstream 127.0.0.1:3000 [--ws] [--tls --cert-path … --key-path …] [--listen-port N] [--name 旧文件名]` 拼装，`--preview` 只渲染不落盘 |
| `nx-as nginx host remove <名>` | 看板移除条目（= 删除对应 conf，先备份） |
| `nx-as nginx files` | 托管目录内配置文件清单（启用态/大小/备份/目录写权） |
| `nx-as nginx file get <名>` / `file put <名> --from <文件>` | 读 / 写（新建或更新；备份→-t 失败还原→reload） |
| `nx-as nginx file delete <名>` / `file toggle <名>` | 删除（先备份）/ 停用启用（.conf ↔ .conf.disabled） |
| `nx-as nginx file backups <名>` / `file restore <名> --ts <时间戳>` | 备份清单 / 还原（当前内容先再备份） |
| `nx-as nginx status` / `config [--preview]` / `apply` / `rollback` / `setup` / `rotate-secret` | 托管状态/引导配置（domain+证书）/回滚/部署引导（两档授权）/轮换机机密码 |
| `nx-as web [--port 30141] [--no-open]` | 只拉起 pi-web（安全启动器：随机 PI_WEB_PASSWORD + PI_CODING_AGENT_DIR） |
| `nx-as auth status` / `auth me` | SSO 接入状态 / 当前登录身份 |
| `nx-as auth rotate` | 轮换会话签名密钥（= 全端下线；重新 SSO 登录即恢复） |
| `nx-as health` / `bootstrap --json` / `routes [--http "METHOD /path"]` | 排查 / 上下文 / 命令-路由对照 |
| `nx-as audit [--limit 200]` | 审计日志（只读，新→旧；登录/网关/nginx 变更全落审计） |
| `nx-as client serve [--port 7890]` | **本地 client 管理面**（127.0.0.1，连接 server / 注册穿透 / 对账清单；仅协调 gost，不代劳 server 面板） |
| `nx-as client config set --server <api> --relay <url>` | client 连接配置（凭据不在这里——login 配对） |
| `nx-as client login [--server <url>]` | **OIDC 配对**：浏览器跳 go-ah 登录远程 nx-as，会话自动落 credentials.json（无独立 token） |
| `nx-as nginx tunnel apply <名> --public-port P` / `tunnel remove <名>` | 隧道 conf 由**服务端单一模板**生成/删除（公网口经 SSO 鉴权 → gost 回环） |
| `nx-as client register <名> <本地端口> [--public-port P]` / `unregister <名>` | 一键注册/注销穿透（server conf + 本地 gost -L 同时生效） |
| `nx-as client doctor` / `client reconcile` | 自检 / 本地∪server 对账（gost 由 tunnel add 自动拉起常驻） |
| `nx-as skill install [name] [--to DIR] [--force]` | 装 skill 到 ~/.claude/skills（无参=默认 nx-as） |
| `nx-as skill install --group <g>` | 一键装一组（sidecar=边车容器指南；清单 assets/groups.json） |
| `nx-as skill list` | 可装 skill/group 清单（标默认；source=manifest\|assets-dirs） |
| `nx-as skill get [name] [ref] [--json]` | 导出 skill 上下文（外部 agent 自助获取） |

模型/插件/技能/prompt 的管理都在 **pi-web 自带设置页**（或直接编辑 `~/.nx-as/pi-agent/` 下文件）——nx-as 只管鉴权与转发。

## nginx 看板（UI 表单 ↔ 配置文件）

面板 nginx 页的主体是**看板**：托管目录里每个 `*.conf` 一行卡片（类型/入口/上游/TLS/WS/状态）。
「添加反代站点 / 添加端口转发」表单保存即把 spec 渲染成配置文件落进托管目录（同一条
备份→`nginx -t`→reload 管线），实现「UI ↔ 配置文件」双向映射：

- 表单生成的文件带 `# nxas-spec <json>` 头，文件名约定 `nxas-site.<域名slug>.conf` /
  `nxas-port.<端口>.conf`——面板「编辑」从 spec 回填表单、保存整体重渲染该文件
- 没有 spec 头的文件（手写/历史配置）也进看板：解析 server 块推断字段，只读展示 +
  「配置」按钮进原始编辑器；停用/删除/备份还原与文件管理器共用同一套能力
- agent 等价链路：`nginx hosts` 看清单 → `nginx host apply --spec '<json>'` 增改 →
  `nginx file toggle` 停启用 → `nginx host remove` 删除

**端口占用**：`serve` 的端口已被占用时，占用者就是本面板就直接打开它（不重复启动），
占用者是别的服务就顺延到下一个空闲端口再起；两种情况都会自动开浏览器。
`--no-open`（只影响这一次）或环境变量 `NX_SERVE_NO_OPEN=1`（所有 nx-xx 项目通用的同一个变量名）可关掉。

## 场景路由

| 场景 | 读 |
|---|---|
| SSO 登录链路、`/m/v1/*` API、SSE 短票 | [references/01-gateway.md](01-gateway.md) |
| Bearer 代理、装 pi 扩展/技能、权限扩展 | [references/03-extensions.md](03-extensions.md) |
| **Docker 边车容器：`FROM nx-as-base` 给自有应用套鉴权网关** | 独立 skill：`nx-as skill install nx-as-sidecar`（装后 agent 自动路由） |
| 改代码、加功能域、理解分层 | [references/00-design.md](00-design.md) |

## 什么时候不用

- 想跑**交互式结对编程** → 直接用 pi CLI 本体，不是 nx-as
- 多租户/公网多用户服务 → nx-as 是个人设计（少量自有设备），别硬改成多用户
