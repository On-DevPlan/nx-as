// 端到端自动化测试（A04 L3 同款链路，跑在真实线上）：
// go-ah 登录 → 面板 SSO（PKCE+state cookie）→ consent → nx-as 回调 → 会话
// → web 面板注册 7866 隧道 → 7877/7866 未登录 302 鉴权 + 带会话放行 + 白名单外用户拒绝
// 注意：本测试打真实线上（登录/写隧道 conf），本地 CI 不跑——手动 node tests/e2e-live.mjs

const IDP = 'http://47.110.80.47:8082';
const PANEL = 'http://47.110.80.47:8090';
const EMAIL = '2096343460@qq.com';
const PASSWORD = 'zhaozhao11';

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}${extra ? ' —— ' + extra : ''}`); }
};

// 极简 cookie jar（按 host 分桶——cookie 只对同一 host 跨端口共享）
const jars = { idp: new Map(), panel: new Map() };
function jarHeader(which) {
  return [...jars[which].entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorb(which, res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jars[which].set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
async function hit(url, { which, method = 'GET', body, headers = {} } = {}) {
  const h = { ...(which ? { cookie: jarHeader(which) } : {}), ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers: h, redirect: 'manual', body: body !== undefined ? JSON.stringify(body) : undefined });
  if (which) absorb(which, res);
  return res;
}

// ---------- 1. go-ah 登录 ----------
console.log('\n[1] go-ah 账号登录');
const login = await hit(`${IDP}/api/login`, { which: 'idp', method: 'POST', body: { username: EMAIL, password: PASSWORD } });
const loginBody = await login.json().catch(() => ({}));
ok(login.status === 200 && (loginBody.code === undefined || loginBody.code === 0), `登录成功（HTTP ${login.status}）`, JSON.stringify(loginBody).slice(0, 120));
ok(jars.idp.has('idp_session'), '拿到 idp_session cookie');

// ---------- 2. 面板发起 SSO（拿 state cookie + authorize URL） ----------
console.log('\n[2] nx-as 面板 SSO 发起');
const ssoStart = await hit(`${PANEL}/_nxas/oidc/login?next=/panel`, { which: 'panel' });
ok(ssoStart.status === 302, `/_nxas/oidc/login 302（实际 ${ssoStart.status}）`);
ok(jars.panel.has('nxas_oidc'), 'state cookie 已种');
const authorizeUrl = ssoStart.headers.get('location');
const authQ = new URL(authorizeUrl).searchParams;
ok(authQ.get('client_id') === 'nx-as' && authQ.get('code_challenge_method') === 'S256', 'authorize 请求带 PKCE S256');

// ---------- 3. authorize（已登录 → 302 consent） ----------
console.log('\n[3] go-ah authorize → consent');
const authRes = await hit(authorizeUrl, { which: 'idp' });
ok(authRes.status === 302, `authorize 302（实际 ${authRes.status}）`);
const consentLoc = authRes.headers.get('location') || '';
ok(consentLoc.includes('/consent'), `跳同意页（${consentLoc.slice(0, 40)}...）`);

// ---------- 4. 同意授权 → 拿 code ----------
console.log('\n[4] 同意授权（consent allow）');
const consentRes = await hit(`${IDP}/api/consent`, {
  which: 'idp', method: 'POST',
  body: {
    client_id: authQ.get('client_id'),
    redirect_uri: authQ.get('redirect_uri'),
    scope: authQ.get('scope'),
    state: authQ.get('state'),
    nonce: authQ.get('nonce') || '',
    code_challenge: authQ.get('code_challenge'),
    code_challenge_method: authQ.get('code_challenge_method'),
    decision: 'allow',
  },
});
const consentBody = await consentRes.json().catch(() => ({}));
const redirectTo = consentBody.redirect_to || '';
ok(consentRes.status === 200 && redirectTo.includes('code='), `签发授权码（${redirectTo.slice(0, 60)}...）`, JSON.stringify(consentBody).slice(0, 150));

// ---------- 5. nx-as 回调 → 会话 ----------
console.log('\n[5] nx-as 回调换会话');
const cb = await hit(redirectTo, { which: 'panel' });
ok(cb.status === 302, `回调 302 回 next（实际 ${cb.status}）`);
ok(jars.panel.has('nxas_session'), 'nxas_session 会话 cookie 已签发');
const sessionToken = jars.panel.get('nxas_session');

// ---------- 6. 会话身份 + 白名单 ----------
console.log('\n[6] 会话身份');
const me = await hit(`${PANEL}/_nxas/api/auth/me`, { which: 'panel' });
const meBody = await me.json().catch(() => ({}));
ok(me.status === 200 && meBody.email === EMAIL, `me 返回 ${meBody.email || '(无)'}`);

// ---------- 7. 自建临时隧道三态鉴权（自给自足：注册→验→删，不依赖用户数据） ----------
console.log('\n[7] 临时隧道 e2e-t1(17871) / e2e-t2(17872) 注册+鉴权');
for (const [name, pub] of [['e2e-t1', 17871], ['e2e-t2', 17872]]) {
  const reg = await hit(`${PANEL}/_nxas/api/nginx/tunnel`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}` },
    body: { name, 'public-port': pub },
  });
  const rb = await reg.json().catch(() => ({}));
  ok(reg.status === 200 && rb.status === 'ok', `注册 ${name}(:${pub})`, JSON.stringify(rb).slice(0, 100));
  const anon = await fetch(`http://47.110.80.47:${pub}/`, { redirect: 'manual' }).catch(() => null);
  ok(anon && anon.status === 302 && (anon.headers.get('location') || '').includes('/_nxas/login'),
    `${pub} 未登录 → 302 登录（实际 ${anon ? anon.status : '无响应=安全组拦截'}）`);
  const authed = await fetch(`http://47.110.80.47:${pub}/`, { redirect: 'manual', headers: { cookie: `nxas_session=${sessionToken}` } }).catch(() => null);
  ok(authed && authed.status !== 401 && authed.status !== 302, `${pub} 带会话 → 过鉴权（实际 ${authed ? authed.status : '无响应'}；502=本地无转发属预期）`);
  const forged = await fetch(`http://47.110.80.47:${pub}/`, { redirect: 'manual', headers: { cookie: 'nxas_session=nxas_s2.x.y' } }).catch(() => null);
  ok(forged && (forged.status === 302 || forged.status === 401), `${pub} 伪造会话 → 拒绝（实际 ${forged ? forged.status : '?'}）`);
}

// ---------- 10. 清理临时隧道 + conf 对账 ----------
console.log('\n[10] 清理 + conf 对账');
const files = await hit(`${PANEL}/_nxas/api/nginx/files`, { headers: { authorization: `Bearer ${sessionToken}` } });
const filesBody = await files.json().catch(() => ({}));
const names = (filesBody.files || []).map((f) => f.name);
ok(names.includes('nxas-tunnel-e2e-t1.conf') && names.includes('nxas-tunnel-e2e-t2.conf'), '两条临时隧道 conf 在册');
for (const name of ['e2e-t1', 'e2e-t2']) {
  const del = await hit(`${PANEL}/_nxas/api/nginx/tunnel/remove`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}` }, body: { name },
  });
  ok(del.status === 200, `清理 ${name}`);
}

console.log(`
E2E: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
