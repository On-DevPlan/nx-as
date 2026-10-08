# Changelog

## 0.7.2 (2026-10-08)

**安全 review 后的一致性与加固修复**：未发现可直接利用的高危漏洞；修复 6 项「注释/死代码与实际行为不一致」及纵深防御点。

### Fixed

- **统一短票通道机机 Basic 口径**：nginx 模板对 `/m/v1/` 注入 Basic 是正确行为（每个请求先过
  `auth_request`，裸请求在到达 `proxy_pass` 前即 401），但原注释声称「短票不注入 Basic、否则放行裸请求」，
  与 direct 模式及实际行为矛盾、易误导。已更正两处注释，行为不变。
- **删除 `proxyToUpstream` 死分支**：`withMachineAuth=false` 分支无任何调用方且注释与默认行为相反，已移除。
- **启动 pi-web 显式绑定 loopback**：launcher 增加 `--hostname 127.0.0.1`，不再仅依赖 pi-web 默认值
  （防止上游默认改为非 loopback 时静默暴露）。
- **限流洪泛不再整表解封**：`state` 超 10000 条时改为按插入序淘汰最旧条目（LRU），而非 `clear()`
  造成的短暂全局解封窗口。
- **store 缓存身份纳入路径**：多 store 路径切换时不再因仅按 mtime 缓存而串数据。
- **入拼 nginx 配置字段加白名单**：`domain`/`certPath`/`keyPath` 与 `NXAS_TARGET_AUTH_HEADER`
  校验字符集，拒绝引号/分号/换行等可破坏或注入配置的值。

### Added

- 回归测试：nginx 入拼白名单、限流洪泛 LRU 淘汰、store 路径缓存隔离（全套 49 项全绿）。

## 0.7.1 (2026-09-29)

**基础镜像双形态 + GHCR 分发**：同一个 Dockerfile 出两个 target——`base`（纯权限壳）与 `full`（base + pi-web），CI 同时构建并推送到 GHCR。

### Added

- **Dockerfile 多 target**：`runtime-common`（nginx + nx-as）→ `base`（无主程序）→ `full`（+ pi-web）。
  派生镜像 `FROM ghcr.io/on-devplan/nx-as-base` 后设 `NXAS_TARGET_CMD` / `NXAS_TARGET_PORT` /
  `NXAS_PROTECT` / `NXAS_TARGET_ENV_PIWEB=0` 即可给自己的应用套上鉴权网关。
- **GHCR 发布**：CI 推 `ghcr.io/on-devplan/nx-as-base` 与 `ghcr.io/on-devplan/nx-as`（version + latest）；
  47 部署仍走 artifact docker load（不依赖 47 能拉私有 GHCR 包）。
- base 镜像冒烟断言：网关就绪 + 日志含「纯权限壳模式」+ 匿名 `/` 不崩。

### Fixed

- **短票通道注入机机 Basic**（线上实测：短票签发/验证/消费全正常，但上游 pi-web 认 Basic/cookie，
  短票通道此前**从未真正打通**）。票在 `decide()` 一次性消费 + 会话绑定，本身即授权证明；
  注入的 Basic 只进上游请求头、不回传客户端，安全边界不变。手机端 EventSource 从此可用。
- **`docker-image.yml` retag 硬编码 `0.4.1`**：0.7.0 artifact load 后被旧镜像覆盖 tag，
  47 起的仍是旧版 → 新模板占位符不被旧 entrypoint 渲染 → nginx 重启循环。改为按版本号 retag。
- **cert 单测不再依赖 openssl CLI**（ubuntu-24.04 runner 不带，`spawnSync ENOENT` 曾拦死发版）：
  改用提交进仓库的静态 PEM fixture（`tests/fixtures/`）。
- **compose 去掉 nginx 模板挂载**：镜像自带正确版本，外挂旧模板正是版本漂移雷的根源。

## 0.7.0 (2026-09-29)

