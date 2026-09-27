// 事件存储层：每个任务一份 JSONL（append-only）
//
// 为什么不用 store.json 加 events 字段：
// 1. append-only 写：每个 text_delta 都写 store = 全文件 IO，1 万字响应 = 几 MB 写盘
// 2. 自然分文件：单 task 体积独立，删 task 时一起删
// 3. SSE 重放：列出某 task 全部事件可独立用，不必带 store 大对象
//
// 存储位置：~/.nx-as/tasks/<taskId>.events.jsonl
// 与 pi 自己的 sessions/<...>.jsonl 分开 —— 那是 pi SDK 自己的事；这边是 nx-as
// 透传 / 累积 / 可视化用的「应用层事件流」。
import { fsp } from './fs.js';
import { join, dirname } from 'node:path';
import { appDirFromEnv, storePathFromEnv } from './paths.js';

function dir() {
  // tasks/ 与 store.json 同级（store 在 ~/.nx-as/store.json，则 events 在 ~/.nx-as/tasks/）
  const base = storePathFromEnv() === join(appDirFromEnv(), 'store.json')
    ? appDirFromEnv()
    : dirname(storePathFromEnv());
  return join(base, 'tasks');
}

function file(taskId) {
  if (!/^t_[a-z0-9]{4,30}$/.test(taskId)) {
    throw new Error(`非法 taskId: ${taskId}`);
  }
  return join(dir(), `${taskId}.events.jsonl`);
}

// 追加一条事件（追加失败抛异常，不让 task 状态走错）
export async function appendEvent(taskId, event) {
  const f = file(taskId);
  await fsp.mkdir(dir(), { recursive: true });
  // ts 强制由存储层注入，避免调用方传错；type/spanId 等允许调用方传
  // 注意：调用方不能传 ts 字段，否则会被覆盖（保留唯一时间源）
  const { ts: _ignore, ...rest } = event;
  const line = JSON.stringify({ ts: Date.now(), ...rest }) + '\n';
  await fsp.appendFile(f, line, 'utf8');
}

// 列出某 task 的全部事件（按时间顺序）
export async function listEvents(taskId) {
  const f = file(taskId);
  try {
    const raw = await fsp.readFile(f, 'utf8');
    const out = [];
    // 按行解析；坏行跳过（不挡 timeline）
    for (const l of raw.split(/\r?\n/)) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* skip */ }
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// 删除某 task 的事件文件（task remove 时清理）
export async function removeEvents(taskId) {
  const f = file(taskId);
  try { await fsp.unlink(f); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}