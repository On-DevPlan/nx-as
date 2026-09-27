// 纯逻辑单测：spec 校验/强转/路由、store 原子写与事务、prompts 模板渲染
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

// ---------- spec ----------
const { applySpec, compileRoute, sortRoutes, usageOf } = await imp('src/runtime/spec.js');

test('applySpec: required 缺失报 INVALID_INPUT 且带用法串', () => {
  const action = { cli: ['x'], args: ['id'], flags: {}, run: () => {} };
  assert.throws(() => applySpec(action, {}), (e) => e.code === 'INVALID_INPUT' && e.message.includes('用法:'));
});

test('applySpec: number 强转 / enum 校验 / array 拆分', () => {
  const action = {
    cli: ['x'],
    flags: {
      depth: { type: 'number' },
      side: { type: 'string', enum: ['a', 'b'] },
      names: { type: 'array' },
    },
  };
  const ctx = applySpec(action, { depth: '3', side: 'a', names: 'x, y,z' });
  assert.equal(ctx.depth, 3);
  assert.equal(ctx.side, 'a');
  assert.deepEqual(ctx.names, ['x', 'y', 'z']);
  assert.throws(() => applySpec(action, { side: 'zzz' }), (e) => e.code === 'INVALID_INPUT');
});

test('applySpec: 读命令 flag 不注入 default（「没传」可达）', () => {
  const action = { cli: ['x'], flags: { scope: { type: 'string' } } };
  const ctx = applySpec(action, {});
  assert.equal(ctx.scope, undefined, 'default 被无条件注入会消灭「没传」分支');
});

test('compileRoute + 字面量段优先排序', () => {
  const routes = sortRoutes([
    { method: 'GET', path: '/api/t/:id', ...compileRoute(['GET', '/api/t/:id']) },
    { method: 'GET', path: '/api/t/special', ...compileRoute(['GET', '/api/t/special']) },
  ]);
  assert.equal(routes[0].path, '/api/t/special', '字面量必须排在参数前');
  const param = routes.find((r) => r.path === '/api/t/:id');
  const m = param.regex.exec('/api/t/abc');
  assert.equal(m[1], 'abc');
});

test('usageOf: enum 展开进占位符', () => {
  const u = usageOf({ cli: ['x'], flags: { s: { type: 'string', enum: ['a', 'b'] } } });
  assert.ok(u.includes('--s <a|b>'), u);
});

// ---------- store ----------
process.env.NX_AS_STORE = join(ROOT, '.tool', 'test-store', 'unit-store.json');
const { loadStore, saveStore, mutateStore, resetStoreCache, taskWorkspace } = await imp('src/core/store.js');

test('store: 首次读取返回空结构；原子写后能读回', async () => {
  resetStoreCache();
  const s = await loadStore();
  assert.equal(s.version, 1);
  assert.deepEqual(s.tasks, []);
  await mutateStore((d) => {
    d.tasks.push({ id: 't1', status: 'pending' });
  });
  resetStoreCache();
  const s2 = await loadStore();
  assert.equal(s2.tasks.length, 1);
});

test('store: 事务抛错不落盘（structuredClone 隔离）', async () => {
  resetStoreCache();
  const before = (await loadStore()).tasks.length;
  await assert.rejects(
    mutateStore(() => {
      throw new Error('boom');
    }),
  );
  resetStoreCache();
  assert.equal((await loadStore()).tasks.length, before);
});

test('store: normalize 补默认字段（向前兼容）', async () => {
  resetStoreCache();
  await saveStore({ version: 1, settings: { model: 'm1' }, tasks: undefined });
  resetStoreCache();
  const s = await loadStore();
  assert.equal(s.settings.model, 'm1');
  assert.equal(s.settings.maxConcurrent, 2, '缺省字段应补默认值');
  assert.deepEqual(s.tasks, []);
});

test('taskWorkspace 在 store 同级的 workspaces 下', () => {
  const w = taskWorkspace('t_abc');
  assert.ok(w.replace(/\\/g, '/').endsWith('workspaces/t_abc'), w);
});

