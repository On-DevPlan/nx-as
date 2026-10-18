#!/usr/bin/env node
// nxas-tunnel —— gost-as 隧道注册 CLI（端口映射管理）
//
// 在 nx-as（gost-as 容器）里注册一条隧道 = 写一个 nginx server 块（配置文件管理器管线：
// 备份 → nginx -t（失败还原）→ graceful reload），并打印本地 gost 客户端常驻命令。
//
// 用法（任意能访问 gost-as 面板端口的机器上）：
//   node scripts/nxas-tunnel.mjs add <名称> <本地端口> [--public-port P] [--server URL] [--token TOK]
//   node scripts/nxas-tunnel.mjs remove <名称>
//   node scripts/nxas-tunnel.mjs list
//
// 示例（发布本机 sql-harness http://127.0.0.1:7877 → 公网 http://47.x.x.x:7877）：
//   node scripts/nxas-tunnel.mjs add sqlh 7877 --server http://47.110.80.47:8090/_nxas --token <管理密钥>
//   gost -L "rtcp://127.0.0.1:17877/127.0.0.1:7877" -F "relay://gost:<隧道密码>@47.110.80.47:8442"
//
// 端口约定：隧道 rtcp 监听 = 127.0.0.1:<10000+公网端口>（gost 服务端 loopback 绑定，公网不可直达，
// 唯一入口是 nginx 鉴权后的 proxy_pass）。

const args = process.argv.slice(2);
const cmd = args[0];
const pos = [];
const flags = {};
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] ?? true, i++;
  else pos.push(args[i]);
}

const SERVER = flags.server || process.env.NXAS_SERVER || 'http://127.0.0.1:8090/_nxas';
const TOKEN = flags.token || process.env.NX_AS_TOKEN || '';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

function die(msg) {
  console.error(`nxas-tunnel: ${msg}`);
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(SERVER + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}（${method} ${path}）`);
  return data;
}

function tunnelConf({ name, local, pub, apiPort }) {
  const rtcpPort = 10000 + pub;
  return `# nx-as gost-as 隧道: ${name}（本地 127.0.0.1:${local} → 公网 :${pub}）
# 由 nxas-tunnel.mjs 生成；手改会被下次注册覆盖。删除请用 nxas-tunnel remove ${name}
server {
    listen ${pub};
    server_name _;

    # 登录/管理面（cookie 按 host 共享：任一端口登录，全部隧道端口放行）
    location /_nxas/ {
        proxy_pass http://127.0.0.1:${apiPort}/_nxas/;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }

    # 委托鉴权端点（internal 只在 server 内生效，故每条隧道自带）
    location = /_tunnel_auth_${pub} {
        internal;
        proxy_pass http://127.0.0.1:${apiPort}/_nxas/auth/check;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Cookie $http_cookie;
        proxy_set_header X-Original-Uri $request_uri;
        proxy_set_header X-Original-Method $request_method;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    location @nxas_login_${pub} {
        return 302 /_nxas/login?next=$request_uri;
    }

    # ── 隧道数据路径：鉴权后直代 gost rtcp（127.0.0.1:${rtcpPort}）──
    location / {
        auth_request /_tunnel_auth_${pub};
        auth_request_set $nxas_device $upstream_http_x_device_id;
        error_page 401 = @nxas_login_${pub};
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
}

function gostCommand({ pub, local, serverUrl }) {
  const host = new URL(serverUrl.replace(/\/_nxas\/?$/, ''));
  const rtcpPort = 10000 + pub;
  return `gost -L "rtcp://127.0.0.1:${rtcpPort}/127.0.0.1:${local}" -F "relay://<用户>:<密码>@${host.hostname}:${process.env.NXAS_GOST_PORT || 8442}"`;
}

if (cmd === 'add') {
  const [name, localStr] = pos;
  if (!name || !NAME_RE.test(name)) die('用法: nxas-tunnel add <名称(字母数字._-) > <本地端口>');
  const local = Number(localStr);
  if (!Number.isInteger(local) || local < 1 || local > 65535) die('本地端口必须是 1-65535');
  const pub = flags['public-port'] ? Number(flags['public-port']) : local;
  if (!Number.isInteger(pub) || pub < 1 || pub > 65535) die('--public-port 必须是 1-65535');
  if (10000 + pub > 65535) die(`公网端口 ${pub} 过大（10000+pub 超出端口范围）`);
  if (!TOKEN) die('缺少管理密钥：--token <TOK> 或环境变量 NX_AS_TOKEN');

  const conf = tunnelConf({ name, local, pub, apiPort: process.env.NXAS_API_PORT || 7801 });
  const file = `nxas-tunnel-${name}.conf`;
  try {
    const r = await api('POST', `/api/nginx/files/${file}`, { content: conf });
    console.log(`✅ 隧道已注册并生效: ${name}（${r.created ? '新建' : '更新'}，nginx -t 通过 + reload，备份 ${r.backedUp || '无'}）`);
  } catch (e) {
    die(`注册失败: ${e.message}`);
  }
  console.log(`公网入口:  http://<服务器IP>:${pub}/   （首次访问会跳登录；安全组需放行 ${pub}）`);
  console.log(`本地常驻（Windows/Linux 通用，gost ≥3.2）:`);
  console.log(`  ${gostCommand({ pub, local, serverUrl: SERVER })}`);
  console.log(`提示: 隧道密码在服务器 /opt/gost-as/data/gost-auth.env；多端口就在本命令后加多组 -L。`);
} else if (cmd === 'remove') {
  const [name] = pos;
  if (!name || !NAME_RE.test(name)) die('用法: nxas-tunnel remove <名称>');
  if (!TOKEN) die('缺少管理密钥：--token <TOK> 或环境变量 NX_AS_TOKEN');
  try {
    const r = await api('DELETE', `/api/nginx/files/nxas-tunnel-${name}.conf`);
    console.log(`✅ 已删除并生效: nxas-tunnel-${name}.conf${r.backedUp ? `（备份 ${r.backedUp}，可还原）` : ''}`);
  } catch (e) {
    die(`删除失败: ${e.message}`);
  }
} else if (cmd === 'list') {
  if (!TOKEN) die('缺少管理密钥：--token <TOK> 或环境变量 NX_AS_TOKEN');
  try {
    const r = await api('GET', '/api/nginx/files');
    const tunnels = r.files.filter((f) => f.name.startsWith('nxas-tunnel-'));
    if (!tunnels.length) {
      console.log('（暂无隧道。注册: nxas-tunnel add <名称> <本地端口>）');
    } else {
      for (const t of tunnels) {
        const m = /^nxas-tunnel-(.+)\.conf(\.disabled)?$/.exec(t.name);
        console.log(`  ${t.enabled ? '·' : '×'} ${m[1].padEnd(16)} 公网:${t.name.match(/-(\d+)\.conf/)?.[1] || '?'}  ${fmtTime(t.mtimeMs)}${t.enabled ? '' : '（已停用）'}`);
      }
    }
  } catch (e) {
    die(`查询失败: ${e.message}`);
  }
} else {
  die(`未知命令: ${cmd || '(空)'}。可用: add <名称> <本地端口> | remove <名称> | list`);
}

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '';
}
