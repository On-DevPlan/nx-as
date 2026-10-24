// 统一会话：OIDC SSO 登录后的凭据载体（浏览器 cookie + CLI/脚本 Bearer 双载体）
//
// 登录链路（人的访问唯一入口）：
//   GET /login   → 302 /oidc/login（原路径保留：nginx error_page 兼容）
//   GET /oidc/login   → 302 go-ah 授权页（state+PKCE 装签名短时 cookie）
//   GET /oidc/callback← go-ah 回调：code 换 token → userinfo → 签会话 + 上游代签
//   GET /auth/logout  → 清会话 cookie
//
// 会话格式: nxas_s2.<b64url(JSON{sub,email,name,exp})>.<HMAC(sessionSecret)>
//   sessionSecret 持久化 store（重启不掉线；auth rotate 轮换即全端下线）
//   无服务端会话表：单条吊销不支持，全端下线 = rotate（个人工具取舍）
//
// 节流：登录失败与网关 /m/v1 共用同一 `ip:` 桶（指数退避），登录成功落审计
import { createHmac, timingSafeEqual } from 'node:crypto';
import { retryAfterMs, recordFailure } from './gateway/throttle.js';
import { appendAudit } from '../core/audit.js';
import { safeNext, safeCliHandoff } from './oidc.js';

const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 天
export const SESSION_COOKIE = 'nxas_session';
const STATE_COOKIE_NAME = 'nxas_oidc';

// ---------- 签发 / 校验 ----------

async function sign(payload) {
  const { ensureSessionSecret } = await import('../modules/auth/service.js');
  return createHmac('sha256', await ensureSessionSecret()).update(payload).digest('hex');
}

// 签发：返回 cookie 值（调用方负责 Set-Cookie 头）。identity = {sub,email,name}
export async function issueSessionCookie(identity) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = 'nxas_s2.' + Buffer.from(
    JSON.stringify({ sub: identity.sub, email: identity.email || '', name: identity.name || '', exp }),
  ).toString('base64url');
  return { value: `${payload}.${await sign(payload)}`, maxAgeSec: SESSION_TTL_SEC };
}

// 校验：返回 identity 或 null（过期/篡改/格式错一律 null）
export async function verifySessionToken(value) {
  if (typeof value !== 'string') return null;
  const m = /^(nxas_s2\.([A-Za-z0-9_-]+))\.([0-9a-f]{64})$/.exec(value);
  if (!m) return null;
  // 三个捕获组：m[1]=完整 payload（含前缀）、m[2]=b64 段、m[3]=签名
  const [, payload, , sig] = m;
  const expected = await sign(payload);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.slice('nxas_s2.'.length), 'base64url').toString('utf8'));
    if (!data || typeof data.exp !== 'number' || data.exp * 1000 < Date.now() || !data.sub) return null;
    return { sub: String(data.sub), email: data.email || '', name: data.name || '' };
  } catch {
    return null;
  }
}

// 统一入口：Bearer 头（CLI/脚本）优先，其次会话 cookie（浏览器）
export async function requireSession(req) {
  const bearer = /^Bearer (nxas_s2\.[A-Za-z0-9_-]+\.[0-9a-f]{64})$/.exec(req.headers.authorization || '');
  if (bearer) return verifySessionToken(bearer[1]);
  return verifySessionToken(sessionFromCookieHeader(req.headers.cookie));
}

// 从 Cookie 头解析 nxas_session 值
export function sessionFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader);
  return m ? decodeURIComponent(m[1]) : null;
}

