// OIDC SSO 全链路单测：假 IdP + 真 nx-as 服务器（起在临时端口/临时 store）
// 覆盖：SSO 授权码流程 → 会话 cookie → Bearer 等价 → state 重放拒绝 → 错 verifier 拒绝
//      → email 白名单 → CLI 回环 handoff → 未登录 401 → 登出
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const { startFakeIdp } = await imp('tests/helpers/fake-idp.mjs');

// 极简 cookie jar（记录全部 Set-Cookie 值，同 name 覆盖）
function makeJar() {
  const jar = new Map();
  return {
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb: (res) => {
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    get: (name) => jar.get(name) || null,
  };
}

// 一次「浏览器」：带 jar 的 fetch，自动跟随 302（跨主机也跟——fake IdP 是另一端口）
async function browserFetch(url, { jar, method = 'GET', redirect = 'follow' } = {}) {
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: jar ? { cookie: jar.header() } : {},
  });
  if (jar) jar.absorb(res);
  if (redirect === 'follow' && res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (loc) {
      const next = new URL(loc, url).toString();
      const r2 = await browserFetch(next, { jar, redirect: 'follow' });
      r2.chain = [res, ...(r2.chain || [])]; // Response 是原型属性对象，不能 spread
      return r2;
    }
  }
  return res;
}

const TMP = await mkdtemp(join(tmpdir(), 'oidc-flow-'));
process.env.NX_AS_STORE = join(TMP, 'store.json');
process.env.NXAS_BOOTSTRAP = '0'; // 不外呼上游 pi-web
delete process.env.NXAS_GW_MODE;

// 用独立的 store 路径起独立服务器；先起假 IdP，再配 nx-as
const idp = await startFakeIdp({ clients: { 'nx-as': [
  'http://127.0.0.1:*/oidc/callback',
  'http://127.0.0.1:*/_nxas/oidc/callback',
  'http://10.1.2.3:9999/_nxas/oidc/callback', // probe 一致性检查用的生效回调
] } });
process.env.NXAS_OIDC_ISSUER = idp.issuer;
process.env.NXAS_OIDC_CLIENT_ID = 'nx-as';
delete process.env.NXAS_OIDC_REDIRECT_URI;
delete process.env.NXAS_OIDC_SCOPES;

const { startServer } = await imp('src/runtime/server.js');
const { resetStoreCache } = await imp('src/core/store.js');
const { resetThrottle } = await imp('src/runtime/gateway/throttle.js');
resetStoreCache();
const server = await startServer({ port: 0, host: '127.0.0.1' });
const BASE = `http://127.0.0.1:${server.address().port}`;

// 全部用例跑完后关掉监听句柄——否则 test runner 等事件池排空会一直挂着
test.after(() => {
  server.close();
  idp.close();
});

