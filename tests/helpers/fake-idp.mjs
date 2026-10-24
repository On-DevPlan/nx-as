// 测试用假 IdP：模拟 go-ah 认证中心的最小 OIDC 面
// - discovery / authorize（redirect 白名单 + 回环端口通配，语义对齐 go-ah matchRedirectPattern）
// - token（校验 code 一次性 + redirect_uri 一致 + PKCE S256）
// - userinfo（Bearer access_token） / logout
// 只为单测/冒烟服务：登录+consent 在 fake 里折叠成「authorize 直接发码」
import { createHash } from 'node:crypto';
import http from 'node:http';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// go-ah 同款 redirect 白名单匹配：精确相等，或 loopback 端口通配（path 须一致）
export function matchRedirectPattern(pattern, uri) {
  if (pattern === uri) return true;
  let wildCard = '';
  if (pattern.includes('://127.0.0.1:*')) wildCard = '127.0.0.1';
  else if (pattern.includes('://localhost:*')) wildCard = 'localhost';
  else return false;
  const scheme = pattern.startsWith('https://') ? 'https' : 'http';
  const prefix = `${scheme}://${wildCard}:`;
  if (!uri.startsWith(prefix)) return false;
  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return false;
  const port = rest.slice(0, slash);
  const path = rest.slice(slash);
  if (!/^\d+$/.test(port)) return false;
  return pattern.slice(pattern.indexOf(':*', pattern.indexOf('://') + 3) + 2) === path;
}

export function startFakeIdp({ clients = {} } = {}) {
  // clients: { 'nx-as': ['http://127.0.0.1:*/oidc/callback', ...] }
  const codes = new Map(); // code -> { identity, challenge, redirectUri, clientId, used }
  const tokens = new Map(); // accessToken -> identity
  let loggedOut = 0;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://idp');
    // issuer/端点用实际监听地址（nx-as 会对 issuer 做逐字一致性校验）
    const port = server.address()?.port || 0;
    const base = `http://127.0.0.1:${port}`;
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (u.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth2/auth`,
        token_endpoint: `${base}/oauth2/token`,
        userinfo_endpoint: `${base}/oauth2/userinfo`,
        end_session_endpoint: `${base}/oauth2/logout`,
        jwks_uri: `${base}/.well-known/jwks.json`,
      });
    }

    if (u.pathname === '/oauth2/auth') {
      const clientId = u.searchParams.get('client_id') || '';
      const redirectUri = u.searchParams.get('redirect_uri') || '';
      const patterns = clients[clientId];
      if (!patterns) return json(400, { error: 'invalid client_id' });
      if (!patterns.some((p) => matchRedirectPattern(p, redirectUri))) {
        return json(400, { error: 'redirect_uri 未在客户端注册白名单内' });
      }
      if (u.searchParams.get('response_type') !== 'code') return json(400, { error: 'unsupported_response_type' });
      const challenge = u.searchParams.get('code_challenge') || '';
      const method = u.searchParams.get('code_challenge_method') || '';
      if (!challenge || method !== 'S256') return json(400, { error: 'PKCE required' });
      const identity = {
        sub: u.searchParams.get('fx_sub') || '42',
        email: u.searchParams.get('fx_email') || 'user@example.com',
        name: u.searchParams.get('fx_name') || 'Test User',
      };
      const code = `code_${Math.random().toString(36).slice(2)}`;
      codes.set(code, { identity, challenge, redirectUri, clientId, used: false, exp: Date.now() + 5 * 60_000 });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', u.searchParams.get('state') || '');
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }

    if (u.pathname === '/oauth2/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const code = codes.get(form.get('code') || '');
        const fail = (error) => json(400, { error });
        if (!code) return fail('invalid_grant: code 不存在');
        if (code.used) return fail('invalid_grant: code 已被使用');
        if (Date.now() > code.exp) return fail('invalid_grant: code 已过期');
        if (form.get('client_id') !== code.clientId) return fail('invalid_grant: client 不匹配');
        if (form.get('redirect_uri') !== code.redirectUri) return fail('invalid_grant: redirect_uri 不匹配');
        const verifier = form.get('code_verifier') || '';
        const expect = b64url(createHash('sha256').update(verifier).digest());
        if (expect !== code.challenge) return fail('invalid_grant: PKCE verifier 不匹配');
        code.used = true;
        const accessToken = `at_${Math.random().toString(36).slice(2)}`;
        tokens.set(accessToken, code.identity);
        return json(200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 600,
          // fake 不发可验签 JWT（nx-as 后端通道不依赖 id_token 验签，只透传）
          id_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.fakesig',
          scope: 'openid profile email',
        });
      });
      return;
    }

    if (u.pathname === '/oauth2/userinfo') {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const identity = m && tokens.get(m[1]);
      if (!identity) return json(401, { error: 'invalid_token' });
      return json(200, { sub: identity.sub, email: identity.email, name: identity.name, email_verified: true });
    }

    if (u.pathname === '/oauth2/logout') {
      loggedOut++;
      return json(200, { ok: true });
    }

    json(404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        issuer: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        stats: { get loggedOut() { return loggedOut; }, tokens },
      });
    });
  });
}
