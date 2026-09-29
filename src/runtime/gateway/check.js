// 鉴权决策核心：direct 模式的中间件链与 nginx 模式的 /auth/check 委托端点共用这一份逻辑
//
// 决策输入：Authorization 头（device token）/ ticket（query 或头里的 X-Original-Uri）
// 决策输出：{ decision: 'allow', device } | { decision: 'deny-auth', retryAfterSec }
//          | { decision: 'throttled', retryAfterSec }
// 节流键：认证前 ip:*、认证后 tok:*（与 direct 模式同语义）
import { verifyDeviceToken } from '../../modules/gateway/service.js';
import { appendAudit } from '../../core/audit.js';
import { resolveTicket } from './tickets.js';
import { retryAfterMs, recordFailure } from './throttle.js';

// 从 URI 提取 SSE 短票与目标会话 id。
//
// 路径形态（两种模式都要认，否则票签了却永远验不过——这坑踩过一次）：
//   direct 模式原始 URI      : /m/v1/agent/:id/events?ticket=…
//   nginx 模式 auth_request 的 X-Original-Uri : /_nxas/m/v1/agent/:id/events?ticket=…
//     （server.js 在 stripPrefix 之前把用户实际请求的 URI 透传过来）
const TICKET_PATH_RE = /(?:\/_nxas)?(?:\/m\/v1)?\/agent\/([^/]+)\/events$/;

export function ticketFromUri(rawUri) {
  try {
    const u = new URL(rawUri || '', 'http://x');
    const m = TICKET_PATH_RE.exec(u.pathname);
    if (!m) return null;
    // 特殊路径段 '.' / '..' 会在 URL 解析时被规范化掉，不存在越界风险
    return { sessionId: decodeURIComponent(m[1]), ticket: u.searchParams.get('ticket') };
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

  // SSE 事件流短票（EventSource 无 header 场景）。票与会话绑定：只能用在自己签发的那个会话上
  const t = ticketFromUri(rawUri);
  if (t && t.ticket && resolveTicket(t.ticket, t.sessionId)) {
    return { decision: 'allow', device: { id: 'ticket', name: 'sse-ticket', ticket: true } };
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
    // 有凭据但凭据错误 → 记节流；完全无凭据（未登录浏览）→ 静默拒绝不计数
    // （页面加载几十个资源在登录前全部 401，若计数会把正常用户锁死）
    if (authorization) {
      const delay = recordFailure(`ip:${ip}`);
      appendAudit({ action: 'gw.auth_fail', detail: { ip, path: rawUri } }).catch(() => {});
      return { decision: 'deny-auth', retryAfterSec: Math.max(1, Math.ceil(delay / 1000)) };
    }
    return { decision: 'deny-auth', retryAfterSec: 0 };
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
    // X-Auth-Cred: ticket 让上游反代知道该用哪套凭据（短票不注入机机密码）
    res.writeHead(204, { 'X-Device-Id': r.device.id, 'X-Auth-Cred': r.device.ticket ? 'ticket' : 'machine' });
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
