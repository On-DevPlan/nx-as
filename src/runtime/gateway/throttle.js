// 认证失败指数退避（移植 pi-web lib/auth-throttle.ts 的参数与语义）
// - 基数 1s、上限 60s、5 分钟无失败后清零
// - reset 窗口必须大于最大延迟，否则等一次封锁就能重置回基数（送爆破窗口）
// 双键改造：key 由调用方给（认证前 = 客户端 IP；认证后 = tokenId∥IP）——
// pi-web 全局单键是因为本机单用户；网关公网多设备，全局封锁会互相连坐。

export const THROTTLE_BASE_DELAY_MS = 1_000;
export const THROTTLE_MAX_DELAY_MS = 60_000;
const THROTTLE_RESET_AFTER_MS = 5 * 60_000;

const state = new Map(); // key -> { failures, lastFailureAt, blockedUntil }
const THROTTLE_MAX_ENTRIES = 10_000;

// 超过上限时只淘汰最旧条目（Map 按插入序），不整表 clear——
// 整表清空会瞬间解封所有键（含正常用户），制造全局短窗口。
function evictIfOverflowing() {
  let excess = state.size - THROTTLE_MAX_ENTRIES;
  if (excess <= 0) return;
  for (const k of state.keys()) {
    state.delete(k);
    if (--excess <= 0) break;
  }
}

function entry(key) {
  let s = state.get(key);
  if (!s) {
    s = { failures: 0, lastFailureAt: 0, blockedUntil: 0 };
    state.set(key, s);
  }
  return s;
}

function expireIfStale(s, now) {
  if (s.failures > 0 && now - s.lastFailureAt >= THROTTLE_RESET_AFTER_MS) {
    s.failures = 0;
    s.lastFailureAt = 0;
    s.blockedUntil = 0;
  }
}

export function backoffDelayMs(failures) {
  if (failures <= 0) return 0;
  const exponent = Math.min(failures - 1, 31);
  return Math.min(THROTTLE_BASE_DELAY_MS * 2 ** exponent, THROTTLE_MAX_DELAY_MS);
}

// 还要等多久（0 = 可尝试）
export function retryAfterMs(key, now = Date.now()) {
  const s = entry(key);
  expireIfStale(s, now);
  return Math.max(0, s.blockedUntil - now);
}

// 记录一次失败，返回下次封锁时长
export function recordFailure(key, now = Date.now()) {
  const s = entry(key);
  expireIfStale(s, now);
  s.failures += 1;
  s.lastFailureAt = now;
  const delay = backoffDelayMs(s.failures);
  s.blockedUntil = now + delay;
  evictIfOverflowing(); // 兜底：IP 造假洪泛时淘汰最旧条目
  return delay;
}

// 测试辅助
export function resetThrottle() {
  state.clear();
}
