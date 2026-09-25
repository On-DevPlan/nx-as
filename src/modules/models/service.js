import { loadStore, mutateStore } from '../../core/store.js';
import { fsp } from '../../core/fs.js';
import { PI_AGENT_DIR } from '../../core/paths.js';
import { join } from 'node:path';

// 模型域：非 resource（查询类）。
// pi 的模型目录（内置 30+ provider）+ models.json 自定义端点 + 默认模型设置

export async function listModels() {
  const builtin = await builtinCatalog();
  const custom = await customEndpoints();
  return { builtin, custom };
}

// pi-ai 的模型目录：直接读它导出的目录数据，避免硬编码
async function builtinCatalog() {
  try {
    const { typeModels } = await import('@earendil-works/pi-ai');
    // pi-ai 导出 provider → models 映射
    const out = [];
    for (const [providerId, info] of Object.entries(typeModels || {})) {
      out.push({
        provider: providerId,
        name: info.name || providerId,
        models: Object.keys(info.models || {}).slice(0, 50),
        envVar: info.apiKeyEnvVar || '',
      });
    }
    return out;
  } catch {
    // pi-ai 未安装或结构变化：给出最小可用信息
    return [
      { provider: 'anthropic', name: 'Anthropic', models: [], envVar: 'ANTHROPIC_API_KEY' },
      { provider: 'openai', name: 'OpenAI', models: [], envVar: 'OPENAI_API_KEY' },
      { provider: 'deepseek', name: 'DeepSeek', models: [], envVar: 'DEEPSEEK_API_KEY' },
      { provider: 'openrouter', name: 'OpenRouter', models: [], envVar: 'OPENROUTER_API_KEY' },
    ];
  }
}

// models.json 自定义端点（OpenAI 兼容地址 / Ollama / vLLM 等）
async function modelsJsonPath() {
  return join(PI_AGENT_DIR, 'models.json');
}

export async function customEndpoints() {
  try {
    const raw = await fsp.readFile(await modelsJsonPath(), 'utf8');
    const data = JSON.parse(raw);
    return data.providers || {};
  } catch {
    return {};
  }
}

export async function setCustomEndpoint({ provider, baseUrl, apiKeyEnv = '', models = [] }) {
  if (!provider || !baseUrl) {
    const err = new Error('缺少 provider 或 baseUrl');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  await fsp.mkdir(PI_AGENT_DIR, { recursive: true });
  const data = { providers: await customEndpoints() };
  data.providers[provider] = {
    type: 'openai-completions',
    baseUrl,
    apiKey: apiKeyEnv ? `$${apiKeyEnv}` : 'dummy-key',
    ...(models.length ? { models: Object.fromEntries(models.map((m) => [m, { id: m }])) } : {}),
  };
  await fsp.writeFile(await modelsJsonPath(), JSON.stringify(data, null, 2), 'utf8');
  return { status: 'ok', provider, file: await modelsJsonPath() };
}

export async function removeCustomEndpoint({ provider }) {
  const data = { providers: await customEndpoints() };
  if (!data.providers[provider]) {
    const err = new Error(`自定义端点不存在: ${provider}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  delete data.providers[provider];
  await fsp.writeFile(await modelsJsonPath(), JSON.stringify(data, null, 2), 'utf8');
  return { status: 'ok', removed: provider };
}

export async function currentModel() {
  const store = await loadStore();
  return { model: store.settings.model || '(pi 默认)' };
}

export async function setCurrentModel({ model = '' }) {
  await mutateStore((s) => {
    s.settings.model = model;
  });
  return { model: model || '(pi 默认)' };
}
