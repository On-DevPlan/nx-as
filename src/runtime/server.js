import http from 'node:http';

export function startServer({ port = 7801, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        const { handleApi } = await import('./api.js');
        return await handleApi(req, res, url);
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
