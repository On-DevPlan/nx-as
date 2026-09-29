# 03 · 插件与技能（Extensions & Skills）

pi-web 内嵌的 pi 内核支持 Agent Skills 规范（https://agentskills.io/specification）。
nx-as 的角色是**把扩展物化到 pi 的 agent dir**（Bearer 代理配置自动生成扩展文件），
其余扩展/技能装到 agent dir 即可被 pi-web 的会话使用。

## 装在哪里

pi 的 agent dir 隔离在 `~/.nx-as/pi-agent/`（不再读用户的 `~/.pi/agent`）。
装扩展就是把文件放到：

```
~/.nx-as/pi-agent/
  extensions/<name>.ts         # pi 扩展（TypeScript，jiti 直跑无需编译）
  extensions/nx-as-bearer-anthropic.ts   # ← nx-as 自动生成（settings 的 Bearer 配置）
  skills/<name>/SKILL.md       # pi 技能（目录 + frontmatter）
  AGENTS.md                    # 全局静态上下文（每次启动注入）
  auth.json                    # pi 凭据（一般用环境变量代替）
  models.json                  # 自定义模型端点（pi-web 设置页或手编；pi 的 models.json 格式）
```

启动后 pi 的 `DefaultResourceLoader` 会自动发现这些。

## 推荐装哪些（按你的需求）

| 你想要的 | 装这个 | 怎么装 |
|---|---|---|
| **跨会话记忆** | `pi-hermes-memory` / `@amaster.ai/pi-memory` / `shitty-extensions/memory-mode` | `git clone <repo> ~/.nx-as/pi-agent/extensions/<name>` 或 git+ssh 装对应 skill |
| **按项目筛选 skill 省 context** | `pi-context-skills` | 同上 |
| **权限闸**（拒绝危险 bash） | pi 原生 `tool_call` 事件扩展（`block: true` 可拦截全部九类工具） | 同上；可参考 v2 设计的 nx-as-permission 扩展 |
| **自定义存储工具** | pi 原生 `pi.registerTool()`（LLM 可直接调用） | 同上 |
| **会话续跑** | pi 原生 `compaction` + `branch`（不用装） | 自动 |
| **Web 技能**（浏览器/Google/Gmail） | `pi-skills`（brave-search/gccli/gmcli/youtube-transcript） | clone `badlogic/pi-skills` 到 `~/.nx-as/pi-agent/skills/` |
| **通知**（会话完成推送） | pi-web 内置 web-push（PWA 订阅即可） | 零安装 |

> pi **没有 MCP 支持**——工具接入走 `pi.registerTool()`，不是 MCP server。
> awesome 列表参考：awesome-pi-agent（`.claude/repo/awesome-pi-agent/`）——查
> Extensions / Skills / Tools 三个章节找最新的活跃项目。

## pi 的 TUI GUI 插件在 pi-web 里看不见

pi 扩展的 `ctx.ui` 是终端上下文（pi-web 已桥接为 `extension_ui_request` SSE 事件，
手机端可做审批 UI）。画 TUI 的插件在浏览器上**没有完整画面**。nx-as 管理面已覆盖配置场景：

| pi TUI 命令 | 等价 |
|---|---|
| `pi /settings` | pi-web 自带设置页（模型/插件/技能全在那里管） |
| `pi /login` | pi-web 设置页（provider 登录/API key） |
| `pi /model` | pi-web 模型选择器；或 `models.json` 自定义端点 |
| 全局 prompt 模板 | pi-web 会话内 `/prompt`；或 AGENTS.md 写全局指引 |

## 验证扩展加载

装完扩展，`nx-as serve --with-web` 拉起 pi-web，在会话里发一条触发扩展的消息；
或读 `~/.nx-as/pi-agent/AGENTS.md` 里如果扩展要求写的内容被自动注入。