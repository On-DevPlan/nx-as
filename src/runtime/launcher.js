// 安全启动器：拉起 pi-web 并注入机机信任
// - PI_WEB_PASSWORD 来源：store.machineSecret（nginx 模式与轮换语义）> 每次启动随机生成
//   （direct 模式未轮换前的兜底；一旦 nginx 模板渲染过就固定用 store 值，保证 nginx/pi-web 对齐）
// - pi-web 保持默认绑定 127.0.0.1（公网流量物理上只能经网关/nginx）
// - PI_CODING_AGENT_DIR 指向 ~/.nx-as/pi-agent（会话/扩展/模型与 pi CLI 共享的隔离目录）
import { randomBytes } from 'node:crypto';
import { PI_AGENT_DIR } from '../core/paths.js';

export async function resolvePiWebPassword() {
  const { loadStore } = await import('../core/store.js');
  const store = await loadStore();
  if (store.machineSecret) return store.machineSecret;
  // 首次生成并持久化（后续 nginx 模板渲染与 launcher 读同一个值）
  const secret = randomBytes(32).toString('hex');
  const { mutateStore } = await import('../core/store.js');
  await mutateStore((s) => { s.machineSecret = secret; }).catch(() => {});
  return secret;
}

export async function resolvePiWebBin() {
  try {
    const resolved = await import.meta.resolve('@agegr/pi-web/bin/pi-web.js');
    return new URL(resolved).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  } catch {
    return null;
  }
}

export async function spawnWeb({ port = 30141, open = false } = {}) {
  const { spawn } = await import('node:child_process');
  const binPath = await resolvePiWebBin();
  if (!binPath) {
    console.log('pi-web 未安装。安装后重试（一次性，约 200MB 依赖）：');
    console.log('  npm install -g @agegr/pi-web');
    console.log('或直接运行：');
    console.log(`  PI_CODING_AGENT_DIR="${PI_AGENT_DIR.replace(/\\/g, '/')}" npx @agegr/pi-web`);
    return null;
  }

  const piWebPassword = await resolvePiWebPassword();
  const { loadStore: ls } = await import('../core/store.js');
  const persisted = Boolean((await ls()).machineSecret);
  const child = spawn(process.execPath, [
    binPath, '--no-open',
    // 显式绑定 loopback（不依赖 pi-web 默认值 / PI_WEB_HOSTNAME）——公网流量物理上只能经网关
    '--hostname', '127.0.0.1',
    '--port', String(port),
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: PI_AGENT_DIR,
      PI_WEB_PASSWORD: piWebPassword,
    },
  });
  console.log(`pi-web: http://127.0.0.1:${port}  (PI_WEB_PASSWORD 已注入，来源=${persisted ? 'store' : 'random-first-run'})`);
  if (open) {
    const { openBrowser } = await import('../core/open.js');
    openBrowser(`http://127.0.0.1:${port}`);
  }
  child.on('exit', (code) => {
    // 独立 `nx-as web` 场景：子进程退出 = 进程退出（cmdWeb 的 Promise 永挂）。
    // serve --with-web 场景由 cmdServe 的 shutdown 负责 kill。
    if (!process.env.NXAS_SERVE_PARENT) process.exit(code ?? 0);
  });
  return { child };
}
