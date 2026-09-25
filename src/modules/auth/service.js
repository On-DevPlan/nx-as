import { mutateStore, loadStore } from '../../core/store.js';
import { badInput, unauthorized } from '../../core/errors.js';
import { randomBytes } from 'node:crypto';

// 单用户密钥：store.json 里存一个 token；来源优先级 CLI/环境变量 > store
// 本机文件场景，token 明文落 store.json 可接受（与 ~/.ssh 私钥同级别的信任边界）

export async function ensureToken(override) {
  if (override) return override;
  if (process.env.NX_AS_TOKEN) return process.env.NX_AS_TOKEN;
  const store = await loadStore();
  if (store.auth.token) return store.auth.token;
  // 自动生成并落盘（首次 serve 无 token 时）
  const token = 'nxas_' + randomBytes(24).toString('hex');
  await mutateStore((s) => {
    s.auth.token = token;
  });
  return token;
}

export async function verifyToken(candidate) {
  if (!candidate) throw unauthorized();
  const expected = await ensureToken(null);
  if (candidate !== expected) throw unauthorized('密钥不匹配');
  return { valid: true };
}

export async function rotateToken() {
  const token = 'nxas_' + randomBytes(24).toString('hex');
  await mutateStore((s) => {
    s.auth.token = token;
  });
  return { token, note: '旧密钥立即失效；所有已登录的 App 需要更新密钥' };
}

export async function authStatus() {
  const store = await loadStore();
  const token = store.auth.token;
  return {
    configured: Boolean(token || process.env.NX_AS_TOKEN),
    source: process.env.NX_AS_TOKEN ? 'env' : token ? 'store' : 'none',
    masked: mask(token || process.env.NX_AS_TOKEN || ''),
  };
}

export function mask(token) {
  if (!token) return '';
  if (token.length <= 10) return token.slice(0, 2) + '****';
  return token.slice(0, 8) + '****' + token.slice(-4);
}

export function assertTokenProvided(ctx) {
  if (!ctx.token) throw badInput('缺少 --token（rotate 之后所有端点用新密钥）');
  return ctx.token;
}
