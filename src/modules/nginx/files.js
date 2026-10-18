// nginx 配置文件管理器（多文件）：托管目录内 *.conf 的浏览 / 编辑 / 新建 / 停用 / 删除 / 备份还原
//
// 管理边界（安全设计，与单文件托管同一红线）：
// - 只操作「托管目录」（managedPath 所在目录，默认 /etc/nginx/conf.d）下的平铺文件
//   （容器形态如 gost-as 下为 http.d，同一套规则）
// - 文件名白名单：^[\w][\w.-]*\.conf(\.disabled)?$，basename only，无子目录、不追符号链接
// - 主 nginx.conf 与托管目录之外的任何文件永不可写；面板不是通用文件编辑器
// - 目录级操作（新建/删除/停用）需要目录写权限：status.dirWritable 探测，
//   没授权时只读 + 编辑托管单文件内容（nginx setup 输出完整管理授权命令）
// - 每次变更都走 nginx -t（失败自动还原）+ graceful reload；变更前的内容滚动备份
//   到 ~/.nx-as/nginx-backups/<文件名>/<时间戳>.conf（保留最近 10 份，不在 nginx 目录里留垃圾）
// - 停用语义：.conf → .conf.disabled（nginx 默认只 include conf.d/*.conf，改名即不加载，
//   无需 sites-enabled 软链；跨发行版一致）
import { basename, join, resolve, sep } from 'node:path';
import { constants as FS_CONSTANTS } from 'node:fs';
import { appDirFromEnv } from '../../core/paths.js';
import { badInput, blocked, notFound } from '../../core/errors.js';
import { appendAudit } from '../../core/audit.js';
import { fsp } from '../../core/fs.js';
import { nginxConfig, nginxExec, isLinux } from './service.js';

const DEFAULT_MANAGED = '/etc/nginx/conf.d/nx-as-managed.conf';
const FILE_RE = /^[\w][\w.-]{0,127}\.conf(\.disabled)?$/;
// 基础设施文件（entrypoint 渲染产物/公共变量），不属于用户可编辑内容：
// 清单里不显示，也拒绝任何写操作（改它们请改模板/env 后重建容器）
const INFRA_RE = /^(gost-as\.conf|00-nxas-vars\.conf)(\.disabled)?$/;
// 备份时间戳：YYYYMMDD-HHmmss；同秒多次变更时追加 -<序号>（备份永不互相覆盖）
const TS_RE = /^\d{8}-\d{6}(-\d{1,3})?$/;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_BACKUPS = 10;

// ---------- 基础设施 ----------

function backupsRoot() {
  return join(appDirFromEnv(), 'nginx-backups');
}

function managedDirOf(cfg) {
  const managedPath = cfg.managedPath || DEFAULT_MANAGED;
  const i = Math.max(managedPath.lastIndexOf('/'), managedPath.lastIndexOf('\\'));
  return i > 0 ? managedPath.slice(0, i) : managedPath;
}

// 文件名守卫：basename 白名单 + 解析后必须仍在托管目录内（双保险，防穿越/符号链接逃逸）
function assertSafeFileName(dir, name) {
  if (typeof name !== 'string' || !FILE_RE.test(name)) {
    throw badInput(`非法配置文件名: ${JSON.stringify(name)}（只允许目录内的 *.conf / *.conf.disabled）`);
  }
  if (INFRA_RE.test(name)) {
    throw badInput(`${name} 是 entrypoint 渲染的基础设施文件，不可通过管理器修改`);
  }
  const abs = resolve(dir, name);
  if (!abs.startsWith(resolve(dir) + sep)) {
    throw badInput(`路径越界: ${name}`);
  }
  return abs;
}

async function assertManageable() {
  // 容器模式同样适用（gost-as 等容器形态：http.d 目录 root 直写，多文件管理与宿主一致）；
  // 仅平台守卫：非 Linux 且未显式放行（测试）时拒绝。
  if (!isLinux() && process.env.NXAS_TEST_ALLOW_NON_LINUX !== '1') {
    throw blocked('nginx 配置文件管理仅支持 Linux 服务器');
  }
}

