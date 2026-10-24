// 浏览器 SSO 配对（回环 handoff）：本机起一次性监听 → 打开浏览器走 nx-as 的
// /oidc/login?cli=http://127.0.0.1:<port>/done → 远端登录完成后 302 回传会话 token。
// nx-as login（CLI）与 client 域配对（nx-as client login / 面板按钮）共用这一份。
import { createServer } from 'node:http';

// 可达性预检：跳浏览器前先探 server 是否活着（公开探针 /api/auth/verify，与 client doctor 同款）。
// 不预检的代价：地址打错/容器没起/安全组没放行时，浏览器打开一个死链、本函数干等 5 分钟
// 才报「登录超时」——用户拿不到可行动的错误。网络层失败立即报错并给出排查顺序；
// 拿到任何 HTTP 响应都算可达（路径/登录问题交给后续 SSO 流程）。
async function probeReachable(base) {
  try {
    await fetch(`${base}/api/auth/verify`, { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    throw Object.assign(new Error(
      `无法连接 ${base}（${e.message}）。排查：① server 地址是否正确（nginx 部署通常以 /_nxas 结尾）`
      + ` ② gost-as/nx-as 容器是否在跑（docker compose ps） ③ 防火墙/安全组是否放行面板端口`,
    ), { code: 'EXTERNAL' });
  }
}

/**
 * @param {{server: string, open?: boolean, timeoutMs?: number}} opts
 * @returns {Promise<{token: string}>}
 */
export async function ssoHandoff({ server, open = true, timeoutMs = 5 * 60_000 } = {}) {
  const base = String(server || '').replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(base)) {
    throw Object.assign(new Error(`server 地址不合法: ${server || '(空)'}`), { code: 'INVALID_INPUT' });
  }
  await probeReachable(base);
  return new Promise((resolve, reject) => {
    let settled = false;
    const l = createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/done') {
        res.writeHead(404);
        return res.end();
      }
      const token = u.searchParams.get('token') || '';
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setTimeout(() => l.close(), 100).unref();
        if (token.startsWith('nxas_s2.')) resolve({ token });
        else reject(new Error('SSO 回传缺少有效会话 token'));
      };
      if (token.startsWith('nxas_s2.')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<meta charset="utf-8"><title>nx-as 配对</title><p style="font-family:system-ui">登录成功，回到终端/面板继续。</p>');
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<meta charset="utf-8"><title>nx-as 配对</title><p>回传内容不是有效会话，回去重试。</p>');
      }
      done();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      l.close();
      reject(Object.assign(new Error(`登录超时（${Math.round(timeoutMs / 60000)} 分钟内未完成浏览器 SSO）`), { code: 'EXTERNAL' }));
    }, timeoutMs);
    l.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(`本机回环监听失败: ${e.message}`), { code: 'INTERNAL' }));
    });
    l.listen(0, '127.0.0.1', async () => {
      const loginUrl = `${base}/oidc/login?cli=${encodeURIComponent(`http://127.0.0.1:${l.address().port}/done`)}`;
      console.log(`[sso] 浏览器打开单点登录（go-ah；完成后自动返回）：\n${loginUrl}`);
      if (open) {
        try {
          const { openBrowser } = await import('./open.js');
          openBrowser(loginUrl);
        } catch { /* 打不开浏览器时用户手点上面链接 */ }
      }
    });
  });
}

/** 用会话 token 换身份（server /api/auth/me；失败返回 null 不阻塞配对）。 */
export async function fetchIdentity(server, token) {
  try {
    const r = await fetch(`${String(server).replace(/\/+$/, '')}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
