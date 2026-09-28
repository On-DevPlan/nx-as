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
const { loadStore, saveStore, mutateStore, resetStoreCache } = await imp('src/core/store.js');

test('store: 首次读取返回空结构；原子写后能读回', async () => {
  resetStoreCache();
  const s = await loadStore();
  assert.equal(s.version, 1);
  assert.deepEqual(s.devices, []);
  await mutateStore((d) => {
    d.devices.push({ id: 'dev1', tokenHash: 'x', name: 'phone', createdAt: 1 });
  });
  resetStoreCache();
  const s2 = await loadStore();
  assert.equal(s2.devices.length, 1);
});

test('store: 事务抛错不落盘（structuredClone 隔离）', async () => {
  resetStoreCache();
  const before = (await loadStore()).devices.length;
  await assert.rejects(
    mutateStore(() => {
      throw new Error('boom');
    }),
  );
  resetStoreCache();
  assert.equal((await loadStore()).devices.length, before);
});
test('store: normalize 补默认字段，容忍旧 store 的多余字段（向前兼容）', async () => {
  resetStoreCache();
  await saveStore({ version: 1, settings: { bearerBaseUrl: 'https://x' }, devices: undefined });
  resetStoreCache();
  const s = await loadStore();
  assert.equal(s.settings.bearerBaseUrl, 'https://x');
  assert.equal(s.settings.bearerProvider, 'MiniMax', '缺省字段应补默认值');
  assert.deepEqual(s.devices, []);
});
