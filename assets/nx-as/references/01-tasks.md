# 01 · 任务：提交、事件流、结果

## 生命周期

```
task add (pending/queued) → running → done | error
                              │
                              └─ pi 会话：JSONL 落盘 <store同级>/workspaces/<taskId>/
```

- `POST /api/tasks` 默认**创建即执行**（settings.autoRun）；`--no-run` / body `{"run":false}` 只创建
- 并发上限 settings.maxConcurrent（默认 2），超出入队
- 模型错误不抛异常：pi 产出 stopReason=error 的消息 → runner 上浮为任务 `error` 状态（errorMessage 字段）

## CLI

```bash
nx-as prompt add hello --content "用一句话介绍 $input"
nx-as task add hello --input "TypeScript"      # → t_xxx，自动执行
nx-as task events t_xxx                        # 轮询到终态，打印结果
nx-as task get t_xxx                           # 含 result
```

## HTTP API（App 对接）

```bash
TOKEN=xxx; BASE=https://your-server:7801

# 提交（立即返回，不等执行）
curl -X POST $BASE/api/tasks -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"promptId":"hello","input":"TypeScript"}'
# → {"id":"t_xxx","status":"queued",...}

# 实时事件（SSE）
curl -N $BASE/api/tasks/t_xxx/events -H "Authorization: Bearer $TOKEN"
# data: {"type":"task_start",...}
# data: {"type":"text","delta":"Ty"}     ← 文字增量
# data: {"type":"tool_start","tool":"read",...}
# data: {"type":"done","result":"..."}   ← 终态，连接关闭
# data: {"type":"error","error":"..."}

# 结果
curl $BASE/api/tasks/t_xxx -H "Authorization: Bearer $TOKEN"
```

浏览器端 SSE 注意：EventSource 不能自定义 header，用 query 传 token
`/api/tasks/:id/events?token=<TOKEN>`（api.js 支持 query 上的 token 等价 body 字段？**不支持**
——当前实现只认 Authorization header 与 PUBLIC_PATHS；面板实现是走 fetch 不走 EventSource 的
场景，App 端用原生 SSE 库带 header，或自己在 header 里带）。

## 事件类型

| type | 字段 | 含义 |
|---|---|---|
| task_start | taskId | 开始执行 |
| message_start | role | 一条消息开始 |
| text | delta | assistant 文字增量（拼起来 = 最终结果） |
| tool_start / tool_end | tool, args | 工具调用 |
| agent_end | — | 一轮 agent 运行结束 |
| done | result | 终态：成功（连接关闭） |
| error | error | 终态：失败（连接关闭） |

断线重连：重新连上即收到 replay（最近 500 条），从 delta 拼接处继续。
任务已终态时连接 → 立即 replay 完整事件后关闭。

## 排查

| 症状 | 看哪 |
|---|---|
| task 一直 queued | settings.maxConcurrent 是否被占满（health 的 tasksRunning） |
| status=error 但 error 空 | 读会话 JSONL：`<store同级>/workspaces/<id>/`（pi 的 errorMessage 在里面） |
| 401 | NX_AS_TOKEN 环境变量 vs store 里的 token 不一致；auth status 看 source |
