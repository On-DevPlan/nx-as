// nx-as client：本地侧服务（连接远程 gost-as server 的本地管理面）
//
// 职责（与 server 侧 src/modules/* 平行的独立顶层，不进 server 面板的 tab 体系）：
// - 连接配置：server API 地址 / 管理密钥 / relay 凭据（~/.nx-as/client.json）
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

export async function addTunnel({ name, local, public: pub }) {
  if (!name || !NAME_RE.test(name)) throw badInput(`非法隧道名: ${JSON.stringify(name)}（字母数字._-，32 内）`);
  if (!PORT_RE(local)) throw badInput('本地端口必须是 1-65535 整数');
  const pubPort = pub ?? local;
  if (!PORT_RE(pubPort)) throw badInput('公网端口必须是 1-65535 整数');
  if (10000 + pubPort > 65535) throw badInput(`公网端口 ${pubPort} 过大（10000+pub 超出范围）`);
  const cur = await loadClientConfig();
  if (cur.tunnels.some((t) => t.name === name)) throw badInput(`隧道已存在: ${name}`);
  if (cur.tunnels.some((t) => t.public === pubPort)) throw badInput(`公网端口已被占用: ${pubPort}`);
  if (cur.tunnels.some((t) => t.local === local)) throw badInput(`本地端口已被占用: ${local}`);
  const tunnel = { name, local, public: pubPort };
  await updateClientConfig({ tunnels: [...cur.tunnels, tunnel] });
  await restartGost().catch(() => {}); // gost 不在时静默（register 只写清单，start 时拉起）
  return tunnel;
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

// ---------- 远程调用（代理 server 的 nx-as API；token 不出本进程边界以外） ----------

async function serverApi(method, path, body) {
  const cur = await loadClientConfig();
  if (!cur.server.api || !cur.server.token) {
    throw badInput('尚未配置 server 连接（nx-as client config --server <api> --token <tok>）');
  }
  const res = await fetch(cur.server.api + path, {
    method,
    headers: {
      Authorization: `Bearer ${cur.server.token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `server HTTP ${res.status}`), { code: data.code || 'EXTERNAL' });
  return data;
}

// server 侧隧道清单（conf.d 里的 nxas-tunnel-*.conf）
export async function remoteList() {
  const r = await serverApi('GET', '/api/nginx/files');
  const serverBase = (await loadClientConfig()).server.api || '';
  let host = '';
  try { host = new URL(serverBase.replace(/\/_nxas\/?$/, '')).origin; } catch { /* keep empty */ }
  return {
    host,
    tunnels: (r.files || [])
      .filter((f) => f.name.startsWith('nxas-tunnel-'))
      .map((f) => {
        const m = /^nxas-tunnel-(.+)\.conf(\.disabled)?$/.exec(f.name);
        const pub = Number(f.name.match(/-(\d+)\.conf/)?.[1] || 0) || null;
        return { name: m?.[1] || f.name, public: pub, enabled: f.enabled, size: f.size, mtimeMs: f.mtimeMs, url: pub ? `${host}:${pub}/` : null };
      }),
  };
}

// 一键注册：server 侧先写 conf（失败不动本地，避免两侧不一致）→ 本地加隧道 + 重启 gost
export async function registerTunnel({ name, local, public: pub }) {
  const pubPort = pub ?? local;
  const rtcpPort = 10000 + pubPort;
  const conf = `# nx-as gost-as 隧道: ${name}（本地 127.0.0.1:${local} → 公网 :${pubPort}）
# 由 nx-as client register 生成
server {
    listen ${pubPort};
    server_name _;

    location /_nxas/ {
        proxy_pass http://127.0.0.1:7801/_nxas/;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }

    location = /_tunnel_auth_${pubPort} {
        internal;
        proxy_pass http://127.0.0.1:7801/_nxas/auth/check;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Cookie $http_cookie;
        proxy_set_header X-Original-Uri $request_uri;
        proxy_set_header X-Original-Method $request_method;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    location @nxas_login_${pubPort} {
        return 302 /_nxas/login?next=$request_uri;
    }

    location / {
        auth_request /_tunnel_auth_${pubPort};
        auth_request_set $nxas_device $upstream_http_x_device_id;
        error_page 401 = @nxas_login_${pubPort};
        proxy_pass http://127.0.0.1:${rtcpPort};
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header X-Forwarded-For $remote_addr;
        add_header X-Nxas-Device $nxas_device always;
    }
}
`;
  // server 先行（conf 幂等写入；失败抛错且本地未动）→ 本地清单 → gost 重启
  const r = await serverApi('POST', `/api/nginx/files/nxas-tunnel-${name}.conf`, { content: conf });
  const tunnel = await addTunnel({ name, local, public: pub });
  await restartGost().catch(() => {});
  return { tunnel, server: r, url: (await remoteList()).tunnels.find((t) => t.name === tunnel.name)?.url || null };
}

export async function unregisterTunnel({ name }) {
  // server 先删（不存在也继续）→ 本地清单移除 → gost 重启
  const server = await serverApi('DELETE', `/api/nginx/files/nxas-tunnel-${name}.conf`).catch((e) => ({ error: e.message }));
  const removed = await removeTunnel({ name });
  await restartGost().catch(() => {});
  return { removed, server };
}

// 连接自检：server API 可达 + relay 配置存在 + gost 二进制可用
export async function doctor() {
  const cur = await loadClientConfig();
  const checks = {};
  checks.config = Boolean(cur.server.api && cur.server.token && cur.relay.url);
  if (cur.server.api) {
    try {
      const res = await fetch(cur.server.api + '/api/auth/verify', { headers: { Authorization: `Bearer ${cur.server.token}` } });
      const j = await res.json().catch(() => ({}));
      checks.server = j.valid === true ? 'ok' : `token 无效（valid:false）`;
    } catch (e) {
      checks.server = `不可达: ${e.message}`;
    }
  } else {
    checks.server = '未配置';
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
