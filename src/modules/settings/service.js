import { loadStore, mutateStore } from '../../core/store.js';
import { badInput } from '../../core/errors.js';

// 设置域：单例配置（settings.get / settings.set，不硬凑 CRUD）
export const SETTABLE = [
  'model',
  'maxConcurrent',
  'autoRun',
  // Anthropic 兼容代理（MiniMax 等）的 Bearer 配置
  'bearerProvider',
  'bearerBaseUrl',
  'bearerModels',
  'bearerToken',
];

// 返回给前端/CLI 时脱敏 token
export function maskSecrets(s) {
  const out = { ...s };
  if (out.bearerToken) out.bearerToken = out.bearerToken.slice(0, 8) + '****' + out.bearerToken.slice(-4);
  out.hasBearerToken = Boolean(s.bearerToken);
  return out;
}

// 内部用：拿原始设置（含真实 token，runner 用它生成扩展）
export async function getRawSettings() {
  const store = await loadStore();
  return { ...store.settings };
}

// 对外用：token 脱敏（面板/CLI 展示）
export async function getSettings() {
  const store = await loadStore();
  return maskSecrets(store.settings);
}

export async function updateSettings(patch = {}) {
  const keys = Object.keys(patch);
  if (!keys.length) throw badInput('没有要修改的设置项');
  const unknown = keys.filter((k) => !SETTABLE.includes(k));
  if (unknown.length) throw badInput(`未知设置项: ${unknown.join(', ')}（可设置: ${SETTABLE.join(', ')}）`);
  await mutateStore((s) => {
    for (const k of keys) s.settings[k] = patch[k];
  });
  // 配置变更后立刻重新生成 pi 扩展，下一个任务即生效
  const { writeBearerExtension } = await import('../tasks/runner.js');
  await writeBearerExtension().catch(() => {});
  return getSettings();
}
