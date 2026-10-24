// OIDC 授权码流程（对接 go-ah 认证中心）——人的凭据唯一入口
//
// 设计（对齐 go-ah/.claude/skills/integrate-go-ah-sso 硬约束）：
// - public client + PKCE S256，无 client_secret（go-ah token 端点本就不校验）
// - code 换 token 是服务端 back-channel 直连（可信传输），身份用 /oauth2/userinfo
//   解析（access_token 是 opaque，10min）——不需要 JWKS / JWT 验签
// - refresh_token 一律不落地：过期就重新走一次 302 授权（IdP 全局会话 30 天内无感跳转）
// - 只依赖 node:crypto + 全局 fetch，零新依赖
//
// 端点（go-ah，与 issuer 逐字同源）：
//   /.well-known/openid-configuration → 自举；/oauth2/auth、/oauth2/token、
//   /oauth2/userinfo、/oauth2/logout
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DISCOVERY_PATH = '/.well-known/openid-configuration';
const STATE_COOKIE = 'nxas_oidc';
const STATE_TTL_SEC = 600; // state/verifier 10 分钟有效（覆盖慢网登录）

// ---------- 配置解析（env > store；env 供容器部署免改 store） ----------

export async function oidcConfig() {
  const { loadStore } = await import('../core/store.js');
  const store = await loadStore();
  const o = store.oidc || {};
  const issuer = (process.env.NXAS_OIDC_ISSUER || o.issuer || '').replace(/\/+$/, '');
  const clientId = process.env.NXAS_OIDC_CLIENT_ID || o.clientId || '';
  const redirectUri = process.env.NXAS_OIDC_REDIRECT_URI || o.redirectUri || '';
  const scopes = process.env.NXAS_OIDC_SCOPES || o.scopes || 'openid profile email';
  // 登录白名单：env 覆盖 store（gost-as 公网部署在 compose 里设，面板改 store 只影响本机形态）
  const emailsEnv = (process.env.NXAS_OIDC_ALLOWED_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const allowedEmails = emailsEnv.length ? emailsEnv : (Array.isArray(o.allowedEmails) ? o.allowedEmails.map((x) => String(x).toLowerCase()) : []);
  return { issuer, clientId, redirectUri, scopes, allowedEmails };
}

export function configComplete(cfg) {
  return Boolean(cfg && cfg.issuer && cfg.clientId);
}

// ---------- discovery（成功才缓存，失败不缓存可重试——业务可能先于 IdP 启动） ----------

let discoveryCache = null;

export function resetDiscoveryCache() {
  discoveryCache = null;
}

export async function loadDiscovery(cfg) {
  if (discoveryCache) return discoveryCache;
  const res = await fetch(cfg.issuer + DISCOVERY_PATH, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw Object.assign(new Error(`发现文档拉取失败: HTTP ${res.status}`), { code: 'EXTERNAL' });
  const doc = await res.json();
  if (doc.issuer !== cfg.issuer) {
    throw Object.assign(
      new Error(`issuer 不一致：配置 ${cfg.issuer}，发现文档 ${doc.issuer}（必须逐字一致）`),
      { code: 'EXTERNAL' },
    );
  }
  discoveryCache = doc;
  return doc;
}

export async function endpoints() {
  const cfg = await oidcConfig();
  if (!configComplete(cfg)) {
    throw Object.assign(new Error('OIDC 未配置（nx-as oidc config set --issuer <url> --client-id <id>）'), {
      code: 'INVALID_INPUT',
    });
  }
  const doc = await loadDiscovery(cfg);
  return {
    cfg,
    authorize: doc.authorization_endpoint || `${cfg.issuer}/oauth2/auth`,
    token: doc.token_endpoint || `${cfg.issuer}/oauth2/token`,
    userinfo: doc.userinfo_endpoint || `${cfg.issuer}/oauth2/userinfo`,
    logout: doc.end_session_endpoint || `${cfg.issuer}/oauth2/logout`,
  };
}

// ---------- PKCE ----------

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ---------- redirect_uri 构造 ----------

// env 配置优先（公网部署精确匹配）；否则按请求动态构造：
//   proto = X-Forwarded-Proto（https 反代）或 http；host = Host 头；
//   nginx 模式补 /_nxas 前缀。回环部署落在 http://127.0.0.1:<port>/oidc/callback，
//   go-ah 对回环注册项支持端口通配。
export function buildRedirectUri(req, cfg, nginxMode) {
  if (cfg.redirectUri) return cfg.redirectUri;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers.host || '127.0.0.1';
  const prefix = nginxMode ? '/_nxas' : '';
  return `${proto}://${host}${prefix}/oidc/callback`;
}

// ---------- state cookie（防 CSRF + 携带 verifier/next/cli，无状态） ----------
// 格式: nxas_oidc.<exp秒>.<nonce>.<HMAC(payload)>；payload JSON base64url

async function sessionSecret() {
  const { ensureSessionSecret } = await import('../modules/auth/service.js');
  return ensureSessionSecret();
}

export async function issueStateCookie(data) {
  const secret = await sessionSecret();
  const exp = Math.floor(Date.now() / 1000) + STATE_TTL_SEC;
  const payload = b64url(JSON.stringify({ ...data, exp }));
  return {
    value: `${STATE_COOKIE}.${exp}.${payload}.${createHmac('sha256', secret).update(`${exp}.${payload}`).digest('hex')}`,
    maxAgeSec: STATE_TTL_SEC,
  };
}

export async function readStateCookie(cookieHeader) {
  // 头部形态: nxas_oidc=nxas_oidc.<exp>.<payload>.<sig>（值本身以名字开头，注意 name= 前缀）
  const m = /(?:^|;\s*)nxas_oidc=(nxas_oidc\.(\d{10})\.([A-Za-z0-9_-]+)\.([0-9a-f]{64}))$/.exec(cookieHeader || '');
  if (!m) return null;
  const [, , expStr, payload, sig] = m;
  if (Number(expStr) * 1000 < Date.now()) return null;
  const secret = await sessionSecret();
  const expected = createHmac('sha256', secret).update(`${expStr}.${payload}`).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function clearStateCookie() {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---------- 授权 URL ----------

export async function authorizeUrl({ redirectUri, state, challenge }) {
  const { authorize, cfg } = await endpoints();
  const u = new URL(authorize);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', cfg.scopes);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

// next 只允许站内相对路径（防开放重定向）；cli 只允许本机回环 handoff 地址
export function safeNext(next) {
  return typeof next === 'string' && /^\/(?!\/)/.test(next) ? next : '/';
}

export function safeCliHandoff(cli) {
  if (typeof cli !== 'string') return null;
  try {
    const u = new URL(cli);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'http:' || (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]')) return null;
    if (!u.pathname || u.pathname.includes('..')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function newState() {
  return randomBytes(16).toString('hex');
}

// ---------- token 交换 + 身份解析 ----------

export async function exchangeCode({ code, verifier, redirectUri }) {
  const { token, cfg } = await endpoints();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  const res = await fetch(token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw Object.assign(
      new Error(`code 换 token 失败: ${data.error || `HTTP ${res.status}`}`),
      { code: 'UNAUTHORIZED' },
    );
  }
  // refresh_token 一律不落地（平台硬约束）：这里取了也不用、不返回
  return { accessToken: data.access_token, idToken: data.id_token };
}

export async function fetchIdentity(accessToken) {
  const { userinfo } = await endpoints();
  const res = await fetch(userinfo, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`userinfo 失败: HTTP ${res.status}`), { code: 'UNAUTHORIZED' });
  }
  const u = await res.json();
  return {
    sub: String(u.sub || ''),
    email: u.email || '',
    name: u.name || u.preferred_username || u.email || u.sub || '',
  };
}