function cookieAttributes(req) {
  // Secure 标志：经 HTTPS 反代（X-Forwarded-Proto: https）时才加——纯 HTTP 本机直连
  // 加了浏览器就不发 cookie，登录直接坏；由部署拓扑决定而不是一刀切
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

// ---------- 客户端 IP / 节流 ----------

function clientIpOf(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------- 上游会话代签（pi-web bootstrap；机机信任与 OIDC 正交，原样保留） ----------

async function bootstrapUpstreamCookies() {
  if (process.env.NXAS_BOOTSTRAP === '0') return [];
  try {
    const upstreamPort = process.env.NXAS_TARGET_PORT || '30141';
    const bootstrapPath = process.env.NXAS_BOOTSTRAP_PATH || '/api/web-auth';
    const { loadStore } = await import('../core/store.js');
    const store = await loadStore();
    const secret = store.machineSecret || '';
    const r = await fetch(`http://127.0.0.1:${upstreamPort}${bootstrapPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${upstreamPort}` },
      body: JSON.stringify({ password: secret }),
    });
    const setCookie = r.headers.getSetCookie?.() || [];
    if (setCookie.length) {
      console.log(`[nx-as] bootstrap: 上游会话已代签（${bootstrapPath}，${setCookie.length} cookie）`);
    }
    return setCookie.map((c) => c.replace(/;\s*$/, ''));
  } catch (e) {
    // 主程序不支持 bootstrap（非 pi-web / 无需登录）——静默跳过，不影响 nx-as 登录
    console.log(`[nx-as] bootstrap 跳过（上游无会话端点）：${e.message}`);
    return [];
  }
}

// ---------- 登录链路端点 ----------

// GET /oidc/login（?next= 回跳站内路径；?cli= 本机回环 CLI handoff）
export async function handleOidcLogin(req, res, url, nginxMode) {
  const { oidcConfig, configComplete, pkcePair, newState, authorizeUrl, buildRedirectUri, issueStateCookie } =
    await import('./oidc.js');
  const cfg = await oidcConfig();
  if (!configComplete(cfg)) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: false,
      error: 'OIDC 未配置：先 nx-as oidc config set --issuer <go-ah地址> --client-id nx-as（并完成 go-ah 侧 client 注册，nx-as oidc register）',
      code: 'INVALID_INPUT',
    }));
  }
  const ip = clientIpOf(req);
  const blockedMs = retryAfterMs(`ip:${ip}`);
  if (blockedMs > 0) {
    res.writeHead(429, { 'Retry-After': String(Math.max(1, Math.ceil(blockedMs / 1000))) });
    return res.end('Too many failed attempts');
  }
  const state = newState();
  const { verifier, challenge } = pkcePair();
  const next = safeNext(url.searchParams.get('next'));
  const cli = safeCliHandoff(url.searchParams.get('cli'));
  const redirectUri = buildRedirectUri(req, cfg, nginxMode);
  const { value, maxAgeSec } = await issueStateCookie({ state, verifier, next, cli, redirectUri });
  const target = await authorizeUrl({ redirectUri, state, challenge });
  res.writeHead(302, {
    Location: target,
    'Set-Cookie': `${STATE_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`,
    'Cache-Control': 'no-store',
  });
  res.end();
}