test('runner.defaultModel：settings.model 优先，空则回落 Bearer 代理', async () => {
  const { defaultModel } = await imp('src/modules/tasks/runner.js');

  // 1) settings.model 有值 → 用它
  await saveStore({ version: 1, settings: { model: 'MiniMax/MiniMax-M3' } });
  resetStoreCache();
  assert.equal(await defaultModel(), 'MiniMax/MiniMax-M3');

  // 2) settings.model 空但配了 Bearer → 用 Bearer 的第一个模型。
  //    不能返回空串：那样 pi 会按进程环境变量挑 provider，用户 shell 里若有
  //    ANTHROPIC_BASE_URL（如跑 Claude Code 的终端）就会打错端点，得到难懂的 403。
  await saveStore({
    version: 1,
    settings: { model: '', bearerProvider: 'MiniMax', bearerBaseUrl: 'https://example.test/anthropic', bearerModels: 'MiniMax-M3,MiniMax-M2' },
  });
  resetStoreCache();
  assert.equal(await defaultModel(), 'MiniMax/MiniMax-M3', 'Bearer 已配 → 回落它的首个模型，不交给 pi 猜');

  // 3) 都没配 → 空串（此时只能交给 pi 默认 provider）
  await saveStore({ version: 1, settings: { model: '', bearerBaseUrl: '', bearerModels: '' } });
  resetStoreCache();
  assert.equal(await defaultModel(), '');
});

// ---------- events JSONL ----------
test('events: append/list/remove，taskId 校验', async () => {
  const { appendEvent, listEvents, removeEvents } = await imp('src/core/events.js');
  const tid = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // 1) 空时 list → 空数组
  assert.deepEqual(await listEvents(tid), []);

  // 2) append 多条，list 按时间顺序返回
  await appendEvent(tid, { type: 'task_start' });
  await appendEvent(tid, { type: 'span_open', spanId: 's1', name: 'turn_1', spanType: 'turn' });
  await appendEvent(tid, { type: 'text', spanId: 's1', delta: 'hi' });
  await appendEvent(tid, { type: 'span_close', spanId: 's1' });

  const all = await listEvents(tid);
  assert.equal(all.length, 4, '4 条事件都被存下');
  assert.equal(all[0].type, 'task_start');
  assert.equal(all[1].type, 'span_open');
  assert.equal(all[1].spanType, 'turn', 'span 的子类型独立存为 spanType，不与事件 type 冲突');
  assert.equal(all[3].type, 'span_close');
  for (const e of all) assert.equal(typeof e.ts, 'number', '每条带 ts 时间戳');

  // 3) 非法 taskId 拒绝
  await assert.rejects(() => appendEvent('../etc', {}), /非法 taskId/);
  await assert.rejects(() => appendEvent('not_start_with_t', {}), /非法 taskId/);

  // 4) removeEvents 后再 list → 空
  await removeEvents(tid);
  assert.deepEqual(await listEvents(tid), []);

  // 5) removeEvents 对不存在的不抛错
  await removeEvents(tid);
});

// ---------- normalize（pi 事件 → span 树） ----------
test('normalize: turn_start/message_update/tool call → span 树开/续/关', async () => {
  const { createNormalizer } = await imp('src/modules/tasks/normalize.js');
  const out = [];
  const n = createNormalizer('t_test', (e) => out.push(e));

  n.ingest({ type: 'turn_start' });
  n.ingest({ type: 'message_start', message: { role: 'assistant' } });
  n.ingest({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } });
  n.ingest({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '先思考' } });
  n.ingest({ type: 'agent_end' });
  n.ingest({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'echo hi' } });
  n.ingest({ type: 'tool_execution_end', toolName: 'bash', result: { output: 'hi\n' } });
  n.ingest({ type: 'turn_end' });
  n.finalize();

  // 期望事件序列（去掉 ts 字段后逐项断言）：
  // 1. turn_start → span_open turn-1
  // 2. message_start(assistant) → span_open llm-1(parentId=turn-1)
  // 3. text_delta → span_text 给 llm-1
  // 4. thinking_delta → span_data 给 llm-1
  // 5. agent_end → 关 llm-1
  // 6. tool_execution_start → span_open tool-1(parentId=turn-1)
  // 7. tool_execution_end → 关 tool-1
  // 8. turn_end → 关 turn-1
  // 9. finalize → 已经空栈，无事件
  const strip = (e) => { const { ts: _ts, ...rest } = e; return rest; };
  const seq = out.map(strip);

  assert.equal(seq[0].type, 'span_open');
  assert.equal(seq[0].spanType, 'turn');

  assert.equal(seq[1].type, 'span_open');
  assert.equal(seq[1].spanType, 'llm');
  assert.equal(seq[1].parentId, seq[0].spanId, 'llm 的父 span 是 turn');

  assert.equal(seq[2].type, 'span_text');
  assert.equal(seq[2].spanId, seq[1].spanId, 'text 归给当前 llm');
  assert.equal(seq[2].delta, '你好');

  assert.equal(seq[3].type, 'span_data');
  assert.equal(seq[3].key, 'thinking');
  assert.equal(seq[3].spanId, seq[1].spanId);

  assert.equal(seq[4].type, 'span_close');
  assert.equal(seq[4].spanId, seq[1].spanId, 'agent_end 关掉 llm');

  assert.equal(seq[5].type, 'span_open');
  assert.equal(seq[5].spanType, 'tool');
  assert.equal(seq[5].name, 'bash');
  assert.equal(seq[5].parentId, seq[0].spanId, 'tool 落到 turn 下');

  assert.equal(seq[6].type, 'span_close');
  assert.equal(seq[6].spanId, seq[5].spanId);
  assert.equal(seq[6].status, 'ok');

  assert.equal(seq[7].type, 'span_close');
  assert.equal(seq[7].spanId, seq[0].spanId);

  assert.equal(seq.length, 8, 'finalize 时栈已空，不再产生事件');
});

