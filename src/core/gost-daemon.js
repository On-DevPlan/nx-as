// gost 常驻守护：注册隧道后自动拉起独立 gost 进程（不随 CLI 退出而死——
// 曾实测 CLI spawn 的 gost 随进程 EOF 断开）。
// - Windows：powershell Start-Process -WindowStyle Hidden（脱离控制台）
// - POSIX：spawn detached + stdio ignore + unref
// 已有 gost 进程在跑时跳过（避免端口竞争空转）。
import { spawn, execFile } from 'node:child_process';

/** 检测本机是否已有 gost 进程（有任何实例即复用，不重复拉起）。 */
export function hasGostRunning() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? execFile('tasklist', ['/FI', 'IMAGENAME eq gost.exe'], (_e, stdout) =>
          resolve(/gost\.exe/i.test(String(stdout || ''))))
      : execFile('pgrep', ['-x', 'gost'], () => resolve(true), () => resolve(false));
    if (process.platform !== 'win32') {
      execFile('pgrep', ['-x', 'gost'], () => resolve(true));
      execFile('which', ['pgrep'], (_e, out) => { if (!out) resolve(false); });
    }
    void cmd;
  });
}

/**
 * 拉起常驻 gost（聚合 client.json 全部隧道 -L）。
 * @param {{args: string[], bin?: string}} opts
 * @returns {Promise<{status: 'started'|'already_running'}>}
 */
export async function ensureGostDaemon({ args, bin = 'gost' }) {
  if (await hasGostRunning()) return { status: 'already_running' };
  await new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // PowerShell 数组参数转义：每个元素单引号包裹（内部单引号翻倍）
      const psArgs = ['-Command', 'Start-Process',
        '-FilePath', `'${bin}'`,
        '-ArgumentList', `'${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')}'`,
        '-WindowStyle', 'Hidden'];
      const p = spawn('powershell', psArgs, { stdio: 'ignore', detached: true });
      p.on('error', reject);
      p.on('spawn', () => { p.unref(); resolve(); });
    } else {
      const p = spawn(bin, args, { stdio: 'ignore', detached: true });
      p.on('error', reject);
      p.on('spawn', () => { p.unref(); resolve(); });
    }
  });
  return { status: 'started' };
}
