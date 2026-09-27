# Changelog

## 0.2.1 (2026-09-27)

调试面板补全：时序瀑布图 + 对话页强化（参考 pi-web 的成熟模式）。

### Added

- **调试视图「时序」模式**：Gantt 式时间线瀑布图——每个 span 一行水平条，按全局时间比例定位；llm 深色 / tool 黄 / turn 灰 / error 红；与「树」模式一键切换。
- **对话页**：用户输入渲染为右对齐气泡（带 /promptId 前缀）；turn 内 content blocks 按 startMs 交错渲染（thinking → 文本 → 工具卡片顺序与真实执行时序一致）；assistant 消息 hover 显示复制按钮（pi-web 模式）；chat 滚动 stick-to-bottom（用户上滚即停止吸底）。
- **工具卡片**（pi-web ToolCallBlock 式）：绿/红描边区分成败；头部显示参数智能摘要（command/path/file_path/pattern/query 优先）；时长徽章；chevron 展开输入/输出。
- **timeline API 保留 input/output**（4000 字符截断保护）——工具参数预览与结果在面板直接可见。
- **smoke 增强（26→37）**：fake executor 走完整事件管道（turn → llm(thinking+text) → tool → done），timeline 的 span 树 / tool input/output / 起止时间 / 树挂载全部有端到端断言。

## 0.2.0 (2026-09-27)

调试面板：完整事件流 + Trace 视图 + 对话页。

### Added

- **完整事件流**：runner 把 pi 的 turn / llm / tool 事件归一为 span 树，落 `~/.nx-as/tasks/<taskId>.events.jsonl`（append-only），并随 SSE 实时推送。旧 `type:'text'` 事件继续推，旧前端兼容。
- **`GET /api/tasks/:id/timeline`**：从事件 JSONL 重建 span 树（`{spans, tree, rootIds, total}`）。CLI `task timeline` 同步可用。
- **面板「对话」视图**：任务详情改对话形态——Markdown 渲染（零依赖：代码块/行内代码/粗体/标题/列表）、thinking 折叠、工具调用卡片（可展开输入/输出）。
- **面板「调试」视图**：span 树 + 耗时 + 状态（ok/error）+ 点击看详情（文本/属性/输出）。running 任务每 2s 自动刷新。

### Changed

- 事件归一器（`src/modules/tasks/normalize.js`）：assistant 消息按 `stopReason` 决定 llm span 状态——模型 4xx 错误在 trace 里精确落在失败的 llm span 上，不再误标 ok。

## 0.1.2 (2026-09-26)

Bug 修复。

- runner：消费 `settings.model` 作为默认模型回退，并在 `settings.model` 为空时回落到已配 Bearer 代理的首个模型（修复不传 model 时静默落到 pi 默认 provider、请求被错误代理端点拒绝的 403 问题）
- runner：模型未注册时抛出可读错误（列出本机已配置凭据的模型 + 用法串），替代裸 403
- prompts：`renderPrompt` 改用函数式替换，避免用户输入含 `$&` / `` $` `` / `$'` 时被 String.replace 当作替换模式吞掉
- cli：`VERSION` 字面量与 npm 版本同步（之前 0.1.1 仍报 0.1.0）
- auth：`/api/auth/verify` 返回的 version 与 npm 版本同步

## 0.1.1 (2026-09-26)

面板品牌化。

- 新增 logo / favicon 全套（`src/web/frontend/public/`）：logo.png、logo-rounded.png、favicon-{16,32,48}.png、favicon.ico
- 撞色：克莱因蓝 `#002EA6` 底 + 松花黄 `#FFE76F` 字母
- header 品牌区带图，index.html 挂 favicon / apple-touch-icon

## 0.1.0 (2026-09-26)

首个版本。

- serve：Web 面板 + token 鉴权 HTTP API（单用户 Bearer 密钥）
- tasks：提交 AI 任务（pi 内核）、SSE 实时事件流、结果与会话 JSONL 持久化、并发队列
- prompts：Markdown 提示词模板（$input 变量），CRUD 双端可用
- models：pi 内置 30+ provider 目录 + 自定义端点（OpenAI 兼容/Ollama/vLLM）
- auth：密钥状态、轮换
- CLI 与 API 同源；skill install/get；GitHub Actions 发版（tag 幂等）
