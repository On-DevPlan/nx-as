import http from 'node:http';

// 网关模式：direct（默认，进程内反代 /m/v1）| nginx（nginx auth_request 委托）
//
// nginx 模式的路径契约（v0.5.3）：nx-as 自有功能全部收进 /_nxas/ 特殊前缀，
// 其余一切路径原样留给 pi-web（pi-web 零改动、零感知，它的 /login、/api/*、
// /_next/* 与直跑根路径完全一致）。
//
//   /_nxas/auth/check        nginx auth_request 委托端点
//   /_nxas/auth/login  POST  登录换会话 cookie
//   /_nxas/login   GET      登录页（?next= 回跳）
//   /_nxas/api/*             nx-as 管理面 API（设备/nginx/证书/settings）
//   /_nxas/m/v1/*            手机 API（ticket、sessions、agent…）
//
// direct 模式路径不变：/api/*、/m/v1/*、/auth/check、/login（无前缀，向后兼容）。
export function gwMode() {
  return process.env.NXAS_GW_MODE === 'nginx' ? 'nginx' : 'direct';
}

// nginx 模式下把任意路径归一成 nx-as 内部路径：
//   /_nxas/auth/login → /auth/login（session.js/api.js 的路由不变，只剥前缀）
function stripPrefix(pathname) {
  return pathname.slice('/_nxas'.length) || '/';
}

export function startServer({ port = 7801, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const nginxMode = gwMode() === 'nginx';

      // ── /auth/check：两种模式都保留原路径（nginx 模板引用，兼容旧部署）──
      if (url.pathname === '/auth/check' || (nginxMode && url.pathname === '/_nxas/auth/check')) {
        const { handleAuthCheck } = await import('./gateway/check.js');
        return await handleAuthCheck(req, res, url);
      }

      // ── nginx 模式：/_nxas/* 前缀下是 nx-as 的一切 ──
      if (nginxMode && (url.pathname === '/_nxas' || url.pathname.startsWith('/_nxas/'))) {
        const inner = stripPrefix(url.pathname);
        const innerUrl = new URL(req.url.replace(url.pathname, inner), `http://${req.headers.host || 'localhost'}`);

        if (inner === '/auth/login' && req.method === 'POST') {
          const { handleLogin } = await import('./gateway/session.js');
          return await handleLogin(req, res);
        }
        if (inner === '/login' && req.method === 'GET') {
          const { handleLoginPage } = await import('./gateway/session.js');
          return await handleLoginPage(req, res, innerUrl.searchParams.get('next') || '/');
        }
        if (inner.startsWith('/api/')) {
          const { handleApi } = await import('./api.js');
          return await handleApi(req, res, innerUrl);
        }
        // 手机 API：/m/v1/* 全量走 gateway 逻辑（ticket/反代……）
        // 注意：nginx 模式下 gateway 的反代目标也是 pi-web /api/*，与 direct 一致
        if (inner === '/m/v1' || inner.startsWith('/m/v1/')) {
          const { handleGateway } = await import('./gateway/proxy.js');
          return await handleGateway(req, res, innerUrl);
        }
        // 其余 /_nxas/* 未知路径 → 404 JSON（不落 SPA）
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'no such route', code: 'NOT_FOUND' }));
      }

      // ── direct 模式（或 nginx 直连 7801 的旧路径兼容）：无前缀原路由 ──
      if (!nginxMode) {
        if (url.pathname === '/auth/login' && req.method === 'POST') {
          const { handleLogin } = await import('./gateway/session.js');
          return await handleLogin(req, res);
        }
        if (url.pathname === '/login' && req.method === 'GET') {
          const { handleLoginPage } = await import('./gateway/session.js');
          return await handleLoginPage(req, res, url.searchParams.get('next') || '/');
        }
        if (url.pathname.startsWith('/api/')) {
          const { handleApi } = await import('./api.js');
          return await handleApi(req, res, url);
        }
        if (url.pathname === '/m/v1' || url.pathname.startsWith('/m/v1/')) {
          const { handleGateway } = await import('./gateway/proxy.js');
          return await handleGateway(req, res, url);
        }
      } else {
        // nginx 模式直连 7801 的兼容路径（本机调试用）：/api/*、/m/v1/* 仍可用
        if (url.pathname.startsWith('/api/')) {
          const { handleApi } = await import('./api.js');
          return await handleApi(req, res, url);
        }
        if (url.pathname === '/m/v1' || url.pathname.startsWith('/m/v1/')) {
          const { handleGateway } = await import('./gateway/proxy.js');
          return await handleGateway(req, res, url);
        }
      }

      const { serveStatic } = await import('./api.js');
      return await serveStatic(url.pathname, res);
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
