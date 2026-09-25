# compare_dsh-vs-pi — DeepSeek Harness 与 Pi Agent 框架对比（2026-09-25 v1）

> **Date:** 2026-09-25
> **Topic:** personal-agent-framework
> **类型:** project compare（外部实现对比 · 现状盘点）
> **版本:** v1（首次产出）

## 原始请求（用户原话）

> 那个更加适合使用插件机制做个人可落地的业务agent开发，主要我定义提示词，可以记录事件进行持久化 如果是插件为设计思想 应该提交任务也能使用网络，最后结果也能范围，很适合做个人的agent，我有云服务器，在思考如何选择  dsn和piagent，支持自己定义tool吗 比如claudecode codex 只能支持skill和mcp的接入

后续轮次补充（AskUserQuestion 确认结果）：

> 讨论模式 = 项目学习模式（只产 project/ 对比文档，不产 intent）；主题目录 = personal-agent-framework；「你设想的个人 agent 在云服务器上以什么形态被使用？」= 还没想清楚，先看两者各自的服务化改造成本再拍板。

## 轻微重写版（仅修错别字与口癖）

> 哪个更适合使用插件机制做个人可落地的业务 agent 开发？主要是我定义提示词，可以记录事件进行持久化。如果是插件为设计思想，应该提交任务也能使用网络，最后结果也能访问，很适合做个人的 agent。我有云服务器，在思考如何选择 dsh 和 pi agent。支持自己定义 tool 吗？比如 Claude Code、Codex 只能支持 skill 和 MCP 的接入。

## 对比对象与版本

