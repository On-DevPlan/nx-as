# 03 · 插件与技能（Extensions & Skills）

pi 内核支持 Agent Skills 规范（https://agentskills.io/specification）。nx-as 把 pi 跑成进程内 SDK，
所以**所有 pi 扩展/技能都能直接装到 nx-as 的服务里跑**——只要放到 pi 的 agent dir。

## 装在哪里

nx-as 把 pi 的 agent dir 隔离在 `~/.nx-as/pi-agent/`（不再读用户的 `~/.pi/agent`）。
装扩展就是把文件放到：

```
~/.nx-as/pi-agent/
  extensions/<name>.ts         # pi 扩展（TypeScript，jiti 直跑无需编译）
  skills/<name>/SKILL.md       # pi 技能（目录 + frontmatter）
  AGENTS.md                    # 全局静态上下文（每次启动注入）
  auth.json                    # pi 凭据（一般用环境变量代替）
  models.json                  # 自定义模型端点（用 `nx-as models set-endpoint`）
```

启动后 pi 的 `DefaultResourceLoader` 会自动发现这些。

## 推荐装哪些（按你的需求）

| 你想要的 | 装这个 | 怎么装 |
|---|---|---|
| **跨会话记忆** | `pi-hermes-memory` / `@amaster.ai/pi-memory` / `shitty-extensions/memory-mode` | `git clone <repo> ~/.nx-as/pi-agent/extensions/<name>` 或 git+ssh 装对应 skill |
| **按项目筛选 skill 省 context** | `pi-context-skills` | 同上 |
| **权限闸**（拒绝危险 bash） | `pi-hooks/permission` 或 `michalvavra/agents` 的 `security.ts` | 同上 |
| **会话续跑** | pi 原生 `compaction` + `branch`（不用装） | 自动 |
| **Web 技能**（浏览器/Google/Gmail） | `pi-skills`（brave-search/gccli/gmcli/youtube-transcript） | clone `badlogic/pi-skills` 到 `~/.nx-as/pi-agent/skills/` |
| **用量统计** | `pi-cost-dashboard` 或 `usage-extension` | 跑独立端口 |
| **通知**（任务完成弹窗） | `pi-notification-extension`（Telegram） / `ferologics/pi-notify`（桌面） | 同上 |

> awesome 列表参考：awesome-pi-agent（`.claude/repo/awesome-pi-agent/`）——查
> Extensions / Skills / Tools 三个章节找最新的活跃项目。

## pi 的 TUI GUI 插件在 nx-as 里看不见

pi 扩展的 `ctx.ui` 是终端上下文。`pi-gui` / `pi-canvas` / `pi-prompt-template-model` 这类画
TUI 的插件在浏览器上**没有画面**。nx-as 自带的 Web 面板已经覆盖配置场景：

| pi TUI 命令 | nx-as 等价 |
|---|---|
| `pi /settings` | Web 面板 → settings；CLI：`nx-as settings get/set` |
| `pi /login` | `nx-as models set-endpoint --api-key-env <VAR>` + 环境变量 |
| `pi /model` | `nx-as models set --model <id>`；单任务覆盖：`task add ... --model <id>` |
| 全局 prompt 模板 | `nx-as prompt add`（一样能写全局指引，结构化更清晰） |

## 验证扩展加载

装完扩展，提交一个 task，看 task events SSE 里是否收到扩展注入的消息；或读
`~/.nx-as/pi-agent/AGENTS.md` 里如果扩展要求写的内容被自动注入。