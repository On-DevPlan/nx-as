import http from 'node:http';

// 网关模式：direct（默认，进程内反代 /m/v1）| nginx（nginx auth_request 委托）
//
// nginx 模式的路径契约（v0.5.3）：nx-as 自有功能全部收进 /_nxas/ 特殊前缀，
// 其余一切路径原样留给主进程（pi-web 零改动、零感知，它的 /login、/api/*、
// /_next/* 与直跑根路径完全一致）。
//
//   /_nxas/auth/check        nginx auth_request 委托端点
//   /_nxas/auth/login  POST  登录换会话 cookie
//   /_nxas/login   GET      登录页（?next= 回跳）
//   /_nxas/api/*             nx-as 管理面 API（设备/nginx/证书/设置）
//   /_nxas/panel*            管理面板 SPA
//   /_nxas/m/v1/*            手机 API（ticket、sessions、agent…）
//
// direct 模式路径不变：/api/*、/m/v1/*、/auth/check、/login（无前缀，向后兼容）。
export function gwMode() {
  return process.env.NXAS_GW_MODE === 'nginx' ? 'nginx' : 'direct';
}

// 内层路径归一：/_nxas/auth/login → /auth/login（路由器只认无前缀形态，剥前缀即可）
function splitNamespace(pathname, nginxMode) {
  if (nginxMode && (pathname === '/_nxas' || pathname.startsWith('/_nxas/'))) {
    return { inner: pathname.slice('/_nxas'.length) || '/', namespaced: true };
  }
  return { inner: pathname, namespaced: false };
}

export function startServer({ port = 7801, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const nginxMode = gwMode() === 'nginx';
      const { inner, namespaced } = splitNamespace(url.pathname, nginxMode);
      // 剥前缀后的 URL（query 原样保留），给需要看完整路径的处理器用
      const innerUrl = namespaced
        ? new URL(req.url.replace(url.pathname, inner), `http://${req.headers.host || 'localhost'}`)
        : url;

      // ── 鉴权委托端点：两种模式都保留原路径（nginx 模板引用，兼容旧部署）──
      if (inner === '/auth/check') {
        const { handleAuthCheck } = await import('./gateway/check.js');
        return await handleAuthCheck(req, res, innerUrl);
      }
      // ── 登录（POST 换 cookie / GET 登录页）──
      if (inner === '/auth/login' && req.method === 'POST') {
        const { handleLogin } = await import('./gateway/session.js');
        return await handleLogin(req, res);
      }
      if (inner === '/login' && req.method === 'GET') {
        const { handleLoginPage } = await import('./gateway/session.js');
        return await handleLoginPage(req, res, innerUrl.searchParams.get('next') || '/');
      }
      // ── 管理面 API ──
      if (inner.startsWith('/api/')) {
        const { handleApi } = await import('./api.js');
        return await handleApi(req, res, innerUrl);
      }
      // ── 管理面板 SPA（面板自身有 TokenGate 管理密钥保护）──
      if (inner === '/panel' || inner.startsWith('/panel/')) {
        const { serveStatic } = await import('./api.js');
        return await serveStatic(inner === '/panel' ? '/' : inner.slice('/panel'.length), res, req);
      }
      // ── 手机 API：/m/v1/* 全量走 gateway 逻辑（ticket/反代……）──
      if (inner === '/m/v1' || inner.startsWith('/m/v1/')) {
        const { handleGateway } = await import('./gateway/proxy.js');
        return await handleGateway(req, res, innerUrl);
      }

      // ── /_nxas/* 下未知的路径 → 404 JSON（不落 SPA，命名空间内不藏页面）──
      if (namespaced) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'no such route', code: 'NOT_FOUND' }));
      }
      // ── 其余路径：direct 模式的面板 SPA / nginx 模式直连 7801 的兼容调试 ──
      const { serveStatic } = await import('./api.js');
      return await serveStatic(url.pathname, res, req);
    } catch (err) {
      // 兜底：处理器自己抛出的未捕获异常
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ ok: false, error: err.message, code: 'INTERNAL' }));
    }
  });
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, host, () => ok(server));
  });
}
