// nginx 模式（NXAS_GW_MODE=nginx）回归：/_nxas 前缀下全链路
import { startFakeIdp } from '../tests/helpers/fake-idp.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = await mkdtemp(join(tmpdir(), 'nginx-mode-'));
process.env.NX_AS_STORE = join(TMP, 'store.json');
process.env.NXAS_BOOTSTRAP = '0';
process.env.NXAS_GW_MODE = 'nginx';
const idp = await startFakeIdp({ clients: { 'nx-as': ['http://127.0.0.1:*/oidc/callback', 'http://127.0.0.1:*/_nxas/oidc/callback'] } });
process.env.NXAS_OIDC_ISSUER = idp.issuer;
process.env.NXAS_OIDC_CLIENT_ID = 'nx-as';

const { startServer } = await import('../src/runtime/server.js');
const { resetStoreCache } = await import('../src/core/store.js');
resetStoreCache();
const server = await startServer({ port: 0, host: '127.0.0.1' });
const BASE = `http://127.0.0.1:${server.address().port}`;

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.error(`FAIL  ${n}`); } };

const jar = new Map();
const absorb = (res) => { for (const c of res.headers.getSetCookie?.() || []) { const [pair] = c.split(';'); const eq = pair.indexOf('='); if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()); } };
const jh = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

// 1. 前缀公开探针
const v = await fetch(`${BASE}/_nxas/api/auth/verify`);
ok(v.status === 200 && (await v.json()).valid === true, '/_nxas/api/auth/verify 探活');

// 2. 前缀 SSO 登录链路（redirect_uri 必须带 /_nxas 前缀——注册白名单要含它）
const r1 = await fetch(`${BASE}/_nxas/oidc/login?next=/panel`, { redirect: 'manual', headers: { cookie: jh() } });
absorb(r1);
const authUrl = new URL(r1.headers.get('location'));
ok(r1.status === 302 && authUrl.pathname === '/oauth2/auth', '/_nxas/oidc/login 302 到 IdP');
ok(decodeURIComponent(authUrl.searchParams.get('redirect_uri')).includes('/_nxas/oidc/callback'),
  `redirect_uri 带 /_nxas 前缀（${decodeURIComponent(authUrl.searchParams.get('redirect_uri'))}）`);
const r2 = await fetch(authUrl.toString(), { redirect: 'manual', headers: { cookie: jh() } });
absorb(r2);
ok(r2.status === 302, 'IdP 发码');
const r3 = await fetch(r2.headers.get('location'), { redirect: 'manual', headers: { cookie: jh() } });
absorb(r3);
ok(r3.status === 302 && r3.headers.get('location') === '/panel', '/_nxas/callback 成功回 next');

// 3. 前缀 API 会话鉴权
const sess = jar.get('nxas_session');
const me = await fetch(`${BASE}/_nxas/api/auth/me`, { headers: { cookie: `nxas_session=${sess}` } });
ok(me.status === 200 && (await me.json()).email === 'user@example.com', '/_nxas/api/auth/me 会话生效');

// 4. 旧登录路径（nginx error_page 落点）→ SSO 跳板
const lp = await fetch(`${BASE}/_nxas/login?next=/panel`, { redirect: 'manual' });
ok(lp.status === 302 && lp.headers.get('location') === '/_nxas/oidc/login?next=%2Fpanel', '/_nxas/login → /_nxas/oidc/login（带前缀）');

// 5. 前缀静态面板
const sp = await fetch(`${BASE}/_nxas/panel`);
ok(sp.status === 200 && (await sp.text()).includes('<div id="root">'), '/_nxas/panel 静态页');

// 6. 前缀 auth/check 委托（nginx auth_request 契约）
const chk = await fetch(`${BASE}/_nxas/auth/check`, { headers: { cookie: `nxas_session=${sess}` } });
ok(chk.status === 204, '/_nxas/auth/check 有会话 204');
const chk2 = await fetch(`${BASE}/_nxas/auth/check`);
ok(chk2.status === 401, '/_nxas/auth/check 无会话 401');

server.close(); idp.close();
console.log(`\nnginx-mode: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
