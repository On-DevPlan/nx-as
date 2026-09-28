// pi 扩展生成器：把 store 里的 Bearer 配置物化成 PI_AGENT_DIR/extensions/ 下的扩展文件
// （原 runner.js 的 writeBearerExtension/bearerConfig，runner 退役后移到这里）
//
// 注意：不要把 bearer token export 成 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN，
// 否则 pi 内置 anthropic provider 会走 x-api-key 或 OAuth 路径，
// 而 MiniMax 这种 Anthropic 兼容代理只接受干净的 Authorization: Bearer
// （Bearer 扩展通过 authHeader:true 注入 Bearer 头）
import { join } from 'node:path';
import { PI_AGENT_DIR } from '../../core/paths.js';

// 从 store.settings 读 Bearer 配置（面板/CLI 可配），环境变量兜底；
// 直接把 token 写进生成的扩展文件（apiKey 字面量），避免依赖进程环境变量
export async function bearerConfig() {
  const { getRawSettings } = await import('../settings/service.js');
  const st = await getRawSettings();
  return {
    provider: st.bearerProvider || process.env.NXAS_BEARER_PROVIDER || 'MiniMax',
    baseUrl: st.bearerBaseUrl || process.env.NXAS_BEARER_BASE_URL || '',
    models: (st.bearerModels || process.env.NXAS_BEARER_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean),
    token: st.bearerToken || process.env.NXAS_BEARER_TOKEN || '',
  };
}

// 从 store 的 bearer 配置**生成**扩展文件（token 内联，不依赖进程环境变量）。
// 每次启动重写——配置改了重启即生效；返回是否写入了有效配置。
export async function writeBearerExtension() {
  const fsp = (await import('node:fs/promises')).default;
  const cfg = await bearerConfig();
  const target = join(PI_AGENT_DIR, 'extensions');
  await fsp.mkdir(target, { recursive: true });
  const file = join(target, 'nx-as-bearer-anthropic.ts');
  const meta = join(target, 'nx-as-bearer-anthropic.json');

  if (!cfg.token || !cfg.baseUrl || !cfg.models.length) {
    // 配置不完整 → 删除生成物（避免用到过期的 token）
    await fsp.rm(file, { force: true });
    await fsp.rm(meta, { force: true });
    return { active: false, config: cfg };
  }

  const json = JSON.stringify({ provider: cfg.provider, baseUrl: cfg.baseUrl, models: cfg.models });
  const src = `// 本文件由 nx-as 自动生成（每次 serve 重写）——改配置请用：
//   nx-as settings set --bearer-base-url ... --bearer-token ... --bearer-models ...
// 或面板「设置」页 / PATCH /api/settings
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const CFG = ${json};
const TOKEN = ${JSON.stringify(cfg.token)};
export default function (pi: ExtensionAPI) {
  if (!TOKEN) return;
  const models = CFG.models.map((id: string) => ({
    id, name: id, reasoning: false, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000, maxTokens: 8192,
  }));
  pi.registerProvider(CFG.provider, {
    baseUrl: CFG.baseUrl,
    apiKey: TOKEN,
    api: "anthropic-messages",
    authHeader: true,
    models,
  });
}
`;
  await fsp.writeFile(file, src, 'utf8');
  await fsp.writeFile(meta, JSON.stringify({ provider: cfg.provider, baseUrl: cfg.baseUrl, models: cfg.models }, null, 2), 'utf8');
  return { active: true, config: cfg };
}
