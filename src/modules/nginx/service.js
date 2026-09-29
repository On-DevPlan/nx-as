// nginx 托管模块：模板渲染 → nginx -t 验证 → graceful reload，单文件托管 + 备份回滚
//
// 托管边界（安全设计）：
// - nx-as 只拥有一个文件：managedPath（默认 /etc/nginx/conf.d/nx-as-managed.conf）
// - 主 nginx.conf 与其它站点配置永不可写；面板不是通用 nginx 编辑器
// - sudoers 白名单只有两条命令：nginx -t / nginx -s reload（nx-as nginx setup 生成）
import { loadStore } from '../../core/store.js';
import { badInput, blocked, notFound } from '../../core/errors.js';
import { appendAudit } from '../../core/audit.js';

const NGINX_BIN = process.env.NXAS_NGINX_BIN || 'nginx';
// 容器内以 root 直跑 nginx，无需 sudo（NXAS_NGINX_SUDO=0）；宿主机默认走 sudo -n 白名单
const SUDO = process.env.NXAS_NGINX_SUDO === '0' ? [] : ['sudo', '-n'];
const DEFAULT_MANAGED = '/etc/nginx/conf.d/nx-as-managed.conf';
const NGINX_PORT_DEFAULT = 30141;

// ---------- 配置存取 ----------

export async function nginxConfig() {
  const store = await loadStore();
  return store.nginx || { domain: '', certPath: '', keyPath: '', managedPath: DEFAULT_MANAGED, enabled: false };
}

export async function machineSecret() {
  const store = await loadStore();
  return store.machineSecret || '';
}

// ---------- 模板渲染（纯函数，可单测） ----------

export function renderTemplate(cfg, { machineSecret: secret, gatewayPort = 7801, upstreamPort = NGINX_PORT_DEFAULT } = {}) {
  if (!cfg.domain) throw badInput('缺少 domain（公网域名）');
  if (!secret) throw badInput('机机密码未生成（先 rotate-machine-secret 或 serve 一次）');

  // TLS 可选：两个都给才 emit ssl_ 指令；半配报 INVALID_INPUT；都不给 = 默认 HTTP
  const hasCert = !!(cfg.certPath || cfg.keyPath);
  if (hasCert && !(cfg.certPath && cfg.keyPath)) {
    throw badInput('certPath/keyPath 必须同时设置或同时留空');
  }
  const useTls = !!(cfg.certPath && cfg.keyPath);
  const listenBlock = useTls
    ? 'listen 443 ssl;\n    http2 on;'
    : 'listen 80;';
  const sslDirectives = useTls
    ? `\n    ssl_certificate     ${cfg.certPath};\n    ssl_certificate_key ${cfg.keyPath};\n`
    : '';

  return `# 本文件由 nx-as 托管生成（nx-as nginx apply）——手改会被下次 Apply 覆盖
# 管理面板/CLI: nx-as nginx config / nginx apply

server {
    ${listenBlock}
    server_name ${cfg.domain};${sslDirectives}

    # ── 短票签发（自带校验，不走 auth_request）──
    location ~ ^/m/v1/sessions/[^/]+/ticket$ {
        proxy_pass http://127.0.0.1:${gatewayPort};
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    # ── 数据路径：委托鉴权 + 直代 pi-web（SSE 直通）──
    location /m/v1/ {
        auth_request /_nxas_auth;
        auth_request_set $nxas_device $upstream_http_x_device_id;
        # 短票通道不带机机凭据（票即授权）：nx-as 在 X-Auth-Cred: ticket 时就要求
        # 不要注入 Basic。缺了这句会退化成「票被换成 Basic」，等于放行裸请求
        auth_request_set $nxas_cred $upstream_http_x_auth_cred;
        proxy_pass http://127.0.0.1:${upstreamPort}/api/;
        proxy_set_header Authorization "Basic ${secret}";
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;          # SSE 关键：不缓冲
        proxy_read_timeout 1h;        # SSE 长连
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Auth-Cred $nxas_cred;
        add_header X-Nxas-Device $nxas_device always;
    }

    # ── 委托端点：每请求一个 loopback 子请求 ──
    location = /_nxas_auth {
        internal;
        proxy_pass http://127.0.0.1:${gatewayPort}/auth/check;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Original-Uri $request_uri;
        proxy_set_header X-Original-Method $request_method;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    # ── 管理面板（管理密钥在 nx-as 侧校验）──
    location / {
        proxy_pass http://127.0.0.1:${gatewayPort};
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_read_timeout 1h;
    }
}
`;
}

