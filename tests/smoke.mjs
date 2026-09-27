#!/usr/bin/env node
// 端到端 smoke：起 serve（随机端口 + 临时 store + 假执行器）→ 鉴权 → prompt/task 全链路 → SSE
// 不依赖模型密钥：用 runner 的 setExecutor 钩子替代真 pi 调用
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

// 假执行器：不碰 pi，直接走 override 路径
// serve 进程通过 NX_AS_FAKE_EXECUTOR=1 开启
process.env.NX_AS_STORE = join(await mkdtemp(join(tmpdir(), 'nxas-smoke-')), 'store.json');
process.env.NX_AS_TOKEN = TOKEN;
process.env.NX_AS_FAKE_EXECUTOR = '1';
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
  // 2. 鉴权
  const anon = await req('GET', '/api/tasks', undefined, null);
  ok(anon.status === 401, '无密钥 → 401');
  const bad = await req('GET', '/api/tasks', undefined, 'wrong');
  ok(bad.status === 401, '错误密钥 → 401');
  const good = await req('GET', '/api/tasks');
  ok(good.status === 200 && Array.isArray(good.data), '正确密钥 → 200 数组');
  const verify = await req('GET', '/api/auth/verify', undefined, TOKEN);
  ok(verify.data?.valid === true, 'verify 带 correct token → valid:true');
  const verifyBad = await req('GET', '/api/auth/verify', undefined, 'wrong');
  ok(verifyBad.data?.valid === false, 'verify 带错误 token → valid:false');

  // 3. prompt CRUD（HTTP 端）
  const add = await req('POST', '/api/prompts', { name: 'hello', content: '介绍 $input', description: 'smoke' });
  ok(add.status === 200 && add.data.name === 'hello', 'prompt add');
  const dup = await req('POST', '/api/prompts', { name: 'hello', content: 'x' });
  ok(dup.status === 409, 'prompt add 重复 → 409 CONFLICT');
  const list = await req('GET', '/api/prompts');
  ok(list.data.some((p) => p.name === 'hello'), 'prompt list 含 hello');
  const upd = await req('PATCH', '/api/prompts/hello', { description: '改过的' });
  ok(upd.data?.description === '改过的', 'prompt update PATCH 语义');
  const nf = await req('GET', '/api/prompts/nope');
  ok(nf.status === 404, 'prompt get 不存在 → 404');

  // 4. task 全链路（假执行器：echo 输入）
  const task = await req('POST', '/api/tasks', { promptId: 'hello', input: 'SMOKE_INPUT' });
  ok(task.status === 200 && task.data.id, 'task add 返回 id');
  ok(task.data.status === 'queued', 'task add 默认 queued（autoRun）');

  // 轮询等终态（假执行器立即完成）
  let final = null;
  for (let i = 0; i < 30; i++) {
    const r = await req('GET', `/api/tasks/${task.data.id}`);
    if (r.data?.status === 'done' || r.data?.status === 'error') { final = r.data; break; }
    await sleep(300);
  }
  ok(final?.status === 'done', 'task 执行到 done');
  ok(
    typeof final?.result === 'string' && final.result.includes('SMOKE_INPUT'),
    `task result 含渲染后的输入（got: ${JSON.stringify(final?.result?.slice(0, 50))})`,
  );

  // 5. SSE：流已结束，验证 replay（补发历史事件）
  const sse = await fetch(`${BASE}/api/tasks/${task.data.id}/events`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const text = await sse.text();
  ok(sse.headers.get('content-type')?.includes('text/event-stream'), 'SSE content-type');
  ok(text.includes('"type":"task_start"'), 'SSE replay 含 task_start');
  ok(text.includes('"type":"done"'), 'SSE replay 含 done');

  // 5.5 timeline：事件管道端到端（span 树 + tool span + thinking）
  const tl = await req('GET', `/api/tasks/${task.data.id}/timeline`);
  ok(tl.status === 200 && Array.isArray(tl.data?.spans), 'timeline 200 且含 spans');
  const spans = tl.data.spans || [];
  const turnSpans = spans.filter((s) => s.spanType === 'turn');
  const llmSpans = spans.filter((s) => s.spanType === 'llm');
  const toolSpans = spans.filter((s) => s.spanType === 'tool');
  ok(turnSpans.length === 1, `timeline 有 1 个 turn span（got ${turnSpans.length}）`);
  ok(llmSpans.length >= 1, `timeline 有 llm span（got ${llmSpans.length}）`);
  ok(llmSpans.some((s) => s.text?.includes('SMOKE_INPUT')), 'llm span 文本含渲染后的输入');
  ok(llmSpans.some((s) => s.attrs?.thinking), 'llm span 捕获 thinking');
  ok(toolSpans.length === 1, `timeline 有 1 个 tool span（got ${toolSpans.length}）`);
  const toolSpan = toolSpans[0];
  ok(toolSpan?.name === 'bash', 'tool span 名为 bash');
  ok(toolSpan?.input?.command === 'echo ok', 'tool span 保留 input.args');
  ok(toolSpan?.output?.output === 'ok\n', 'tool span 保留 output');
  ok(toolSpan?.startMs && toolSpan?.endMs && toolSpan.endMs >= toolSpan.startMs, 'tool span 有起止时间');
  // 树结构：tool 挂在 turn 下
  const turnId = turnSpans[0]?.id;
  ok((tl.data.tree[turnId] || []).includes(toolSpan?.id), 'tool span 挂在 turn 下（树结构正确）');

  // 6. task remove
  const rm = await req('DELETE', `/api/tasks/${task.data.id}`);
  ok(rm.status === 200 && rm.data.status === 'ok', 'task remove');
  const rmAgain = await req('DELETE', `/api/tasks/${task.data.id}`);
  ok(rmAgain.status === 404, 'task remove 再删 → 404');

  // 7. settings / models / system
  const st = await req('PATCH', '/api/settings', { 'max-concurrent': 4 });
  ok(st.data?.maxConcurrent === 4, 'settings set');
  const stBad = await req('PATCH', '/api/settings', { nope: 1 });
  ok(stBad.status === 400, 'settings set 未知项 → 400');
  const models = await req('GET', '/api/models');
  ok(Array.isArray(models.data?.builtin), 'models list');
  const health = await req('GET', '/api/health');
  ok(health.data?.ok === true, 'health');
  const boot = await req('GET', '/api/bootstrap');
  ok(Array.isArray(boot.data?.commands) && boot.data.commands.length > 10, 'bootstrap 命令表');
  const routes = await req('GET', '/api/routes?http=' + encodeURIComponent('GET /api/tasks'));
  ok(Array.isArray(routes.data) && routes.data[0]?.id === 'task.list', 'routes 反查');

  // 8. 静态页
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  ok(page.status === 200 && html.includes('<div id="root">'), '静态面板 index.html');
} finally {
  server.kill('SIGTERM');
}

console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