// 目录可写探测（新建/删除/停用依赖它；不可写时这些操作给出明确指引而不是 EACCES）
export async function dirWritable() {
  const cfg = await nginxConfig();
  try {
    await fsp.access(managedDirOf(cfg), FS_CONSTANTS.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------- 变更管线：先备份 → 落盘 → nginx -t（失败还原）→ reload ----------

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function backupFile(dir, name) {
  const abs = join(dir, name);
  try {
    await fsp.access(abs);
  } catch {
    return null; // 目标不存在（新建/已删除），无备份可做
  }
  const st = await fsp.lstat(abs);
  if (st.isSymbolicLink()) throw badInput(`${name} 是符号链接，拒绝操作`);
  const dirBak = join(backupsRoot(), name);
  await fsp.mkdir(dirBak, { recursive: true });
  // 时间戳秒级精度：同秒内多次变更追加序号，保证任何一份历史都不被覆盖
  const exists = (f) => fsp.access(f).then(() => true).catch(() => false);
  let stamp = ts();
  let n = 0;
  while (await exists(join(dirBak, `${stamp}${n ? `-${n}` : ''}.conf`))) n += 1;
  stamp = n ? `${stamp}-${n}` : stamp;
  await fsp.copyFile(abs, join(dirBak, `${stamp}.conf`));
  await pruneBackups(name);
  return stamp;
}

// 备份文件按时间序（stem 排序——带扩展名排序会让 '-1' 后缀排在 '.' 前，顺序全反）
const byStem = (a, b) => a.replace(/\.conf$/, '').localeCompare(b.replace(/\.conf$/, ''));

async function restoreLastBackup(dir, name) {
  // 还原「刚刚那一次」备份：取该文件备份目录里最新的时间戳
  const dirBak = join(backupsRoot(), name);
  let entries = [];
  try {
    entries = (await fsp.readdir(dirBak)).filter((f) => TS_RE.test(f.replace(/\.conf$/, ''))).sort(byStem).reverse();
  } catch {
    entries = [];
  }
  const abs = join(dir, name);
  if (!entries.length) {
    // 无备份（首次新建就失败）→ 移除刚写的文件即可还原
    await fsp.unlink(abs).catch(() => {});
    return;
  }
  await fsp.copyFile(join(dirBak, entries[0]), abs);
}

async function pruneBackups(name) {
  const dirBak = join(backupsRoot(), name);
  let entries = [];
  try {
    entries = (await fsp.readdir(dirBak)).sort(byStem).reverse();
  } catch {
    return;
  }
  for (const old of entries.slice(MAX_BACKUPS)) {
    await fsp.unlink(join(dirBak, old)).catch(() => {});
  }
}

// 校验 + reload 的统一收尾；失败抛 EXTERNAL（nginx -t 的 stderr 原样带出）
async function validateAndReload(what) {
  try {
    await nginxExec(['-t']);
  } catch (e) {
    throw Object.assign(new Error(`nginx -t 失败（已还原）:\n${(e.stderr || e.stdout || e.message).trim()}`), { code: 'EXTERNAL' });
  }
  try {
    await nginxExec(['-s', 'reload']);
  } catch (e) {
    throw Object.assign(new Error(`${what}已写入且校验通过，但 reload 失败:\n${(e.stderr || e.message).trim()}`), { code: 'EXTERNAL' });
  }
}

function assertContent(content) {
  if (typeof content !== 'string' || !content.trim()) throw badInput('内容不能为空');
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw badInput(`内容超过上限（${Math.floor(MAX_CONTENT_BYTES / 1024)} KB）`);
  }
  if (content.includes('\0')) throw badInput('内容包含 NUL 字符');
}

// ---------- 对外能力 ----------

/** 托管目录内全部配置文件（含停用态），附备份计数与托管单文件标记。 */
export async function listConfigFiles() {
  await assertManageable();
  const cfg = await nginxConfig();
  const dir = managedDirOf(cfg);
  const managedBase = basename(cfg.managedPath || DEFAULT_MANAGED);
  let names = [];
  let dirExists = true;
  try {
    names = await fsp.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') dirExists = false;
    else throw Object.assign(new Error(`托管目录不可读: ${dir}（${e.message}）`), { code: 'EXTERNAL' });
  }
  const writable = dirExists ? await dirWritable() : false;
  const files = [];
  for (const name of names.sort()) {
    if (!FILE_RE.test(name) || INFRA_RE.test(name)) continue;
    let st;
    try {
      st = await fsp.lstat(join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue; // 目录/符号链接不进清单
    let backupCount = 0;
    try {
      backupCount = (await fsp.readdir(join(backupsRoot(), name))).length;
    } catch { /* 无备份 */ }
    files.push({
      name,
      enabled: !name.endsWith('.disabled'),
      size: st.size,
      mtimeMs: st.mtimeMs,
      managed: name === managedBase,
      writable: writable ? await fsp.access(join(dir, name), FS_CONSTANTS.W_OK).then(() => true).catch(() => false) : false,
      backups: backupCount,
    });
  }
  // 启用在前，组内按名称排序；managed 文件置顶
  files.sort((a, b) => (b.managed - a.managed) || (b.enabled - a.enabled) || a.name.localeCompare(b.name));
  return { dir, dirExists, dirWritable: writable, files };
}

/** 读取单个配置文件内容。 */
export async function readConfigFile(name) {
  await assertManageable();
  const cfg = await nginxConfig();
  const dir = managedDirOf(cfg);
  const abs = assertSafeFileName(dir, name);
  let real;
  try {
    real = await fsp.realpath(abs);
  } catch (e) {
    if (e.code === 'ENOENT') throw notFound(`文件不存在: ${name}`);
    throw e;
  }
  if (real !== abs) throw badInput(`${name} 是符号链接，拒绝读取`);
  const content = await fsp.readFile(abs, 'utf8');
  return { name, content };
}

/**
 * 写入（新建或更新）配置文件：备份现网 → 落盘 → nginx -t 失败自动还原 → reload。
 * @param {string} name 文件名（*.conf / *.conf.disabled）
 * @param {string} content 完整文件内容
 */
export async function writeConfigFile(name, content) {
  await assertManageable();
  assertContent(content);
  const cfg = await nginxConfig();
  const dir = managedDirOf(cfg);
  const abs = assertSafeFileName(dir, name);
  const writable = await dirWritable();
  if (!writable) {
    throw blocked(`托管目录不可写（${dir}）：新建文件需要目录写权限，nginx setup 输出完整管理授权命令`);
  }
  if (!name.endsWith('.disabled')) {
    // 待写入的是启用态文件：确保目录里没有同名停用文件占位（会造成两个文件一个语义的混乱）
    const shadowed = join(dir, name + '.disabled');
    if (await fsp.access(shadowed).then(() => true).catch(() => false)) {
      throw badInput(`已存在停用副本 ${name}.disabled，先删除或启用它再写 ${name}`);
    }
  }
  const existed = await fsp.access(abs).then(() => true).catch(() => false);
  if (existed) {
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) throw badInput(`${name} 是符号链接，拒绝覆盖`);
  }
  const bak = existed ? await backupFile(dir, name) : null;
  const tmp = abs + '.new';
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, abs);
  try {
    await validateAndReload('配置');
  } catch (e) {
    if (existed) await restoreLastBackup(dir, name);
    else await fsp.unlink(abs).catch(() => {});
    throw e;
  }
  appendAudit({ action: 'nginx.file.put', detail: { name, bytes: Buffer.byteLength(content), created: !existed } }).catch(() => {});
  return { status: 'ok', name, created: !existed, backedUp: bak };
}

/** 删除配置文件（先备份；nginx -t 失败自动还原）。 */
export async function deleteConfigFile(name) {
  await assertManageable();
  const cfg = await nginxConfig();
  const dir = managedDirOf(cfg);
  const abs = assertSafeFileName(dir, name);
  const writable = await dirWritable();
  if (!writable) throw blocked(`托管目录不可写（${dir}）：删除文件需要目录写权限`);
  const existed = await fsp.access(abs).then(() => true).catch(() => false);
  if (!existed) throw notFound(`文件不存在: ${name}`);
  const bak = await backupFile(dir, name);
  await fsp.unlink(abs);
  try {
    await validateAndReload('删除');
  } catch (e) {
    await restoreLastBackup(dir, name);
    throw e;
  }
  appendAudit({ action: 'nginx.file.delete', detail: { name, backedUp: bak } }).catch(() => {});
  return { status: 'ok', name, backedUp: bak };
}

/** 停用/启用：.conf ↔ .conf.disabled（改名即生效语义；nginx -t 失败自动改回）。 */
export async function toggleConfigFile(name) {
  await assertManageable();
  const cfg = await nginxConfig();
  const dir = managedDirOf(cfg);
  const abs = assertSafeFileName(dir, name);
  const writable = await dirWritable();
  if (!writable) throw blocked(`托管目录不可写（${dir}）：停用/启用（改名）需要目录写权限`);
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) throw notFound(`文件不存在: ${name}`);
  if (st.isSymbolicLink()) throw badInput(`${name} 是符号链接，拒绝操作`);
  const target = name.endsWith('.disabled') ? name.replace(/\.disabled$/, '') : name + '.disabled';
  const absTarget = assertSafeFileName(dir, target);
  if (await fsp.access(absTarget).then(() => true).catch(() => false)) {
    throw badInput(`目标名已存在: ${target}`);
  }
  await fsp.rename(abs, absTarget);
  try {
    await validateAndReload(target.endsWith('.disabled') ? '停用' : '启用');
  } catch (e) {
    await fsp.rename(absTarget, abs).catch(() => {});
    throw e;
  }
  appendAudit({ action: 'nginx.file.toggle', detail: { from: name, to: target } }).catch(() => {});
  return { status: 'ok', from: name, to: target, enabled: !target.endsWith('.disabled') };
}

/** 某文件的备份清单（新→旧）。 */
export async function listBackups(name) {
  await assertManageable();
  assertSafeFileName(managedDirOf(await nginxConfig()), name); // 名字合法性同一把尺
  const dirBak = join(backupsRoot(), name);
  let entries = [];
  try {
    entries = await fsp.readdir(dirBak);
  } catch (e) {
    if (e.code === 'ENOENT') return { name, backups: [] };
    throw e;
  }
  const backups = [];
  for (const f of entries.sort(byStem).reverse()) {
    const m = /^(\d{8}-\d{6}(?:-\d{1,3})?)\.conf$/.exec(f);
    if (!m) continue;
    const st = await fsp.stat(join(dirBak, f)).catch(() => null);
    if (st) backups.push({ ts: m[1], size: st.size, mtimeMs: st.mtimeMs });
  }
  return { name, backups };
}

/** 还原指定备份：当前内容先备份一份（还原可再还原）→ 覆盖 → nginx -t → reload。 */
export async function restoreBackup(name, stamp) {
  await assertManageable();
  if (typeof stamp !== 'string' || !TS_RE.test(stamp)) throw badInput('时间戳格式应为 YYYYMMDD-HHmmss');
  const cfg = await nginxConfig();
  const dir = managedDirOf(cfg);
  const abs = assertSafeFileName(dir, name);
  const writable = await dirWritable();
  if (!writable) throw blocked(`托管目录不可写（${dir}）：还原需要目录写权限`);
  const src = join(backupsRoot(), name, `${stamp}.conf`);
  if (!(await fsp.access(src).then(() => true).catch(() => false))) {
    throw notFound(`备份不存在: ${name}/${stamp}`);
  }
  const currentBak = await backupFile(dir, name).catch(() => null); // 当前内容可不存在（被删过）
  await fsp.copyFile(src, abs);
  try {
    await validateAndReload('还原');
  } catch (e) {
    if (currentBak) await restoreLastBackup(dir, name);
    else await fsp.unlink(abs).catch(() => {});
    throw e;
  }
  appendAudit({ action: 'nginx.file.restore', detail: { name, stamp } }).catch(() => {});
  return { status: 'ok', name, restoredFrom: stamp };
}

/** 测试辅助：备份目录位置（单测指向临时目录用 NX_AS_HOME）。 */
export function backupsRootForTest() {
  return backupsRoot();
}
