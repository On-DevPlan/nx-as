// nginx 看板（hosts）：把「站点反代 / 端口转发」从面板表单映射为托管目录里的配置文件
//
// 设计：
// - 每条看板条目 = 托管目录里的一个 *.conf（与多文件管理器同一批文件、同一条变更管线：
//   备份 → nginx -t 失败自动还原 → graceful reload），不引入第二份真相
// - 表单生成的文件带 `# nxas-spec <json>` 头：面板「编辑」从 spec 回填表单，保存即整体重渲染；
//   没有 spec 的文件（手写/历史配置）也能进看板——解析 server 块推断字段，只读展示 + 原始编辑
// - 文件名约定：nxas-site.<域名slug>.conf / nxas-port.<端口>.conf，删除/停用/备份
//   全部复用 files.js 的既有能力（本模块只做「spec ↔ conf 文本」与命名）
import { basename } from 'node:path';
import { badInput } from '../../core/errors.js';
import {
  listConfigFiles, readConfigFile, writeConfigFile, deleteConfigFile,
} from './files.js';
import { nginxConfig } from './service.js';

// ---------- spec 校验 ----------

const DOMAIN_RE = /^[A-Za-z0-9*._-]+$/;
const HOST_RE = /^[A-Za-z0-9._-]+$/; // 上游主机：域名或 IP
const PATH_RE = /^[A-Za-z0-9/._-]+$/; // 与 service.js renderTemplate 同一把尺
const MAX_DOMAINS = 8;
const SITE_PREFIX = 'nxas-site.';
const PORT_PREFIX = 'nxas-port.';

function assertSpec(spec) {
  if (!spec || typeof spec !== 'object') throw badInput('需要 spec 对象');
  const kind = spec.kind;
  if (kind !== 'site' && kind !== 'port') throw badInput('spec.kind 只允许 site | port');
  if (kind === 'site') {
    const domains = Array.isArray(spec.domains) ? spec.domains : [];
    if (!domains.length) throw badInput('站点至少需要一个域名');
    if (domains.length > MAX_DOMAINS) throw badInput(`域名最多 ${MAX_DOMAINS} 个`);
    for (const d of domains) {
      if (typeof d !== 'string' || !DOMAIN_RE.test(d)) {
        throw badInput(`域名含非法字符: ${JSON.stringify(d)}（仅允许字母数字 . * _ -）`);
      }
    }
  } else {
    const port = Number(spec.listenPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw badInput('listenPort 必须是 1-65535 的整数');
    }
  }
  // upstream："host:port" 或 "http(s)://host:port"，归一成带 scheme
  const raw = typeof spec.upstream === 'string' ? spec.upstream.trim() : '';
  const m = /^(https?:\/\/)?([A-Za-z0-9._-]+):(\d{1,5})$/.exec(raw);
  if (!m || !HOST_RE.test(m[2])) {
    throw badInput(`upstream 不合法: ${JSON.stringify(raw)}（应为 host:port 或 http(s)://host:port）`);
  }
  const upPort = Number(m[3]);
  if (upPort < 1 || upPort > 65535) throw badInput('upstream 端口超出 1-65535');
  spec.upstream = `${m[1] || 'http://'}${m[2]}:${upPort}`;
  if (spec.ws !== undefined && typeof spec.ws !== 'boolean') throw badInput('ws 只允许布尔');
  if (spec.tls != null) {
    const { certPath, keyPath } = spec.tls;
    if (!certPath || !keyPath) throw badInput('启用 TLS 时 certPath/keyPath 必须同时给出');
    for (const [p, label] of [[certPath, 'certPath'], [keyPath, 'keyPath']]) {
      if (typeof p !== 'string' || !PATH_RE.test(p) || !p.startsWith('/')) {
        throw badInput(`${label} 须为以 / 开头的绝对路径（仅允许字母数字 / . _ -）`);
      }
    }
  }
  return spec;
}

/** 表单 spec 的展示摘要（action render / CLI 输出用）。 */
function specSummary(spec) {
  const head = spec.kind === 'site' ? (spec.domains || []).join(', ') : `:${spec.listenPort}`;
  return `${head} → ${spec.upstream}${spec.tls ? ' (tls)' : ''}${spec.ws ? ' (ws)' : ''}`;
}

