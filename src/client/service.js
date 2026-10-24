// nx-as client：本地侧服务（连接远程 gost-as server 的本地管理面）
//
// 职责（与 server 侧 src/modules/* 平行的独立顶层，不进 server 面板的 tab 体系）：
// - 连接配置：server API 地址 / 会话 token / relay 凭据（~/.nx-as/client.json）
//   会话 token 优先用显式配置；否则回落 credentials.json（nx-as login --server 落盘）
// - 本地隧道清单：name/local/public（同一文件持久化）
// - gost 进程管理：单进程聚合所有 -L rtcp 参数；清单变更自动重启；退出自动拉起
// - 远程调用：代理 server 的 /api/nginx/files（注册/删除/清单），token 只在本进程内使用
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fsp } from '../core/fs.js';
import { badInput, notFound } from '../core/errors.js';

export const CLIENT_CONFIG_PATH = process.env.NXAS_CLIENT_CONFIG
  || join(homedir(), '.nx-as', 'client.json');

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const PORT_RE = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

// ---------- 配置存取（原子写，与 store.json 同风格） ----------

const EMPTY = () => ({
  version: 1,
  server: { api: '', token: '' },          // 例: api=http://47.110.80.47:8090/_nxas
  relay: { url: '' },                       // 例: relay://gost:pass@47.110.80.47:8442
  gost: { bin: 'gost' },                    // PATH 上的 gost 或绝对路径
  tunnels: [],                              // { name, local, public }
});

function normalize(data) {
  const base = EMPTY();
  if (!data || typeof data !== 'object') return base;
  base.server = { ...base.server, ...(data.server || {}) };
  base.relay = { ...base.relay, ...(data.relay || {}) };
  base.gost = { ...base.gost, ...(data.gost || {}) };
  base.tunnels = Array.isArray(data.tunnels) ? data.tunnels : [];
  return base;
}

let cache = null;

export async function loadClientConfig() {
  if (cache) return cache;
  try {
    cache = normalize(JSON.parse(await fsp.readFile(CLIENT_CONFIG_PATH, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 与 server 侧 store 同红线：损坏不得静默清空
      throw Object.assign(new Error(`client 配置读取失败（${CLIENT_CONFIG_PATH}）: ${e.message}`), { code: 'INTERNAL' });
    }
    cache = normalize(null);
  }
  return cache;
}

export async function saveClientConfig(next) {
  const data = normalize(next);
  await fsp.mkdir(dirname(CLIENT_CONFIG_PATH), { recursive: true });
  const tmp = CLIENT_CONFIG_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, CLIENT_CONFIG_PATH);
  cache = data;
  return data;
}

export function resetClientConfigCache() {
  cache = null;
}

export async function updateClientConfig(patch) {
  const cur = structuredClone(await loadClientConfig());
  if (patch.server) cur.server = { ...cur.server, ...patch.server };
  if (patch.relay) cur.relay = { ...cur.relay, ...patch.relay };
  if (patch.gost) cur.gost = { ...cur.gost, ...patch.gost };
  if (patch.tunnels) cur.tunnels = patch.tunnels;
  return saveClientConfig(cur);
}

// ---------- 本地隧道清单 ----------

export async function addTunnel({ name, local, public: pub, upsert = false }) {
  if (!name || !NAME_RE.test(name)) throw badInput(`非法隧道名: ${JSON.stringify(name)}（字母数字._-，32 内）`);
  if (!PORT_RE(local)) throw badInput('本地端口必须是 1-65535 整数');
  const pubPort = pub ?? local;
  if (!PORT_RE(pubPort)) throw badInput('公网端口必须是 1-65535 整数');
  if (10000 + pubPort > 65535) throw badInput(`公网端口 ${pubPort} 过大（10000+pub 超出范围）`);
  const cur = await loadClientConfig();
  const exist = cur.tunnels.find((t) => t.name === name);
  if (exist && !upsert) throw badInput(`隧道已存在: ${name}（要改端口先注销再注册，或用接管语义）`);
  if (cur.tunnels.some((t) => t.name !== name && t.public === pubPort)) throw badInput(`公网端口已被占用: ${pubPort}`);
  if (cur.tunnels.some((t) => t.name !== name && t.local === local)) throw badInput(`本地端口已被占用: ${local}`);
  const tunnel = { name, local, public: pubPort };
  const tunnels = exist
    ? cur.tunnels.map((t) => (t.name === name ? tunnel : t)) // 接管：同名覆盖本地端口映射
    : [...cur.tunnels, tunnel];
  await updateClientConfig({ tunnels });
  await restartGost().catch(() => {}); // gost 不在时静默（register 只写清单，start 时拉起）
  return { ...tunnel, adopted: Boolean(exist) };
}

export async function removeTunnel({ name }) {
  const cur = await loadClientConfig();
  const t = cur.tunnels.find((x) => x.name === name);
  if (!t) throw notFound(`隧道不存在: ${name}`);
  await updateClientConfig({ tunnels: cur.tunnels.filter((x) => x.name !== name) });
  await restartGost().catch(() => {});
  return t;
}

export async function listTunnels() {
  const cur = await loadClientConfig();
  return cur.tunnels.map((t) => ({ ...t, gostPid: gostProc?.pid || null, gostRunning: Boolean(gostProc && !gostProc.killed) }));
}

// ---------- gost 进程管理（单进程聚合所有 -L） ----------

let gostProc = null;
let gostLastExit = null; // { code, signal, at }
let exitHookInstalled = false;

export function gostArgs() {
  return loadClientConfig().then((cur) => {
    if (!cur.relay.url) throw badInput('尚未配置 relay（nx-as client config --relay <url>）');
    const args = [];
    for (const t of cur.tunnels) {
      args.push('-L', `rtcp://127.0.0.1:${10000 + t.public}/127.0.0.1:${t.local}`);
    }
    if (!args.length) throw badInput('没有已注册的本地隧道');
    return [...args, '-F', cur.relay.url];
  });
}

export async function startGost({ fresh = false } = {}) {
  if (gostProc && !gostProc.killed && !fresh) {
    return { status: 'already_running', pid: gostProc.pid, tunnels: (await loadClientConfig()).tunnels.length };
  }
  await stopGost().catch(() => {});
  const cur = await loadClientConfig();
  const args = await gostArgs();
  gostProc = spawn(cur.gost.bin || 'gost', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  gostProc.stdout.on('data', (c) => process.stderr.write(`[gost] ${c}`));
  gostProc.stderr.on('data', (c) => process.stderr.write(`[gost] ${c}`));
  gostProc.on('exit', (code, signal) => {
    gostLastExit = { code, signal, at: Date.now() };
    gostProc = null;
  });
  // client 生命周期边界：client（serve 进程）退出时 gost 子进程随之消亡——
  // 「不需要注册时 client 完全不存在」意味着也不能留下孤儿隧道进程
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => { try { gostProc?.kill('SIGKILL'); } catch { /* already gone */ } });
  }
  return { status: 'started', pid: gostProc.pid, tunnels: cur.tunnels.length, args };
}

