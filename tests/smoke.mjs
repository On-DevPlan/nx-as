#!/usr/bin/env node
// 端到端 smoke：起 serve（随机端口 + 临时 store + 假 IdP）→ SSO 登录 → 会话鉴权 → 短票 → 静态页
// OIDC 细粒度用例（state 重放/错 verifier/白名单/CLI handoff）在 tests/unit/oidc.test.mjs
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BIN = join(ROOT, 'bin', 'nx-as.mjs');
// 7900-7989：避开常用本机服务端口段
const PORT = 7900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

const TMP = await mkdtemp(join(tmpdir(), 'nxas-smoke-'));
process.env.NX_AS_STORE = join(TMP, 'store.json');
delete process.env.NX_AS_HOME;
delete process.env.NXAS_GW_MODE;
delete process.env.NXAS_BOOTSTRAP;

const { startFakeIdp } = await import(new URL('./helpers/fake-idp.mjs', import.meta.url).href);
const idp = await startFakeIdp({ clients: { 'nx-as': ['http://127.0.0.1:*/oidc/callback'] } });
process.env.NXAS_OIDC_ISSUER = idp.issuer;
process.env.NXAS_OIDC_CLIENT_ID = 'nx-as';

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}`);
  }
}

// 极简 cookie jar
const jar = new Map();
const jarHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
function absorb(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function req(method, path, body, headers = {}) {
  const h = { cookie: jarHeader(), ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  absorb(res);
  const data = await res.json().catch(() => null);
  return { status: res.status, data, res };
}

// 1. 起服务
const server = spawn(process.execPath, [BIN, 'serve', '--no-open', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
let serverLog = '';
server.stdout.on('data', (c) => (serverLog += c));
server.stderr.on('data', (c) => (serverLog += c));
server.on('exit', (code) => {
  if (code && code !== 0) {
    console.error('serve 进程退出:', code, '\n', serverLog);
    process.exit(1);
  }
});

let up = false;
for (let i = 0; i < 40; i++) {
  try {
    // 探活必须是 nx-as 自己的应答（带 version 的 JSON）——端口撞上别的本机服务时继续重试
    const r = await fetch(`${BASE}/api/auth/verify`);
    if (r.status < 500) {
      const j = await r.json().catch(() => null);
      if (j && typeof j.version === 'string') { up = true; break; }
    }
  } catch { /* not yet */ }
  await sleep(250);
}
if (!up) {
  console.error('serve 40 次重试后仍未就绪\n', serverLog);
  server.kill();
  process.exit(1);
}
console.log(`smoke: serve 就绪 :${PORT}（IdP :${idp.port}）`);

try {
  // 2. 公开探针与匿名鉴权边界
  const verify = await req('GET', '/api/auth/verify');
  ok(verify.data?.valid === true, 'verify 公开探针 valid:true');
  const bootAnon = await req('GET', '/api/bootstrap');
  ok(bootAnon.status === 200 && Array.isArray(bootAnon.data?.commands), 'bootstrap 公开（端口协商签名）');
  const anon = await req('GET', '/api/auth/status');
  ok(anon.status === 401, '未登录管理面 → 401');

  // 3. SSO 登录（fake IdP 登录+consent 折叠为 authorize 直接发码）
  const loginRes = await fetch(`${BASE}/oidc/login?next=/panel`, { redirect: 'manual', headers: { cookie: jarHeader() } });
  absorb(loginRes);
  ok(loginRes.status === 302, '/oidc/login 302 到 IdP');
  const authRes = await fetch(loginRes.headers.get('location'), { redirect: 'manual', headers: { cookie: jarHeader() } });
  absorb(authRes);
  ok(authRes.status === 302, 'IdP 发码回跳');
  const cbRes = await fetch(authRes.headers.get('location'), { redirect: 'manual', headers: { cookie: jarHeader() } });
  absorb(cbRes);
  ok(cbRes.status === 302 && cbRes.headers.get('location') === '/panel', '回调成功回 next');
  const sessionToken = jar.get('nxas_session');
  ok(!!sessionToken && sessionToken.startsWith('nxas_s2.'), '会话 cookie 已签发');

  // 4. 会话鉴权（cookie 与 Bearer 等价）
  const me = await req('GET', '/api/auth/me');
  ok(me.status === 200 && me.data?.email === 'user@example.com', `me 返回身份（${me.data?.email}）`);
  const meBearer = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${sessionToken}` } });
  ok(meBearer.status === 200, 'Bearer 会话等价');

  // 5. 管理面与静态页
  const status = await req('GET', '/api/auth/status');
  ok(status.status === 200 && status.data?.complete === true, 'auth status complete');
  const health = await req('GET', '/api/health');
  ok(health.data?.ok === true, 'health');
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  ok(page.status === 200 && html.includes('<div id="root">'), '静态面板 index.html');

  // 6. SSE 短票端到端（回归：短票曾「签发了但永远验不过」——断言必须打到带票请求不再 401）
  const sid = 'smoke-sess-1';
  const ticketRes = await fetch(`${BASE}/m/v1/sessions/${sid}/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const ticketBody = await ticketRes.json().catch(() => ({}));
  ok(ticketRes.status === 200 && typeof ticketBody.url === 'string',
    `短票签发 return url（${ticketBody.url || '无'}）`);
  ok(!ticketBody.url?.startsWith('/_nxas'), 'direct 模式短票 url 无前缀');
  if (!ticketBody.url) {
    console.error('短票未签发，后续短票用例跳过\n', serverLog.slice(-2000));
  } else {

  // 带票请求：本机没装 pi-web，上游不可达是预期的（502/404 都算「票通过了」），
  // 唯一不能出现的是 401——那是票被拒的信号。
  const viaTicket = await fetch(`${BASE}${ticketBody.url}`, { headers: { Accept: 'text/event-stream' } });
  ok(viaTicket.status !== 401, `带票请求不再 401（实际 ${viaTicket.status}）`);
  const replay = await fetch(`${BASE}${ticketBody.url}`, { headers: { Accept: 'text/event-stream' } });
  ok(replay.status === 401, `短票重放 → 401（实际 ${replay.status}）`);

  // 票与会话绑定：拿 A 会话的票去读 B 会话 → 401
  const otherSid = 'smoke-sess-2';
  const t2 = await fetch(`${BASE}/m/v1/sessions/${otherSid}/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const url2 = (await t2.json().catch(() => ({}))).url;
  const cross = url2 ? await fetch(`${BASE}${url2.replace(otherSid, sid)}`) : { status: -1 };
  ok(cross.status === 401, `短票换会话使用 → 401（实际 ${cross.status}）`);

  }

  // 7. 登出
  const out = await fetch(`${BASE}/auth/logout`, { redirect: 'manual', headers: { cookie: jarHeader() } });
  absorb(out);
  ok(out.status === 302, '登出 302');
  const afterOut = await req('GET', '/api/auth/me');
  ok(afterOut.status === 401, '登出后 me → 401');
} finally {
  server.kill('SIGTERM');
  idp.close();
}

console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