test('normalize: 异常 finalize 把残留 span 都标 error', async () => {
  const { createNormalizer } = await imp('src/modules/tasks/normalize.js');
  const out = [];
  const n = createNormalizer('t_test', (e) => out.push(e));
  n.ingest({ type: 'turn_start' });
  n.ingest({ type: 'message_start', message: { role: 'assistant' } });
  n.finalize({ error: 'boom' });

  // 应该关两个 span（turn + llm），都标 error
  const closes = out.filter((e) => e.type === 'span_close');
  assert.equal(closes.length, 2);
  for (const c of closes) assert.equal(c.status, 'error');
});

// ---------- prompts ----------
const promptService = await imp('src/modules/prompts/service.js');

test('prompts: add/get/update/remove 与模板渲染', async () => {
  const name = 'zz-unit-' + Date.now().toString(36);
  await promptService.addPrompt({ name, content: 'hello $input', description: 'd1' });
  const p = await promptService.getPrompt(name);
  assert.equal(p.description, 'd1');
  assert.equal(await promptService.renderPrompt(name, 'world'), 'hello world');
  // 默认值语法
  await promptService.updatePrompt({ name, content: 'hi ${input:-fallback}' });
  assert.equal(await promptService.renderPrompt(name, ''), 'hi fallback');
  assert.equal(await promptService.renderPrompt(name, 'X'), 'hi X');
  const upd = await promptService.updatePrompt({ name, description: 'd2' });
  assert.equal(upd.description, 'd2');
  assert.equal(upd.content, 'hi ${input:-fallback}', 'PATCH 语义：没传 content 保持原值');
  await promptService.removePrompt(name);
  await assert.rejects(() => promptService.getPrompt(name), (e) => e.code === 'NOT_FOUND');
});

test('prompts: 输入含 $& / $1 不被当作替换模式展开', async () => {
  const name = 'zz-unit-repl-' + Date.now().toString(36);
  await promptService.addPrompt({ name, content: '处理 $input' });
  // $& / $` / $' 在替换串里有特殊含义（$& = 整个匹配），曾经会把用户输入吞成 "$input"。
  // 用户输入常含这类字符：shell 片段、sed 's/a/$&/'、正则断言。
  assert.equal(await promptService.renderPrompt(name, '包含 $& 的输入'), '处理 包含 $& 的输入');
  assert.equal(await promptService.renderPrompt(name, 'a$1b'), '处理 a$1b');
  assert.equal(await promptService.renderPrompt(name, '价格 $100'), '处理 价格 $100');
  assert.equal(await promptService.renderPrompt(name, "sed 's/a/\$&/'"), "处理 sed 's/a/\$&/'");

  // 同一占位符出现多次 + 默认值语法混用，input 里的 $& 仍要原样保留
  await promptService.updatePrompt({ name, content: 'A $input B ${input:-dflt} C $input' });
  assert.equal(await promptService.renderPrompt(name, '$&'), 'A $& B $& C $&');
  // 不传 input 时走默认值分支（默认值来自模板，同样不能被展开）
  assert.equal(await promptService.renderPrompt(name, ''), 'A  B dflt C ');

  await promptService.removePrompt(name);
});

test('prompts: 名称校验拒绝路径穿越', async () => {
  await assert.rejects(() => promptService.getPrompt('../etc'), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => promptService.getPrompt('a/b'), (e) => e.code === 'INVALID_INPUT');
});