export async function restartGost() {
  return startGost({ fresh: true });
}

export async function stopGost() {
  if (!gostProc || gostProc.killed) return { status: 'not_running' };
  const pid = gostProc.pid;
  gostProc.kill('SIGTERM');
  return { status: 'stopped', pid };
}

export async function gostStatus() {
  const cur = await loadClientConfig();
  return {
    running: Boolean(gostProc && !gostProc.killed),
    pid: gostProc?.pid || null,
    lastExit: gostLastExit,
    tunnels: cur.tunnels.length,
    bin: cur.gost.bin || 'gost',
  };
}

// ---------- OIDC 配对：本地 ↔ 远程 nx-as（不再有独立 token——浏览器 SSO 形成配对） ----------

export async function pairWithServer({ server, open = true } = {}) {
  const { ssoHandoff, fetchIdentity } = await import('../core/sso-handoff.js');
  const { rememberCredential } = await import('../core/credentials.js');
  const cur = await loadClientConfig();
  const target = String(server || cur.server.api || '').replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(target)) {
    throw badInput('缺少 server 地址（--server http://<host>:<port>/[_nxas]，或先 client config set --server）');
  }
  const { token } = await ssoHandoff({ server: target, open });
  const identity = await fetchIdentity(target, token);
  await rememberCredential({ server: target, token, identity });
  if (target !== cur.server.api) {
    await updateClientConfig({ server: { api: target, token: '' } });
  }
  return { server: target, identity };
}

// 当前配对状态（面板/doctor 显示用）：有会话条目 + 身份
export async function pairingStatus() {
  const { credentialFor } = await import('../core/credentials.js');
  const cur = await loadClientConfig();
  const entry = await credentialFor(cur.server.api);
  return {
    server: cur.server.api || '',
    paired: Boolean(entry?.token),
    identity: entry?.identity || null,
    obtainedAt: entry?.obtainedAt || null,
  };
}

// ---------- 远程调用（代理 server 的 nx-as API；token 不出本进程边界以外） ----------
// SSO 时代 token = 会话 token（nxas_s2.*）：client.json 显式配置优先，
// 否则回落 credentials.json（nx-as login --server <同地址> 落盘的条目）。

async function resolveClientToken() {
  const cur = await loadClientConfig();
  if (cur.server.token) return cur.server.token;
  const { credentialFor } = await import('../core/credentials.js');
  const entry = await credentialFor((cur.server.api || '').replace(/\/_nxas\/?$/, ''));
  return entry?.token || null;
}

async function serverApi(method, path, body) {
  const cur = await loadClientConfig();
  const token = await resolveClientToken();
  if (!cur.server.api || !token) {
    throw badInput('尚未配置 server 连接（nx-as client config --server <api>，并用 nx-as login --server <api> 登录）');
  }
  const res = await fetch(cur.server.api + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `server HTTP ${res.status}`), { code: data.code || 'EXTERNAL' });
  return data;
}

