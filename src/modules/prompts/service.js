import { fsp } from '../../core/fs.js';
import { promptsDir, assertSafeName } from '../../core/paths.js';
import { notFound, conflict, badInput } from '../../core/errors.js';
import { join } from 'node:path';

// 提示词域：~/.nx-as/prompts/<name>.md
// frontmatter（--- 包裹的 YAML 简易格式）：description / model / tools
// 正文是模板，$input / ${input:-default} 占位

export async function listPrompts() {
  const dir = promptsDir();
  await fsp.mkdir(dir, { recursive: true });
  const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.md'));
  const out = [];
  for (const n of names) {
    try {
      const p = await getPrompt(n.slice(0, -3));
      out.push(p);
    } catch {
      // 单个坏文件不挡列表
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPrompt(name) {
  assertSafeName(name);
  const file = join(promptsDir(), `${name}.md`);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    throw notFound(`提示词不存在: ${name}（prompt list 查看可用）`);
  }
  return parsePromptFile(name, raw);
}

export async function addPrompt({ name, content, description = '' }) {
  assertSafeName(name);
  if (!content || !content.trim()) throw badInput('缺少 content（提示词正文）');
  const file = join(promptsDir(), `${name}.md`);
  if (await exists(file)) throw conflict(`提示词已存在: ${name}（用 prompt update 修改）`);
  const body = formatPromptFile({ description, content });
  await fsp.mkdir(promptsDir(), { recursive: true });
  await fsp.writeFile(file, body, 'utf8');
  return getPrompt(name);
}

export async function updatePrompt({ name, content, description }) {
  const cur = await getPrompt(name); // 不存在则抛 NOT_FOUND
  const next = {
    description: description !== undefined ? description : cur.description,
    content: content !== undefined && content !== '' ? content : cur.content,
  };
  await fsp.writeFile(join(promptsDir(), `${name}.md`), formatPromptFile(next), 'utf8');
  return getPrompt(name);
}

export async function removePrompt(name) {
  await getPrompt(name); // 不存在则抛 NOT_FOUND
  await fsp.unlink(join(promptsDir(), `${name}.md`));
  return { status: 'ok', removed: name };
}

// ---------- 模板渲染 ----------

export async function renderPrompt(name, input = '') {
  const p = await getPrompt(name);
  // 必须用**函数式**替换：替换串里的 $& / $` / $' 会被 String.replace 当作
  // 替换模式展开（$& = 匹配到的 "$input" 本身），用户输入含 $& 时会被静默吞掉。
  // 函数返回值不做模式解析。
  return p.content.replace(/\$\{input:-([^}]*)\}/g, (_, dflt) => (input ? input : dflt)).replace(/\$input/g, () => input);
}

// ---------- 文件格式 ----------

function parsePromptFile(name, raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name, description: '', content: raw.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { name, description: meta.description || '', content: m[2].trim() };
}

function formatPromptFile({ description, content }) {
  const head = description ? `---\ndescription: ${description}\n---\n\n` : '';
  return head + content.trim() + '\n';
}

async function exists(file) {
  return fsp
    .stat(file)
    .then(() => true)
    .catch(() => false);
}
