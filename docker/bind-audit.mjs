// 未授权 bind 审计：gost relay 的 bind=true 允许凭据持有者申请任意端口监听——
// 非回环 bind 即绕过 nginx 鉴权的裸穿透（gost v3.2.6 无白名单选项，实测 bindAddr 无效）。
// 本脚本扫描 /proc/net/tcp(+tcp6) 的 LISTEN：回环忽略；在 nginx 声明端口集合或
// 基础白名单（宿主其他服务，env NXAS_BIND_AUDIT_ALLOW）里的忽略；其余公网监听 = 告警。
// 由 entrypoint-gost.sh 每分钟调用；发现异常写 stderr + 审计日志（人工确认后 kill 对应 gost）。
import { readFile } from 'node:fs/promises';

export function parseListen(procText, isV6 = false) {
  const out = [];
  for (const line of procText.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (cols[3] !== '0A') continue; // LISTEN
    const [ipHex, portHex] = cols[1].split(':');
    const port = parseInt(portHex, 16);
    let ip;
    if (!isV6) {
      // /proc/net/tcp 为小端序：hex 两两分组后**反序**才是点分 IP（0100007F → 127.0.0.1）
      const b = ipHex.match(/../g);
      ip = [b[3], b[2], b[1], b[0]].map((h) => parseInt(h, 16)).join('.');
    } else if (ipHex === '0'.repeat(32)) {
      ip = '[::]';
    } else if (ipHex === '0'.repeat(24) + '01000000') {
      ip = '[::1]';
    } else {
      ip = `v6:${ipHex}`;
    }
    out.push({ ip, port });
  }
  return out;
}

export function isLoopback(entry) {
  return entry.ip === '127.0.0.1' || entry.ip === '[::1]';
}

/** 收集本容器 nginx 实际声明监听的端口（http.d 各 conf 的 listen + stream relay 口）。 */
export function nginxPorts(confTexts, streamPort) {
  const ports = new Set([8090, streamPort].filter(Boolean));
  for (const t of confTexts) {
    // 逐行剥掉 # 注释再收 listen（避免注释里的示例端口误入白名单）
    for (const line of t.split('\n')) {
      const m = /\blisten\s+(?:[\d.]*:)?(\d+)\s*;/.exec(line.replace(/#.*$/, ''));
      if (m) ports.add(Number(m[1]));
    }
  }
  return ports;
}

export async function auditBinds({ allow = [], nginxPortSet, log = console.error } = {}) {
  const allowSet = new Set(allow.map(Number));
  const offenders = [];
  for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const e of parseListen(text, v6)) {
      if (isLoopback(e)) continue;
      if (nginxPortSet.has(e.port) || allowSet.has(e.port)) continue;
      offenders.push(e);
    }
  }
  if (offenders.length) {
    const detail = offenders.map((o) => `${o.ip}:${o.port}`).join(', ');
    log(`[bind-audit] ⚠️ 未授权公网监听（疑似 relay bind 滥用，绕过 nginx 鉴权）：${detail}`);
    try {
      const { appendAudit } = await import('../src/core/audit.js');
      await appendAudit({ action: 'gost.bind_abuse', detail: { binds: offenders } });
    } catch { /* 审计旁路 */ }
  }
  return { offenders, checked: true };
}

// 直接执行时跑一轮（entrypoint 循环调用；IIFE 避免 unsettled top-level await 警告）
if (process.argv[1]?.endsWith('bind-audit.mjs')) {
  (async () => {
    const { readConfPorts } = await import('./bind-audit-conf.js');
    const allow = (process.env.NXAS_BIND_AUDIT_ALLOW || '22,80,81,82,443,3478,5432,8000,8081,8082,8988,8991,18080').split(',').map(Number);
    const nginxPortSet = await readConfPorts('/etc/nginx/http.d', Number(process.env.NXAS_GOST_PORT || 8442));
    const r = await auditBinds({ allow, nginxPortSet });
    if (!r.offenders.length) console.error('[bind-audit] ok（无未授权公网监听）');
  })().catch((e) => console.error(`[bind-audit] 执行失败: ${e.message}`));
}
