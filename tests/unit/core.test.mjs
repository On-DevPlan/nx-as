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

test('prompts: 名称校验拒绝路径穿越', async () => {
  await assert.rejects(() => promptService.getPrompt('../etc'), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => promptService.getPrompt('a/b'), (e) => e.code === 'INVALID_INPUT');
});
