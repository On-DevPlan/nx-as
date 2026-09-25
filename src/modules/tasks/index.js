import * as svc from './service.js';
import { addSubscriber } from './runner.js';
import { notFound } from '../../core/errors.js';

// task.events 在 HTTP 下是 SSE：action 标记 sse:true，api.js 把 res 交给 run
// CLI 下轮询打印事件直到任务结束

function streamToCli(taskId) {
  return new Promise((resolve, reject) => {
    let lastLen = 0;
    const timer = setInterval(async () => {
      try {
        const t = await svc.getTask(taskId);
        // 简化：CLI 端不做实时流，轮询终态；过程事件看 App/面板
        if (t.status === 'done') {
          clearInterval(timer);
          resolve({ status: 'done', result: t.result });
        } else if (t.status === 'error') {
          clearInterval(timer);
          resolve({ status: 'error', error: t.error });
        }
      } catch (e) {
        clearInterval(timer);
        reject(e);
      }
    }, 1000);
    // 首次立即打一次长度，后续增量打印结果文本
    const printer = setInterval(async () => {
      try {
        const t = await svc.getTask(taskId);
        if (t.result && t.result.length > lastLen) {
          process.stdout.write(t.result.slice(lastLen));
          lastLen = t.result.length;
        }
      } catch {
        /* ignore */
      }
    }, 500);
    timer.unref?.();
    setTimeout(() => clearInterval(printer), 0); // printer 在 resolve 前持续工作
  });
}

const actions = [
  {
    id: 'task.list',
    cli: ['task', 'list'],
    http: ['GET', '/api/tasks'],
    summary: '任务列表（新的在前；--status 过滤）',
    flags: { status: { type: 'string', enum: ['pending', 'queued', 'running', 'done', 'error'] } },
    run: (ctx) => svc.listTasks(ctx),
    render: (list) =>
      list.length
        ? list
            .map(
              (t) =>
                `${t.id}  ${t.status.padEnd(8)}  ${t.promptId.padEnd(16)}  ${String(t.input).slice(0, 24)}`,
            )
            .join('\n')
        : '(无任务)',
  },
  {
    id: 'task.get',
    cli: ['task', 'get'],
    http: ['GET', '/api/tasks/:id'],
    summary: '任务详情（含最终结果）',
    args: ['id'],
    run: (ctx) => svc.getTask(ctx.id),
    render: (t) =>
      [
        `id:      ${t.id}`,
        `状态:    ${t.status}${t.streaming ? ' (有订阅者在线)' : ''}`,
        `提示词:  ${t.promptId}`,
        `输入:    ${t.input}`,
        t.error ? `错误:    ${t.error}` : '',
        t.result ? `结果:\n${t.result}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
  },
  {
    id: 'task.add',
    cli: ['task', 'add'],
    http: ['POST', '/api/tasks'],
    summary: '创建任务（默认创建即执行；--no-run 只创建）',
    flags: {
      input: { type: 'string' },
      model: { type: 'string' },
      'no-run': { type: 'boolean' },
    },
    args: ['promptId'],
    run: (ctx) => svc.addTask({ promptId: ctx.promptId, input: ctx.input || '', model: ctx.model || '', run: ctx['no-run'] ? false : undefined }),
    render: (t) => `${t.id}  ${t.status}${t.status === 'queued' ? '（执行中，task get 看进度）' : ''}`,
  },
  {
    id: 'task.update',
    cli: ['task', 'update'],
    http: ['PATCH', '/api/tasks/:id'],
    summary: '更新任务输入/模型（仅 pending 可改）',
    args: ['id'],
    flags: { input: { type: 'string' }, model: { type: 'string' } },
    run: async (ctx) => {
      const { loadStore, mutateStore } = await import('../../core/store.js');
      const store = await loadStore();
      const t = store.tasks.find((x) => x.id === ctx.id);
      if (t && t.status !== 'pending') {
        return { status: 'blocked', id: ctx.id, note: `状态为 ${t.status}，只有 pending 任务可改` };
      }
      await mutateStore((s) => {
        const x = s.tasks.find((y) => y.id === ctx.id);
        if (ctx.input !== undefined) x.input = ctx.input;
        if (ctx.model !== undefined) x.model = ctx.model;
      });
      return { status: 'ok', id: ctx.id };
    },
    render: (r) => (r.status === 'ok' ? `已更新: ${r.id}` : `被阻止: ${r.note}`),
  },
  {
    id: 'task.remove',
    cli: ['task', 'remove'],
    http: ['DELETE', '/api/tasks/:id'],
    summary: '删除任务（running 中拒绝）',
    args: ['id'],
    run: (ctx) => svc.removeTask(ctx.id),
    render: (r) => `已删除: ${r.removed}`,
  },
  {
    id: 'task.run',
    cli: ['task', 'run'],
    http: ['POST', '/api/tasks/:id/run'],
    summary: '执行任务（queued/running 幂等跳过）',
    args: ['id'],
    run: (ctx) => svc.runTask(ctx.id),
    render: (r) => (r.status === 'ok' ? `已入队: ${r.id}` : `跳过: ${r.note}`),
  },
  {
    id: 'task.events',
    cli: ['task', 'events'],
    http: ['GET', '/api/tasks/:id/events'],
    summary: '事件流（HTTP=SSE 实时推；CLI=轮询至终态）',
    args: ['id'],
    sse: true,
    run: async (ctx, meta) => {
      if (meta.transport === 'http') {
        // SSE 响应
        const { loadStore } = await import('../../core/store.js');
        const store = await loadStore();
        if (!store.tasks.find((t) => t.id === ctx.id)) throw notFound(`任务不存在: ${ctx.id}`);
        meta.res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        meta.res.write(': connected\n\n');
        addSubscriber(ctx.id, meta.res);
        return undefined; // 响应由事件总线接管
      }
      // CLI：轮询到终态
      return streamToCli(ctx.id);
    },
    render: (r) => (r ? (r.status === 'done' ? r.result : `错误: ${r.error}`) : ''),
  },
];

export default { id: 'tasks', resource: 'task', view: true, actions };