**基础镜像 + 零感知登录 + 单一命名空间**：nx-as 与 nginx 打包为基础镜像，主进程（默认 pi-web）可替换；nx-as 全部功能收进 `/_nxas/*` 一个前缀。

### Added

- **零感知登录（bootstrap）**：`/_nxas/auth/login` 登录时，nx-as 用机机信任在服务端代签上游（pi-web）session cookie，与自身 cookie 一起下发——浏览器只输一次 device token，主程序无感知。
- **基础镜像形态**：`NXAS_TARGET_CMD`/`NXAS_TARGET_PORT`/`NXAS_PROTECT` 环境变量驱动；`FROM nx-as` 即可构建带鉴权的自有应用镜像（`docker/render-protect.mjs` 按路径模式生成 auth_request location）。
- **单一命名空间 `/_nxas/*`**：面板（`/_nxas/panel`）、登录页、管理 API、手机 API 全部收进来；其余路径 100% 原样给主进程（pi-web 的 `/login`、`/api/*`、`/_next/*` 零改动）。
- **面板 nginx 编辑器（容器模式）**：直接编辑生效模板 → 渲染 → `nginx -t`（失败回滚）→ reload；`/assets`、logo/favicon 放行。
- **SSE 短票绑定会话**：票与会话 id 一起签名，偷票读别的会话既拒绝又作废。
- **pi 数据落挂载卷**：`PI_CODING_AGENT_DIR` 环境变量优先（修复会话写容器可写层、重建即丢的问题）。

### Removed（breaking）

- **配对码机制**：`device pair`/`pairCreate`/`pairRedeem`/`POST /m/v1/pair` 全删，改为 `nx-as device issue --name <名>` 直接签发。
- **settings 模块**：Bearer 代理配置（provider/baseUrl/models/token）删除——模型/插件/技能管理全部交给 pi-web 自带设置页。
- `gateway/extensions.js`（Bearer 扩展生成器）、`store.settings`、`store.pairCodes`。
- 旧的 `/m/v1/*` 顶层路径（收回 `/_nxas/m/v1/*`）。

## 0.4.1 (2026-09-28)

单容器全内置镜像 + GitHub Actions 构建分发（docker save，不走 registry）。

### Added

- **Dockerfile**（node:22-alpine）：nginx（公网入口/TLS/auth_request 委托）+ nx-as（鉴权/面板）+ pi-web@0.9.3（会话运行时）三进程单容器；数据卷 `/data`（store/audit/pi-agent 会话与凭据）。
- **`docker/entrypoint.sh`**：机机密码物化到 store（与 launcher 同源）→ 自签证书 → envsubst 渲染 nginx conf → `nx-as serve --with-web` 拉起 pi-web+网关 → nginx 前台。
- **`docker/nginx.conf.template`**：与 `nx-as nginx apply` 托管模板同构的容器内版本。
- **`docker-compose.yml`**：47 服务器部署件（8443 公网入口，7801 不映射；mem_limit 700m）。
- **`.github/workflows/docker-image.yml`**：构建 → 容器冒烟（探活 + 匿名 401 断言）→ `docker save|gzip` → artifact；打 `v*` tag 时 SCP 到 47 服务器 `docker load` + compose up + 健康检查。
- `NXAS_NGINX_SUDO=0`：容器内 root 直跑 nginx，跳过 sudo 前缀。

## 0.4.0 (2026-09-28)

**auth_request 委托架构**：公网数据路径交给 nginx（SSE 直通），nx-as 瘦身为纯鉴权服务 + nginx 托管面板；鉴权逻辑与暴露方式分离，direct/nginx 双模式。

### Added

