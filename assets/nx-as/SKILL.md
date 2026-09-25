---
name: nx-as
description: 当用户要"提交 AI 任务/跑一个提示词/用手机调 agent/查任务结果/管理提示词模板/配置模型端点"，或提到 nx-as、npx-ai-server、个人 agent 服务、task、prompt 模板、SSE 事件流时使用。通过 nx-as CLI 或 token 鉴权的 HTTP API 操作 pi 内核的 agent 任务。不适用于：与 nx-as 无关的通用编程问题、Claude Code 自身配置。
---

# nx-as — 个人 AI Agent Server

pi 内核的 agent 服务：`serve` 驱动 Web 面板 + HTTP API；CLI 与 API 同源（一条 action 两端暴露）；
单用户 Bearer 密钥鉴权；任务事件实时可见（SSE）；pi 会话 JSONL 自动持久化。

## 核心不变量

1. **一切通过 action 声明** — CLI 命令与 HTTP 路由来自同一张表。加功能 = 加一条 action
   （`modules/<域>/index.js`），不要在 api.js/cli.js 里散落写路由或命令。
2. **失败抛异常、业务结果返回 `{status}`** — 参数错抛 `INVALID_INPUT`；「任务已在跑」返回
   `{status:'skipped'}`；冲突（重复 prompt 名）抛 `CONFLICT`（HTTP 409，CLI 退出码 1）。
3. **API 必须带密钥** — 除 `GET /api/auth/verify` 外全部要求 `Authorization: Bearer <token>`；
   token 来源：`--token` 参数 > `NX_AS_TOKEN` 环境变量 > serve 首次启动自动生成（终端打印）。

## 命令速查

| 命令 | 作用 |
|---|---|
| `nx-as serve [--port 7801] [--host 127.0.0.1] [--no-open]` | 起服务（云服务器加 `--host 0.0.0.0`） |
| `nx-as prompt add <name> --file <f.md> [--description]` / `prompt list` / `get` / `update` / `remove` | 提示词 CRUD（正文用 `$input` 接收任务输入） |
| `nx-as task add <promptId> --input "..." [--no-run]` | 提交任务（默认创建即执行） |
| `nx-as task list` / `task get <id>` / `task remove <id>` / `task run <id>` | 任务管理 |
| `nx-as task events <id>` | 跟踪任务到终态（CLI 轮询 / HTTP 是 SSE） |
| `nx-as models list` / `models current` / `models set --model <id>` | 模型目录与默认模型 |
| `nx-as models set-endpoint <provider> --base-url <url> [--api-key-env VAR] [--models a,b]` | 自定义端点（OpenAI 兼容/Ollama/vLLM） |
| `nx-as settings get` / `settings set [--max-concurrent N] [--auto-run]` | 并发数 / 创建即执行 |
| `nx-as auth status` / `auth rotate` | 密钥状态（掩码）/ 轮换（旧密钥立即失效） |
| `nx-as health` / `bootstrap --json` / `routes [--http "METHOD /path"]` | 排查 / 上下文 / 命令-路由对照 |
| `nx-as skill install [name] [--to DIR] [--force]` | 装 skill 到 ~/.claude/skills |
| `nx-as skill get [name] [ref] [--json]` | 导出 skill 上下文（外部 agent 自助获取） |

## 场景路由

| 场景 | 读 |
|---|---|
| 提交任务、消费事件流/结果、App 对接 API | [references/01-tasks.md](01-tasks.md) |
| 写提示词模板（变量、frontmatter、多步任务） | [references/02-prompts.md](02-prompts.md) |
| 装 pi 扩展/技能、补记忆/权限/通知 | [references/03-extensions.md](03-extensions.md) |
| 改代码、加功能域、理解分层 | [references/00-design.md](00-design.md) |

## 什么时候不用

- 想跑**交互式结对编程** → 直接用 pi CLI 本体，不是 nx-as
- 多租户/公网多用户服务 → nx-as 是单用户设计（一把密钥），别硬改成多用户
