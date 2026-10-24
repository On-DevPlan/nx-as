// 鉴权加固单测：同源 Origin 校验 / 统一会话校验（SSO 签发）/ state cookie 签名
// 静态密钥时代的 verifyToken 与 device 登录用例已随方案废除——SSO 全链路在 oidc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const TMP = await mkdtemp(join(tmpdir(), 'auth-hard-'));
process.env.NX_AS_STORE = join(TMP, 'store.json');
delete process.env.NXAS_GW_MODE;

const { originAllowed } = await imp('src/runtime/api.js');
const session = await imp('src/runtime/session.js');
const oidc = await imp('src/runtime/oidc.js');
const { resetStoreCache, mutateStore } = await imp('src/core/store.js');

// ---------- originAllowed（纯函数，直接喂 headers） ----------

const req = (headers) => ({ headers });

test('origin: 无 Origin 放行（curl/CLI）', () => {
  assert.equal(originAllowed(req({})), true);
});

test('origin: Sec-Fetch-Site 现代浏览器语义', () => {
  assert.equal(originAllowed(req({ origin: 'https://evil.com', 'sec-fetch-site': 'same-origin' })), true);
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

// ---------- 统一会话（cookie 载体属性在签发时决定） ----------

test('会话: 签发格式与校验（HttpOnly 属性由调用方 Set-Cookie 拼装）', async () => {
  resetStoreCache();
  const { value, maxAgeSec } = await session.issueSessionCookie({ sub: '7', email: 'a@b.c', name: 'A' });
  assert.match(value, /^nxas_s2\./);
  assert.equal(maxAgeSec, 7 * 24 * 3600);
  const identity = await session.verifySessionToken(value);
  assert.equal(identity.sub, '7');
  assert.equal(identity.email, 'a@b.c');
  // cookie 头解析
  assert.equal(session.sessionFromCookieHeader(`other=1; nxas_session=${value}`), value);
  assert.equal(session.sessionFromCookieHeader(null), null);
});

// ---------- state cookie（防 CSRF / 防重放） ----------

test('oidc state cookie: 签发→读取→篡改拒→过期拒', async () => {
  resetStoreCache();
  const data = { state: 'abc123', verifier: 'vvv', next: '/panel', cli: null, redirectUri: 'http://127.0.0.1:7801/oidc/callback' };
  const { value } = await oidc.issueStateCookie(data);
  assert.match(value, /^nxas_oidc\.\d{10}\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  const read = await oidc.readStateCookie(`other=1; nxas_oidc=${value}`);
  assert.equal(read.state, 'abc123', 'state 数据完整取回');
  assert.equal(read.verifier, 'vvv');
  assert.ok(read.exp > Date.now() / 1000, 'exp 在未来');

  // 篡改签名段（保持 name= 前缀形态）
  const tampered = `nxas_oidc=${value.slice(0, -1)}${value.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(await oidc.readStateCookie(tampered), null);
  // 缺失/垃圾
  assert.equal(await oidc.readStateCookie(null), null);
  assert.equal(await oidc.readStateCookie('nxas_oidc=broken'), null);
});

// ---------- PKCE 与 redirect 构造 ----------

test('PKCE: verifier/challenge 成对（S256）', async () => {
  const { createHash } = await import('node:crypto');
  const { verifier, challenge } = oidc.pkcePair();
  assert.equal(
    challenge,
    Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64url'),
    'challenge = BASE64URL(SHA256(verifier))',
  );
  assert.notEqual(oidc.pkcePair().verifier, verifier, '每次随机');
});

test('redirect_uri: env 优先；动态构造按 X-Forwarded-Proto/Host/nginx 前缀', async () => {
  const cfg = { redirectUri: 'https://pub.example.com/_nxas/oidc/callback' };
  assert.equal(
    oidc.buildRedirectUri({ headers: { host: '127.0.0.1:7801' } }, cfg, false),
    'https://pub.example.com/_nxas/oidc/callback',
    'env 配置优先',
  );
  const dynamic = { headers: { host: 'agent.example.com', 'x-forwarded-proto': 'https' } };
  assert.equal(oidc.buildRedirectUri(dynamic, { redirectUri: '' }, true), 'https://agent.example.com/_nxas/oidc/callback');
  assert.equal(oidc.buildRedirectUri(dynamic, { redirectUri: '' }, false), 'https://agent.example.com/oidc/callback');
  assert.equal(
    oidc.buildRedirectUri({ headers: { host: '127.0.0.1:7801' } }, { redirectUri: '' }, false),
    'http://127.0.0.1:7801/oidc/callback',
    '回环部署（go-ah 端口通配可覆盖）',
  );
});

test('safeNext / safeCliHandoff：只放行站内相对路径与本机回环', () => {
  assert.equal(oidc.safeNext('/panel'), '/panel');
  assert.equal(oidc.safeNext('//evil.com'), '/', '协议相对地址拒绝');
  assert.equal(oidc.safeNext('http://evil.com'), '/');
  assert.equal(oidc.safeNext(undefined), '/');

  assert.equal(oidc.safeCliHandoff('http://127.0.0.1:52133/done'), 'http://127.0.0.1:52133/done');
  assert.equal(oidc.safeCliHandoff('http://localhost:9999/done?x=1'), 'http://localhost:9999/done?x=1');
  assert.equal(oidc.safeCliHandoff('http://evil.com/done'), null, '非回环拒绝');
  assert.equal(oidc.safeCliHandoff('https://127.0.0.1:1/done'), null, 'https 也拒（本机回环 http 约定）');
  assert.equal(oidc.safeCliHandoff('not a url'), null);
});

// ---------- 登录白名单（env 覆盖 store——gost-as 公网部署在 compose 设） ----------

test('oidcConfig: NXAS_OIDC_ALLOWED_EMAILS env 覆盖 store 且统一小写', async () => {
  resetStoreCache();
  await mutateStore((s) => { s.oidc.allowedEmails = ['store@x.com']; });
  resetStoreCache();
  const before = await oidc.oidcConfig();
  assert.deepEqual(before.allowedEmails, ['store@x.com'], '无 env 时用 store');
  process.env.NXAS_OIDC_ALLOWED_EMAILS = 'A@B.com, c@d.com';
  const cfg = await oidc.oidcConfig();
  assert.deepEqual(cfg.allowedEmails, ['a@b.com', 'c@d.com'], 'env 优先且归一');
  delete process.env.NXAS_OIDC_ALLOWED_EMAILS;
  const after = await oidc.oidcConfig();
  assert.deepEqual(after.allowedEmails, ['store@x.com'], '清 env 回落 store');
});
