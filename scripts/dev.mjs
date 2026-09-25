#!/usr/bin/env node
// dev 启动器：vite(5180) + serve(7801) 双进程，一个 ctrl-c 双杀（A08 规范）
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NODE = process.execPath;
const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const SERVE_BIN = join(ROOT, 'bin', 'nx-as.mjs');

function prefixed(name, color) {
  return (buf) => {
    const text = buf.toString();
    for (const line of text.split('\n')) {
      if (line.trim()) process.stderr.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`);
    }
  };
}

// 等 vite ready：GET / 不再 ECONNREFUSED
async function waitVite(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const children = [];
function run(name, color, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
    cwd: ROOT,
    // Windows 下不 shell:true；node 二进制直启没有 npm.cmd 问题
  });
  children.push(child);
  child.stdout.on('data', prefixed(name, color));
  child.stderr.on('data', prefixed(name, color));
  child.on('exit', (code) => {
    if (code && code !== 0 && !shuttingDown) {
      process.stderr.write(`[${name}] 异常退出 (${code})，关闭全部\n`);
      shutdown();
    }
  });
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.stdin.on('close', shutdown);

const viteUrl = 'http://127.0.0.1:5180/';
run('vite', '36', NODE, [VITE_BIN, '--host', '127.0.0.1']); // Node 18+ IPv6 坑：必须显式 127.0.0.1

const ready = await waitVite(viteUrl);
if (!ready) {
  console.error('[dev] vite 60 秒内未就绪，退出');
  shutdown();
} else {
  run('serve', '33', NODE, [SERVE_BIN, 'serve', '--no-open'], {
    NXAS_DEV: '1',
  });
  console.log('[dev] 面板: http://127.0.0.1:5180/  (API 代理到 7801)');
}
