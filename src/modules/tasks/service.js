import { loadStore, mutateStore } from '../../core/store.js';
import { notFound, conflict, badInput } from '../../core/errors.js';
import { enqueue, runningCount, hasSubscribers } from './runner.js';
import { getSettings } from '../settings/service.js';

// 任务域业务：CRUD + 执行调度。不认识 argv，也不认识 HTTP

function findTask(store, id) {
  const t = store.tasks.find((x) => x.id === id);
  if (!t) throw notFound(`任务不存在: ${id}`);
  return t;
}

export async function listTasks({ status } = {}) {
  const store = await loadStore();
  const tasks = status ? store.tasks.filter((t) => t.status === status) : store.tasks;
  // 新的在前
  return [...tasks].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function getTask(id) {
  const store = await loadStore();
  const t = findTask(store, id);
  const live = t.status === 'running';
  return { ...t, streaming: live && hasSubscribers(id) };
}

export async function addTask({ promptId, input = '', model = '', run = undefined } = {}) {
  if (!promptId) throw badInput('缺少 promptId（提示词名，先 prompt list 查看）');
  const settings = await getSettings();
  // 默认创建即执行；显式 run:false 可只创建（先建后跑）
  const shouldRun = run === undefined ? settings.autoRun : Boolean(run);

  // 预检提示词存在（fail fast，不等到 run 时才报）
  const { getPrompt } = await import('../prompts/service.js');
  await getPrompt(promptId);

  const id = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const task = {
    id,
    promptId,
    input,
    model: model || '',
    status: shouldRun ? 'queued' : 'pending',
    result: '',
    error: '',
    createdAt: new Date().toISOString(),
    startedAt: '',
    finishedAt: '',
  };
  await mutateStore((s) => {
    s.tasks.push(task);
  });
  if (shouldRun) enqueue(id);
  return task;
}

export async function runTask(id) {
  const store = await loadStore();
  const t = findTask(store, id);
  if (t.status === 'running' || t.status === 'queued') {
    return { status: 'skipped', id, taskStatus: t.status, note: '任务已在执行队列中' };
  }
  if (t.status === 'done') {
    return { status: 'skipped', id, taskStatus: t.status, note: '任务已完成；如需重跑请重建任务' };
  }
  await mutateStore((s) => {
    const x = s.tasks.find((y) => y.id === id);
    x.status = 'queued';
    x.error = '';
  });
  enqueue(id);
  return { status: 'ok', id, taskStatus: 'queued' };
}

export async function removeTask(id) {
  const store = await loadStore();
  const t = findTask(store, id);
  if (t.status === 'running') {
    throw conflict(`任务执行中，等完成后再删: ${id}`);
  }
  await mutateStore((s) => {
    s.tasks = s.tasks.filter((x) => x.id !== id);
  });
  return { status: 'ok', removed: id };
}

export function queueStats() {
  return { running: runningCount() };
}
