import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';

export const APP_NAME = 'nx-as';
export const APP_DIR = join(homedir(), `.${APP_NAME}`);
export const STORE_PATH = join(APP_DIR, 'store.json');
// pi 的 agent 目录隔离在 nx-as 自己的目录下（auth.json / models.json / sessions 都在里面）
// 容器/多实例可用 PI_CODING_AGENT_DIR 覆盖（容器内 = /data/pi-agent，落在挂载卷上才会持久）
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(APP_DIR, 'pi-agent');

// 允许测试与多实例覆盖存储位置：环境变量优先
export function storePathFromEnv() {
  return process.env.NX_AS_STORE || STORE_PATH;
}

export function appDirFromEnv() {
  return process.env.NX_AS_HOME || APP_DIR;
}

// 名称校验：提示词名 / skill 名。只允许安全字符，防止路径穿越
export function assertSafeName(name) {
  if (typeof name !== 'string' || !name || name.length > 64) {
    throw invalidName(name);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.includes('..')) {
    throw invalidName(name);
  }
  return name;
}

// 路径校验：与名称分开校验，路径允许前导点（.gitignore 这类正常文件）
export function resolveWithin(baseDir, rel) {
  const abs = isAbsolute(rel) ? rel : resolve(baseDir, rel);
  const base = resolve(baseDir);
  if (abs !== base && !abs.startsWith(base + sepOf(abs, base))) {
    throw Object.assign(new Error(`路径越界: ${rel}`), { code: 'INVALID_INPUT' });
  }
  return abs;
}

function sepOf(a, b) {
  return a.includes('\\') || b.includes('\\') ? '\\' : '/';
}

function invalidName(name) {
  return Object.assign(
    new Error(`非法名称: ${JSON.stringify(name)}（只允许字母数字与 . _ -，且不以符号开头除首字母外）`),
    { code: 'INVALID_INPUT' },
  );
}
