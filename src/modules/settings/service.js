import { loadStore, mutateStore } from '../../core/store.js';
import { badInput } from '../../core/errors.js';

// 设置域：单例配置（settings.get / settings.set，不硬凑 CRUD）
export const SETTABLE = ['model', 'maxConcurrent', 'autoRun'];

export async function getSettings() {
  const store = await loadStore();
  return { ...store.settings };
}

export async function updateSettings(patch = {}) {
  const keys = Object.keys(patch);
  if (!keys.length) throw badInput('没有要修改的设置项');
  const unknown = keys.filter((k) => !SETTABLE.includes(k));
  if (unknown.length) throw badInput(`未知设置项: ${unknown.join(', ')}（可设置: ${SETTABLE.join(', ')}）`);
  await mutateStore((s) => {
    for (const k of keys) s.settings[k] = patch[k];
  });
  return getSettings();
}