// ---------- spec → 配置文本 ----------

function serverBody(spec, indent) {
  const ws = spec.ws === true;
  return [
    'location / {',
    `    proxy_pass ${spec.upstream};`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Real-IP $remote_addr;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    ...(ws ? [
      '    proxy_set_header Upgrade $http_upgrade;',
      '    proxy_set_header Connection "upgrade";',
    ] : []),
    '    proxy_buffering off;',
    '    proxy_read_timeout 1h;',
    '}',
  ].map((l, i) => (l ? (i ? indent : '') + l : l)).join('\n');
}

/** 渲染一条看板条目为完整 conf 文本（含 nxas-spec 头，供面板回填表单）。 */
export function renderHostConf(spec) {
  assertSpec(spec);
  const useTls = !!spec.tls;
  const listen = spec.kind === 'port'
    ? `listen ${spec.listenPort}${useTls ? ' ssl' : ''};`
    : useTls ? 'listen 443 ssl;\n    http2 on;' : 'listen 80;';
  const serverName = spec.kind === 'site'
    ? `\n    server_name ${(spec.domains || []).join(' ')};`
    : '';
  const ssl = useTls
    ? `\n    ssl_certificate     ${spec.tls.certPath};\n    ssl_certificate_key ${spec.tls.keyPath};`
    : '';
  const head = [
    '# 本文件由 nx-as 看板生成——面板「编辑」以表单为准，手改会被下次保存覆盖',
    `# nxas-spec ${JSON.stringify({ kind: spec.kind, domains: spec.domains, listenPort: spec.listenPort, upstream: spec.upstream, ws: spec.ws === true, tls: spec.tls || null })}`,
  ].join('\n');
  return `${head}\nserver {\n    ${listen}${ssl}${serverName}\n\n    ${serverBody(spec, '    ')}\n}\n`;
}

// ---------- 配置文本 → 条目（解析/推断） ----------

