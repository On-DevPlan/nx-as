# Changelog

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