// ---------- 执行层（execFile 注入，测试可 mock） ----------

let execFileImpl = null;
async function run(cmd, ...rest) {
  // 支持 run(NGINX_BIN, ['-t']) 与 run(...SUDO, [NGINX_BIN, '-t']) 两种形态：
  // rest 末尾必须是数组（真正的 args），前面的字符串是 sudo 前缀
  const args = [...rest.filter((x) => typeof x === 'string'), ...rest.find((x) => Array.isArray(x)) || []];
  if (!execFileImpl) {
    execFileImpl = (await import('node:child_process')).execFile;
  }
  return new Promise((resolve, reject) => {
    execFileImpl(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        reject(err);
      } else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// 测试注入点
export function _setExecFile(fn) { execFileImpl = fn; }

export function isLinux() {
  return process.platform === 'linux';
}

async function assertLinux() {
  // 测试注入：单测用 NXAS_TEST_ALLOW_NON_LINUX=1 验证文件层逻辑（执行层已被 mock）
  if (!isLinux() && process.env.NXAS_TEST_ALLOW_NON_LINUX !== '1') {
    throw blocked('nginx 管理仅支持 Linux 服务器（当前: ' + process.platform + '）');
  }
}

// ---------- status / apply / reload / setup ----------

export async function nginxStatus() {
  const cfg = await nginxConfig();
  const out = { platform: process.platform, managedPath: cfg.managedPath || DEFAULT_MANAGED, enabled: Boolean(cfg.enabled), nginx: null, drifted: null, sudoers: null };
  if (!isLinux()) return out;

  // nginx 进程/服务状态
  try {
    const { stdout } = await run(...(process.env.NXAS_NGINX_SUDO === '0' ? [NGINX_BIN, '-v'] : ['systemctl', 'is-active', 'nginx']));
    out.nginx = { service: stdout.trim() || 'unknown' };
  } catch (e) {
    out.nginx = { service: e.stdout?.trim() || 'inactive' };
  }

  // 配置漂移：磁盘文件 ≠ 模板渲染产物
  try {
    const fsp = (await import('node:fs/promises')).default;
    const disk = await fsp.readFile(out.managedPath, 'utf8');
    const secret = await machineSecret();
    const expected = cfg.domain ? renderTemplate(cfg, { machineSecret: secret }) : null;
    out.drifted = expected ? disk.trim() !== expected.trim() : null;
  } catch (e) {
    out.drifted = e.code === 'ENOENT' ? 'missing' : 'unreadable';
  }

  // sudoers 探测（能 -t 即视为授权）
  try {
    await run(...SUDO, [NGINX_BIN, '-t']);
    out.sudoers = 'ok';
  } catch (e) {
    out.sudoers = /sudo.*password|a password is required/i.test(e.stderr || '') ? 'needs-password' : 'no-sudoers';
  }
  return out;
}

/**
 * Apply：渲染 → 写 .new → 备份 → nginx -t → 失败回滚 / 成功 reload。
 * @param {object} patch nginx 配置块（domain/certPath/keyPath/managedPath）
 * @param {object} [opts] { rawConfig: string } 高级模式：整文件 textarea 内容优先
 */
export async function nginxApply(patch = {}, opts = {}) {
  await assertLinux();
  const { mutateStore: mutate } = await import('../../core/store.js');

  // 1. 合并配置
  const cur = await nginxConfig();
  const cfg = { ...cur, ...patch };
  if (patch && Object.keys(patch).length) {
    await mutate((s) => { s.nginx = cfg; });
  }

  const fsp = (await import('node:fs/promises')).default;
  const managedPath = cfg.managedPath || DEFAULT_MANAGED;
  const secret = await machineSecret();
  const content = opts.rawConfig ?? renderTemplate(cfg, { machineSecret: secret });

  // 2. 写 .new + 备份现网
  const tmp = managedPath + '.new';
  const bak = managedPath + '.bak';
  await fsp.writeFile(tmp, content, 'utf8');
  try {
    await fsp.copyFile(managedPath, bak);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // 首次 Apply 无现网文件，正常
  }
  await fsp.rename(tmp, managedPath);

  // 3. nginx -t；失败回滚
  try {
    await run(...SUDO, [NGINX_BIN, '-t']);
  } catch (e) {
    try { await fsp.copyFile(bak, managedPath); } catch { /* 首次失败无备份可回滚 */ }
    throw Object.assign(new Error(`nginx -t 失败（已回滚）:\n${(e.stderr || e.stdout || e.message).trim()}`), { code: 'EXTERNAL' });
  }

  // 4. graceful reload
  try {
    await run(...SUDO, [NGINX_BIN, '-s', 'reload']);
  } catch (e) {
    throw Object.assign(new Error(`配置已写入且校验通过，但 reload 失败:\n${(e.stderr || e.message).trim()}`), { code: 'EXTERNAL' });
  }

  await mutate((s) => { s.nginx = { ...cfg, enabled: true }; });
  appendAudit({ action: 'nginx.apply', detail: { domain: cfg.domain, managedPath } }).catch(() => {});
  return { status: 'ok', managedPath, domain: cfg.domain };
}

// 回滚到上一版（.bak → 现网）并 reload
export async function nginxRollback() {
  await assertLinux();
  const cfg = await nginxConfig();
  const managedPath = cfg.managedPath || DEFAULT_MANAGED;
  const fsp = (await import('node:fs/promises')).default;
  try {
    await fsp.access(managedPath + '.bak');
  } catch {
    throw notFound('没有可回滚的备份（.bak 不存在）');
  }
  await fsp.copyFile(managedPath + '.bak', managedPath);
  try {
    await run(...SUDO, [NGINX_BIN, '-t']);
    await run(...SUDO, [NGINX_BIN, '-s', 'reload']);
  } catch (e) {
    throw Object.assign(new Error(`回滚后 reload 失败:\n${(e.stderr || e.message).trim()}`), { code: 'EXTERNAL' });
  }
  appendAudit({ action: 'nginx.rollback', detail: { managedPath } }).catch(() => {});
  return { status: 'ok', rolledBackTo: managedPath + '.bak' };
}

// 预览模板（不落盘；面板「预览」按钮 / config --preview）
export async function nginxPreview() {
  const cfg = await nginxConfig();
  const secret = await machineSecret();
  return renderTemplate(cfg, { machineSecret: secret });
}

// setup：打印 sudoers 片段 + 托管文件初始化命令（部署期手工执行一次）
export async function nginxSetup() {
  const cfg = await nginxConfig();
  const managedPath = cfg.managedPath || DEFAULT_MANAGED;
  return {
    sudoers: `nxas ALL=(root) NOPASSWD: ${NGINX_BIN} -t, ${NGINX_BIN} -s reload`,
    steps: [
      `sudo visudo.d/  或 /etc/sudoers.d/nxas 写入:`,
      `  ${' '.repeat(2)}nxas ALL=(root) NOPASSWD: ${NGINX_BIN} -t, ${NGINX_BIN} -s reload`,
      `sudo touch ${managedPath} && sudo chown root:nxas ${managedPath} && sudo chmod 664 ${managedPath}`,
      `sudo nginx -t && sudo systemctl reload nginx`,
    ],
    note: 'nx-as 服务用户须在 nxas 组；managedPath 所在目录不给 nx-as 写权（防止改其它配置）',
    managedPath,
  };
}
