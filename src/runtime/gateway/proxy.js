// 网关 HTTP 层（direct 模式）：/m/v1/* 的中间件链 + 到 pi-web 的反代
//
// 中间件顺序对齐 pi-web proxy.ts：
//   ① source-check（Host 白名单，GW_ALLOWED_HOSTS 环境变量；默认仅 localhost/loopback/IP）
//   ② 节流（认证前按 IP）
//   ③ 短票端点（SSE events 走一次性票）
//   ④ device-auth（Bearer → store 校验）——决策逻辑在 check.js（与 nginx 模式的 /auth/check 共享）
//   ⑤ 审计 + 反代（注入 Authorization: Basic pi:<机机密码>，机机密码与 pi-web PI_WEB_PASSWORD 同源）
//
// nginx 模式（NXAS_GW_MODE=nginx）下本模块不挂载：数据路径由 nginx 直代 pi-web，
// nx-as 只暴露 /auth/check（check.js）与签发端点。
import http from 'node:http';
import { appendAudit } from '../../core/audit.js';
import { issueTicket } from './tickets.js';
import { retryAfterMs } from './throttle.js';
import { decide } from './check.js';

// ---------- 机机密码 ----------
// 与 pi-web 的 PI_WEB_PASSWORD 同源：store.machineSecret（launcher spawn pi-web 时注入）。
// 容器启动后同步预热（阻塞 < 100ms），保证第一批请求立即可用。
let cachedMachineSecret = '';
async function warmMachineSecret() {
  const { loadStore } = await import('../../core/store.js');
  const store = await loadStore();
  cachedMachineSecret = store.machineSecret || '';
}
warmMachineSecret().catch(() => {});

export function machineAuthHeader() {
  // pi-web 的 Basic 用户名固定 'pi'（lib/web-auth.ts PI_WEB_AUTH_USERNAME）
  return `Basic ${Buffer.from(`pi:${cachedMachineSecret}`).toString('base64')}`;
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
  try {
    return await _handleGateway(req, res, url);
  } catch (err) {
    console.error('NXAS_TRACE', err.stack);
    throw err;
  }
}
async function _handleGateway(req, res, url) {
  const ip = clientIp(req);

  // 路径解析：/m/v1/xxx → 上游 /api/xxx（pi-web 的 API 前缀收敛到这里）
  const sub = url.pathname.slice('/m/v1'.length) || '/';
  const upstreamPath = '/api' + sub;

  // ②/⑤ 节流前置查询（认证前的键是 IP）
  const blockMs = retryAfterMs(`ip:${ip}`);
  if (blockMs > 0) {
    return sendJson(res, 429, { ok: false, error: 'Too many failed attempts' }, { 'Retry-After': String(Math.max(1, Math.ceil(blockMs / 1000))) });
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
  //
  // basePath 是**客户端看到的前缀**（见 server.js）：nginx 模式为 '/_nxas'，direct 模式为空。
  // 回给客户端的 url 必须带这个前缀，否则手机端拿到 /m/v1/... 会打到根路径
  // （nginx 模式下落到 pi-web 登录页，表现为「跟随后拿到 200 text/html」的假成功）。
  const ticketMatch = /^\/sessions\/([^/]+)\/ticket$/.exec(sub);
  if (req.method === 'POST' && ticketMatch) {
    const basePath = process.env.NXAS_GW_MODE === 'nginx' ? '/_nxas' : '';
    const sid = decodeURIComponent(ticketMatch[1]);
    const ticket = issueTicket(sid);
    return sendJson(res, 200, {
      url: `${basePath}/m/v1/agent/${encodeURIComponent(sid)}/events?ticket=${encodeURIComponent(ticket)}`,
      expiresInMs: 60_000,
    });
  }

  // ⑥ 审计 + 反代
  // 短票通道**也注入**机机 Basic：票已在 decide() 消费（一次性 + 会话绑定），本身即授权证明，
  // 注入的 Basic 是 nx-as↔pi-web 的内部机机信任，不回传客户端。不注入的话上游
  // pi-web /api/agent/:id/events 会 401（它认 Basic 或浏览器 cookie，二者都没有）——
  // 短票通道实际上从来打不通（2026-09-29 线上实测确认）。安全边界不变：
  // 客户端拿不到 Basic（只进上游请求头），且票仍只能打开「签发时绑定」的那个会话。
  const viaTicket = device.ticket === true
    || String(req.headers['x-auth-cred'] || '').toLowerCase() === 'ticket';
  appendAudit({ action: 'gw.proxy', deviceId: device.id, viaTicket, detail: { method: req.method, path: url.pathname } }).catch(() => {});
  return proxyToUpstream(req, res, upstreamPath);
}

// ---------- 反代（流式管道） ----------

function proxyToUpstream(req, res, upstreamPath) {
  const { host, port } = upstreamUrl();
  const headers = { ...req.headers };
  headers.host = `${host}:${port}`;
  delete headers['x-auth-cred']; // nx-as 内部头，不外传
  // 鉴权已在 decide() 通过：注入 nx-as↔pi-web 内部机机信任（只进上游头、不回传客户端），
  // 覆盖掉客户端自带的 Authorization。裸请求在 decide() 即被 401，到不了这里。
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
