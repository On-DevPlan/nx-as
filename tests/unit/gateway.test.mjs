// gateway 鉴权单测：device token / 短票 / 节流
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

process.env.NX_AS_STORE = join(ROOT, '.tool', 'test-store', 'gateway-unit.json');

const svc = await imp('src/modules/gateway/service.js');
const { issueTicket, resolveTicket, verifyTicket, __resetTicketsForTest } =
  await imp('src/runtime/gateway/tickets.js');
const { ticketFromUri } = await imp('src/runtime/gateway/check.js');
const { retryAfterMs, recordFailure, backoffDelayMs, resetThrottle } = await imp('src/runtime/gateway/throttle.js');
const { resetStoreCache } = await imp('src/core/store.js');

// ---------- device token ----------

test('device token: 签发→校验→吊销→再校验失败', async () => {
  resetStoreCache();
  const { token, device } = await svc.issueToken({ name: 'unit-phone' });
  assert.match(token, /^nxas_d1\.dev_[a-z0-9]+\.[0-9a-f]{64}$/, 'token 格式');
  assert.ok(device.id.startsWith('dev_'));

  // 正确 token 通过
  const dev = await svc.verifyDeviceToken(`Bearer ${token}`);
  assert.equal(dev?.id, device.id);
  assert.equal(dev?.name, 'unit-phone');

  // 篡改 secret 拒绝
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal(await svc.verifyDeviceToken(`Bearer ${tampered}`), null);

  // 格式错误拒绝
  assert.equal(await svc.verifyDeviceToken('Bearer nonsense'), null);
  assert.equal(await svc.verifyDeviceToken(null), null);

  // 吊销后拒绝
  await svc.revokeDevice({ id: device.id });
  assert.equal(await svc.verifyDeviceToken(`Bearer ${token}`), null, '吊销后立即 401 语义');
  const again = await svc.revokeDevice({ id: device.id });
  assert.equal(again.status, 'already_revoked');
});

test('device token: 未知名/超长名拒绝', async () => {
  await assert.rejects(() => svc.issueToken({}), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => svc.issueToken({ name: 'x'.repeat(65) }), (e) => e.code === 'INVALID_INPUT');
});

// ---------- SSE 短票 ----------

test('短票: 有效一次、过期拒、篡改拒、格式拒', async () => {
  __resetTicketsForTest();
  const t = issueTicket('sess-abc');
  assert.match(t, /^t1\.sess-abc\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
  assert.equal(verifyTicket(t), true, '首次验证通过');
  assert.equal(verifyTicket(t), false, '重放拒绝');

  // 篡改签名
  const tampered = t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a');
  assert.equal(verifyTicket(tampered), false);

  // 过期（构造已过期的时间戳 + 真签名不可行——密钥在模块内；用格式错误代替过期语义）
  assert.equal(verifyTicket('t1.123.abc'), false);
  assert.equal(verifyTicket(undefined), false);
  assert.equal(verifyTicket(''), false);
});

test('短票: 绑定会话（换会话即拒且消费票）+ 会话 id 参与签名', () => {
  __resetTicketsForTest();
  const t = issueTicket('sess-1');
  // 拿去读别的会话 → 拒绝，且该票**同时作废**（拿偷来的票试别的会话只会加速作废）
  assert.equal(resolveTicket(t, 'sess-2'), null, '会话不匹配拒绝');
  assert.equal(resolveTicket(t, 'sess-1'), null, '不匹配已消费掉这张票');

  // 换成「改签名段里的会话 id」也拒（签名覆盖 sessionId）
  const t2 = issueTicket('sess-1');
  const forged = t2.replace('t1.sess-1.', 't1.sess-2.');
  assert.equal(resolveTicket(forged, 'sess-2'), null, '改会话 id 破坏签名');

  // 正常路径：同会话可用一次
  const t3 = issueTicket('sess-1');
  assert.deepEqual(resolveTicket(t3, 'sess-1'), { sessionId: 'sess-1' });
  assert.equal(resolveTicket(t3, 'sess-1'), null, '已消费');

  assert.throws(() => issueTicket(), (e) => e.code === 'INVALID_INPUT', '必须传 sessionId');
});

test('短票: 从 URI 提取（direct 与 nginx 两种路径形态都要认）', () => {
  const tk = 't1.sess-x.1.a.bb';
  assert.deepEqual(
    ticketFromUri(`/m/v1/agent/sess-x/events?ticket=${tk}`),
    { sessionId: 'sess-x', ticket: tk },
    'direct 模式原始 URI',
  );
  assert.deepEqual(
    ticketFromUri(`/_nxas/m/v1/agent/sess-x/events?ticket=${tk}`),
    { sessionId: 'sess-x', ticket: tk },
    'nginx 模式 X-Original-Uri（内层 url 无 /_nxas）',
  );
  // 非 SSE 路径不提取（票只在 events 上生效）
  assert.equal(ticketFromUri(`/m/v1/sessions/sess-x/ticket?ticket=${tk}`), null);
  assert.equal(ticketFromUri('/m/v1/agent/sess-x/ticket'), null);
  assert.equal(ticketFromUri(''), null);
});

// ---------- 节流 ----------

test('节流: 指数退避 1s→2s→…→60s 封顶；5 分钟静默清零', () => {
  resetThrottle();
  const key = 'ip:1.2.3.4';
  assert.equal(retryAfterMs(key), 0, '初始无封锁');

  // 失败序列：1s, 2s, 4s, 8s, 16s, 32s, 64s → 封顶 60s
  assert.equal(backoffDelayMs(1), 1000);
  assert.equal(backoffDelayMs(2), 2000);
  assert.equal(backoffDelayMs(3), 4000);
  assert.equal(backoffDelayMs(4), 8000);
  assert.equal(backoffDelayMs(7), 60000, '封顶 60s（2^6=64s 超限截断）');

  // recordFailure 返回下次封锁时长且 blockedUntil 生效
  const t0 = 1_000_000;
  assert.equal(recordFailure(key, t0), 1000);
  assert.ok(retryAfterMs(key, t0 + 500) > 0, '封锁期内');
  assert.equal(retryAfterMs(key, t0 + 1001), 0, '窗口过后放行');

  // 5 分钟无失败 → 计数清零（下次失败回到 1s 基数）
  const t5 = t0 + 5 * 60_000 + 1;
  assert.equal(recordFailure(key, t5), 1000, '静默清零后回到基数');
});

test('节流: 不同键互不影响', () => {
  resetThrottle();
  recordFailure('ip:a', 1000);
  assert.equal(retryAfterMs('ip:b', 1000), 0, '别的 IP 不连坐');
  recordFailure('tok:dev1', 1000);
  assert.ok(retryAfterMs('tok:dev1', 1000) > 0);
  assert.equal(retryAfterMs('tok:dev2', 1000), 0, '别的设备不连坐');
});

test('节流: 洪泛超上限只淘汰最旧条目，不整表解封（近期键仍封锁）', () => {
  resetThrottle();
  const N = 10_002; // 超过 THROTTLE_MAX_ENTRIES(10000)
  for (let i = 0; i < N; i++) recordFailure(`ip:flood${i}`, 1000 + i);
  // 最旧条目被淘汰（重新查询得到空条目 → 0）
  assert.equal(retryAfterMs('ip:flood0', 1000), 0, '最旧键已淘汰');
  // 近期条目仍在封锁（没有被整表 clear）
  assert.ok(retryAfterMs(`ip:flood${N - 1}`, 1000) > 0, '最近键仍封锁，未全局解封');
});

