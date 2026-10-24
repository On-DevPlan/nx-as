// 身份与会话：OIDC SSO（go-ah）落地后的 auth 域
// - 静态管理密钥与 device token 已废除：人的凭据唯一来源是 go-ah 单点登录，
//   nx-as 只保存「OIDC 接入配置 + 会话签名密钥」这两样本地状态
// - 会话签发/校验原语在 runtime/session.js（cookie 与 Bearer 双载体共用），这里管配置与运维
import { randomBytes, createHash } from 'node:crypto';
import { mutateStore, loadStore } from '../../core/store.js';
import { badInput } from '../../core/errors.js';
import { VERSION } from '../../core/version.js';

// ---------- 会话签名密钥 ----------

// 首用时生成并持久化（重启不掉线——与旧「进程随机、重启全员失效」语义相反，
// 因为现在登录要走 SSO 跳转，重启就全员掉线代价太高）
export async function ensureSessionSecret() {
  const store = await loadStore();
  if (store.oidc.sessionSecret) return store.oidc.sessionSecret;
  const secret = randomBytes(32).toString('hex');
  await mutateStore((s) => {
    if (!s.oidc.sessionSecret) s.oidc.sessionSecret = secret;
  });
  const cur = await loadStore();
  return cur.oidc.sessionSecret || secret;
}

// 轮换 = 全端下线（所有 cookie 与 Bearer 会话立即失效；SSO 重新登录即可恢复）
export async function rotateSessionSecret() {
  const secret = randomBytes(32).toString('hex');
  await mutateStore((s) => {
    s.oidc.sessionSecret = secret;
  });
  appendAuditSafe('auth.session_rotate', {});
  return { note: '会话密钥已轮换：所有已发会话（cookie 与 Bearer）立即失效，重新登录即可' };
}

function appendAuditSafe(action, detail) {
  import('../../core/audit.js')
    .then(({ appendAudit }) => appendAudit({ action, detail }))
    .catch(() => {});
}

// ---------- OIDC 接入配置 ----------

export async function setOidcConfig({ issuer, clientId, redirectUri, scopes, allowedEmails }) {
  if (issuer === undefined && clientId === undefined && redirectUri === undefined
    && scopes === undefined && allowedEmails === undefined) {
    throw badInput('没有要修改的字段（--issuer / --client-id / --redirect-uri / --scopes / --allowed-emails 至少一个）');
  }
  const emailList = typeof allowedEmails === 'string'
    ? allowedEmails.split(',').map((s) => s.trim()).filter(Boolean)
    : allowedEmails;
  await mutateStore((s) => {
    if (issuer !== undefined) s.oidc.issuer = String(issuer).trim().replace(/\/+$/, '');
    if (clientId !== undefined) s.oidc.clientId = String(clientId).trim();
    if (redirectUri !== undefined) s.oidc.redirectUri = String(redirectUri).trim();
    if (scopes !== undefined) s.oidc.scopes = String(scopes).trim();
    if (emailList !== undefined) s.oidc.allowedEmails = emailList;
  });
  return oidcStatus();
}

export async function oidcStatus() {
  const { oidcConfig, configComplete } = await import('../../runtime/oidc.js');
  const cfg = await oidcConfig();
  const store = await loadStore();
  return {
    version: VERSION,
    complete: configComplete(cfg),
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri || '(按请求动态构造；回环部署自动适配)',
    scopes: cfg.scopes,
    allowedEmails: cfg.allowedEmails,
    source: {
      issuer: process.env.NXAS_OIDC_ISSUER ? 'env' : store.oidc.issuer ? 'store' : 'none',
      clientId: process.env.NXAS_OIDC_CLIENT_ID ? 'env' : store.oidc.clientId ? 'store' : 'none',
    },
    hasSessionSecret: Boolean(store.oidc.sessionSecret),
  };
}

// ---------- 零凭据探测（A01 白名单探测法） ----------

