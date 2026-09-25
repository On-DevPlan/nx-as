// 插件域：扫描 pi agent dir 的 extensions/ 与 skills/，
// 启用/禁用通过 .disabled 后缀重命名实现（不依赖 pi 内部 settings 字段）。
// 实际运行时 pi 的 DefaultResourceLoader 会跳过这些后缀的文件。

import { fsp } from '../../core/fs.js';
import { PI_AGENT_DIR } from '../../core/paths.js';
import { notFound, badInput } from '../../core/errors.js';
import { join, basename } from 'node:path';

const EXT_DIR = join(PI_AGENT_DIR, 'extensions');
const SKILLS_DIR = join(PI_AGENT_DIR, 'skills');
const DISABLED_SUFFIX = '.disabled';

// ---------- 扫描 ----------

async function listOneDir(dir, type) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const enabled = !ent.name.endsWith(DISABLED_SUFFIX);
    const rawName = ent.name.replace(DISABLED_SUFFIX, '');
    if (type === 'extension') {
      if (!/\.(ts|js|mjs|cjs)$/.test(rawName)) continue;
      out.push({
        name: rawName.replace(/\.(ts|js|mjs|cjs)$/, ''),
        type: 'extension',
        enabled,
        path: join(dir, ent.name),
      });
    } else if (type === 'skill') {
      if (!ent.isDirectory()) continue;
      const skillFile = join(dir, ent.name, 'SKILL.md');
      const exists = await fsp.stat(skillFile).then(() => true).catch(() => false);
      const meta = await readFrontmatter(skillFile).catch(() => ({}));
      out.push({
        name: ent.name, // 目录名是权威来源（install 时已归一化为 frontmatter 的 name）
        type: 'skill',
        enabled,
        path: skillFile,
        hasSkillMd: exists,
        description: meta.description || '',
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readFrontmatter(file) {
  const raw = await fsp.readFile(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

// ---------- CRUD ----------

export async function listPlugins({ type = 'all' } = {}) {
  const [extensions, skills] = await Promise.all([
    type === 'skill' ? [] : listOneDir(EXT_DIR, 'extension'),
    type === 'extension' ? [] : listOneDir(SKILLS_DIR, 'skill'),
  ]);
  return { extensions, skills };
}

export async function getPlugin({ type, name }) {
  const list = type === 'extension'
    ? await listOneDir(EXT_DIR, 'extension')
    : await listOneDir(SKILLS_DIR, 'skill');
  const hit = list.find((p) => p.name === name);
  if (!hit) throw notFound(`插件不存在: ${type}/${name}`);
  if (type === 'skill' && hit.hasSkillMd) {
    hit.content = await fsp.readFile(hit.path, 'utf8').catch(() => '');
  } else {
    hit.content = await fsp.readFile(hit.path, 'utf8').catch(() => '');
  }
  return hit;
}

async function toggle(name, dir, type, enabled) {
  const entries = await fsp.readdir(dir).catch(() => []);
  // 直接找名字含原名 + DISABLED_SUFFIX 的文件
  const hit = entries.find((e) => {
    if (!e.endsWith(DISABLED_SUFFIX)) return false;
    return e.replace(DISABLED_SUFFIX, '') === name ||
      e.replace(DISABLED_SUFFIX, '').replace(/\.(ts|js|mjs|cjs|md)$/, '') === name;
  });
  if (enabled) {
    if (!hit) throw notFound(`插件已是启用状态: ${name}`);
    await fsp.rename(join(dir, hit), join(dir, hit.slice(0, -DISABLED_SUFFIX.length)));
    return { status: 'ok', name, type, enabled: true };
  } else {
    // 找当前启用形态的文件
    const enabledHit = entries.find((e) => {
      if (e.endsWith(DISABLED_SUFFIX)) return false;
      return e === name || e.replace(/\.(ts|js|mjs|cjs|md)$/, '') === name;
    });
    if (!enabledHit) throw notFound(`插件已是禁用状态: ${name}`);
    await fsp.rename(join(dir, enabledHit), join(dir, enabledHit + DISABLED_SUFFIX));
    return { status: 'ok', name, type, enabled: false };
  }
}

export async function setEnabled({ type, name, enabled }) {
  const dir = type === 'extension' ? EXT_DIR : SKILLS_DIR;
  return toggle(name, dir, type, enabled);
}

// 简单本地安装：source 是已存在的目录（含 SKILL.md）
// 安装时把目录改名为 SKILL.md frontmatter 里的 name（社区惯例），保证 list/get/toggle 一致
export async function installSkill({ source }) {
  if (!source) throw badInput('缺少 source（本地目录路径、npm 包名或 git URL）');
  if (!source.startsWith('git') && !source.startsWith('npm:') && !source.startsWith('http')) {
    const srcDir = source;
    let stat;
    try { stat = await fsp.stat(srcDir); } catch { throw notFound(`本地路径不存在: ${srcDir}`); }
    if (!stat.isDirectory()) throw badInput(`不是目录: ${srcDir}`);
    const skillFile = join(srcDir, 'SKILL.md');
    if (!await fsp.stat(skillFile).then(() => true).catch(() => false)) {
      throw badInput(`目录缺 SKILL.md: ${srcDir}`);
    }
    const meta = await readFrontmatter(skillFile);
    const dirName = meta.name || basename(srcDir);
    // 名称校验：只允许 a-z0-9._-，防路径穿越
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(dirName) || dirName.includes('..') || dirName.length > 64) {
      throw badInput(`SKILL.md frontmatter name 非法: ${dirName}`);
    }
    const target = join(SKILLS_DIR, dirName);
    if (await fsp.stat(target).then(() => true).catch(() => false)) {
      throw badInput(`已存在同名 skill: ${dirName}（先 uninstall 再装）`);
    }
    await fsp.mkdir(SKILLS_DIR, { recursive: true });
    await fsp.cp(srcDir, target, { recursive: true });
    return { status: 'ok', installed: target, name: dirName };
  }
  throw badInput(`暂只支持本地目录路径（git/npm 后续版本）：${source}`);
}

export async function uninstallPlugin({ type, name }) {
  const dir = type === 'extension' ? EXT_DIR : SKILLS_DIR;
  const list = await fsp.readdir(dir).catch(() => []);
  const targets = list.filter((e) => {
    if (e.endsWith(DISABLED_SUFFIX)) return false;
    if (type === 'extension') return e.replace(/\.(ts|js|mjs|cjs)$/, '') === name;
    return e === name;
  });
  if (!targets.length) throw notFound(`插件不存在: ${type}/${name}`);
  for (const t of targets) await fsp.rm(join(dir, t), { recursive: true, force: true });
  return { status: 'ok', removed: name, type };
}

export async function openFile({ type, name }) {
  const p = type === 'extension' ? EXT_DIR : SKILLS_DIR;
  const list = await fsp.readdir(p).catch(() => []);
  const ent = list.find((e) => {
    const base = e.endsWith(DISABLED_SUFFIX) ? e.slice(0, -DISABLED_SUFFIX.length) : e;
    return base === name || base.replace(/\.(ts|js|mjs|cjs|md)$/, '') === name;
  });
  if (!ent) throw notFound(`插件不存在: ${type}/${name}`);
  const full = join(p, ent);
  return fsp.readFile(full, 'utf8');
}