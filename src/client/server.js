// nx-as client serve：本地管理面 HTTP 服务
// - 只绑 127.0.0.1（本地工具，无鉴权层——不暴露公网）
// - /api/client/* ← CLIENT_ACTIONS（与 CLI 同一张表）
// - / ← 构建产物 public/client/（vite 第二 entry；未构建时给出提示页）
import http from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRoute, sortRoutes, applySpec } from '../runtime/spec.js';
import { CLIENT_ACTIONS } from './actions.js';
import { openBrowser } from '../core/open.js';

let compiled = null;
function routes() {
  if (!compiled) {
    compiled = sortRoutes(CLIENT_ACTIONS.filter((a) => a.http).map((a) => ({ action: a, ...compileRoute(a.http) })));
  }
  return compiled;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 10 * 1024 * 1024) reject(new Error('body 过大')); });
    req.on('end', () => {
      if (!buf.trim()) return resolveBody({});
      try { resolveBody(JSON.parse(buf)); } catch { reject(new Error('body 不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// 静态根：仓库根 public/（/assets/* 与 server 面板共享同一份产物）；
// SPA fallback：public/client/index.html（client 面板入口）
function clientStaticPaths() {
  const base = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
  return { base, fallback: join(base, 'client', 'index.html') };
}

async function serveStatic(pathname, res) {
  const fsp = (await import('node:fs/promises')).default;
  const { base, fallback } = clientStaticPaths();
  const rel = decodeURIComponent(pathname);
  const file = join(base, rel === '/' ? 'client/index.html' : rel);
  const resolved = await fsp.realpath(file).catch(() => null);
  if (!resolved || !resolved.startsWith(base)) {
    if (!extname(rel)) {
      const index = await fsp.readFile(fallback).catch(() => null);
      if (index) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(index);
      }
      // 面板未构建：给出可操作的提示页
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>nx-as client</title>
<body style="font-family:system-ui;max-width:560px;margin:12vh auto;padding:0 16px">
<h2>nx-as client 面板未构建</h2>
<p>执行 <code>pnpm build</code> 生成 <code>public/client/</code> 后刷新本页。</p>
<p>CLI 已可用：<code>nx-as client config / register / list / remote-list / start / doctor</code></p>
</body>`);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  res.writeHead(200, { 'Content-Type': types[extname(resolved)] || 'application/octet-stream' });
  res.end(await fsp.readFile(resolved));
}

export function startClientServer({ port = 7890, host = '127.0.0.1', open = true } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const method = req.method.toUpperCase();
      if (url.pathname.startsWith('/api/client/')) {
        const hit = routes().find((r) => r.method === method && r.regex.test(url.pathname));
        if (!hit) return sendJson(res, 404, { ok: false, error: `无此路由: ${method} ${url.pathname}`, code: 'NOT_FOUND' });
        const raw = {};
        const m = url.pathname.match(hit.regex);
        hit.keys.forEach((k, i) => { raw[k] = decodeURIComponent(m[i + 1]); });
        if (method === 'GET' || method === 'HEAD') {
          for (const [k, v] of url.searchParams) raw[k] = v;
        } else {
          Object.assign(raw, await readBody(req).catch(() => ({})));
        }
        try {
          const data = await hit.action.run(applySpec(hit.action, raw), { transport: 'http' });
          return sendJson(res, 200, data === undefined ? null : data);
        } catch (err) {
          const { httpStatusOf } = await import('../core/errors.js');
          return sendJson(res, httpStatusOf(err.code || 'INTERNAL'), { ok: false, error: err.message, code: err.code || 'INTERNAL' });
        }
      }
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end('method not allowed');
      }
      return await serveStatic(url.pathname, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message, code: 'INTERNAL' }));
    }
  });
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, host, () => {
      const url = `http://127.0.0.1:${port}/`;
      console.log(`nx-as client 面板: ${url}  (仅本机可访问)`);
      console.log('CLI: nx-as client config / register / list / remote-list / start / stop / doctor');
      console.log('提示: 面板里可填写 server 连接、注册隧道、点击打开 server 面板与各隧道公网 URL');
      if (open) openBrowser(url);
      ok(server);
    });
  });
}
