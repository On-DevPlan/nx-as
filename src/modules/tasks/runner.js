// pi 会话生命周期管理：并发限制、事件总线、SSE 订阅者
// pi 的 import 是重操作（首次加载模型目录），放模块级懒加载
import { join } from 'node:path';

// 把 pi 的 agent dir 隔离到 nx-as 自己的目录（pi-cwd 外）
// 让 pi 找 ~/.nx-as/pi-agent/{extensions,skills,AGENTS.md,auth.json,models.json}
// 受 PI_CODING_AGENT_DIR 环境变量控制——在进程启动时设一次即可
import { PI_AGENT_DIR } from '../../core/paths.js';
process.env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || PI_AGENT_DIR;

let piModule = null;
async function pi() {
  if (!piModule) {
    piModule = await import('@earendil-works/pi-coding-agent');
  }
  return piModule;
}

// 测试/smoke 钩子：注入假执行器替代真 pi 调用（不依赖模型密钥）
// 形如 async (task, emit) => result；emit.text(delta) 推文字增量
let executorOverride = null;
export function setExecutor(fn) {
  executorOverride = fn;
}

// ---------- 事件总线 ----------

const subscribers = new Map(); // taskId -> Set<{res, heartbeat}>
const ringBuffer = new Map(); // taskId -> [event]  断线重连补发用（最近 500 条）

function pushEvent(taskId, event) {
  let ring = ringBuffer.get(taskId);
  if (!ring) {
    ring = [];
    ringBuffer.set(taskId, ring);
  }
  ring.push(event);
  if (ring.length > 500) ring.shift();

  const subs = subscribers.get(taskId);
  if (!subs) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const sub of subs) {
    try {
      sub.res.write(payload);
    } catch {
      // 客户端断开，清理交给 req close
    }
  }
}

export function addSubscriber(taskId, res) {
  let subs = subscribers.get(taskId);
  if (!subs) {
    subs = new Set();
    subscribers.set(taskId, subs);
  }
  const sub = { res };
  subs.add(sub);

  // 补发历史事件
  const ring = ringBuffer.get(taskId) || [];
  res.write(`: replay ${ring.length} events\n`);
  for (const e of ring) res.write(`data: ${JSON.stringify(e)}\n\n`);

  // 任务已终态：replay 完立即结束，不挂心跳
  const last = ring[ring.length - 1];
  if (last && (last.type === 'done' || last.type === 'error')) {
    res.end();
    return;
  }

  // 心跳 15s 防中间层断连
  const hb = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  res.on('close', () => {
    clearInterval(hb);
    subs.delete(sub);
    if (!subs.size) subscribers.delete(taskId);
  });
}

export function hasSubscribers(taskId) {
  return Boolean(subscribers.get(taskId)?.size);
}

function closeTaskStream(taskId, finalEvent) {
  pushEvent(taskId, finalEvent);
  const subs = subscribers.get(taskId);
  if (subs) {
    for (const sub of subs) {
      try {
        sub.res.end();
      } catch {
        /* ignore */
      }
    }
    subscribers.delete(taskId);
  }
}

// ---------- 队列 + 并发限制 ----------

const queue = [];
let running = 0;

export function runningCount() {
  return running;
}