| 对象 | 仓库位置 | HEAD | 说明 |
|---|---|---|---|
| 对象 A：DeepSeek Harness (dsh) | `.claude/repo/deepseek-harness/` | `477b4f4` rel/dsh-0.1.7-rc.2（2026-09-24） | DeepSeek AI 开源，"一切皆插件"架构，构建于 Cordis 插件元框架之上，MIT |
| 对象 B：Pi Agent (pi) | `.claude/repo/pi/` | `b348765` fix(tui)（2026-09-25） | Mario Zechner (badlogic) 的极简 coding agent toolkit，Extension 为核心扩展机制，MIT |
| 本项目现状 | `D:\DevProjects\my\github\nx-as\` | — | **未开始**：目录仅含 `.claude/`，无任何业务代码 |

## 逐维对比总表

| 维度 | dsh (deepseek-harness) | pi (earendil-works/pi) | 本项目现状 |
|---|---|---|---|
| 1. 自定义工具（模型可调用 tool） | ✅ 工具即 Cordis 插件：`defineTool` + `ctx.tools.register()`，参数自动校验，含执行策略扩展点与后台 jobs（`docs/cookbook/adding-a-tool.md:7-55`） | ✅ Extension API：`pi.registerTool()`，TypeBox schema + `execute()`，支持热重载与动态激活（`packages/coding-agent/docs/extensions.md:76,132-145`） | 未开始 |
| 2. 提示词定制 | preset 修订（revision）机制：每个 Agent 看到"其选中修订的 tools、prompts 与 skills"（`packages/preset/README.md:9`）；系统提示词由装配流程派生，tool schema 自动流入（`docs/cookbook/adding-a-tool.md:38`、`docs/subsystems/session.md:183`） | 三层文件直接覆盖：`<agent-dir>/SYSTEM.md` **替换**默认系统提示词、`APPEND_SYSTEM.md` 追加；项目级 `.pi/SYSTEM.md` 同理，trusted 项目文件优先（`packages/coding-agent/docs/configuration.md:18-19,30-31,37`） | 未开始 |
| 3. 事件记录与持久化 | Session = **append-only 类型化事件日志**，单一事实源，LLM 消息历史由日志派生、回放即重新推导（`docs/subsystems/session.md:5`）；事件信封 `{type, seq, time, data, ignorable?, surfaceOp?, sourceEventSeqs?}`，区分 surface / log-only（`docs/persistence-catalog.md:10`）；插件可经 declaration merging 扩展事件类型（`docs/subsystems/session.md:11`）；持久化类型带 SHA-256 指纹与历史格式变更记录（`docs/persistence-catalog.md:6`） | 会话 = JSONL 文件，条目经 `id`/`parentId` 构成**树**，支持就地分支（`packages/coding-agent/docs/session-format.md:1-5`）；扩展内有分级状态存储表：tool-result `details`（随分支）/ `pi.appendEntry()`（持久、不进模型上下文）/ `pi.sendMessage()` / 外部存储（`packages/coding-agent/docs/extensions.md:159-168`）；SQLite 会话后端独立成包 `pi-session-backend-sqlite-node`（`packages/agent/README.md`）；`pi-durable` 提供会话/任务/文档持久运行时，含 Memory/JSONL/SQLite 三种存储实现（`packages/durable/README.md:3-5`） | 未开始 |
| 4. 任务提交 / 联网接入 | **server 形态内建**：API Gateway 以 `@Remote`/`@RemoteScope` 声明 unary 与 stream 方法，复用 Connection RPC 与 `/api` 路由，流式走 `/api/remote.mux` WebSocket（`docs/api-gateway.md:5,9,58`）；`webhook/` 接收认证过的外部 provider 事件，经可信规则**自动创建 Session**（process-local、fire-and-forget，无投递库/队列/重试/去重/完成态）（`packages/webhook/README.md:2,12`） | 三条接入路径：SDK（进程内，Node/Bun）、RPC 模式（**长驻子进程**，stdin/stdout JSON 记录，含命令/响应/事件/扩展 UI 四类记录族，`packages/coding-agent/docs/rpc.md:1-14`）、实验性 `pi-server`（durable Session 的本地 server，多端 attach 同一 Session，`packages/server/README.md:3`）+ `pi-protocol`（CBOR 编码、字节流分帧的路由信封，协议版本 8，`packages/protocol/README.md:3`）+ `pi-client`（传输无关客户端，WebSocket/Unix socket 皆可作字节传输层，`packages/client/README.md`） | 未开始 |
| 5. 结果访问与交付 | Web UI 优先产品 + Trajectory 视图（按来源检查事件流、resume/fork/search/replay 共享同一事件流）；`deliverables/` 交付物包（`packages/` 目录清单；`event:deliverables/presented` 见 `docs/persistence-catalog.md` 事件目录） | 会话文件落盘（`~/.pi/agent/sessions/`）；展示层**不在包内**——SDK/RPC/server 之上由宿主自建 UI（`packages/coding-agent/docs/rpc.md:3`："custom user interfaces" 为 RPC 适用场景） | 未开始 |
| 6. 云服务器部署形态（开箱内容 vs 需自建内容） | 开箱：Web UI 服务（`npx @deepseek-ai/dsh web`，127.0.0.1:3080）、API Gateway、webhook、jobs 后台任务、acp/ssh/web 包均在 `packages/` 清单内。需注意：webhook 为 fire-and-forget，无重试/去重/完成态（`packages/webhook/README.md:12`） | 开箱：CLI（终端交互）、RPC 子进程、SDK、实验性 server/protocol/client。需自建：面向"提交任务—查看结果"的 HTTP API 与前端界面均不在包内（`packages/` 清单中 server 为 experimental local server） | 未开始 |
| 7. 外部生态入口 | 内置 MCP 客户端插件组：`mcp/`（mcp-client + mcp-resources），"让模型调用外部 MCP 工具并读取 server 资源"，仅配置 `mcp-client` 条目即可（`packages/mcp/README.md:3,7`）；另有 skill/、hooks/、subagent/、workflow/ 等包 | 实现 Agent Skills 规范（agentskills.io）（`packages/coding-agent/docs/skills.md:7`）；prompt templates、themes、extensions 均为生态入口；**核心无 MCP**——docs 全目录 grep "mcp" 零命中，`packages/` 下无 mcp 包（设计性取舍，官方深度解析文章亦确认核心刻意排除 MCP） | 未开始 |

## 逐维展开（证据细节）

### 1. 自定义工具

两者均为**代码级一等工具注册**，且工具参数 schema 会进入模型可见面（dsh：schema 自动流入系统提示词装配，`adding-a-tool.md:38`；pi：TypeBox schema 定义于 `defineTool`，`hello.ts:8-12`）。

dsh 侧差异点：注册是**基于 effect 的**（ disposing 插件 fiber 即注销工具，`adding-a-tool.md:38`）；`defineTool` 在 `execute` 前对模型生成的 arguments 做统一校验（`adding-a-tool.md:42`）；执行策略有完整扩展点序列——`tools/pre-execute`（allow/deny/ask 策略）、`ctx.tools.guard()`（终局拒绝）、`tools/execute`（超时/重试/指标包裹）、`tools/post-execute`、`tools/result`（观察不可变结果）（`adding-a-tool.md`「Execution policy and observation」节）；长任务经 `ctx.jobs.start({kind, label, owner, run})` 进后台作业环，返回 `{kind:'background', jobId}` 类型化句柄（`adding-a-tool.md:53-55`）。

pi 侧差异点：单扩展文件**热重载**；工具可动态激活/停用（`pi.setActiveTools()`，已注册名字必须先存在，`extensions.md:141-145`）；执行约定要求返回 `{content, details}`，`details` 同时承担"随会话分支的状态重建"职责（`extensions.md:132-136,159-168`）；文件变更类工具须用 `withFileMutationQueue()` 包裹读-改-写（`extensions.md:139`）。

### 2. 提示词定制

- pi：文件级直接控制，`SYSTEM.md` 整体替换、`APPEND_SYSTEM.md` 追加，agent 目录与项目 `.pi/` 两级，trusted 项目文件优先且同名文件不合并（`configuration.md:18-19,30-31,37`）。
- dsh：提示词是 preset 修订的组成部分（"each Agent sees the tools, prompts and skills of its selected revision"，`preset/README.md:9`）；系统提示词本身不进请求头，而是作为 `system/message` surface 事件被记录，prompt 变更会替换/追加 system 节点（`session.md:183`）。

### 3. 事件记录与持久化

- dsh：事件溯源（event-sourced）设计——Session 是"append-only 类型化 SessionEvent 日志，agent 全部交互历史的单一事实源"，LLM 消息历史是派生物，回放 = 从同一事件集重新推导（`session.md:5,452`）；事件类型对插件开放（declaration merging，如 compaction/* 与 hook/invoked 等即为插件合入的事件类型，`session.md:11`）；持久化事件有机器可校验的目录（生成式 catalog + SHA-256 类型指纹 + 历史格式变更记录，`persistence-catalog.md:1-10`）。
- pi：JSONL 会话树（分支不新建文件，`session-format.md:1-5`）；扩展状态四档存储策略表（`extensions.md:159-168`）；核心 SQLite 会话后端独立成包以避免默认引入原生依赖（`packages/agent/README.md`「SQLite session backends」）；`pi-durable` 的 JSONL 存储支持 `fsync` 刷盘选项，SQLite 核心带有序 schema 迁移，但"一个 JsonlStorage 所有者必须串行化写入，跨进程锁与 ID 分配不受支持"（`durable/README.md:28-30`）。

### 4. 任务提交 / 联网接入

- dsh 的接入面在产品内闭环：业务服务声明 `@Remote` 方法即生成 Host/Client 契约并挂上 `/api` 路由（`api-gateway.md:5,9`）；流式方法经 `/api/remote.mux` WebSocket，客户端上行项会先过生成的 In codec 校验（`api-gateway.md:58`）；webhook 把认证过的外部事件转成 Web Workspace 内的根 Session（`webhook/README.md:12`）——该路径明确标注无投递数据库、无队列、无重试、无去重、无 Agent 完成态。
- pi 的接入面是三层嵌 入式路径：SDK（进程内）/ RPC（子进程 JSONL，四类记录族：命令、response、会话事件、扩展 UI 记录，`rpc.md:9-14`）/ 实验性 server 栈（`pi-server` + `pi-protocol` CBOR 路由信封 + `pi-client` 传输无关客户端，`server/README.md:3`、`protocol/README.md:3-8`、`client/README.md`）。server README 自述为 "Experimental local server"（`server/README.md:3`）。

### 5-6. 结果访问与部署形态

- dsh 仓库内含完整 client/web 包（`packages/`：client、web、terminal、host）与 deliverables 交付物机制（`event:deliverables/presented` 在持久化事件目录中）。
- pi 仓库不含面向终端用户的 Web 界面；RPC 文档把 "custom user interfaces" 列为适用场景（`rpc.md:3`），即展示层由宿主实现。

### 7. 外部生态入口

- dsh：MCP 是内置插件组（`packages/mcp/README.md:3,7`），与原生 Cordis 工具并存；另有 skill/、hooks/、subagent/、workflow/ 包（`packages/` 清单）。
- pi：实现 Agent Skills 规范（`skills.md:7`）；核心不含 MCP——`packages/coding-agent/docs/` 全目录 grep "mcp" 零命中、`packages/` 无 mcp 包；MCP 能力需经社区扩展包补足（本次仓库扫描范围内未见官方 MCP 包）。

## 当前问题 / 待定点

1. **交互形态未定**（用户确认"还没想清楚"）：dsh 的开箱 server 面（Web UI + `/api` + webhook）与 pi 的嵌入面（SDK/RPC/experimental server）代表两种不同的自建工作量分布——此为现状事实记录；具体选型决策未做。
2. **pi 的 server 栈处于 experimental 状态**（`server/README.md:3`），`pi-protocol` 协议版本号为 8（`protocol/README.md:3`），迭代中。
3. **dsh 处于 developer preview**，官方声明未来将有破坏兼容性变更（仓库 README「Developer preview」节）。
4. **webhook 路径无可靠投递**：fire-and-forget，无队列/重试/去重/完成态（`webhook/README.md:12`）——对"提交任务后结果可访问"诉求的覆盖程度是现状缺口事实。
5. 用户原话中"Claude Code、Codex 只能支持 skill 和 MCP 接入"为用户前提表述，本次未对 Claude Code/Codex 做仓库级验证，不在两对象对比范围内。
6. 本项目（个人业务 agent）**未开始**：nx-as 目录仅含 `.claude/`。

## 参考

- 对象 A 仓库：`.claude/repo/deepseek-harness/`（HEAD `477b4f4`）
- 对象 B 仓库：`.claude/repo/pi/`（HEAD `b348765`）
- 本文档所有行号引用均基于上述 HEAD 版本；两仓库后续更新后引用可能漂移
