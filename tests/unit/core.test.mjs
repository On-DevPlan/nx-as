// 纯逻辑单测：spec 校验/强转/路由、store 原子写与事务、prompts 模板渲染
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

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
// 临时目录隔离（固定路径会在二轮运行时带着上一轮的数据，首轮假设被打破）
process.env.NX_AS_STORE = join(await mkdtemp(join(tmpdir(), 'core-unit-')), 'store.json');
const { loadStore, saveStore, mutateStore, resetStoreCache } = await imp('src/core/store.js');

test('store: 首次读取返回空结构；原子写后能读回', async () => {
  resetStoreCache();
  const s = await loadStore();
  assert.equal(s.version, 1);
  assert.deepEqual(s.oidc.allowedEmails, []);
  assert.deepEqual(s.machineSecret, '');
  await mutateStore((d) => {
    d.oidc.allowedEmails.push('a@b.c');
    d.machineSecret = 'm1';
  });
  resetStoreCache();
  const s2 = await loadStore();
  assert.deepEqual(s2.oidc.allowedEmails, ['a@b.c']);
  assert.equal(s2.machineSecret, 'm1');
});

test('store: 事务抛错不落盘（structuredClone 隔离）', async () => {
  resetStoreCache();
  const before = (await loadStore()).machineSecret;
  await assert.rejects(
    mutateStore(() => {
      throw new Error('boom');
    }),
  );
  resetStoreCache();
  assert.equal((await loadStore()).machineSecret, before);
});
test('store: 不同路径的缓存互不串（缓存身份含路径）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-path-'));
  const a = join(dir, 'a.json');
  const b = join(dir, 'b.json');
  await saveStore({ version: 1, machineSecret: 'AAA' }, a);
  await saveStore({ version: 1, machineSecret: 'BBB' }, b);
  // 不显式 reset：验证按路径区分缓存，A 不会返回 B 的内容
  assert.equal((await loadStore(a)).machineSecret, 'AAA');
  assert.equal((await loadStore(b)).machineSecret, 'BBB');
  assert.equal((await loadStore(a)).machineSecret, 'AAA', '再读 A 仍正确');
});

test('store: 损坏/不可读必须抛错，不得静默当空（防密钥与配置被重置）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-corrupt-'));
  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{ corrupted json !!!', 'utf8');
  // 旧行为：任何读取异常都返回空结构 → mutateStore 会把配置「重置」
  // 新行为：只有 ENOENT（首次运行）走空结构，其余一律抛错
  await assert.rejects(() => loadStore(bad), (e) => e.code === 'INTERNAL' && /store 读取失败/.test(e.message));
  // ENOENT 仍然返回空结构（首次运行语义不变）
  const fresh = await loadStore(join(dir, 'missing.json'));
  assert.deepEqual(fresh.oidc.allowedEmails, []);
});

// ---------- audit ----------
test('audit: append/list roundtrip + limit（坏行跳过）', async () => {
  const { appendAudit, listAudit } = await imp('src/core/audit.js');
  // auditPath 与 store 同目录（测试 store 在临时目录 → 审计落在同一临时目录，不碰真实 ~/.nx-as）
  await appendAudit({ action: 'device.issue', detail: { deviceId: 'dev_a' } });
  await appendAudit({ action: 'nginx.file.put', detail: { name: 'x.conf' }, ts: Date.now() + 5 });
  await appendAudit({ action: 'gw.login', deviceId: 'dev_a' });
  const all = await listAudit({ limit: 200 });
  assert.ok(all.length >= 3);
  assert.ok(all.some((e) => e.action === 'gw.login' && e.deviceId === 'dev_a'), '顶层字段平铺');
  const two = await listAudit({ limit: 2 });
  assert.equal(two.length, 2, 'limit 截断');
});

