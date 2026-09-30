// skill 命令域：把随包 skill 装到 ~/.claude/skills、或导出给外部 agent
// 平台级能力（不属于业务域），挂在 runtime/skill.js —— CLI 与 HTTP 都通过 builtin action 暴露
import { fsp } from '../core/fs.js';
import { assertSafeName } from '../core/paths.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = join(__dirname, '..', '..', 'assets');
export const DEFAULT_SKILLS_DIR = join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'skills');
export const SKILL_NAME = 'nx-as';
const SENTINEL = '# --- begin skill content (do not modify this line) ---';

export async function bundledSkillNames() {
  try {
    const entries = await fsp.readdir(ASSETS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------- groups.json（B04：多 skill 分组安装的清单） ----------
//
// assets/ 是兜底事实源（每个 <dir>/SKILL.md 就是一个可装 skill）；
// groups.json 只是「group 名 → skill 名列表」的便捷聚合，坏了降级到目录扫描，不崩。

const GROUPS_FILE = join(ASSETS_DIR, 'groups.json');

// 读清单；损坏（JSON 坏 / schema 错）抛 INVALID_INPUT；缺失返回 null（调用方降级）
export async function loadGroups() {
  let raw;
  try {
    raw = await fsp.readFile(GROUPS_FILE, 'utf8');
  } catch {
    return null; // 缺失 → 降级（清单是便捷，不是必需）
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`groups.json 损坏（JSON 解析失败）：${e.message}`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.groups || typeof parsed.groups !== 'object') {
    const err = new Error('groups.json schema 错：缺少 groups 对象');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  for (const [key, g] of Object.entries(parsed.groups)) {
    if (!g || !Array.isArray(g.skills) || !g.skills.length) {
      const err = new Error(`groups.json schema 错：group "${key}" 缺 skills 数组`);
      err.code = 'INVALID_INPUT';
      throw err;
    }
    for (const s of g.skills) {
      if (typeof s !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(s)) {
        const err = new Error(`groups.json schema 错：group "${key}" 含非法 skill 名 "${s}"`);
        err.code = 'INVALID_INPUT';
        throw err;
      }
    }
  }
  return parsed.groups;
}

// 默认 group：与 package.json.name 同名（找不到 → null，不崩不猜）
async function defaultGroupName() {
  try {
    const pkg = JSON.parse(await fsp.readFile(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return typeof pkg.name === 'string' ? pkg.name : null;
  } catch {
    return null;
  }
}

// 全部可用 group：清单优先，缺失/读取失败时降级为「每个 skill 目录自成一组」
export async function availableGroups() {
  const groups = await loadGroups();
  if (groups) return { groups, source: 'manifest' };
  const dirs = await bundledSkillNames();
  return { groups: Object.fromEntries(dirs.map((d) => [d, { skills: [d] }])), source: 'assets-dirs' };
}

// skill list：可装清单 + 默认 install 标记 + 数据来源
export async function listBundledSkills() {
  const { groups, source } = await availableGroups();
  const skillSet = new Set();
  for (const g of Object.values(groups)) for (const s of g.skills) skillSet.add(s);
  const names = await bundledSkillNames();
  for (const n of names) skillSet.add(n); // 清单没登记但资产存在的也能装
  const def = await defaultGroupName();
  return {
    skills: [...skillSet],
    defaultSkill: def && skillSet.has(def) ? def : null,
    groups: Object.keys(groups),
    source,
  };
}

// 按 group 安装（幂等聚合：单 skill 结果带 group 字段，判别用显式 group 不做形状嗅探）
export async function installGroup({ name, to, force } = {}) {
  const { groups } = await availableGroups();
  const g = groups[name];
  if (!g) {
    const err = new Error(`未知 group: ${name}（可用: ${Object.keys(groups).join(', ')}）`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  const skills = [...new Set(g.skills)];
  const results = [];
  let replacedAny = false;
  for (const s of skills) {
    const r = await installBundledSkill({ name: s, to, force });
    if (r.replaced) replacedAny = true;
    results.push({ skill: s, ...r });
  }
  const conflicts = results.filter((r) => r.status === 'conflict');
  if (conflicts.length) {
    return { status: 'conflict', group: name, skills: results, count: conflicts.reduce((n, r) => n + r.count, 0) };
  }
  return { status: 'ok', group: name, replaced: replacedAny, skills: results, files: results.reduce((n, r) => n + r.files, 0) };
}

export async function installBundledSkill({ name, to, force } = {}) {
  // 默认 install：无参时装默认 group（= package.json.name 对应的清单 key）
  let skillName = name;
  if (!skillName) {
    const { groups } = await availableGroups();
    const def = await defaultGroupName();
    const g = def ? groups[def] : null;
    skillName = g?.skills?.length === 1 ? g.skills[0] : def && skillExists(def) ? def : SKILL_NAME;
  }
  skillName = assertSafeName(skillName);
  const src = join(ASSETS_DIR, skillName);
  if (!(await exists(join(src, 'SKILL.md')))) {
    const available = (await bundledSkillNames()).join(', ');
    const err = new Error(`未找到内置 skill: ${skillName}（可用: ${available}）`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const dst = join(to || DEFAULT_SKILLS_DIR, skillName);
  const files = await diffTrees(src, dst);
  if (!files.length) return { status: 'ok', skipped: true, path: dst, files: 0 };

  const existsDst = await exists(dst);
  if (existsDst && !force) {
    return { status: 'conflict', path: dst, files, count: files.length };
  }
  if (existsDst) await fsp.rm(dst, { recursive: true, force: true });
  await fsp.cp(src, dst, { recursive: true, dereference: true, force: true });
  return { status: 'ok', installed: !existsDst, replaced: existsDst, path: dst, files: files.length };
}

function skillExists(name) {
  return exists(join(ASSETS_DIR, name, 'SKILL.md'));
}

// skill get：读文档 + 顺手按 install 逻辑装
export async function getSkill({ name = SKILL_NAME, ref = '', to, force } = {}) {
  name = assertSafeName(name);
  let rel;
  if (!ref) rel = 'SKILL.md';
  else if (ref === 'SKILL.md') rel = 'SKILL.md';
  else if (ref.includes('/') || ref.startsWith('./')) rel = ref.replace(/^\.\//, '');
  else {
    // 裸名：先 references/<name>.md 再 <name>.md
    const a = join(ASSETS_DIR, name, 'references', `${ref}.md`);
    const b = join(ASSETS_DIR, name, `${ref}.md`);
    rel = (await exists(a)) ? join('references', `${ref}.md`) : (await exists(b)) ? `${ref}.md` : null;
    if (!rel) {
      const refs = await listRefs(name);
      const err = new Error(`未知 ref: ${ref}（可用: SKILL.md, ${refs.join(', ')}）`);
      err.code = 'INVALID_INPUT';
      throw err;
    }
  }
  if (rel.includes('..')) {
    const err = new Error(`ref 路径不允许包含 '..': ${ref}`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  const file = join(ASSETS_DIR, name, rel);
  const outside = !join(file).startsWith(join(ASSETS_DIR, name));
  if (outside) {
    const err = new Error(`ref 越界: ${ref}`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  let content;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch {
    const err = new Error(`未找到 skill 文档: ${name}/${rel}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const install = await installBundledSkill({ name, to, force });
  return { skillName: name, ref: rel, content, contentBytes: Buffer.byteLength(content, 'utf8'), install };
}

export function skillGetPrefix(name, ref) {
  return [
    `# === ${name} skill context ===`,
    `# 以下内容来自 ${name} skill \`${name}\` ${ref || 'SKILL.md'}。`,
    `# 建议：把 sentinel 行之后的全文复制到你可访问的路径（如 .claude/skills/${name}/SKILL.md），以便后续会话复用。`,
    SENTINEL,
    '',
  ].join('\n');
}

export function skillGetInstallStatus(install) {
  if (install.status === 'conflict') {
    return `-- install 状态 --\n冲突: ${install.path}（${install.count} 个文件不同；确认覆盖用 nx-as skill install --force）`;
  }
  if (install.skipped) return `-- install 状态 --\n已是最新: ${install.path}`;
  if (install.replaced) return `-- install 状态 --\n已替换: ${install.path}（${install.files} 个文件）`;
  return `-- install 状态 --\n已安装: ${install.path}（${install.files} 个文件）`;
}

export async function listRefs(name) {
  const dir = join(ASSETS_DIR, name, 'references');
  try {
    return (await fsp.readdir(dir)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

async function diffTrees(src, dst) {
  const changed = [];
  async function walk(s, d) {
    if (!(await exists(d))) {
      changed.push(s);
      return;
    }
    for (const entry of await fsp.readdir(s, { withFileTypes: true })) {
      const sp = join(s, entry.name);
      const dp = join(d, entry.name);
      if (entry.isDirectory()) await walk(sp, dp);
      else {
        const a = await hash(sp);
        const b = (await exists(dp)) ? await hash(dp) : '';
        if (a !== b) changed.push(sp);
      }
    }
  }
  await walk(src, dst);
  return changed;
}

async function hash(file) {
  const buf = await fsp.readFile(file);
  return createHash('md5').update(buf).digest('hex');
}

async function exists(p) {
  return fsp
    .stat(p)
    .then(() => true)
    .catch(() => false);
}
