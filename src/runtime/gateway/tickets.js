// SSE 事件流短票：EventSource 不能带自定义 header 的解法
//
// 与 device token / 会话 cookie 的区别：短票只授权「打开某一个会话的 SSE 流」。
// - 格式: t1.<会话id>.<过期毫秒>.<nonce 32hex>.<HMAC-SHA256 hex>
// - 会话 id 参与签名 → 票与目标会话绑定，泄漏也不能拿去读别的会话
// - 密钥 = 进程启动时随机生成（重启全员失效）
// - nonce 一次性：验过一次即失效（重放拒绝）
//
// 设计约束（踩过的坑，改动前先读）：
// - 短票进 URL，会落日志/Referer/浏览器历史，因此只用于「进 SSE 流」这一个动词，
//   且 TTL 60s + 一次性消费，把暴露窗口压到最小；**不要**扩用途。
// - 目录级失效（rotate 后让旧票全失效）刻意不做：需要把签发时刻也塞进 payload，
//   收益不抵复杂度。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TICKET_TTL_MS = 60_000;

// 进程级密钥与已用 nonce 集（模块单例）
const serverSecret = randomBytes(32);
const usedNonces = new Set();

// 消费即记，按「票的过期时刻」排队删除：只删已过期项的 nonce，
// 不会误放行仍在有效期内的重放（旧实现整表 clear 会打开这个窗口）
const expiryQueue = [];

function sweep(now = Date.now()) {
  while (expiryQueue.length && expiryQueue[0] <= now) {
    usedNonces.delete(expiryQueue.shift());
  }
}

const TICKET_RE = /^t1\.([A-Za-z0-9_-]{1,64})\.(\d+)\.([0-9a-f]{32})\.([0-9a-f]{64})$/;

function sign(payload) {
  return createHmac('sha256', serverSecret).update(payload).digest('hex');
}

/** 为某个会话签发一次性短票。sessionId 参与签名（URL 安全字符，直接内联）。 */
export function issueTicket(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw Object.assign(new Error('issueTicket 需要 sessionId（票必须绑定会话）'), { code: 'INVALID_INPUT' });
  }
  const now = Date.now();
  sweep(now);
  const payload = `t1.${sessionId}.${now + TICKET_TTL_MS}.${randomBytes(16).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * 校验 + 消费（一次性）。
 * 返回 { sessionId } 表示通过；null 表示非法/过期/重放/会话不匹配。
 * 不区分失败原因（不给爆破者反馈差异）；重放必须在验签通过后才可能拒绝。
 * @param {string} ticket
 * @param {string} [expectSessionId] 传入时校验票绑定的会话是否一致
 */
export function resolveTicket(ticket, expectSessionId) {
  if (typeof ticket !== 'string') return null;
  const m = TICKET_RE.exec(ticket);
  if (!m) return null;
  const [, sessionId, expStr, nonce, sig] = m;
  const exp = Number(expStr);
  if (exp < Date.now()) return null;
  if (!timingSafeEq(sig, sign(`t1.${sessionId}.${expStr}.${nonce}`))) return null;
  sweep();
  if (usedNonces.has(nonce)) return null;
  usedNonces.add(nonce);
  expiryQueue.push(exp);
  if (expectSessionId && expectSessionId !== sessionId) return null;
  return { sessionId };
}

/** 布尔便捷入口（不校验会话绑定）。 */
export function verifyTicket(ticket) {
  return resolveTicket(ticket) !== null;
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// 仅测试用：重置模块级状态（密钥保留，否则同进程内已签发的票语义会变）
export function __resetTicketsForTest() {
  usedNonces.clear();
  expiryQueue.length = 0;
}
