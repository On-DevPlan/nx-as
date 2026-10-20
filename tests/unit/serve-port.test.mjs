// serve 端口协商单测：共享开关 / 面板探测 / 空闲端口 / 端口冲突两分支
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const {
  NO_OPEN_ENV,
  isEnvTruthy,
  autoOpenEnabled,
  probePanel,
  findFreePort,
  resolvePortConflict,
  describeOccupant,
} = await imp('src/core/serve-port.js');
// 认领签名必须用本项目真实的 APP_NAME：换成别的名字 reuse 分支根本测不到
const { APP_NAME } = await imp('src/core/paths.js');

// ---------- 临时服务（测完必须关，否则测试进程挂住） ----------

/** 起一个临时 HTTP 服务；返回 { port, close } */
function startFake(handler) {
  return new Promise((resolve_) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve_({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** 假的 /api/bootstrap：返回 { ok, data: { app: { name } } }（与各面板一致的信封） */
function fakePanel(appName) {
  return (req, res) => {
    if (req.url === '/api/bootstrap') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, data: { app: { name: appName, version: '0.9.1' } } }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false }));
  };
}

/**
 * 占端口的裸 TCP 服务：连上但不回应（探测只能超时）。
 * 收下的连接必须先销毁再 close——否则 server.close() 会一直等这些连接结束。
 */
async function holdPort() {
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise((r) => server.close(r));
    },
  };
}

// ---------- autoOpenEnabled（开关口径） ----------

test('autoOpenEnabled: 环境变量未设 + 无 flag → 允许开浏览器', () => {
  delete process.env[NO_OPEN_ENV];
  assert.equal(autoOpenEnabled(false), true);
  assert.equal(autoOpenEnabled(undefined), true);
});

test('autoOpenEnabled: NX_SERVE_NO_OPEN=1/true/yes/on → 禁止开浏览器', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
    process.env[NO_OPEN_ENV] = v;
    assert.equal(autoOpenEnabled(false), false, `NX_SERVE_NO_OPEN=${v} 应当禁用`);
  }
  delete process.env[NO_OPEN_ENV];
});

test('autoOpenEnabled: NX_SERVE_NO_OPEN=0 → 仍然允许（0 不算真值）', () => {
  process.env[NO_OPEN_ENV] = '0';
  assert.equal(autoOpenEnabled(false), true);
  delete process.env[NO_OPEN_ENV];
});

test('autoOpenEnabled: --no-open 生效（与环境变量是「或」关系）', () => {
  delete process.env[NO_OPEN_ENV];
  assert.equal(autoOpenEnabled(true), false, 'flag 单独为真即禁用');
  process.env[NO_OPEN_ENV] = '1';
  assert.equal(autoOpenEnabled(false), false, '环境变量单独为真即禁用');
  delete process.env[NO_OPEN_ENV];
});

test('共享开关的名字不带项目前缀（所有 nx-xx 项目同一个变量名）', () => {
  assert.equal(NO_OPEN_ENV, 'NX_SERVE_NO_OPEN');
  assert.equal(isEnvTruthy(undefined), false);
  assert.equal(isEnvTruthy(''), false);
  assert.equal(isEnvTruthy('off'), false);
  assert.equal(isEnvTruthy('1'), true);
});

// ---------- probePanel（认领签名） ----------

test('probePanel: 不是面板的端口 → null', async () => {
  // 占着端口但根本不是 HTTP 服务：探测超时后返回 null
  const holder = await holdPort();
  try {
    assert.equal(await probePanel(holder.port, '127.0.0.1', 800), null);
  } finally {
    await holder.close();
  }
});

test('probePanel: 有 HTTP 但不是面板（404）→ null', async () => {
  const fake = await startFake((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  try {
    assert.equal(await probePanel(fake.port, '127.0.0.1', 800), null);
  } finally {
    await fake.close();
  }
});

// ---------- findFreePort ----------

test('findFreePort: 从被占的端口往后找，返回的端口确实能监听', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  try {
    const next = await findFreePort(taken, '127.0.0.1');
    assert.ok(next > taken, `期望 > ${taken}，实际 ${next}`);
    const s = net.createServer();
    await new Promise((r, no) => {
      s.once('error', no);
      s.listen(next, '127.0.0.1', r);
    });
    await new Promise((r) => s.close(r));
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

// ---------- resolvePortConflict（reuse / shift 两分支） ----------

test('resolvePortConflict: 端口上是本项目的面板 → reuse（不重复启动）', async () => {
  const fake = await startFake(fakePanel(APP_NAME));
  try {
    const d = await resolvePortConflict(fake.port, APP_NAME, '127.0.0.1');
    assert.equal(d.action, 'reuse');
    assert.equal(d.port, fake.port, 'reuse 保持原端口');
    assert.equal(d.occupant, APP_NAME);
    assert.equal(describeOccupant(d.occupant), APP_NAME);
  } finally {
    await fake.close();
  }
});

test('resolvePortConflict: 端口上是别人的面板 → shift 到下一个空闲端口', async () => {
  const fake = await startFake(fakePanel('someone-else'));
  try {
    const d = await resolvePortConflict(fake.port, APP_NAME, '127.0.0.1');
    assert.equal(d.action, 'shift');
    assert.ok(d.port > fake.port, `期望 > ${fake.port}，实际 ${d.port}`);
    assert.equal(d.occupant, 'someone-else');
  } finally {
    await fake.close();
  }
});

test('resolvePortConflict: 探测不出来（不是面板）→ shift，占用者记为未知服务', async () => {
  const holder = await holdPort();
  try {
    const d = await resolvePortConflict(holder.port, APP_NAME, '127.0.0.1');
    assert.equal(d.action, 'shift');
    assert.ok(d.port > holder.port);
    assert.equal(describeOccupant(d.occupant), '未知服务');
  } finally {
    await holder.close();
  }
});

// ---------- nx-as 专属：管理面是 Bearer-only，探测必须带 Authorization 头 ----------

test('probePanel: 带 Authorization 头才能探到 Bearer-only 的管理面', async () => {
  const TOKEN = 'unit-bearer-token';
  const fake = await startFake((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: '密钥缺失或错误' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, data: { app: { name: APP_NAME, version: '0.9.1' } } }));
  });
  try {
    // 匿名探测 → 401 → 探不到（这正是 nx-as 必须先拿密钥的原因）
    assert.equal(await probePanel(fake.port, '127.0.0.1', 800), null);
    // 带密钥 → 探得到，并能读出认领签名
    const got = await probePanel(fake.port, '127.0.0.1', 800, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(got?.app?.name, APP_NAME);
    // 于是端口冲突判成 reuse（而不是一味 shift）
    const d = await resolvePortConflict(fake.port, APP_NAME, '127.0.0.1', {
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(d.action, 'reuse');
    assert.equal(d.port, fake.port);
  } finally {
    await fake.close();
  }
});
