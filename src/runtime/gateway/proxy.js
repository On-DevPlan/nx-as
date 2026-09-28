// 网关 HTTP 层（direct 模式）：/m/v1/* 的中间件链 + 到 pi-web 的反代
//
// 中间件顺序对齐 pi-web proxy.ts：
//   ① source-check（Host 白名单，GW_ALLOWED_HOSTS 环境变量；默认仅 localhost/loopback/IP）
//   ② 节流（认证前按 IP）
//   ③ 路由白名单（/m/v1/pair 免 Bearer；SSE events 走短票）
//   ④ device-auth（Bearer → store 校验）——决策逻辑在 check.js（与 nginx 模式的 /auth/check 共享）
//   ⑤ 审计 + 反代（注入 Authorization: Basic pi:<机机密码>，机机密码 serve 启动时随机生成）
//
// nginx 模式（NXAS_GW_MODE=nginx）下本模块不挂载：数据路径由 nginx 直代 pi-web，
// nx-as 只暴露 /auth/check（check.js）与签发端点。
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pairRedeem } from '../../modules/gateway/service.js';
import { appendAudit } from '../../core/audit.js';
import { issueTicket } from './tickets.js';
import { retryAfterMs } from './throttle.js';
import { decide } from './check.js';

// ---------- 机机密码（serve 进程内随机；每进程轮换） ----------

const machinePassword = randomBytes(32).toString('hex');
export function machineAuthHeader() {
  // pi-web 的 Basic 用户名固定 'pi'（lib/web-auth.ts PI_WEB_AUTH_USERNAME）
  return `Basic ${Buffer.from(`pi:${machinePassword}`).toString('base64')}`;
}

// ---------- 上游地址 ----------

export function upstreamUrl() {
  const port = process.env.NXAS_UPSTREAM_PORT || '30141';
  return { host: '127.0.0.1', port, target: `http://127.0.0.1:${port}` };
}

// ---------- ① Host 白名单 ----------

function allowedHosts() {
  const extra = (process.env.GW_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set(['127.0.0.1', 'localhost', '::1', '[::1]', ...extra]);
}

function isLoopback(host) {
  const h = (host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

export function hostAllowed(req) {
  const host = req.headers.host || '';
  if (isLoopback(host)) return true;
  return allowedHosts().has(host.toLowerCase());
}

function clientIp(req) {
  // 有可信反代（本机 Caddy/Nginx）时 XFF 第一跳可用；直连时 socket 地址最可靠
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function sendJson(res, status, data, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(data));
}

// ---------- /m/v1 分发入口 ----------

export async function handleGateway(req, res, url) {
  // ① 来源校验
  if (!hostAllowed(req)) {
    return sendJson(res, 403, { ok: false, error: 'Untrusted host', code: 'BLOCKED' });
  }
  const ip = clientIp(req);

  // 路径解析：/m/v1/xxx → 上游 /api/xxx（pi-web 的 API 前缀收敛到这里）
  const sub = url.pathname.slice('/m/v1'.length) || '/';
  const upstreamPath = '/api' + sub;

  // ②/⑤ 节流前置查询（认证前的键是 IP）
  const blockMs = retryAfterMs(`ip:${ip}`);
  if (blockMs > 0) {
    return sendJson(res, 429, { ok: false, error: 'Too many failed attempts' }, { 'Retry-After': String(Math.max(1, Math.ceil(blockMs / 1000))) });
  }

  // ③ 路由白名单
  if (req.method === 'POST' && sub === '/pair') {
    return handlePair(req, res, ip);
  }

  // ④ device-auth（决策逻辑与 nginx 模式 /auth/check 同源：check.js）
  const r = await decide({ authorization: req.headers.authorization, rawUri: url.pathname + url.search, ip });
  if (r.decision === 'throttled') {
    return sendJson(res, 429, { ok: false, error: 'Too many failed attempts' }, { 'Retry-After': String(r.retryAfterSec) });
  }
  if (r.decision === 'deny-auth') {
    return sendJson(res, 401, { ok: false, error: 'device token 缺失或无效', code: 'UNAUTHORIZED' }, { 'Retry-After': String(r.retryAfterSec) });
  }
  const device = r.device;

  // SSE 短票换取端点：POST /m/v1/sessions/:id/ticket（Bearer 已在上面验过）
  const ticketMatch = /^\/sessions\/([^/]+)\/ticket$/.exec(sub);
  if (req.method === 'POST' && ticketMatch) {
    const ticket = issueTicket();
    return sendJson(res, 200, {
      url: `/m/v1/agent/${ticketMatch[1]}/events?ticket=${encodeURIComponent(ticket)}`,
      expiresInMs: 60_000,
    });
  }

  // ⑥ 审计 + 反代
  appendAudit({ action: 'gw.proxy', deviceId: device.id, detail: { method: req.method, path: url.pathname } }).catch(() => {});
  return proxyToUpstream(req, res, upstreamPath);
}

// ---------- 配对兑换（唯一免 Bearer 路由） ----------

async function handlePair(req, res, ip) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 4096) req.destroy(); // 配对 body 不需要大
  });
  req.on('end', async () => {
    let code = '';
    try {
      code = String(JSON.parse(body || '{}').code || '');
    } catch { /* 落到下面统一报错 */ }
    try {
      const r = await pairRedeem({ code });
      appendAudit({ action: 'gw.pair_ok', detail: { ip, deviceId: r.device.id } }).catch(() => {});
      return sendJson(res, 200, r);
    } catch {
      const delay = recordFailure(`ip:${ip}`);
      appendAudit({ action: 'gw.pair_fail', detail: { ip } }).catch(() => {});
      return sendJson(res, 401, { ok: false, error: '配对码无效或已过期', code: 'UNAUTHORIZED' }, { 'Retry-After': String(Math.max(1, Math.ceil(delay / 1000))) });
    }
  });
}

// ---------- 反代（流式管道） ----------

function proxyToUpstream(req, res, upstreamPath) {
  const { host, port } = upstreamUrl();
  const headers = { ...req.headers };
  headers.host = `${host}:${port}`;
  headers.authorization = machineAuthHeader();
  delete headers['content-length']; // 管道转发时由 node 重算
  if (headers['x-forwarded-for']) headers['x-forwarded-for'] += `, ${req.socket.remoteAddress}`;
  else headers['x-forwarded-for'] = req.socket.remoteAddress || '';

  const upstreamReq = http.request(
    { host, port, method: req.method, path: upstreamPath + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res); // 流式透传（SSE 长连不缓冲）
    },
  );
  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: `pi-web 上游不可达: ${err.message}`, code: 'EXTERNAL' });
    } else {
      res.end();
    }
  });
  req.pipe(upstreamReq);
  // 客户端断开 → 断上游（SSE 取消语义）
  res.on('close', () => upstreamReq.destroy());
}
