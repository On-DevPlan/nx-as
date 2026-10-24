---
name: dev-as
description: nx-as 的开发者 skill（项目级，.claude/skills/dev-as）——改 nx-as/gost-as 代码、加功能、加隧道、调鉴权、改网络模型、构建镜像、发布部署时使用。触发词：开发 nx-as、改 gost-as、加 action、加模块、加隧道端口、OIDC 鉴权扩展、网络模型、bind-audit、构建镜像、发布 gost-as、nx-as 二次开发。A 序列=关键操作流程（怎么干），B 序列=关键设计与代码（为什么这样/在哪改）。运行面使用（登录/注册隧道/面板操作）请用主 skill `nx-as`；本 skill 只管"改它本身"。
---

# dev-as — nx-as 开发者指南（改这个项目本身）

**代码是唯一真相**：每条路径/函数在 0.10.2 代码验证过；改代码后按各 ref 尾部检查清单同步本文档（X03 内容同步）。

## A 序列 · 关键操作流程（怎么干——拿命令照抄）

| 代号 | 干什么时读 | 一句话 |
|---|---|---|
| [A01-镜像构建](references/A01-镜像构建.md) | 打镜像（gost / base 边车 / full 三 target） | 前端在构建内完成；发版前本地容器冒烟 |
| [A02-gost使用](references/A02-gost使用.md) | 注册隧道 / 本地 gost 常驻 / bind 守卫观察 | bind 地址永远带 127.0.0.1 前缀；常驻须独立进程 |
| [A03-发布上线](references/A03-发布上线.md) | 版本迭代上服务器 | 传输→compose→重建→五项验证，缺一不算发布完成 |
| [A04-测试与E2E](references/A04-测试与E2E.md) | 改完代码怎么验 | 三层：pnpm test（假 IdP）→ nginx 回归 → e2e-live 手动 |

## B 序列 · 关键设计与代码（为什么这样 / 在哪改）

| 代号 | 看什么时读 | 一句话 |
|---|---|---|
| [B01-网络模型](references/B01-网络模型.md) | 端口拓扑 / 三进程编排 / 持久化 / bind 滥用防线 | 公网唯一暴露面 = nginx，gost 零公网 socket |
| [B02-配置体系](references/B02-配置体系.md) | store.oidc / env 优先级 / compose 清单 / 凭据文件 | env > store > 动态构造；公网部署白名单必填 |
| [B03-交互模型与会话](references/B03-交互模型与会话.md) | action 双端 / SSO 会话流 / client 配对 / auth_request 契约 | 一切功能 = 一条 action；会话是唯一人的凭据 |
| [B04-扩展点](references/B04-扩展点.md) | 加 action / 加模块 / 加隧道 / 改鉴权 | 隧道 conf 单一模板源；鉴权收敛在三个函数 |

## 五条红线不变量（违反 = 线上事故，动手前默诵）

1. **公网唯一暴露面 = nginx**：新端口公网可达必须以 nginx conf（HTTP/stream）落地；进程绝不直接绑 0.0.0.0。
2. **gost 零公网 socket**：relay 只绑回环 `18442`，公网 `8442` 是 nginx stream 反代；rtcp bind 一律 `127.0.0.1:1L`。relay `bind=true` 可被凭据持有者滥用（gost 无白名单）——bind-audit 守卫 + 安全组兜底。
3. **隧道 conf 单一模板源**：`src/modules/nginx/tunnel.js` 唯一渲染处；客户端/脚本只调 `nginx.tunnelApply/Remove`（历史事故：模板散落 → 登录链路分叉死循环）。
4. **公开路径只进 `PUBLIC_PATHS`**（`src/runtime/api.js`）：当前仅 verify 探活与 bootstrap 端口协商签名。加公开面 = 扩攻击面，需显式声明。
5. **配置优先级 env > store > 动态构造**（`oidcConfig()`）：容器部署 env 注入；面板改 store 只影响无 env 的本机形态。

## 快速定位（代码地图）

```
src/runtime/oidc.js           OIDC 协议（discovery/PKCE/state cookie/redirect 构造）
src/runtime/session.js        统一会话（requireSession 唯一校验入口 + 登录链路端点）
src/runtime/api.js            管理面路由编译 + 鉴权 + PUBLIC_PATHS
src/runtime/gateway/check.js  网关决策（会话/短票/节流；nginx auth_request 同源）
src/runtime/gateway/proxy.js  /m/v1 反代（注入机机 Basic）
src/modules/nginx/tunnel.js   隧道 conf 唯一模板（nginx 页「穿透隧道」卡消费 files API 过滤展示）
src/modules/nginx/cert.js     证书（已并入 nginx；导入自动回填 store.nginx 路径）
src/core/gost-daemon.js       gost 常驻守护（tunnel add 自动拉起，脱离 CLI 进程）
src/modules/auth/             SSO 域（status/me/rotate + oidc config·probe·register）
src/core/sso-handoff.js       浏览器配对 handoff（CLI login 与 client 域共用）
src/core/credentials.js       ~/.nx-as/credentials.json（0600）
docker/entrypoint-gost.sh     gost-as 三进程编排 + stream + 守卫循环
docker/bind-audit.mjs         未授权公网监听审计（60s /proc 扫描）
tests/helpers/fake-idp.mjs    测试假 IdP；tests/e2e-live.mjs 真实线上 E2E（手动）
```
