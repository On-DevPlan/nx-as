// 鉴权加固单测：同源 Origin 校验 / 登录节流+审计+Secure cookie / timing-safe 密钥比较
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const TMP = await mkdtemp(join(tmpdir(), 'auth-hard-'));
process.env.NX_AS_STORE = join(TMP, 'store.json');
process.env.NXAS_BOOTSTRAP = '0'; // 登录成功路径不外呼上游
delete process.env.NXAS_GW_MODE;

const { originAllowed } = await imp('src/runtime/api.js');
const { verifyToken } = await imp('src/modules/auth/service.js');
const { mutateStore, resetStoreCache } = await imp('src/core/store.js');
const gw = await imp('src/modules/gateway/service.js');
const session = await imp('src/runtime/gateway/session.js');
const { retryAfterMs, resetThrottle } = await imp('src/runtime/gateway/throttle.js');

// ---------- originAllowed（纯函数，直接喂 headers） ----------

const req = (headers) => ({ headers });

test('origin: 无 Origin 放行（curl/CLI）', () => {
  assert.equal(originAllowed(req({})), true);
});

test('origin: Sec-Fetch-Site 现代浏览器语义', () => {
  assert.equal(originAllowed(req({ origin: 'https://evil.com', 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(originAllowed(req({ origin: 'null', 'sec-fetch-site': 'none' })), true);
  assert.equal(originAllowed(req({ origin: 'https://evil.com', 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(originAllowed(req({ origin: 'https://evil.com', 'sec-fetch-site': 'same-site' })), false, '同站不同源也拒');
});

test('origin: loopback 与同源 Host 放行；跨域拒绝', () => {
  assert.equal(originAllowed(req({ origin: 'http://127.0.0.1:7801', host: '127.0.0.1:7801' })), true);
  assert.equal(originAllowed(req({ origin: 'http://localhost:5180' })), true, 'loopback 无 Host 也放行');
  // nginx 模式公网域名部署：Origin 与 Host 同源 → 放行（旧实现这里 403，面板写操作全挂）
  assert.equal(originAllowed(req({ origin: 'https://agent.example.com', host: 'agent.example.com' })), true);
  assert.equal(originAllowed(req({ origin: 'https://agent.example.com:8443', host: 'agent.example.com' })), true, '端口差异不影响同源判定');
  assert.equal(originAllowed(req({ origin: 'https://evil.com', host: 'agent.example.com' })), false, '跨站拒绝');
  assert.equal(originAllowed(req({ origin: 'not a url', host: 'x' })), false, 'Origin 非法拒绝');
});

// ---------- verifyToken（timing-safe，行为不变） ----------

test('verifyToken: 正确/错误/缺失', async () => {
  resetStoreCache();
  await mutateStore((s) => { s.auth.token = 'nxas_test_token_123'; });
  resetStoreCache();
  delete process.env.NX_AS_TOKEN;
  assert.deepEqual(await verifyToken('nxas_test_token_123'), { valid: true });
  await assert.rejects(() => verifyToken('wrong'), (e) => e.code === 'UNAUTHORIZED');
  await assert.rejects(() => verifyToken(''), (e) => e.code === 'UNAUTHORIZED');
  delete process.env.NX_AS_TOKEN;
});

// ---------- handleLogin：节流 + Secure cookie ----------

function fakeReq(body, headers = {}) {
  const r = new EventEmitter();
  r.headers = { 'x-forwarded-for': '203.0.113.7', ...headers };
  r.socket = { remoteAddress: '203.0.113.7' };
  r.destroy = () => {};
  queueMicrotask(() => {
    if (body) r.emit('data', Buffer.from(body));
    r.emit('end');
  });
  return r;
}

function fakeRes() {
  return {
    statusCode: null, headers: {}, ended: null,
    writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
    end(body) { this.ended = body ?? ''; },
  };
}

const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

test('login: 失败记节流（与网关共用 ip 桶）+ 401；封锁期内 429', async () => {
  resetStoreCache();
  resetThrottle();
  // 首次失败：401 + Retry-After
  const res1 = fakeRes();
  await session.handleLogin(fakeReq(JSON.stringify({ token: 'bad-token' })), res1);
  assert.ok(await waitFor(() => res1.statusCode !== null), '响应已写');
  assert.equal(res1.statusCode, 401);
  assert.ok(res1.headers['Retry-After'] >= 1);
  assert.ok(retryAfterMs('ip:203.0.113.7') > 0, '失败进入 ip 节流桶');

  // 封锁期内（1s 内）再来：429，且不读 body
  const res2 = fakeRes();
  await session.handleLogin(fakeReq(JSON.stringify({ token: 'bad-token' })), res2);
  assert.ok(await waitFor(() => res2.statusCode !== null));
  assert.equal(res2.statusCode, 429, '封锁期内 429');
  resetThrottle();
});

test('login: 成功签发 HttpOnly 会话 cookie；HTTPS 反代时加 Secure', async () => {
  resetStoreCache();
  resetThrottle();
  const { token } = await gw.issueToken({ name: 'login-unit' });

  const res1 = fakeRes();
  await session.handleLogin(fakeReq(JSON.stringify({ token })), res1);
  assert.ok(await waitFor(() => res1.statusCode !== null));
  assert.equal(res1.statusCode, 200);
  const cookie1 = (res1.headers['Set-Cookie'] || [])[0] || '';
  assert.ok(cookie1.startsWith('nxas_session='), '会话 cookie 名');
  assert.ok(cookie1.includes('HttpOnly') && cookie1.includes('SameSite=Lax'));
  assert.ok(!cookie1.includes('Secure'), '纯 HTTP 不加 Secure');

  // 经 HTTPS 反代（X-Forwarded-Proto: https）→ Secure
  const res2 = fakeRes();
  await session.handleLogin(fakeReq(JSON.stringify({ token }), { 'x-forwarded-proto': 'https' }), res2);
  assert.ok(await waitFor(() => res2.statusCode !== null));
  assert.equal(res2.statusCode, 200);
  assert.ok(((res2.headers['Set-Cookie'] || [])[0] || '').includes('Secure'), 'TLS 拓扑加 Secure');
});
