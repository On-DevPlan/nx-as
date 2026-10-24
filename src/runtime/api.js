// HTTP 路由：由 action.http 编译，与 CLI 同源
// 鉴权中间件在这里做（所有 action 之前）；SSE action 特殊放行
import { requireSession } from './session.js';

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
  ['GET', '/api/auth/verify'],  // 存活探针（entrypoint 就绪探测 / client doctor）
  ['GET', '/api/bootstrap'],    // 端口协商探测签名（serve-port.js 认领「是不是自己」；内容无敏感字段）
];

function isPublic(action) {
  return PUBLIC_PATHS.some(([m, p]) => action.http[0] === m && action.http[1] === p);
}

// 鉴权：统一会话（OIDC SSO 登录签发）——Bearer 头（CLI/脚本）或 cookie（浏览器）。
// 静态管理密钥方案已废除：不再有 runtime token / store 密钥可比对。
async function authorized(req) {
  return Boolean(await requireSession(req));
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Origin 校验（写操作的纵深防御）。
 *
 * 管理面 API 是 Bearer-only（token 在 localStorage，不随请求自动携带），所以跨站请求
 * 天然打不进来——这层校验是纵深而非唯一防线。规则：
 *   ① 无 Origin → 放行（curl/CLI 等非浏览器客户端）
 *   ② 浏览器自带的 Sec-Fetch-Site：same-origin / none → 放行，其余（cross-site 等）→ 拒
 *   ③ 兜底按 Origin 解析：loopback → 放行；与 Host 头同源 → 放行（面板挂在
 *      https://domain/_nxas/panel 时同源 POST 不再被误杀——旧实现只认 loopback，
 *      nginx 模式公网部署所有写操作 403）；其余 → 拒（跨站）
 * @returns {boolean} true=放行
 */
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none';
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false; // Origin 非法
  }
  if (LOOPBACK_HOSTS.has(host)) return true;
  const reqHost = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === reqHost;
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
      return sendJson(res, 401, { ok: false, error: '未登录或会话已过期（访问 /oidc/login 走 go-ah 单点登录）', code: 'UNAUTHORIZED' });
    }
  }

  // Origin 校验（写操作的纵深防御；非浏览器客户端无 Origin 放行，同源放行——见 originAllowed）
  if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req)) {
    return sendJson(res, 403, { ok: false, error: `跨站 Origin 被拒绝: ${req.headers.origin}`, code: 'BLOCKED' });
  }

  // ctx 拼装：路径占位符 → query → body，无条件合并
  const m = path.match(hit.regex);
  const raw = {};
  hit.keys.forEach((k, i) => {
    raw[k] = decodeURIComponent(m[i + 1]);
  });
  // 会话身份注入 ctx（auth.me 等 action 用；公开路径无会话则为 null）
  raw.session = isPublic(hit.action) ? null : await requireSession(req);
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

export async function serveStatic(pathname, res, req) {
  // 静态资源只读：非 GET/HEAD 一律 405（POST / 面板路径没有意义，收紧面）
  if (req && req.method && !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    return res.end('method not allowed');
  }
  const { join, dirname, extname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  // 构建产物在仓库根 public/（vite outDir；构建产物不进 src/，git 不入库、npm 随包分发）
  const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
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