- **`/auth/check` 委托端点**：nginx `auth_request` 每请求子询问；决策逻辑抽入 `gateway/check.js`（direct/nginx 共享一份）。节流状态按 auth_request 契约以 403+Retry-After 表达。
- **nginx 托管模块**（`src/modules/nginx/`）：模板渲染（auth_request + 直代 pi-web + SSE 不缓冲 + 签发端点直通）、Apply 流程（写 .new → 备份 .bak → `nginx -t` 失败自动回滚 → graceful reload）、配置漂移检测、sudoers 探测、`nx-as nginx setup` 部署引导、`rotate-secret` 机机密码原子轮换。
- **面板「nginx」页**：状态卡（服务/漂移/授权）、domain/证书表单、高级模式（托管 conf textarea，仍有 nginx -t 兜底）、Apply/回滚/轮换按钮。
- **机机密码持久化**：`store.machineSecret`（launcher 与 nginx 模板同源），首次 serve 自动生成。
- 双模式：`NXAS_GW_MODE=nginx` 不挂进程内反代；`direct`（默认）行为不变。
- 单测：nginx 模板结构断言 + Apply 备份/回滚全链路（mock 执行层，平台无关）。

## 0.3.0 (2026-09-28)

**彻底重构：nx-as → nx-apiserver（语义名）** —— 从嵌入式 pi 运行时转型为 pi-web 的鉴权代理网关 + 安全启动器。pi-web 成为会话运行时核心（零改动、锁版本），nx-as 不再内嵌 pi。

### Added

- **设备鉴权网关 `/m/v1/*`**：per-device token（`nxas_d1.<id>.<secret>`，sha256 落库、timing-safe 比较、可单独吊销、last_used 审计）；配对码签发（8 位数字、5 分钟、单次）；SSE 一次性短票（HMAC、60 秒、EventSource 无 header 场景）；认证失败指数退避限流（1s→60s、5 分钟静默清零、429 + Retry-After）；Host 白名单（`GW_ALLOWED_HOSTS`）+ Origin 跨站校验；全量审计落 `audit.jsonl`。
- **安全启动器**：`nx-as serve --with-web` 一条命令拉起网关 + pi-web；`PI_WEB_PASSWORD` 每次启动随机生成注入（机机信任，人工密码退出 pi-web 侧）；网关反代自动注入 `Authorization: Basic pi:<机机密码>`。
- **`nx-as device pair|list|revoke` 命令** + `GET /api/devices`、`POST /api/devices/:id/revoke` 管理路由。
- gateway 单元测试（token/短票/节流）+ 网关 E2E（mock 上游 9 断言全绿）。

### Removed（breaking）

- **tasks 模块整体退役**：`task add/list/get/run/events/timeline` 命令、嵌入式 pi 运行时（runner）、任务事件 SSE 总线、面板时序瀑布图/trace 视图全部删除——会话执行改由 pi-web 承担。
- `@earendil-works/pi-coding-agent` 依赖移除（保留轻量 `pi-ai` 供模型目录）；`core/events.js`、`taskWorkspace` 删除；store 结构 `tasks[]` → `devices[]`（旧 store.json 多余字段容忍读取）。

### Changed

- README/skill 文档重定位为「pi-web 鉴权代理网关」；`web` 命令升级为安全启动器（随机密码注入）。

## 0.2.2 (2026-09-27)

pi-web 集成：生产级对话 UI 一条命令可达。

### Added

- **`nx-as web` 命令**：拉起 [pi-web](https://github.com/agegr/pi-web)（@agegr/pi-web，MIT，89 组件 Next.js 生产级 UI——Markdown/KaTeX/Mermaid/代码高亮/diff 预览/会话树/文件浏览），`PI_CODING_AGENT_DIR` 自动指向 nx-as 的隔离目录。pi-web 未安装时给出安装/直跑提示。

### Changed

- **会话文件布局对齐 pi CLI 标准**：从 `sessions/<uuid>.jsonl` 移到 `sessions/--<cwd 编码>--/<uuid>.jsonl`（pi 的 session-manager 编码公式）。对齐后 pi-web、`pi -r` 等标准 pi 工具能直接发现并继续 nx-as 任务的会话。旧布局文件仍可被 pi CLI 通过 `-r` 全局模式找到。

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
