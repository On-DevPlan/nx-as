import http from 'node:http';

// 网关模式：direct（默认，进程内反代 /m/v1）| nginx（nginx auth_request 委托，本进程只挂
// /auth/check + 签发端点，数据路径由 nginx 直代 pi-web）
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
      if (url.pathname.startsWith('/api/')) {
        const { handleApi } = await import('./api.js');
        return await handleApi(req, res, url);
      }
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

