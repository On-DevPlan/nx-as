# 00 · 设计思想

## 驱动关系

```
手机 App / curl / 面板
        │ HTTPS + Bearer token
        ▼
  serve (node:http)  ──►  /api/*  ──►  api.js（鉴权 → 路由匹配 → ctx 拼装）
        │                                    │
  静态面板 (src/web/public)                   ▼
                                    action 表（唯一真相源，src/index.js 汇总）
                                             │
                                             ▼
                                  modules/<域>/service.js（业务）
                                             │
                             core/（store 原子写 / errors / paths） + pi SDK（tasks/runner）
```

CLI（bin/nx-as.mjs → runtime/cli.js）与 HTTP 走**同一张 action 表**：
`{ id, cli: [...], http: ['METHOD','/path'], run(ctx), render() }`。

## 分层与依赖方向

- `core/` 最底层：不依赖 modules / runtime / web
- `modules/` 互不依赖：共享下沉 core；唯一例外 `settings/service.js` 可被单向只读依赖
- `modules/system/` 是聚合例外（要读各模块状态）
- 前端（view.jsx + web/frontend）只能 import 组件 / api client / 模块的 view.jsx；禁 node:*
- Node 侧禁 import 任何 .jsx
- 以上由 eslint `no-restricted-imports` 强制（config 里互依禁列是**逐模块枚举**——
  **加模块必须补一行，漏补是静默的**）

## 关键不变量（违反会怎样）

1. **action 双端声明** — `cli` 必填，`http` 可 null。只加 CLI 不加 HTTP，面板调不到；
   只改 service 不改 action，两端都不生效。registry 装载期自检会在启动时抛错兜底。
2. **args 名与 http 占位符同名绑定** — `args:['id']` + `/api/tasks/:id` 靠名字对上；
   对不上 → undefined 静默传进 service。GET/DELETE 无 body，args 名必须落在占位符或 flags
   （registry 自检这条）。
3. **存储原子写** — store.json 走 tmp+rename；事务用 `mutateStore`（structuredClone 深拷贝，
   抛错不落盘）。直接 `fsp.writeFile(STORE_PATH)` 会在进程被杀时损坏数据。
4. **密钥在 api.js 层拦** — 别在各 action 里各自验 token。新加公开路径只能改 api.js 的
   `PUBLIC_PATHS`（当前只有 `/api/auth/verify`）。
5. **SSE 用 action.sse 标记** — run 收到 `meta.res` 自己写响应；事件走 runner 的事件总线；
   终态任务连接 SSE 立即 replay 后 end（不挂心跳）。

## 失败 vs 业务结果

| 情形 | 表达 | 例子 |
|---|---|---|
| 调用方无从处理 | throw AppError(code) | prompt 名非法、任务不存在 |
| 调用方要决策/分支 | return {status} | task.run 对 running 任务 `{status:'skipped'}`；task.update 对非 pending `{status:'blocked'}` |

错误码 → HTTP 状态唯一映射（core/errors.js）：INVALID_INPUT 400 / UNAUTHORIZED 401 /
NOT_FOUND 404 / CONFLICT+BLOCKED 409 / EXTERNAL 502 / INTERNAL 500。CLI `--json` 失败输出
`{ok:false,error,code}`，退出码 1。

## 错误案例

| 坑 | 后果 | 正确做法 |
|---|---|---|
| 读命令 flag 写 default | 「没传=全部」分支永远走不到（静默） | 读命令不带 default（applySpec 只强转不注入） |
| 路由字面量被 :param 遮蔽 | 声明顺序决定命中，调整顺序就坏 | sortRoutes 字面量段优先（已有单测钉住） |
| 改 flag 名只改一端 | CLI `--max-concurrent` 与 body `maxConcurrent` 分叉 | 两端同名；对照 smoke 测试 |
| 测试直接写默认 store | 污染 ~/.nx-as/ | `NX_AS_STORE` 指向临时目录（smoke/单测都这么做） |
| pi 会话写进 ~/.pi/agent | 污染用户 pi 配置 | runner 显式 `SessionManager.create(cwd, <nx-as>/pi-agent/sessions)` |