// server 侧隧道清单（conf.d 里的 nxas-tunnel-*.conf）；公网端口从 conf 内容的 listen 提取
// （隧道名可含字母如 sqlh，文件名不一定带数字）
export async function remoteList() {
  const r = await serverApi('GET', '/api/nginx/files');
  const serverBase = (await loadClientConfig()).server.api || '';
  let host = '';
  try { host = new URL(serverBase.replace(/\/_nxas\/?$/, '')).hostname; } catch { /* keep empty */ }
  const tunnels = [];
  for (const f of (r.files || []).filter((f) => f.name.startsWith('nxas-tunnel-'))) {
    const m = /^nxas-tunnel-(.+)\.conf(\.disabled)?$/.exec(f.name);
    let pub = null;
    try {
      const content = (await serverApi('GET', `/api/nginx/files/${encodeURIComponent(f.name)}`)).content;
      pub = Number(/\blisten\s+(?:[\d.]*:)?(\d+)\s*;/.exec(content)?.[1]) || null;
    } catch { /* 内容读不到时只给名字 */ }
    tunnels.push({ name: m?.[1] || f.name, public: pub, enabled: f.enabled, size: f.size, mtimeMs: f.mtimeMs, url: pub ? `${host}:${pub}/` : null });
  }
  return { host, tunnels };
}

// 一键注册：server 侧用**服务端单一模板**生成 conf（失败不动本地，避免两侧不一致）
// → 本地加隧道 + 重启 gost。conf 模板不再嵌在客户端——保证鉴权链路与 server 路由同步演化。
export async function registerTunnel({ name, local, public: pub }) {
  const pubPort = pub ?? local;
  // server 先行（幂等写入；失败抛错且本地未动）→ 本地清单（同名=接管，幂等）→ gost 重启
  const r = await serverApi('POST', '/api/nginx/tunnel', { name, 'public-port': pubPort });
  const tunnel = await addTunnel({ name, local, public: pub, upsert: true });
  await restartGost().catch(() => {});
  return { tunnel, server: r, url: (await remoteList()).tunnels.find((t) => t.name === tunnel.name)?.url || null };
}

// 对账：本地清单 ∪ server 清单按名称对齐，标注每条的两侧状态。
// 这是面板「穿透隧道」表的唯一数据源——sqlh 这类「仅 server」条目一眼可见，
// 配合 register 的同名接管语义（upsert）即可把 server 侧既有隧道收进本地管理。
export async function reconcile() {
  const local = await listTunnels();
  const gost = await gostStatus();
  let remoteTunnels = [];
  let serverError = null;
  try {
    remoteTunnels = (await remoteList()).tunnels;
  } catch (e) {
    serverError = e.message;
  }
  const byName = new Map();
  for (const t of local) byName.set(t.name, { name: t.name, local: t.local, public: t.public, localSide: true, serverSide: false, enabled: null, url: null });
  for (const t of remoteTunnels) {
    const hit = byName.get(t.name);
    if (hit) {
      hit.serverSide = true;
      hit.enabled = t.enabled;
      hit.url = t.url;
      if (t.public && t.public !== hit.public) hit.portConflict = { server: t.public, local: hit.public };
    } else {
      byName.set(t.name, { name: t.name, local: null, public: t.public, localSide: false, serverSide: true, enabled: t.enabled, url: t.url });
    }
  }
  return {
    gost,
    serverError,
    rows: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function unregisterTunnel({ name }) {
  // server 先删（单一模板端点；不存在也继续）→ 本地清单移除 → gost 重启
  const server = await serverApi('POST', '/api/nginx/tunnel/remove', { name }).catch((e) => ({ error: e.message }));
  const removed = await removeTunnel({ name });
  await restartGost().catch(() => {});
  return { removed, server };
}

// 连接自检：server API 可达 + 会话有效 + relay 配置存在 + gost 二进制可用
export async function doctor() {
  const cur = await loadClientConfig();
  const checks = {};
  checks.config = Boolean(cur.server.api && cur.relay.url);
  if (cur.server.api) {
    try {
      const res = await fetch(cur.server.api + '/api/auth/verify', { signal: AbortSignal.timeout(5000) });
      const j = await res.json().catch(() => ({}));
      checks.server = j.valid === true ? 'ok' : `异常（valid:${j.valid}）`;
    } catch (e) {
      checks.server = `不可达: ${e.message}`;
    }
    const token = await resolveClientToken();
    if (token) {
      try {
        const res = await fetch(cur.server.api + '/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        checks.session = res.ok ? `ok（${(await res.json())?.email || ''}）` : '会话无效/过期（nx-as login 重新登录）';
      } catch (e) {
        checks.session = `会话校验失败: ${e.message}`;
      }
    } else {
      checks.session = '无会话（nx-as login --server ' + cur.server.api + '）';
    }
  } else {
    checks.server = '未配置';
    checks.session = '未配置';
  }
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(cur.gost.bin || 'gost', ['-V'], { stdio: 'ignore' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      p.on('error', reject);
    });
    checks.gostBin = 'ok';
  } catch (e) {
    checks.gostBin = `不可用（${e.message}）——安装 gost 或 nx-as client config --gost-bin <路径>`;
  }
  return { config: CLIENT_CONFIG_PATH, ...checks };
}