test('SSO 全链路：登录 → 会话 cookie → /api/auth/me → Bearer 等价', async () => {
  const jar = makeJar();

  // 未登录：管理面 401；SSO 入口正常
  const anon = await fetch(`${BASE}/api/auth/me`);
  assert.equal(anon.status, 401, '未登录 /api/auth/me → 401');

  // /login 旧路径 → 302 /oidc/login → 302 fake IdP → 302 回调 → 302 / + 会话 cookie
  const final = await browserFetch(`${BASE}/login?next=/panel`, { jar });
  assert.equal(final.status, 200, `登录链路最终 200（实际 ${final.status}）`);
  const sessionCookie = jar.get('nxas_session');
  assert.match(sessionCookie || '', /^nxas_s2\./, '会话 cookie 已签发');

  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: `nxas_session=${sessionCookie}` } });
  assert.equal(me.status, 200);
  const identity = await me.json();
  assert.equal(identity.email, 'user@example.com');
  assert.equal(identity.sub, '42');

  // Bearer 与 cookie 同一凭据
  const meBearer = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${sessionCookie}` } });
  assert.equal(meBearer.status, 200, 'Bearer 会话等价 cookie');

  // verify 公开探针仍可用
  const verify = await fetch(`${BASE}/api/auth/verify`);
  assert.equal((await verify.json()).valid, true);
});

test('state 重放拒绝（callback 二次访问 → 400）', async () => {
  const jar = makeJar();
  const first = await browserFetch(`${BASE}/oidc/login`, { jar, redirect: 'manual' });
  assert.equal(first.status, 302, '第一跳到 IdP');
  const authUrl = first.headers.get('location');
  // 走完一次正常登录拿到 callback URL
  const cb1 = await browserFetch(authUrl, { jar, redirect: 'manual' });
  const callbackUrl = cb1.headers.get('location');
  assert.ok(callbackUrl?.includes('code='), '拿到回调 URL');
  const okRes = await browserFetch(callbackUrl, { jar, redirect: 'manual' });
  assert.equal(okRes.status, 302, '首次回调成功');

  // 同一 callback 重放：state cookie 已被清除 → 400
  const replay = await browserFetch(callbackUrl, { jar, redirect: 'manual' });
  assert.equal(replay.status, 400, 'state 重放/缺失拒绝');
});

test('PKCE 错 verifier：token 端点拒绝 → 回调 502', async () => {
  resetThrottle();
  // 直接对 fake IdP 验证：错 verifier 拿不到 token（nx-as 回调链路在第 9 步会 502）
  const jar = makeJar();
  const first = await browserFetch(`${BASE}/oidc/login`, { jar, redirect: 'manual' });
  const authUrl = new URL(first.headers.get('location'));
  // 用错 challenge 发起（模拟攻击者替换 challenge）
  authUrl.searchParams.set('code_challenge', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  const cb = await browserFetch(authUrl.toString(), { jar, redirect: 'manual' });
  const callbackUrl = cb.headers.get('location');
  const res = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie: jar.header() } });
  assert.equal(res.status, 502, '错 verifier → 换 token 失败 → 502');
});

test('email 白名单：不在名单 → 403', async () => {
  resetThrottle();
  const { mutateStore } = await imp('src/core/store.js');
  await mutateStore((s) => { s.oidc.allowedEmails = ['admin@example.com']; });
  resetStoreCache();
  const jar = makeJar();
  const res = await browserFetch(`${BASE}/oidc/login`, { jar });
  assert.equal(res.status, 403, '白名单外 403');
  await mutateStore((s) => { s.oidc.allowedEmails = []; });
  resetStoreCache();
});

test('CLI 回环 handoff：登录后 302 回 127.0.0.1 并带会话 token', async () => {
  resetThrottle();
  // 本机临时监听扮演 CLI
  let handoffResolve;
  const received = new Promise((resolve, reject) => {
    handoffResolve = resolve;
    setTimeout(() => reject(new Error('CLI handoff 20s 未回传')), 20_000).unref();
  });
  const cliListener = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/done') {
      handoffResolve({ token: u.searchParams.get('token') });
      res.writeHead(200);
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => cliListener.listen(0, '127.0.0.1', r));

  const jar = makeJar();
  const loginUrl = `${BASE}/oidc/login?cli=${encodeURIComponent(`http://127.0.0.1:${cliListener.address().port}/done`)}`;
  await browserFetch(loginUrl, { jar });
  const { token } = await received;
  cliListener.close();
  assert.match(token || '', /^nxas_s2\./, 'CLI handoff 收到会话 token');
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200, 'handoff token 可直接调 API');
});

test('auth rotate：全端下线（旧 cookie 与旧 Bearer 立即失效）', async () => {
  resetThrottle();
  const jar = makeJar();
  await browserFetch(`${BASE}/oidc/login`, { jar });
  const old = jar.get('nxas_session');
  assert.ok(old, '前置：已登录');

  const { resolveSessionToken } = await imp('src/core/credentials.js');
  void resolveSessionToken;
  const rotateRes = await fetch(`${BASE}/api/auth/rotate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${old}` },
  });
  assert.equal(rotateRes.status, 200, 'rotate 成功');
  const after = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${old}` } });
  assert.equal(after.status, 401, 'rotate 后旧会话 401');
});

test('登出：清 cookie；oidc probe 零凭据探测可用', async () => {
  resetThrottle();
  const jar = makeJar();
  await browserFetch(`${BASE}/oidc/login`, { jar });
  const sessionToken = jar.get('nxas_session');
  assert.ok(sessionToken, '前置：已登录');

  // probe 是鉴权端点（面板用），带会话调用；探测本身对 IdP 是零凭据的
  // 先给 store 配上「生效回调」（模拟公网部署 env NXAS_OIDC_REDIRECT_URI），probe 应多一条通过项
  const { mutateStore } = await imp('src/core/store.js');
  await mutateStore((s) => { s.oidc.redirectUri = 'http://10.1.2.3:9999/_nxas/oidc/callback'; });
  resetStoreCache();
  const probe = await fetch(`${BASE}/api/oidc/probe`, { headers: { authorization: `Bearer ${sessionToken}` } });
  const body = await probe.json();
  assert.equal(probe.status, 200);
  assert.equal(body.ok, true, `probe 通过（${JSON.stringify(body.checks)}）`);
  const redirectCheck = body.checks.find((c) => c.name === 'redirect_uri');
  assert.ok(redirectCheck && redirectCheck.ok, '生效 redirect_uri 一致性检查存在且通过');
  await mutateStore((s) => { s.oidc.redirectUri = ''; });
  resetStoreCache();

  const out = await browserFetch(`${BASE}/auth/logout`, { jar, redirect: 'manual' });
  assert.equal(out.status, 302);
  assert.ok((out.headers.getSetCookie?.() || []).some((c) => c.startsWith('nxas_session=;')), '清 cookie');
  const afterOut = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: jar.header() } });
  assert.equal(afterOut.status, 401, '登出后 me → 401');
});

test('OIDC 未配置时 /oidc/login 给出 500 指引', async () => {
  // 独立 store + 无 env：起第二个服务器实例验证
  const prev = process.env.NXAS_OIDC_ISSUER;
  delete process.env.NXAS_OIDC_ISSUER;
  delete process.env.NXAS_OIDC_CLIENT_ID;
  process.env.NX_AS_STORE = join(TMP, 'store-unconfigured.json');
  resetStoreCache();
  const s2 = await startServer({ port: 0, host: '127.0.0.1' });
  const res = await fetch(`http://127.0.0.1:${s2.address().port}/oidc/login`, { redirect: 'manual' });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /OIDC 未配置/);
  s2.close();
  process.env.NXAS_OIDC_ISSUER = prev;
  process.env.NXAS_OIDC_CLIENT_ID = 'nx-as';
  process.env.NX_AS_STORE = join(TMP, 'store.json');
  resetStoreCache();
});
