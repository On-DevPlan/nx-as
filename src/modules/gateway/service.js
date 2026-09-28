// 设备 token：签发 / 校验 / 吊销 + 配对码
// token 格式: nxas_d1.<deviceId>.<secret 64hex>
// 存储: store.devices[] = { id, tokenHash(sha256(secret)), name, createdAt, lastUsedAt, revokedAt }
// 明文 secret 只在签发响应里出现一次；校验走 timingSafeEqual（抗时序侧信道）
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { loadStore, mutateStore } from '../../core/store.js';
import { badInput, notFound } from '../../core/errors.js';
import { appendAudit } from '../../core/audit.js';

const PAIR_TTL_MS = 5 * 60_000;

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest();
}

export function secretsEqual(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

// ---------- device token ----------

export async function issueToken({ name }) {
  if (!name || typeof name !== 'string' || name.length > 64) {
    throw badInput('缺少设备名 --name（64 字符内）');
  }
  const id = 'dev_' + randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const token = `nxas_d1.${id}.${secret}`;
  await mutateStore((s) => {
    s.devices.push({
      id,
      tokenHash: sha256(secret).toString('hex'),
      name,
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    });
  });
  appendAudit({ action: 'device.issue', detail: { deviceId: id, name } }).catch(() => {});
  return { token, device: { id, name } };
}

// 校验 Bearer 凭据；成功返回设备记录（含 id/name），失败返回 null。
// 节流式 last_used 更新：距上次 ≥60s 才写一次 store（避免每请求全文件写）。
export async function verifyDeviceToken(header) {
  const m = /^Bearer (nxas_d1\.([a-z0-9_]+)\.([0-9a-f]{64}))$/i.exec(header || '');
  if (!m) return null;
  const [, , deviceId, secret] = m;
  const store = await loadStore();
  const dev = (store.devices || []).find((d) => d.id === deviceId);
  if (!dev || dev.revokedAt) return null;
  // 库里存的就是 sha256(secret) hex——直接 timingSafeEqual 逐字节比（等长恒定时间）
  const input = sha256(secret);
  const stored = Buffer.from(dev.tokenHash, 'hex');
  if (input.length !== stored.length || !timingSafeEqual(input, stored)) return null;
  if (!dev.lastUsedAt || Date.now() - dev.lastUsedAt >= 60_000) {
    await mutateStore((s) => {
      const d = s.devices.find((x) => x.id === deviceId);
      if (d) d.lastUsedAt = Date.now();
    }).catch(() => {});
  }
  return { id: dev.id, name: dev.name };
}

export async function listDevices() {
  const store = await loadStore();
  return (store.devices || []).map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    lastUsedAt: d.lastUsedAt,
    revoked: Boolean(d.revokedAt),
  }));
}

export async function revokeDevice({ id }) {
  if (!id) throw badInput('缺少设备 id');
  const store = await loadStore();
  const dev = (store.devices || []).find((d) => d.id === id);
  if (!dev) throw notFound(`设备不存在: ${id}`);
  if (dev.revokedAt) return { status: 'already_revoked', id };
  await mutateStore((s) => {
    const d = s.devices.find((x) => x.id === id);
    if (d) d.revokedAt = Date.now();
  });
  appendAudit({ action: 'device.revoke', detail: { deviceId: id } }).catch(() => {});
  return { status: 'ok', id };
}

// ---------- 配对码 ----------

// CLI 生成配对码：8 位数字，5 分钟有效、单次使用。存内存（进程内消费，重启即失效——
// 配对是短窗操作，持久化反而扩大攻击面；pairCodes 由 runtime 层持有，serve 与 CLI 直连同进程）
const pairCodes = new Map(); // code -> { deviceName, expiresAt, used }

export function pairCreate({ name }) {
  if (!name || typeof name !== 'string' || name.length > 64) {
    throw badInput('缺少设备名 --name（64 字符内）');
  }
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  pairCodes.set(code, { deviceName: name, expiresAt: Date.now() + PAIR_TTL_MS, used: false });
  // 顺手清理过期码
  for (const [k, v] of pairCodes) {
    if (v.expiresAt < Date.now()) pairCodes.delete(k);
  }
  return { code, name, expiresInMs: PAIR_TTL_MS };
}

// HTTP 兑换：配对码 → 长期 token。错误统一抛 INVALID_INPUT（不区分「码错/过期/已用」，
// 避免给猜码者反馈差异）。兑换成功即消费配对码。
export async function pairRedeem({ code }) {
  const rec = pairCodes.get(String(code || ''));
  if (!rec || rec.used || rec.expiresAt < Date.now()) {
    pairCodes.delete(String(code || ''));
    throw badInput('配对码无效或已过期');
  }
  rec.used = true;
  pairCodes.delete(String(code || ''));
  const r = await issueToken({ name: rec.deviceName });
  appendAudit({ action: 'device.pair_redeem', detail: { deviceId: r.device.id, name: r.device.name } }).catch(() => {});
  return r;
}
