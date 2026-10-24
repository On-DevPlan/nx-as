// CLI 会话凭据（~/.nx-as/credentials.json，0600）：
// nx-as login 通过浏览器 SSO handoff 拿到的会话 token 落这里，供 CLI/脚本静默使用。
// 这不是静态服务器密钥（那个方案已废除）——token 由 SSO 登录签发、7 天过期、
// 可用 auth rotate 全端吊销；本机落盘与旧方案的信任边界一致（同机用户可读）。
import { fsp } from './store.js';
import { appDirFromEnv } from './paths.js';
import { join } from 'node:path';

export function credentialsPath() {
  return join(appDirFromEnv(), 'credentials.json');
}

const EMPTY = () => ({ version: 1, entries: [] });

// entries[]: { server, token, identity: {sub,email,name}, obtainedAt }
export async function loadCredentials() {
  try {
    const raw = await fsp.readFile(credentialsPath(), 'utf8');
    const data = JSON.parse(raw);
    return { ...EMPTY(), ...data, entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    return EMPTY();
  }
}

export async function saveCredentials(data) {
  const p = credentialsPath();
  await fsp.mkdir(join(p, '..'), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(data, null, 2), 'utf8', { mode: 0o600 });
  await fsp.chmod(p, 0o600).catch(() => {});
  return data;
}

// 记录一次登录（同 server 覆盖旧条目）
export async function rememberCredential({ server, token, identity }) {
  const data = await loadCredentials();
  const entry = {
    server,
    token,
    identity: identity || null,
    obtainedAt: new Date().toISOString(),
  };
  const rest = data.entries.filter((e) => e.server !== server);
  await saveCredentials({ version: 1, entries: [...rest, entry] });
  return entry;
}

// server 归一化：/_nxas 前缀差异与尾斜杠不影响匹配（同一 server 的两种写法算同一条）
export function normalizeServer(server) {
  return String(server || '').replace(/\/_nxas\/?$/, '').replace(/\/+$/, '');
}

// 取某个 server 的会话 token；没有匹配条目时回落最近一条（单人本机语义）
export async function credentialFor(server) {
  const data = await loadCredentials();
  const want = normalizeServer(server);
  return data.entries.find((e) => normalizeServer(e.server) === want && want)
    || data.entries[data.entries.length - 1]
    || null;
}

// 供 CLI 命令解析会话 token：--token 参数 > NXAS_SESSION > credentials.json（最近一条）
export async function resolveSessionToken(override) {
  if (override) return override;
  if (process.env.NXAS_SESSION) return process.env.NXAS_SESSION;
  const entry = await credentialFor(process.env.NXAS_SERVER_URL || '');
  return entry?.token || null;
}

export async function forgetCredentials(server) {
  const data = await loadCredentials();
  if (!server) return { removed: data.entries.length, entries: [] };
  const rest = data.entries.filter((e) => e.server !== server);
  await saveCredentials({ version: 1, entries: rest });
  return { removed: data.entries.length - rest.length, entries: rest };
}