// 合法 redirect → 302 到 /login（client 存在）；伪造 redirect → 400。
// 用这对判据可以在没有任何凭据的情况下确认「client 已注册」。
export async function oidcProbe() {
  const { oidcConfig, configComplete, loadDiscovery, pkcePair } = await import('../../runtime/oidc.js');
  const cfg = await oidcConfig();
  const out = { complete: configComplete(cfg), issuer: cfg.issuer, clientId: cfg.clientId, checks: [] };
  if (!out.complete) {
    out.ok = false;
    out.checks.push({ name: 'config', ok: false, note: 'OIDC 未配置（nx-as oidc config set --issuer <url> --client-id <id>）' });
    return out;
  }
  try {
    await loadDiscovery(cfg);
    out.checks.push({ name: 'discovery', ok: true, note: `${cfg.issuer}/.well-known/openid-configuration 可达且 issuer 一致` });
  } catch (e) {
    out.ok = false;
    out.checks.push({ name: 'discovery', ok: false, note: e.message });
    return out;
  }
  const { challenge } = pkcePair();
  const probe = async (redirectUri) => {
    const u = new URL(`${cfg.issuer}/oauth2/auth`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', cfg.clientId);
    u.searchParams.set('scope', 'openid');
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return res.status;
  };
  try {
    const good = await probe('http://127.0.0.1:9/oidc/callback');
    const clientExists = good === 302 || good === 303; // 未登录也会先 302 到 /login
    out.checks.push({ name: 'client', ok: clientExists, note: clientExists ? 'client 已注册（合法 redirect 放行）' : `client 不存在或被禁用（HTTP ${good}）` });
    if (clientExists) {
      const bad = await probe('http://evil.example.com/cb');
      out.checks.push({ name: 'whitelist', ok: bad === 400, note: bad === 400 ? '伪造 redirect 被拒（白名单生效）' : `伪造 redirect 返回 HTTP ${bad}（异常）` });
      // 一致性核心：本部署**实际生效**的 redirect_uri（env 配置的公网地址）必须已被 go-ah 注册，
      // 否则线上登录会在回调一步 400——启动自检与排障时把这种漂移暴露出来
      if (cfg.redirectUri) {
        const st = await probe(cfg.redirectUri);
        const okUri = st === 302 || st === 303;
        out.checks.push({
          name: 'redirect_uri',
          ok: okUri,
          note: okUri ? `生效回调已注册: ${cfg.redirectUri}` : `生效回调未被 go-ah 接受（HTTP ${st}）：补 go-ah 白名单或改 NXAS_OIDC_REDIRECT_URI`,
        });
      }
    }
  } catch (e) {
    out.ok = false;
    out.checks.push({ name: 'client', ok: false, note: `探测失败: ${e.message}` });
    return out;
  }
  out.ok = out.checks.every((c) => c.ok);
  return out;
}

// ---------- 注册 client（一次性；管理员凭据换 idp_session cookie） ----------

// 登录 go-ah → POST /api/admin/clients。redirect_uris 缺省给回环端口通配两条
// （go-ah 对 127.0.0.1/localhost 支持 :* 端口通配、path 须一致），另加 --redirect-uri 传入的公网地址。
export async function oidcRegister({ username, password, issuer, redirectUris = [], clientName = 'nx-as' }) {
  if (!username || !password) throw badInput('缺少 go-ah 管理员账号（--username / --password，或交互输入）');
  const base = String(issuer || process.env.NXAS_OIDC_ISSUER || '').replace(/\/+$/, '');
  if (!base) throw badInput('缺少 --issuer（go-ah 地址，如 http://47.110.80.47:8082）');
  const loginRes = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(10000),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || (loginBody.code !== undefined && loginBody.code !== 0)) {
    throw Object.assign(new Error(`go-ah 登录失败: ${loginBody.message || `HTTP ${loginRes.status}`}`), { code: 'UNAUTHORIZED' });
  }
  const cookies = (loginRes.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0].trim()).filter(Boolean);
  if (!cookies.length) throw Object.assign(new Error('go-ah 登录未返回会话 cookie'), { code: 'EXTERNAL' });

  const uris = [...new Set([
    'http://127.0.0.1:*/oidc/callback',
    'http://127.0.0.1:*/_nxas/oidc/callback', // nginx 模式：回调带 /_nxas 前缀
    'http://localhost:*/oidc/callback',
    ...redirectUris.map((u) => String(u).trim()).filter(Boolean),
  ])];
  const logoutUris = [...new Set(uris
    .filter((u) => !u.includes(':*'))
    .map((u) => { try { return new URL(u).origin + '/'; } catch { return null; } })
    .filter(Boolean))];
  const body = {
    client_id: 'nx-as',
    client_name: clientName,
    redirect_uris: uris,
    scopes: ['openid', 'profile', 'email'],
    is_public: true,
    pkce_required: true,
    enabled: true,
    post_logout_uris: logoutUris,
  };
  const res = await fetch(`${base}/api/admin/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookies.join('; ') },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  const failed = !res.ok || (data.code !== undefined && data.code !== 0);
  if (failed) {
    throw Object.assign(new Error(`注册 client 失败: ${data.message || data.error || `HTTP ${res.status}`}`), {
      code: data.error === 'conflict' || /已存在/.test(data.message || '') ? 'CONFLICT' : 'EXTERNAL',
    });
  }
  appendAuditSafe('auth.oidc_register', { issuer: base, redirect_uris: uris });
  return { issuer: base, clientId: body.client_id, redirectUris: uris, postLogoutUris: logoutUris };
}

// ---------- CLI 交互输入（隐藏回显） ----------

export async function promptHidden(question) {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // 隐藏回显：关掉 output 回写（密码不进终端）
  const { stdout } = await import('node:process');
  const origWrite = stdout.write.bind(stdout);
  rl.output.write = () => true;
  process.stderr.write(question);
  const answer = await rl.question('');
  rl.output.write = origWrite;
  rl.close();
  process.stderr.write('\n');
  return answer;
}

// sha256 hex（probe/展示用的小工具；与旧 secretsEqual 无关——静态密钥已废除）
export function sha256hex(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}
