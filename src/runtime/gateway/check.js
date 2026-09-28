// 鉴权决策核心：direct 模式的中间件链与 nginx 模式的 /auth/check 委托端点共用这一份逻辑
//
// 决策输入：Authorization 头（device token）/ ticket（query 或头里的 X-Original-Uri）
// 决策输出：{ decision: 'allow', device } | { decision: 'deny-auth', retryAfterSec }
//          | { decision: 'throttled', retryAfterSec }
// 节流键：认证前 ip:*、认证后 tok:*（与 direct 模式同语义）
import { verifyDeviceToken } from '../../modules/gateway/service.js';
import { appendAudit } from '../../core/audit.js';
import { verifyTicket } from './tickets.js';
import { retryAfterMs, recordFailure } from './throttle.js';

// 从 URI 提取 events 短票（/m/v1/agent/:id/events?ticket=...）
export function ticketFromUri(rawUri) {
  try {
    const u = new URL(rawUri || '', 'http://x');
    if (!/^\/agent\/[^/]+\/events$/.test(u.pathname)) return null;
    return u.searchParams.get('ticket');
  } catch {
    return null;
  }
}

/**
 * 纯决策函数（无 HTTP 语义）。
 * @param {{authorization?: string, cookieHeader?: string, rawUri?: string, ip?: string}} input
 */
export async function decide({ authorization, cookieHeader, rawUri, ip = 'unknown' }) {
  // 节流前置查询（认证前按 IP）
  const ipBlock = retryAfterMs(`ip:${ip}`);
  if (ipBlock > 0) {
    return { decision: 'throttled', retryAfterSec: Math.max(1, Math.ceil(ipBlock / 1000)) };
  }

  // SSE 事件流短票（EventSource 无 header 场景）
  const ticket = ticketFromUri(rawUri);
  if (ticket && verifyTicket(ticket)) {
    return { decision: 'allow', device: { id: 'ticket', name: 'sse-ticket' } };
  }

  // 登录会话 cookie（浏览器场景：登录一次，同源请求自动携带）
  const { sessionFromCookieHeader, verifySessionCookie } = await import('./session.js');
  const sessionDeviceId = verifySessionCookie(sessionFromCookieHeader(cookieHeader));
  if (sessionDeviceId) {
    return { decision: 'allow', device: { id: sessionDeviceId, name: 'session' } };
  }

  // device token
  const device = await verifyDeviceToken(authorization);
  if (!device) {
    const delay = recordFailure(`ip:${ip}`);
    appendAudit({ action: 'gw.auth_fail', detail: { ip, path: rawUri } }).catch(() => {});
    return { decision: 'deny-auth', retryAfterSec: Math.max(1, Math.ceil(delay / 1000)) };
  }

  // 认证后按 tokenId 查询（失效重放按设备封锁）
  const devBlock = retryAfterMs(`tok:${device.id}`);
  if (devBlock > 0) {
    return { decision: 'throttled', retryAfterSec: Math.max(1, Math.ceil(devBlock / 1000)) };
  }

  return { decision: 'allow', device };
}

// ---------- /auth/check 委托端点（nginx auth_request 目标；仅 loopback 语义） ----------
//
// auth_request 契约：2xx=放行（响应头可被 auth_request_set 捕获）、401/403=原样拒绝、
// 其余一律 500。所以节流状态用 403 + Retry-After 表达（429 语义在委托模式下为 403）。
export async function handleAuthCheck(req, res, url) {
  const rawUri = req.headers['x-original-uri'] || url.search || url.pathname || '';
  const ip = clientIpOf(req);
  const r = await decide({
    authorization: req.headers.authorization,
    cookieHeader: req.headers.cookie,
    rawUri,
    ip,
  });
  if (r.decision === 'allow') {
    res.writeHead(204, { 'X-Device-Id': r.device.id });
    res.end();
    return;
  }
  if (r.decision === 'deny-auth') {
    // auth_request 契约只接受 2xx/401/403（302 会变 500）；浏览器跳登录由
    // nginx 侧 error_page 401 => @nxas_login 完成（模板负责）
    res.writeHead(401, { 'Retry-After': String(r.retryAfterSec) });
    res.end();
    return;
  }
  res.writeHead(403, { 'Retry-After': String(r.retryAfterSec) });
  res.end();
}

function clientIpOf(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
