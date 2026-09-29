// 容器模式 nginx 管理（v0.6）：直接编辑真正生效的模板 + 渲染 + reload
//
// 与宿主机模式（nginxApply 管 /etc/nginx/conf.d/nx-as-managed.conf）的区别：
// 容器内 nginx 是「基础镜像的一部分」，配置由 entrypoint 从 template 渲染到
// /etc/nginx/http.d/nx-as.conf。面板编辑的是 template（卷挂载，改完持久），
// Apply = 写 template → 重新渲染 → nginx -t → reload。
import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { badInput, blocked } from '../../core/errors.js';
import { appendAudit } from '../../core/audit.js';

export const TEMPLATE_PATH = process.env.NXAS_NGINX_TEMPLATE || '/etc/nginx/http.d/nx-as.conf.template';
export const RENDERED_PATH = process.env.NXAS_NGINX_CONF || '/etc/nginx/http.d/nx-as.conf';
const BAK = TEMPLATE_PATH + '.bak';

export function isContainerMode() {
  // 容器内由 entrypoint 设 NXAS_LISTEN_PORT 且模板在 http.d 下
  return process.env.NXAS_NGINX_SUDO === '0';
}

// 读取当前模板（可编辑的真实来源）
export async function readTemplate() {
  try {
    return await readFile(TEMPLATE_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw blocked(`模板不存在: ${TEMPLATE_PATH}`);
    throw e;
  }
}

// 读取渲染后的实际 conf（生效配置，只读展示）
export async function readRendered() {
  try {
    return await readFile(RENDERED_PATH, 'utf8');
  } catch {
    return '';
  }
}

// 渲染 template → conf（复刻 entrypoint 的 envsubst 逻辑，但只替换我们的变量，
// 保留 nginx 自身 $ 变量不动）
export async function renderAndWrite() {
  const tpl = await readTemplate();
  const { loadStore } = await import('../../core/store.js');
  const store = await loadStore();
  const secret = store.machineSecret || '';
  const vars = {
    NXAS_LISTEN_PORT: process.env.NXAS_LISTEN_PORT || '8080',
    NXAS_API_PORT: process.env.NXAS_API_PORT || '7801',
    NXAS_TARGET_PORT: process.env.NXAS_TARGET_PORT || '30141',
    NXAS_MACHINE_B64: Buffer.from(`pi:${secret}`).toString('base64'),
    NXAS_TLS_BLOCK: process.env.NXAS_TLS_BLOCK || '',
    NXAS_PROTECT_BLOCKS: await readProtectBlocks(),
    NXAS_CATCHALL_BODY: await readCatchallBody(),
  };
  const out = tpl.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m);
  await writeFile(RENDERED_PATH, out, 'utf8');
  return out;
}

async function readProtectBlocks() {
  try { return await readFile('/tmp/nxas-protect-blocks.conf', 'utf8'); } catch { return ''; }
}
async function readCatchallBody() {
  const auth = await readFile('/tmp/nxas-catchall-auth.txt', 'utf8').catch(() => '1');
  const port = process.env.NXAS_TARGET_PORT || '30141';
  const common = `        proxy_pass http://127.0.0.1:${port};
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header X-Forwarded-For $remote_addr;`;
  if (auth.trim() !== '1') return common;
  return `        auth_request /_nxas/auth-internal;
        auth_request_set $nxas_device $upstream_http_x_device_id;
        error_page 401 = @nxas_login;
${common}
        add_header X-Nxas-Device $nxas_device always;`;
}

// Apply：写模板 → 渲染 → nginx -t → 失败回滚 → reload
export async function applyTemplate(newTemplate) {
  if (!isContainerMode()) throw blocked('容器模式不可用（NXAS_NGINX_SUDO != 0）');
  if (typeof newTemplate !== 'string' || !newTemplate.includes('server {')) {
    throw badInput('模板内容不合法（缺少 server 块）');
  }
  // 备份现有模板
  try { await copyFile(TEMPLATE_PATH, BAK); } catch { /* 首次无备份 */ }

  await writeFile(TEMPLATE_PATH, newTemplate, 'utf8');
  await renderAndWrite();

  const { execFile } = await import('node:child_process');
  const run = (args) => new Promise((res, rej) =>
    execFile('nginx', args, { timeout: 10_000 }, (e, so, se) => e ? rej(Object.assign(e, { stderr: se, stdout: so })) : res(so)));

  try {
    await run(['-t']);
  } catch (e) {
    // 回滚模板 + 重渲染
    try { await copyFile(BAK, TEMPLATE_PATH); await renderAndWrite(); } catch { /* 忽略 */ }
    throw Object.assign(new Error(`nginx -t 失败（已回滚）:\n${(e.stderr || e.message).trim()}`), { code: 'EXTERNAL' });
  }
  try {
    await run(['-s', 'reload']);
  } catch (e) {
    throw Object.assign(new Error(`配置校验通过但 reload 失败:\n${(e.stderr || e.message).trim()}`), { code: 'EXTERNAL' });
  }
  appendAudit({ action: 'nginx.apply.container', detail: { template: TEMPLATE_PATH } }).catch(() => {});
  return { status: 'ok', template: TEMPLATE_PATH, rendered: RENDERED_PATH };
}

// 回滚到上一版模板
export async function rollbackTemplate() {
  if (!isContainerMode()) throw blocked('容器模式不可用');
  try { await access(BAK); } catch { throw badInput('没有可回滚的模板备份（.bak 不存在）'); }
  await copyFile(BAK, TEMPLATE_PATH);
  await renderAndWrite();
  const { execFile } = await import('node:child_process');
  await new Promise((res, rej) => execFile('nginx', ['-t'], { timeout: 10_000 }, (e, so, se) => e ? rej(new Error((se || e.message).trim())) : res()));
  await new Promise((res, rej) => execFile('nginx', ['-s', 'reload'], { timeout: 10_000 }, (e, so, se) => e ? rej(new Error((se || e.message).trim())) : res()));
  appendAudit({ action: 'nginx.rollback.container', detail: { template: TEMPLATE_PATH } }).catch(() => {});
  return { status: 'ok', rolledBackTo: BAK };
}
