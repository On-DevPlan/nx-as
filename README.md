# nx-as (npx-ai-server)

个人专用 AI Agent Server：云服务器上跑一个服务，手机/App 通过 **HTTPS + 密钥** 提交任务，
内核用 [pi](https://github.com/earendil-works/pi) 执行**你定义的提示词**，事件实时可见、结果与会话持久化。

一套命令三端可用：`nx-as` CLI、Web 面板、HTTP API —— 同一张 action 表。

## 快速开始

```bash
# 本地
pnpm install && pnpm build
nx-as serve                      # 面板 http://127.0.0.1:7801，密钥打印在终端

# 云服务器（给 App 用）
export NX_AS_TOKEN=你的密钥
export DEEPSEEK_API_KEY=sk-xxx   # 或 ANTHROPIC_API_KEY / OPENROUTER_API_KEY 等
nx-as serve --host 0.0.0.0 --port 7801 --no-open
```

App 三个接口就够：

```
POST /api/tasks                     {"promptId":"hello","input":"..."}   → {id, status}
GET  /api/tasks/:id/events          (SSE 实时事件流，done/error 关闭)
GET  /api/tasks/:id                 → {status, result, ...}
```

全部要求 `Authorization: Bearer <NX_AS_TOKEN>`；`GET /api/auth/verify` 免密钥可探活。

## 命令总表

| 命令 | 作用 |
|---|---|
| `nx-as serve [--port] [--host] [--no-open]` | 起 Web 面板 + API |
| `nx-as prompt add/list/get/update/remove` | 提示词模板 CRUD |
| `nx-as task add/list/get/run/remove/events` | 任务提交与管理 |
| `nx-as models list/current/set/set-endpoint/remove-endpoint` | 模型目录与端点 |
| `nx-as settings get/set` | 并发、autoRun |
| `nx-as auth status/rotate` | 密钥 |
| `nx-as skill install` / `skill get` | 给 agent 装/导出使用文档 |
| `nx-as health` / `bootstrap --json` / `routes` / `help [主题]` / `version` | 排查与自省 |

完整 agent 使用文档：`nx-as skill get nx-as`（外部 agent 也能自助获取）。

## 模型配置

- 内置 provider：密钥走环境变量（`DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、
  `OPENROUTER_API_KEY` 等 30+ 家，pi 原生支持）
- 自定义端点（Ollama / vLLM / 任何 OpenAI 兼容地址）：
  `nx-as models set-endpoint my-ollama --base-url http://127.0.0.1:11434/v1 --models qwen2.5`
- 默认模型：`nx-as models set --model deepseek/deepseek-chat`（空 = pi 默认）
- 单任务覆盖：`nx-as task add hello --model anthropic/claude-sonnet-4 --input ...`

## 存储布局

```
~/.nx-as/
  store.json        任务/设置/密钥（原子写）
  prompts/*.md      提示词模板
  workspaces/<id>/  每任务工作目录
  pi-agent/         pi 的会话 JSONL 与 models.json（与用户 ~/.pi 完全隔离）
```

测试/多实例用 `NX_AS_STORE` 环境变量重定向；密钥可用 `NX_AS_TOKEN` 注入。

## 开发

```bash
pnpm install
pnpm run dev        # vite(5180) + serve(7801) 双进程，热更新
pnpm test           # lint + build + smoke(26) + unit(21)
pnpm start          # prod：build + serve
```

分层：`core ← modules ← runtime`；CLI 与 API 同源（action 表）；模块互依由 eslint 枚举禁列
强制（加模块必须补禁列与两处注册表，见 `assets/nx-as/references/00-design.md`）。

## 安全

- 单用户设计：一把密钥，不做多租户
- pi 工具（bash/文件）以 serve 进程权限运行 —— 个人服务器自用可接受；对外开放前把服务放进
  Docker（参考 pi 的 containerization 文档）
- 写操作校验 Origin（纵深防御）；密钥走 Bearer header，别放 URL（SSE 库不支持 header 时除外）

## License

MIT
