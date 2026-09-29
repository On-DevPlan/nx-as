#!/usr/bin/env node
// 端到端 smoke：起 serve（随机端口 + 临时 store）→ 管理面鉴权 → prompts CRUD → 静态页
// 网关流程（/m/v1 反代、设备 token）在 tests/unit/gateway.test.mjs 单测 + 本文件第 7 节
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BIN = join(ROOT, 'bin', 'nx-as.mjs');
const PORT = 7800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'smoketoken';

process.env.NX_AS_STORE = join(await mkdtemp(join(tmpdir(), 'nxas-smoke-')), 'store.json');
process.env.NX_AS_TOKEN = TOKEN;
delete process.env.NX_AS_HOME;

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}`);
  }
}

async function req(method, path, body, token = TOKEN) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// 1. 起服务
const server = spawn(process.execPath, [BIN, 'serve', '--no-open', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
let serverLog = '';
server.stdout.on('data', (c) => (serverLog += c));
server.stderr.on('data', (c) => (serverLog += c));
server.on('exit', (code) => {
  if (code && code !== 0) {
    console.error('serve 进程退出:', code, '\n', serverLog);
    process.exit(1);
  }
});

let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/api/auth/verify`);
    if (r.status < 500) { up = true; break; }
  } catch { /* not yet */ }
  await sleep(250);
}
if (!up) {
  console.error('serve 40 次重试后仍未就绪\n', serverLog);
  server.kill();
  process.exit(1);
}
console.log(`smoke: serve 就绪 :${PORT}`);

try {
  // 2. 管理面鉴权
  const anon = await req('GET', '/api/devices', undefined, null);
  ok(anon.status === 401, '无密钥 → 401');
  const bad = await req('GET', '/api/devices', undefined, 'wrong');
  ok(bad.status === 401, '错误密钥 → 401');
  const verify = await req('GET', '/api/auth/verify', undefined, TOKEN);
  ok(verify.data?.valid === true, 'verify 带 correct token → valid:true');
  const verifyBad = await req('GET', '/api/auth/verify', undefined, 'wrong');
  ok(verifyBad.data?.valid === false, 'verify 带错误 token → valid:false');

  // 3. 设备管理（模型/Bearer 配置已移交 pi-web 自带设置页）
  const devices = await req('GET', '/api/devices');
  ok(devices.status === 200 && Array.isArray(devices.data), 'device list');
  const health = await req('GET', '/api/health');
  ok(health.data?.ok === true, 'health');
  const boot = await req('GET', '/api/bootstrap');
  ok(Array.isArray(boot.data?.commands) && boot.data.commands.length > 5, 'bootstrap 命令表');

  // 4. 静态页
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  ok(page.status === 200 && html.includes('<div id="root">'), '静态面板 index.html');

  // 5. SSE 短票端到端：签发（带前缀） → 无 header 带票请求
  //
  // 这段是回归测试：短票曾经「签发了但永远验不过」——check.js 的路径正则只匹配
  // /agent/:id/events，而实际请求路径是 /m/v1/agent/:id/events（差一层 /m/v1）。
  // 断言必须打到「带票请求不再 401」这一步，只测签发端点会漏掉。
  const gwSvc = await import(new URL('../src/modules/gateway/service.js', import.meta.url).href);
  const { token: dt } = await gwSvc.issueToken({ name: 'smoke-ticket' });
  ok(typeof dt === 'string' && dt.startsWith('nxas_d1.'), '签发 device token（短票前置）');

  const sid = 'smoke-sess-1';
  const ticketRes = await fetch(`${BASE}/m/v1/sessions/${sid}/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${dt}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const ticketBody = await ticketRes.json().catch(() => ({}));
  ok(ticketRes.status === 200 && typeof ticketBody.url === 'string',
    `短票签发 return url（${ticketBody.url || '无'}）`);
  // direct 模式无前缀；nginx 模式必须带 /_nxas（否则手机端会打到根路径）
  ok(!process.env.NXAS_GW_MODE || ticketBody.url?.startsWith('/_nxas/m/v1/'),
    '短票 url 前缀随部署模式');

  // 带票请求：本机没装 pi-web，上游不可达是预期的（502/404 都算「票通过了」），
  // 唯一不能出现的是 401 —— 那是票被拒的信号（曾经就是这样：签发了却永远验不过）。
  const viaTicket = await fetch(`${BASE}${ticketBody.url}`, { headers: { Accept: 'text/event-stream' } });
  ok(viaTicket.status !== 401, `带票请求不再 401（实际 ${viaTicket.status}）`);
  const replay = await fetch(`${BASE}${ticketBody.url}`, { headers: { Accept: 'text/event-stream' } });
  ok(replay.status === 401, `短票重放 → 401（实际 ${replay.status}）`);

  // 票与会话绑定：拿 A 会话的票去读 B 会话 → 401
  const otherSid = 'smoke-sess-2';
  const t2 = await fetch(`${BASE}/m/v1/sessions/${otherSid}/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${dt}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const url2 = (await t2.json().catch(() => ({}))).url;
  const cross = await fetch(`${BASE}${url2.replace(otherSid, sid)}`);
  ok(cross.status === 401, `短票换会话使用 → 401（实际 ${cross.status}）`);
} finally {
  server.kill('SIGTERM');
}

console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
