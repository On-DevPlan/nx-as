# 02 · 提示词模板

## 文件格式

`~/.nx-as/prompts/<name>.md`（名允许 `a-z0-9._-`，首位字母数字）：

```markdown
---
description: 一句话描述（面板列表显示）
---

正文。任务输入：$input

没给输入时的默认：${input:-通用用户}
```

## 模板变量

| 写法 | 行为 |
|---|---|
| `$input` | 替换为任务输入（原样，不转义） |
| `${input:-默认值}` | 输入为空时用默认值 |

注意：变量替换发生在**喂给模型之前**的纯文本层，模型看不到占位符本身。

## 操作

```bash
nx-as prompt add daily --file ./daily.md --description "日报生成"
nx-as prompt list
nx-as prompt update daily --description "新描述"      # PATCH：只改传了的字段
nx-as prompt remove daily
```

HTTP 等价：`POST /api/prompts {name, content, description}` / `PATCH /api/prompts/:name`。

## 写好模板的建议

- 把「角色 + 输出格式」写死在模板里，变化的部分全走 `$input`
- 需要 agent 用工具（读文件/跑命令）的任务，模板里明说允许做什么，因为 pi 内核有真实
  文件与 shell 能力，任务在服务器上以 serve 进程权限运行
- 同类任务建多个模板（daily-report / daily-translate），别做一个巨型模板靠 input 分支

## 与任务的关系

`task add <prompt名> --input "..."` — promptId 必须已存在（add 时预检，报 NOT_FOUND 不入队）。
每个任务各自渲染一次模板，改模板不影响已创建的任务。