// GET /oidc/callback?code=&state=（base：nginx 模式传 /_nxas，错误页链接要用）
export async function handleOidcCallback(req, res, url, base = '') {
  const {
    readStateCookie, clearStateCookie, exchangeCode, fetchIdentity,
  } = await import('./oidc.js');
  const ip = clientIpOf(req);
  const clearCookie = clearStateCookie();

  const st = await readStateCookie(req.headers.cookie);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!st || !code || state !== st.state) {
    appendAudit({ action: 'oidc.login_fail', detail: { ip, reason: 'state 校验失败' } }).catch(() => {});
    recordFailure(`ip:${ip}`);
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' });
    // base 由 server.js 传入（'' 或 '/_nxas'），可控可插值；此页必须是模板字符串——
    // 单引号字符串里的 ${base} 不会插值，「重新登录」链接会变成字面量死链
    return res.end(`<!doctype html><meta charset="utf-8"><title>nx-as 登录失败</title><p>登录状态校验失败（state 不匹配/已过期，或登录回调链接被重复使用——回调一次性）。请从头重新登录。<a href="${base}/oidc/login">重新登录</a></p>`);
  }

  try {
    const { accessToken } = await exchangeCode({ code, verifier: st.verifier, redirectUri: st.redirectUri });
    const identity = await fetchIdentity(accessToken);

    // 白名单用生效值（env NXAS_OIDC_ALLOWED_EMAILS 覆盖 store——gost-as 公网部署在 compose 设）
    const { oidcConfig } = await import('./oidc.js');
    const allow = (await oidcConfig()).allowedEmails;
    if (allow.length && identity.email && !allow.includes(identity.email.toLowerCase())) {
      appendAudit({ action: 'oidc.login_fail', detail: { ip, reason: 'email 不在白名单', email: identity.email } }).catch(() => {});
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' });
      // 可行动的错误页：告诉用户两条加白名单的途径（面板 store / compose env），而不只说被拒
      const safeEmail = String(identity.email || '').replace(/[<>&"]/g, '');
      return res.end(`<!doctype html><meta charset="utf-8"><title>nx-as 登录被拒</title><p>该账号（${safeEmail}）不在 nx-as 登录白名单内。请管理员在面板「登录白名单」或部署环境变量 NXAS_OIDC_ALLOWED_EMAILS 中加入该邮箱后，再重新登录。</p>`);
    }

    const { value, maxAgeSec } = await issueSessionCookie(identity);
    const cookies = [
      `${SESSION_COOKIE}=${encodeURIComponent(value)}; ${cookieAttributes(req)}; Max-Age=${maxAgeSec}`,
      clearCookie,
    ];
    // 上游会话自动交接（0 感知登录）：nx-as 用机机信任代签 pi-web 的 cookie
    cookies.push(...(await bootstrapUpstreamCookies()));

    appendAudit({ action: 'oidc.login', detail: { ip, email: identity.email, sub: identity.sub, via: st.cli ? 'cli' : 'web' } }).catch(() => {});

    if (st.cli) {
      // CLI handoff：会话 token 经本机回环一次性回传（浏览器 → 127.0.0.1 临时监听）
      const target = new URL(st.cli);
      target.searchParams.set('token', value);
      res.writeHead(302, { Location: target.toString(), 'Set-Cookie': cookies, 'Cache-Control': 'no-store' });
      return res.end();
    }
    res.writeHead(302, { Location: st.next || '/', 'Set-Cookie': cookies, 'Cache-Control': 'no-store' });
    return res.end();
  } catch (e) {
    appendAudit({ action: 'oidc.login_fail', detail: { ip, reason: e.message } }).catch(() => {});
    const delay = recordFailure(`ip:${ip}`);
    res.writeHead(502, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': clearCookie,
      'Cache-Control': 'no-store',
      'Retry-After': String(Math.max(1, Math.ceil(delay / 1000))),
    });
    return res.end(`<!doctype html><meta charset="utf-8"><title>nx-as 登录失败</title><p>SSO 登录失败：${String(e.message).replace(/[<>&"]/g, '')}。<a href="${base}/oidc/login">重试</a></p>`);
  }
}

// GET /auth/logout（面板登出按钮与 /oidc/logout 别名都落这里）
export async function handleLogout(req, res) {
  const identity = await requireSession(req);
  appendAudit({ action: 'oidc.logout', detail: { ip: clientIpOf(req), sub: identity?.sub || '' } }).catch(() => {});
  res.writeHead(302, {
    Location: '/',
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    'Cache-Control': 'no-store',
  });
  res.end();
}

// GET /login（旧登录页路径；nginx error_page @nxas_login 仍指这里）→ 进 SSO
// base：nginx 模式下 /oidc/* 必须带 /_nxas 前缀才在代理路径里（否则落 catch-all 造成登录循环）
export async function handleLoginPage(req, res, nextUrl, base = '') {
  const safe = safeNext(nextUrl);
  const nextQ = safe === '/' ? '' : `?next=${encodeURIComponent(safe)}`;
  res.writeHead(302, { Location: `${base}/oidc/login${nextQ}`, 'Cache-Control': 'no-store' });
  res.end();
}
