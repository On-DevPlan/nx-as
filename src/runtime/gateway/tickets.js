// SSE 一次性短票：EventSource 不能带自定义 header 的解法
// 格式: t1.<过期毫秒>.<nonce 32hex>.<HMAC-SHA256 hex>
// 密钥 = 进程启动时随机生成（重启全员失效）；nonce 一次性（进程内 Set + 定期清理）
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TICKET_TTL_MS = 60_000;

// 进程级密钥与已用 nonce 集（模块单例）
const serverSecret = randomBytes(32);
const usedNonces = new Set();
let lastSweep = Date.now();

function sweep() {
  // 简单垃圾回收：集合过大时全量重置（票只有 60s 生命，重置窗口内过期的票本来也验不过时间）
  if (usedNonces.size > 10_000 || Date.now() - lastSweep > 10 * 60_000) {
    usedNonces.clear();
    lastSweep = Date.now();
  }
}

function sign(payload) {
  return createHmac('sha256', serverSecret).update(payload).digest('hex');
}

export function issueTicket() {
  sweep();
  const payload = `t1.${Date.now() + TICKET_TTL_MS}.${randomBytes(16).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}

// 校验 + 消费（一次性）。合法返回 true；非法/过期/重放返回 false。
// 时间/签名错误不区分（不给爆破者反馈差异），但重放必须在验签通过后拒绝。
export function verifyTicket(ticket) {
  if (typeof ticket !== 'string') return false;
  const m = /^(t1\.(\d+)\.([0-9a-f]{32}))\.([0-9a-f]{64})$/.exec(ticket);
  if (!m) return false;
  const [, payload, expStr, nonce, sig] = m;
  if (Number(expStr) < Date.now()) return false;
  if (!timingSafeEq(sig, sign(payload))) return false;
  if (usedNonces.has(nonce)) return false;
  usedNonces.add(nonce);
  return true;
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
