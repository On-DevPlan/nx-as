// 网关鉴权单测：统一会话（SSO）/ 短票 / 节流
// device token 已废除——会话原语在 runtime/session.js（cookie 与 Bearer 双载体）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const TMP = await mkdtemp(join(tmpdir(), 'gateway-unit-'));
process.env.NX_AS_STORE = join(TMP, 'store.json');

const { issueTicket, resolveTicket, verifyTicket, __resetTicketsForTest } =
  await imp('src/runtime/gateway/tickets.js');
const { ticketFromUri, decide } = await imp('src/runtime/gateway/check.js');
const { retryAfterMs, recordFailure, backoffDelayMs, resetThrottle } = await imp('src/runtime/gateway/throttle.js');
const { resetStoreCache } = await imp('src/core/store.js');
const session = await imp('src/runtime/session.js');

const IDENTITY = { sub: '42', email: 'user@example.com', name: 'Test User' };

// ---------- 统一会话（SSO 签发） ----------

test('会话: 签发→校验→篡改拒绝→过期拒绝', async () => {
  resetStoreCache();
  const { value, maxAgeSec } = await session.issueSessionCookie(IDENTITY);
  assert.match(value, /^nxas_s2\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/, '会话 token 格式');
  assert.equal(maxAgeSec, 7 * 24 * 3600, '7 天');

  const identity = await session.verifySessionToken(value);
  assert.deepEqual(identity, IDENTITY);

  // 篡改签名段拒绝
  const tampered = value.slice(0, -1) + (value.endsWith('a') ? 'b' : 'a');
  assert.equal(await session.verifySessionToken(tampered), null);

  // 格式错误拒绝
  assert.equal(await session.verifySessionToken('Bearer nonsense'), null);
  assert.equal(await session.verifySessionToken(null), null);
  assert.equal(await session.verifySessionToken('nxas_s1.dead.beef'), null, '旧格式不认');

  // 过期拒绝（伪造 payload：HMAC 过不了；构造已过期 token 需要密钥——用密钥直签验证语义）
  const { ensureSessionSecret } = await imp('src/modules/auth/service.js');
  const { createHmac } = await import('node:crypto');
  const secret = await ensureSessionSecret();
  const expiredPayload = 'nxas_s2.' + Buffer.from(JSON.stringify({ ...IDENTITY, exp: 1 })).toString('base64url');
  const expired = `${expiredPayload}.${createHmac('sha256', secret).update(expiredPayload).digest('hex')}`;
  assert.equal(await session.verifySessionToken(expired), null, '过期 token 拒绝');
});

test('会话: requireSession 双载体（Bearer 头优先，其次 cookie）', async () => {
  resetStoreCache();
  const { value } = await session.issueSessionCookie(IDENTITY);
  const bearerReq = { headers: { authorization: `Bearer ${value}` } };
  assert.deepEqual(await session.requireSession(bearerReq), IDENTITY);
  const cookieReq = { headers: { cookie: `nxas_session=${encodeURIComponent(value)}` } };
  assert.deepEqual(await session.requireSession(cookieReq), IDENTITY);
  assert.equal(await session.requireSession({ headers: {} }), null);
  // 非会话格式的 Bearer 不认
  assert.equal(await session.requireSession({ headers: { authorization: 'Bearer garbage' } }), null);
});

test('会话: rotate 后旧会话全失效（密钥轮换语义）', async () => {
  resetStoreCache();
  const { value } = await session.issueSessionCookie(IDENTITY);
  assert.ok(await session.verifySessionToken(value), '前置：有效');
  const auth = await imp('src/modules/auth/service.js');
  await auth.rotateSessionSecret();
  assert.equal(await session.verifySessionToken(value), null, 'rotate 后旧会话拒绝');
});

// ---------- 决策核心 decide ----------

test('decide: 会话 cookie 放行；无凭据静默拒绝不计数', async () => {
  resetStoreCache();
  resetThrottle();
  const { value } = await session.issueSessionCookie(IDENTITY);
  const allow = await decide({ cookieHeader: `nxas_session=${encodeURIComponent(value)}`, ip: '198.51.100.7' });
  assert.equal(allow.decision, 'allow');
  assert.equal(allow.session.sub, '42');

  const deny = await decide({ ip: '198.51.100.7' });
  assert.equal(deny.decision, 'deny-auth');
  assert.equal(deny.retryAfterSec, 0, '无凭据不计节流');
});

test('decide: 会话 Bearer 放行；坏 Bearer 记节流（ip 桶）', async () => {
  resetStoreCache();
  resetThrottle();
  const { value } = await session.issueSessionCookie(IDENTITY);
  const allow = await decide({ authorization: `Bearer ${value}`, ip: '198.51.100.8' });
  assert.equal(allow.decision, 'allow');

  const bad = await decide({ authorization: 'Bearer nxas_s2.fake.sig', ip: '198.51.100.9' });
  assert.equal(bad.decision, 'deny-auth');
  assert.ok(retryAfterMs('ip:198.51.100.9') > 0, '坏凭据进入节流桶');
  resetThrottle();
});

test('decide: 认证后按 sub 节流（tok:<sub>）', async () => {
  resetStoreCache();
  resetThrottle();
  const { value } = await session.issueSessionCookie(IDENTITY);
  recordFailure('tok:42', Date.now());
  const blocked = await decide({ authorization: `Bearer ${value}`, ip: '198.51.100.10' });
  assert.equal(blocked.decision, 'throttled', 'tok 桶封锁期内即使会话有效也 429 语义');
  resetThrottle();
});

// ---------- SSE 短票 ----------

test('短票: 有效一次、篡改拒、格式拒', async () => {
  __resetTicketsForTest();
  const t = issueTicket('sess-abc');
  assert.match(t, /^t1\.sess-abc\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
  assert.equal(verifyTicket(t), true, '首次验证通过');
  assert.equal(verifyTicket(t), false, '重放拒绝');

  // 篡改签名
  const tampered = t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a');
  assert.equal(verifyTicket(tampered), false);

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
  recordFailure('tok:u1', 1000);
  assert.ok(retryAfterMs('tok:u1', 1000) > 0);
  assert.equal(retryAfterMs('tok:u2', 1000), 0, '别的用户不连坐');
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
