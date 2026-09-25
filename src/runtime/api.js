// HTTP 路由：由 action.http 编译，与 CLI 同源
// 鉴权中间件在这里做（所有 action 之前）；SSE action 特殊放行

let compiled = null;

function routes() {
  if (!compiled) {
    const { ACTIONS } = requireActions();
    const { compileRoute, sortRoutes } = requireSpec();
    compiled = sortRoutes(
      ACTIONS.filter((a) => a.http).map((a) => ({ action: a, ...compileRoute(a.http) })),
    );
  }
  return compiled;
}

import { ACTIONS } from '../index.js';
function requireActions() {
  return { ACTIONS };
}
import { compileRoute, sortRoutes, applySpec } from './spec.js';
function requireSpec() {
  return { compileRoute, sortRoutes };
}

const PUBLIC_PATHS = [
  ['GET', '/api/auth/verify'], // App 验证密钥用；无 token 也能探活
];

function isPublic(action) {
  return PUBLIC_PATHS.some(([m, p]) => action.http[0] === m && action.http[1] === p);
}

// token 来源优先级：serve 启动参数/环境变量（存 runtimeState）> store 里的
let runtimeToken = null;
export function setRuntimeToken(token) {
  runtimeToken = token;
}

export function currentToken() {
  return runtimeToken;
}

async function authorized(req) {
  if (runtimeToken) {
    const auth = req.headers.authorization || '';
    return auth === `Bearer ${runtimeToken}`;
  }
  // serve 之前（单测直接调 handleApi）回落到 store
  const { ensureToken } = await import('../modules/auth/service.js');
  const token = await ensureToken(null);
  return (req.headers.authorization || '') === `Bearer ${token}`;
}

export async function handleApi(req, res, url) {
  const method = req.method.toUpperCase();
  const path = url.pathname;

  const hit = routes().find((r) => r.method === method && r.regex.test(path));
  if (!hit) {
    return sendJson(res, 404, { ok: false, error: `无此路由: ${method} ${path}`, code: 'NOT_FOUND' });
  }

  // 鉴权（在所有 action 之前；公开路径除外）
  if (!isPublic(hit.action)) {
    if (!(await authorized(req))) {
      return sendJson(res, 401, { ok: false, error: '密钥缺失或错误', code: 'UNAUTHORIZED' });
    }
  }

  // Origin 校验（写操作的纵深防御；非浏览器客户端无 Origin 放行）
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const host = new URL(origin).hostname;
        if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
          return sendJson(res, 403, { ok: false, error: `跨站 Origin 被拒绝: ${origin}`, code: 'BLOCKED' });
        }
      } catch {
        return sendJson(res, 403, { ok: false, error: `Origin 非法: ${origin}`, code: 'INVALID_INPUT' });
      }
    }
  }

  // ctx 拼装：路径占位符 → query → body，无条件合并
  const m = path.match(hit.regex);
  const raw = {};
  hit.keys.forEach((k, i) => {
    raw[k] = decodeURIComponent(m[i + 1]);
  });
  // Bearer 密钥注入 ctx（auth.verify 等公开路径靠它自证）
  const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (bearer) raw.token = bearer[1];
  if (method === 'GET' || method === 'HEAD') {
    for (const [k, v] of url.searchParams) raw[k] = v;
  } else {
    Object.assign(raw, await readBody(req).catch(() => ({})));
  }

  try {
    const ctx = applySpec(hit.action, raw);
    if (hit.action.sse) {
      // SSE action：action 自己写响应（注册事件流），不返回数据
      await hit.action.run(ctx, { transport: 'http', res });
      return;
    }
    const data = await hit.action.run(ctx, { transport: 'http' });
    sendJson(res, 200, data === undefined ? null : data);
  } catch (err) {
    const { httpStatusOf } = await import('../core/errors.js');
    const code = err.code || 'INTERNAL';
    sendJson(res, httpStatusOf(code), { ok: false, error: err.message, code });
  }
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 10 * 1024 * 1024) reject(new Error('body 过大'));
    });
    req.on('end', () => {
      if (!buf.trim()) return resolveBody({});
      try {
        resolveBody(JSON.parse(buf));
      } catch {
        reject(new Error('body 不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ---------- 静态服务 ----------

export async function serveStatic(pathname, res) {
  const { join, dirname, extname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');
  const fsp = (await import('node:fs/promises')).default;
  const rel = decodeURIComponent(pathname);
  const file = join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel);
  const resolved = await fsp.realpath(file).catch(() => null);

  // resolve 后前缀校验（防穿越）
  if (!resolved || !resolved.startsWith(PUBLIC_DIR)) {
    // SPA fallback：非文件路径回 index.html
    if (!extname(rel)) {
      const index = await fsp.readFile(join(PUBLIC_DIR, 'index.html')).catch(() => null);
      if (index) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(index);
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  const body = await fsp.readFile(resolved);
  res.writeHead(200, { 'Content-Type': types[extname(resolved)] || 'application/octet-stream' });
  res.end(body);
}
