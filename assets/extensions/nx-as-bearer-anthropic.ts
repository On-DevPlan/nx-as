/**
 * nx-as-bearer-anthropic — 让 MiniMax 这类 Anthropic 兼容代理走 Bearer 头
 *
 * pi 内置 anthropic-messages 对非 sk-ant-oat 前缀 token 强制 x-api-key。
 * 但 ProviderConfig 支持 authHeader:true，自动加 Authorization: Bearer <apiKey>。
 *
 * 配置（环境变量）：
 *   NXAS_BEARER_BASE_URL  Anthropic 兼容端点（不含 /v1）
 *   NXAS_BEARER_TOKEN    token
 *   NXAS_BEARER_PROVIDER providerId，默认 'MiniMax'
 *   NXAS_BEARER_MODELS   逗号分隔的模型 ID，默认 'MiniMax-M3'
 *
 * 由 nx-as 装到 ~/.nx-as/pi-agent/extensions/，pi 启动时自动加载。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = process.env.NXAS_BEARER_PROVIDER || "MiniMax";
const BASE_URL = (process.env.NXAS_BEARER_BASE_URL || "https://api.minimaxi.com/anthropic").replace(/\/+$/, "");
// 用 $VAR 格式让 pi 通过环境变量解析（process.env 在创建时存在）；
// 用户的 NXAS_BEARER_TOKEN 会原样作为环境变量名传给 pi，pi 自动读 process.env
const TOKEN_ENV = "NXAS_BEARER_TOKEN";
const MODEL_IDS = (process.env.NXAS_BEARER_MODELS || "MiniMax-M3").split(",").map((s) => s.trim()).filter(Boolean);

export default function (pi: ExtensionAPI) {
  const token = process.env[TOKEN_ENV];
  if (!token) return;

  const models = MODEL_IDS.map((id) => ({
    id,
    name: id,
    provider: PROVIDER_ID, // pi registerProvider 时会覆盖确认
    baseUrl: BASE_URL,
    api: "anthropic-messages",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  }));

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: BASE_URL,
    apiKey: `$${TOKEN_ENV}`,
    api: "anthropic-messages",
    authHeader: true,
    models,
  });
}