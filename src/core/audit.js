// 审计日志：append-only JSONL（~/.nx-as/audit.jsonl）
// 高频 append 不走 store.json（全文件 IO）；与 store 同级存放。
// 坏行跳过不挡读取（审计是旁路，不让它拖垮主流程）。
import { fsp } from './fs.js';
import { join, dirname } from 'node:path';
import { appDirFromEnv, storePathFromEnv } from './paths.js';

function auditPath() {
  // audit.jsonl 与 store.json 同级（store 在 ~/.nx-as/store.json，则审计在 ~/.nx-as/audit.jsonl）
  const base = storePathFromEnv() === join(appDirFromEnv(), 'store.json')
    ? appDirFromEnv()
    : dirname(storePathFromEnv());
  return join(base, 'audit.jsonl');
}

// 追加一条审计记录（失败静默：审计失败不能拖垮请求主流程）
export async function appendAudit(entry) {
  try {
    const { ts: _ignore, ...rest } = entry;
    const line = JSON.stringify({ ts: Date.now(), ...rest }) + '\n';
    await fsp.mkdir(dirname(auditPath()), { recursive: true });
    await fsp.appendFile(auditPath(), line, 'utf8');
  } catch { /* 旁路：静默 */ }
}

// 读取全部审计（CLI/面板查看用；量大时可加 tail 参数）
export async function listAudit({ limit = 200 } = {}) {
  try {
    const raw = await fsp.readFile(auditPath(), 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const l of lines.slice(-limit)) {
      try { out.push(JSON.parse(l)); } catch { /* skip */ }
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