// 摘出顶层 server { ... } 块（逐行扫描 + 花括号配平；nginx conf 无跨行字符串，启发式够用）
export function extractServerBlocks(content) {
  const blocks = [];
  let depth = 0;
  let cur = null;
  for (const line of String(content).split('\n')) {
    const code = line.replace(/#.*$/, '');
    if (cur === null) {
      if (/\bserver\s*\{/.test(code)) {
        cur = [line];
        depth = (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
        if (depth <= 0) { blocks.push(cur.join('\n')); cur = null; } // 单行块 server { ...; }
      }
      continue;
    }
    cur.push(line);
    depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
    if (depth <= 0) { blocks.push(cur.join('\n')); cur = null; }
  }
  return blocks;
}

function first(re, text) {
  const m = re.exec(text);
  return m ? m[1] : null;
}

/** 解析单个 server 块为展示字段（推断用；拿不到的字段留 null）。 */
export function parseServerBlock(block) {
  const code = block.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const listenRaw = first(/listen\s+([^;]+);/, code);
  let listenPort = null;
  let tls = null;
  if (listenRaw) {
    // 取 listen 指令里最后一个数字：443 ssl→443、0.0.0.0:8080→8080、[::]:80→80
    const nums = [...listenRaw.matchAll(/(\d+)/g)];
    listenPort = nums.length ? Number(nums[nums.length - 1][1]) : null;
    if (/ssl/.test(listenRaw)) {
      const cert = first(/ssl_certificate\s+([^;]+);/, code);
      const key = first(/ssl_certificate_key\s+([^;]+);/, code);
      tls = cert && key ? { certPath: cert.trim(), keyPath: key.trim() } : true; // true = 有 ssl 但路径未解析全
    }
  }
  const domains = (first(/server_name\s+([^;]+);/, code) || '')
    .split(/\s+/).filter((d) => d && d !== '_' && d !== '-');
  const proxyPass = first(/proxy_pass\s+([^;]+);/, code);
  const upstream = proxyPass
    ? proxyPass.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null
    : null;
  return {
    domains: domains.length ? domains : null,
    listenPort,
    upstream,
    tls,
    ws: /proxy_set_header\s+Upgrade\s+\$http_upgrade/.test(code),
    auth: /auth_request\s+/.test(code),
  };
}

export function readSpecLine(content) {
  const m = /^#\s*nxas-spec\s+(.+)$/m.exec(String(content));
  if (!m) return null;
  try {
    const spec = JSON.parse(m[1]);
    return (spec && (spec.kind === 'site' || spec.kind === 'port')) ? spec : null;
  } catch {
    return null;
  }
}

// ---------- 文件名 ----------

function slugify(domain) {
  return domain.toLowerCase().replace(/[._*]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

export function hostFileName(spec) {
  if (spec.kind === 'site') {
    const slug = slugify((spec.domains || [])[0] || '');
    const dedupe = spec.domains && spec.domains.length > 1 ? `-${spec.domains.length}` : '';
    return `${SITE_PREFIX}${slug}${dedupe}.conf`;
  }
  return `${PORT_PREFIX}${spec.listenPort}.conf`;
}

// ---------- 对外能力 ----------

/**
 * 看板清单：托管目录内全部 *.conf → 卡片条目。
 * kind: gateway(nx-as 引导托管) | site | port(带 spec，可表单编辑) | custom(手写，只读推断)
 */
export async function listHosts() {
  const list = await listConfigFiles();
  const managedBase = basename((await nginxConfig()).managedPath || '');
  const hosts = [];
  for (const f of list.files) {
    const entry = {
      name: f.name,
      enabled: f.enabled,
      size: f.size,
      mtimeMs: f.mtimeMs,
      backups: f.backups,
      writable: f.writable,
      managed: f.managed,
      kind: 'custom',
      domains: null, listenPort: null, upstream: null, tls: null, ws: false, auth: false,
      spec: null,
    };
    if (f.name === managedBase) entry.kind = 'gateway';
    let content = null;
    try {
      content = (await readConfigFile(f.name)).content;
    } catch { /* 读不了（权限）就按清单元数据展示 */ }
    if (content !== null) {
      const spec = readSpecLine(content);
      const blocks = extractServerBlocks(content);
      const parsed = blocks.length ? parseServerBlock(blocks[0]) : null;
      if (spec) {
        entry.kind = spec.kind;
        entry.spec = spec;
        entry.domains = spec.kind === 'site' ? spec.domains : null;
        entry.listenPort = spec.kind === 'port' ? spec.listenPort : parsed?.listenPort ?? null;
        entry.upstream = spec.upstream;
        entry.tls = spec.tls || null;
        entry.ws = spec.ws === true;
        entry.auth = parsed?.auth ?? false;
      } else if (parsed) {
        Object.assign(entry, parsed);
      }
    }
    hosts.push(entry);
  }
  // 停用沉底，组内按名称
  hosts.sort((a, b) => (b.enabled - a.enabled) || a.name.localeCompare(b.name));
  return { dir: list.dir, dirExists: list.dirExists, dirWritable: list.dirWritable, hosts };
}

/**
 * 表单保存（新建或编辑）：渲染 → 写入托管目录（同一管线）→ 清理被替换的旧文件。
 * @param {object} spec {kind, domains|listenPort, upstream, ws, tls}
 * @param {string} [previousName] 编辑场景被替换的旧文件名（成功后删除；同名/其停用副本除外）
 */
export async function upsertHost(spec, previousName) {
  assertSpec(spec);
  const name = hostFileName(spec);
  // 旧文件与目标同名（或只是停用副本）：先清掉停用副本再写，否则 writeConfigFile 拒绝
  if (previousName) {
    if (typeof previousName !== 'string') throw badInput('previousName 须为文件名');
    if (previousName !== name && previousName !== `${name}.disabled`) {
      await deleteConfigFile(previousName);
    } else if (previousName === `${name}.disabled`) {
      await deleteConfigFile(previousName); // 停用副本先删（自动备份，失败可在备份还原）
    }
  }
  const r = await writeConfigFile(name, renderHostConf(spec));
  return { status: 'ok', name, created: r.created, backedUp: r.backedUp, spec, summary: specSummary(spec) };
}

/** 从看板移除条目（= 删除配置文件；先备份，nginx -t 失败自动还原）。 */
export async function removeHost(name) {
  return deleteConfigFile(name);
}
