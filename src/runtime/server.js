import http from 'node:http';

// 网关模式：direct（默认，进程内反代 /m/v1）| nginx（nginx auth_request 委托，本进程只挂
// /auth/check + 签发端点，数据路径由 nginx 直代 pi-web）
//
// nginx 模式下 nginx 把签发类端点（/m/v1/pair、/m/v1/sessions/:id/ticket）直代到本进程
// 的 /m/v1/*；这些端点走与 direct 模式相同的代理逻辑（本身自带 Bearer/IP 校验），
// 不走 auth_request。其余 /m/v1/* 由 nginx 直代 pi-web（auth_request 已在本进程做决策）。
export function gwMode() {
  return process.env.NXAS_GW_MODE === 'nginx' ? 'nginx' : 'direct';
}

export function startServer({ port = 7801, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/auth/check') {
        const { handleAuthCheck } = await import('./gateway/check.js');
        return await handleAuthCheck(req, res, url);
      }
      // 登录：POST 换会话 cookie；GET 渲染极简登录页（浏览器 /pi/ 401 时 302 过来）
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
      // 签发类端点：两种模式都挂（nginx 直代到本进程）
      if (url.pathname === '/m/v1/pair'
          || /^\/m\/v1\/sessions\/[^/]+\/ticket$/.test(url.pathname)) {
        const { handleGateway } = await import('./gateway/proxy.js');
        return await handleGateway(req, res, url);
      }
      // 其余 /m/v1/*：仅 direct 模式进程内反代；nginx 模式下 nginx 已直代 pi-web
      if (gwMode() === 'direct' && (url.pathname === '/m/v1' || url.pathname.startsWith('/m/v1/'))) {
        const { handleGateway } = await import('./gateway/proxy.js');
        return await handleGateway(req, res, url);
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