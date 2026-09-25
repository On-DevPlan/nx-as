import { spawn } from 'node:child_process';
import { platform } from 'node:os';

// 交给 OS 的动作：开浏览器（serve 用）
export function openBrowser(url) {
  const cmds = {
    win32: ['cmd', ['/c', 'start', '', url]],
    darwin: ['open', [url]],
    linux: ['xdg-open', [url]],
  };
  const [cmd, args] = cmds[platform()] || cmds.linux;
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false; // 开不了不挡主流程
  }
}