async function maxConcurrent() {
  // 直接查 store（避免依赖 settings service——同层互依由 lint 禁止）
  const { loadStore } = await import('../../core/store.js');
  const s = await loadStore();
  const n = Number(s.settings.maxConcurrent);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

export function enqueue(taskId) {
  queue.push(taskId);
  pump();
}

async function pump() {
  const cap = await maxConcurrent();
  while (running < cap && queue.length) {
    const taskId = queue.shift();
    running++;
    runOne(taskId)
      .catch((err) => {
        console.error(`[task ${taskId}] 执行异常:`, err.message);
      })
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function runOne(taskId) {
  const { loadStore, mutateStore, taskWorkspace } = await import('../../core/store.js');
  const { renderPrompt } = await import('../prompts/service.js');

  const store = await loadStore();
  const task = store.tasks.find((t) => t.id === taskId);
  if (!task) {
    closeTaskStream(taskId, { type: 'error', error: `任务不存在: ${taskId}` });
    return;
  }
  if (task.status === 'running') return; // 幂等

  await mutateStore((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    t.status = 'running';
    t.startedAt = new Date().toISOString();
  });
  pushEvent(taskId, { type: 'task_start', taskId });

  try {
    if (executorOverride || process.env.NX_AS_FAKE_EXECUTOR === '1') {
      // 测试路径：不碰 pi。NX_AS_FAKE_EXECUTOR 供 smoke 端到端使用
      const emit = {
        text: (delta) => pushEvent(taskId, { type: 'text', delta }),
      };
      const result =
        executorOverride
          ? await executorOverride(task, emit)
          : `echo: ${task.input}（fake executor）`;
      await finishTask(taskId, result);
      closeTaskStream(taskId, { type: 'done', result });
      return;
    }

    const rendered = await renderPrompt(task.promptId, task.input);
    const workspace = taskWorkspace(taskId);
    const fsp = (await import('node:fs/promises')).default;
    await fsp.mkdir(workspace, { recursive: true });

    // pi 的会话/auth/models 全部隔离在 nx-as 自己的目录（不碰用户的 ~/.pi/agent）
    const { PI_AGENT_DIR } = await import('../../core/paths.js');
    const sessionsDir = join(PI_AGENT_DIR, 'sessions');
    await fsp.mkdir(sessionsDir, { recursive: true });

    const { createAgentSession, SessionManager } = await pi();

    const sessionOpts = {
      cwd: workspace,
      // 显式指定会话目录：JSONL 落在 nx-as 目录内，不依赖 PI_CODING_AGENT_DIR
      sessionManager: SessionManager.create(workspace, sessionsDir),
    };
    if (task.model) sessionOpts.model = task.model;

    const { session } = await createAgentSession(sessionOpts);

    const unsub = session.subscribe((event) => {
      // 透传 App 关心的子集；完整原始事件已由 pi 落 JSONL
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        pushEvent(taskId, { type: 'text', delta: event.assistantMessageEvent.delta });
      } else if (event.type === 'message_start') {
        pushEvent(taskId, { type: 'message_start', role: event.message?.role });
      } else if (event.type === 'tool_execution_start') {
        pushEvent(taskId, { type: 'tool_start', tool: event.toolName, args: event.args });
      } else if (event.type === 'tool_execution_end') {
        pushEvent(taskId, { type: 'tool_end', tool: event.toolName });
      } else if (event.type === 'agent_end') {
        pushEvent(taskId, { type: 'agent_end' });
      }
    });

    try {
      await session.prompt(rendered);
      const result = session.getLastAssistantText() || '';
      // pi 对模型错误（403/超时等）不抛异常，而是产出 stopReason=error 的消息；
      // 检查最后一条 assistant 消息把错误上浮到任务状态
      const lastMsg = session.messages.filter((m) => m.role === 'assistant').pop();
      if (lastMsg?.stopReason === 'error') {
        throw new Error(lastMsg.errorMessage || '模型调用失败');
      }
      await finishTask(taskId, result);
      closeTaskStream(taskId, { type: 'done', result });
    } finally {
      unsub();
      session.dispose();
    }
  } catch (err) {
    await markTaskError(taskId, err.message);
    closeTaskStream(taskId, { type: 'error', error: err.message });
  }
}

async function finishTask(taskId, result) {
  const { mutateStore } = await import('../../core/store.js');
  await mutateStore((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    if (t) {
      t.status = 'done';
      t.result = result;
      t.finishedAt = new Date().toISOString();
    }
  });
}

async function markTaskError(taskId, message) {
  const { mutateStore } = await import('../../core/store.js');
  await mutateStore((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    if (t) {
      t.status = 'error';
      t.error = message;
      t.finishedAt = new Date().toISOString();
    }
  }).catch(() => {});
}
