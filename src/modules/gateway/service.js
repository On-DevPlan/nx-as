// 设备 token：直接签发 / 校验 / 吊销（无配对码——token 由管理员线下交付）
// token 格式: nxas_d1.<deviceId>.<secret 64hex>
// 存储: store.devices[] = { id, tokenHash, name, scope, createdAt, lastUsedAt, lastIp, lastUa, revokedAt }
// 明文 secret 只在签发响应里出现一次；校验走 timingSafeEqual（抗时序侧信道）
// scope: 'admin' | 'client'（缺省 admin 向后兼容；本阶段仅落字段+展示，不做端点级 RBAC）
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadStore, mutateStore } from '../../core/store.js';
import { badInput, notFound } from '../../core/errors.js';
import { appendAudit } from '../../core/audit.js';


function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest();
}

export function secretsEqual(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

const SCOPES = ['admin', 'client'];

// ---------- device token ----------

export async function issueToken({ name, scope = 'admin' }) {
  if (!name || typeof name !== 'string' || name.length > 64) {
    throw badInput('缺少设备名 --name（64 字符内）');
  }
  if (!SCOPES.includes(scope)) {
    throw badInput(`--scope 必须是 ${SCOPES.join('|')}，收到: ${scope}`);
  }
  const id = 'dev_' + randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const token = `nxas_d1.${id}.${secret}`;
  await mutateStore((s) => {
    s.devices.push({
      id,
      tokenHash: sha256(secret).toString('hex'),
      name,
      scope,
      createdAt: Date.now(),
      lastUsedAt: null,
      lastIp: null,
      lastUa: null,
      revokedAt: null,
    });
  });
  appendAudit({ action: 'device.issue', detail: { deviceId: id, name, scope } }).catch(() => {});
  return { token, device: { id, name, scope } };
}

// 校验 Bearer 凭据；成功返回设备记录（含 id/name/scope），失败返回 null。
// meta { ip, ua }：校验通过时一并记录最近使用来源（与 lastUsedAt 同用 60s 节流写）。
export async function verifyDeviceToken(header, meta = {}) {
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
      if (d) {
        d.lastUsedAt = Date.now();
        if (meta.ip) d.lastIp = String(meta.ip).slice(0, 64);
        if (meta.ua) d.lastUa = String(meta.ua).slice(0, 256);
      }
    }).catch(() => {});
  }
  return { id: dev.id, name: dev.name, scope: dev.scope || 'admin' };
}

// 设备存活回查（会话 cookie 校验用）：存在且未吊销 → true。
// 吊销语义 = 会话立即失效：session cookie 是无状态 HMAC，靠这条回查把「已发会话」锁死。
export async function isDeviceAlive(deviceId) {
  if (!deviceId) return false;
  const store = await loadStore();
  const dev = (store.devices || []).find((d) => d.id === deviceId);
  return Boolean(dev && !dev.revokedAt);
}

export async function listDevices() {
  const store = await loadStore();
  return (store.devices || []).map((d) => ({
    id: d.id,
    name: d.name,
    scope: d.scope || 'admin',
    createdAt: d.createdAt,
    lastUsedAt: d.lastUsedAt,
    lastIp: d.lastIp || null,
    lastUa: d.lastUa || null,
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

// 全部吊销：把所有未吊销设备一次性标记 revoked（面板「全部吊销」按钮；应急用）
export async function revokeAllDevices() {
  const store = await loadStore();
  const active = (store.devices || []).filter((d) => !d.revokedAt);
  if (!active.length) return { status: 'ok', revoked: 0 };
  await mutateStore((s) => {
    for (const d of s.devices) {
      if (!d.revokedAt) d.revokedAt = Date.now();
    }
  });
  appendAudit({ action: 'device.revoke_all', detail: { count: active.length } }).catch(() => {});
  return { status: 'ok', revoked: active.length };
}
