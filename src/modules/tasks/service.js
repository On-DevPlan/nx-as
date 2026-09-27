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

// 调试面板用：把事件 JSONL 重建成 span 树。
// 返回 { spans, tree, rootIds }：
//   spans = Map<id, span>（带 text/attrs 由 span_open/text/data/close 累积得出）
//   tree  = Map<id, [childId, ...]> 父→子
//   rootIds = [id, ...]              顶层 span（无 parent 或 parentId 找不到）
export async function getTaskTimeline(id) {
  const store = await loadStore();
  if (!store.tasks.find((t) => t.id === id)) throw notFound(`任务不存在: ${id}`);
  const { listEvents } = await import('../../core/events.js');
  const events = await listEvents(id);

  const spans = new Map();
  const tree = new Map();
  const rootIds = [];

  // 先建空 span 占位（open 一定先到，但万一 close 先到——避免 spanId 找不到）
  for (const e of events) {
    if (e.type === 'span_open') {
      spans.set(e.spanId, {
        id: e.spanId,
        parentId: e.parentId,
        spanType: e.spanType,
        name: e.name,
        input: e.input,
        text: '',
        attrs: {},
        status: 'ok',
        output: null,
        startMs: e.ts,
        endMs: null,
      });
    }
  }

  for (const e of events) {
    const s = spans.get(e.spanId);
    switch (e.type) {
      case 'span_open':
        // 已建占位；建父子链
        if (e.parentId && spans.has(e.parentId)) {
          if (!tree.has(e.parentId)) tree.set(e.parentId, []);
          tree.get(e.parentId).push(e.spanId);
        } else {
          rootIds.push(e.spanId);
        }
        break;
      case 'span_text':
        if (s) s.text += e.delta || '';
        break;
      case 'span_data':
        if (s) s.attrs[e.key] = e.value;
        break;
      case 'span_close':
        if (s) {
          s.endMs = e.ts;
          s.status = e.status || 'ok';
          s.output = e.output ?? s.output;
        }
        break;
      // 其它事件类型（text / task_start / done / error）不在 timeline 视图里
      // 直接跳过——它们在 SSE 流里继续可用，旧前端不受影响
    }
  }

  return {
    taskId: id,
    spans: [...spans.values()].map((s) => ({
      ...s,
      // 不要把 input/output 整对象塞回去（tool input 可能很大）；让前端按需 GET 单 span
      input: undefined,
      output: s.output === null ? undefined : s.output,
    })),
    tree: Object.fromEntries(tree),
    rootIds,
    total: events.length,
  };
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
