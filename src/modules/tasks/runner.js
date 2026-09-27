// pi 会话生命周期管理：并发限制、事件总线、SSE 订阅者
// pi 的 import 是重操作（首次加载模型目录），放模块级懒加载
import { join } from 'node:path';

// pi 的 agent dir 隔离到 nx-as 自己的目录（pi-cwd 外）
// 让 pi 找 ~/.nx-as/pi-agent/{extensions,skills,AGENTS.md,auth.json,models.json}
// 受 PI_CODING_AGENT_DIR 环境变量控制——在进程启动时设一次即可
import { PI_AGENT_DIR } from '../../core/paths.js';
process.env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || PI_AGENT_DIR;

// 注意：不要把 bearer token export 成 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN，
// 否则 pi 内置 anthropic provider 会走 x-api-key 或 OAuth 路径，
// 而 MiniMax 这种 Anthropic 兼容代理只接受干净的 Authorization: Bearer
// （nx-as 自带 Bearer 扩展通过 authHeader:true 注入 Bearer 头）

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

// 同步执行一次（fire-and-forget 不阻塞 import）
writeBearerExtension().catch((e) => console.error('[nx-as] 生成 Bearer 扩展失败:', e.message));

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

// 内部 helper：仅 SSE 推送，不落盘（用于补发历史等）
function emit(taskId, event) {
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

// 每个 task 一条落盘队列：保证落盘顺序与 emit 一致；
// 失败也不阻塞 SSE（错误打日志，调试面板最多缺几条事件）
const flushQueues = new Map(); // taskId -> Promise

function pushEvent(taskId, event) {
  emit(taskId, event); // 同步推 SSE
  const prev = flushQueues.get(taskId) || Promise.resolve();
  const next = prev.then(async () => {
    try {
      const { appendEvent } = await import('../../core/events.js');
      await appendEvent(taskId, event);
    } catch (e) {
      console.error(`[task ${taskId}] 事件落盘失败:`, e.message);
    }
  }).catch(() => {});
  flushQueues.set(taskId, next);
  return next;
}

// 任务结束时等落盘队列排空（避免最后几条事件丢失）
export async function awaitFlush(taskId) {
  const q = flushQueues.get(taskId);
  if (q) await q;
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

// 默认模型：task.model 优先，其次 store.settings.model，最后回落到 Bearer 代理的第一个模型。
//
// 最后这条回落很重要：不指定任何模型时 pi 会按**进程环境变量**挑 provider。
// 如果用户在自己的 shell 里（比如跑 Claude Code 的终端）export 了 ANTHROPIC_BASE_URL /
// ANTHROPIC_API_KEY，pi 会挑中 anthropic 并带着那套凭据去打代理端点，结果是难懂的 403。
// nx-as 既然配了 Bearer 代理，用户的本意就是用它。
export async function defaultModel() {
  const { loadStore } = await import('../../core/store.js');
  const s = await loadStore();
  const explicit = (s.settings.model || '').trim();
  if (explicit) return explicit;
  const cfg = await bearerConfig();
  return cfg.models.length ? `${cfg.provider}/${cfg.models[0]}` : '';
}

// "Provider/ModelId" 字符串 → pi 的 Model 对象。
// createAgentSession 不解析字符串：必须先建临时 session 触发扩展加载，
// 从 modelRuntime 的目录里按 provider/id 找到 Model 对象再传。
async function resolveModel(createAgentSession, sessionOpts, wanted) {
  const tmp = await createAgentSession(sessionOpts);
  try {
    return tmp.session?.modelRuntime?.snapshot?.all?.find((m) => `${m.provider}/${m.id}` === wanted) || null;
  } finally {
    tmp.session?.dispose?.();
  }
}

// 报错时列出可用模型。pi 的目录含 42 个 provider、近 1500 个内置模型，
// 全列出来没人看得完。只列 nx-as 自己知道配了凭据的（Bearer 代理 + 已设的默认模型）——
// 不去探测用户自己的 ~/.pi 凭据：那要把 42 个 provider 各起一次 pi auth 子进程，太慢。
async function availableModelLines() {
  const cfg = await bearerConfig();
  const lines = [];
  if (cfg.models.length) lines.push(`  ${cfg.provider}: ${cfg.models.join(', ')}`);
  const dm = await defaultModel();
  if (dm && !cfg.models.some((m) => `${cfg.provider}/${m}` === dm)) lines.push(`  默认模型（settings.model）: ${dm}`);
  return lines.length ? lines.join('\n') : '  (无——用 settings set 配 Bearer 代理，或 pi auth 登录某个 provider)';
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
      // 测试路径：不碰 pi。NX_AS_FAKE_EXECUTOR 供 smoke 端到端使用。
      // 与真路径共享同一套事件管道（pushEvent → JSONL + SSE），并模拟完整
      // pi 事件序列（turn → llm(thinking+text) → tool → done），
      // 让 timeline / 对话页 / 调试视图在无密钥环境下也能端到端验证。
      const { createNormalizer } = await import('./normalize.js');
      const normalizer = createNormalizer(taskId, (e) => pushEvent(taskId, e));

      normalizer.ingest({ type: 'turn_start' });
      normalizer.ingest({ type: 'message_start', message: { role: 'assistant' } });
      normalizer.ingest({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '（fake）先想想…' } });
      const fakeText = `echo: ${task.input}（fake executor）`;
      normalizer.ingest({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: fakeText } });
      normalizer.ingest({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
      normalizer.ingest({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'echo ok' } });
      normalizer.ingest({ type: 'tool_execution_end', toolName: 'bash', result: { output: 'ok\n', isError: false } });
      normalizer.ingest({ type: 'turn_end' });
      normalizer.finalize();
      await awaitFlush(taskId);

      // 旧客户端兼容：text 事件仍单独推
      await finishTask(taskId, fakeText);
      closeTaskStream(taskId, { type: 'done', result: fakeText });
      return;
    }

    const rendered = await renderPrompt(task.promptId, task.input);
    const workspace = taskWorkspace(taskId);
    const fsp = (await import('node:fs/promises')).default;
    await fsp.mkdir(workspace, { recursive: true });

    // 每次跑任务前按当前 store 配置重生成 Bearer 扩展（改配置后下一个任务即生效）
    await writeBearerExtension().catch(() => {});

    // pi 的会话/auth/models 全部隔离在 nx-as 自己的目录（不碰用户的 ~/.pi/agent）
    const { PI_AGENT_DIR } = await import('../../core/paths.js');
    const sessionsDir = join(PI_AGENT_DIR, 'sessions');
    await fsp.mkdir(sessionsDir, { recursive: true });

    const { createAgentSession, SessionManager } = await pi();

    // 会话文件落 sessions/<cwd 编码>/ 子目录（pi CLI 标准布局，见 pi session-manager.ts:
    //   `--${cwd.replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--` ）。
    // 对齐后 pi-web / pi -r 等标准工具能直接发现 nx-as 任务的会话。
    const cwdEncoded = `--${workspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const taskSessionsDir = join(sessionsDir, cwdEncoded);
    await fsp.mkdir(taskSessionsDir, { recursive: true });

    const sessionOpts = {
      cwd: workspace,
      // 显式指定会话目录：JSONL 落在 nx-as 目录内，不依赖 PI_CODING_AGENT_DIR
      sessionManager: SessionManager.create(workspace, taskSessionsDir),
    };

    // 模型选择：task.model 优先，为空则回落到 settings.model（面板「默认模型」）。
    // 两者都是 "Provider/ModelId" 字符串，如 "MiniMax/MiniMax-M3"。
    // 空仍为空 → 交给 pi 自己的默认 provider。
    const wantedModel = task.model || (await defaultModel());
    if (wantedModel) {
      const resolvedModel = await resolveModel(createAgentSession, sessionOpts, wantedModel);
      if (resolvedModel) {
        sessionOpts.model = resolvedModel;
      } else {
        // 不回落到 pi 默认 provider：那样会拿别的凭据去请求，得到难懂的 403/401。
        // 直接把可用的模型列出来，让调用方改 task.model 或 settings.model。
        throw new Error(
          `模型未注册: ${wantedModel}\n本机已配置凭据的模型:\n${await availableModelLines()}` +
            `\n用 task add --model <Provider/ModelId> 指定，或 settings set --model 设默认`,
        );
      }
    }

    const { session } = await createAgentSession(sessionOpts);

    // 用归一器把 pi 的内部事件转为 span 树事件（事件落 JSONL 后供调试面板使用）
    const { createNormalizer } = await import('./normalize.js');
    const normalizer = createNormalizer(taskId, (e) => pushEvent(taskId, e));

    const unsub = session.subscribe((event) => {
      // 兼容旧客户端：text_delta 同时推一条 type:'text'，旧前端不受影响
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        pushEvent(taskId, { type: 'text', delta: event.assistantMessageEvent.delta });
      }
      // 完整事件归一（用于 trace 面板）
      normalizer.ingest(event);
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
      normalizer.finalize({ error: null });
      await awaitFlush(taskId);
      await finishTask(taskId, result);
      closeTaskStream(taskId, { type: 'done', result });
    } catch (err) {
      normalizer.finalize({ error: err.message });
      await awaitFlush(taskId);
      throw err;
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
