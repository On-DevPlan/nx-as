// gost 隧道单一模板单测：conf 内容锚点 + 走文件管线（备份/nginx -t 失败还原/reload）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const TMP = await mkdtemp(join(tmpdir(), 'nginx-tunnel-'));
process.env.NX_AS_STORE = join(TMP, 'store.json');
process.env.NX_AS_HOME = TMP;
process.env.NXAS_TEST_ALLOW_NON_LINUX = '1';
delete process.env.NXAS_NGINX_SUDO;
process.env.NXAS_API_PORT = '7801';

const tunnel = await imp('src/modules/nginx/tunnel.js');
const svc = await imp('src/modules/nginx/service.js');
const { mutateStore, resetStoreCache } = await imp('src/core/store.js');

const CONF_DIR = join(TMP, 'conf.d');
await mkdir(CONF_DIR, { recursive: true });

// 与 nginx-files.test.mjs 同款执行层 mock
let nginxTestOk = true;
svc._setExecFile((_cmd, args, _opts, cb) => {
  if (args.includes('-t')) {
    if (nginxTestOk) return cb(null, '', 'syntax is ok');
    return cb(Object.assign(new Error('t failed'), { stderr: 'emerg: broken' }), '', 'emerg');
  }
  return cb(null, '', '');
});

async function seed() {
  await mutateStore((s) => {
    s.nginx = {
      domain: '', certPath: '', keyPath: '',
      managedPath: join(CONF_DIR, 'nx-as-managed.conf'),
      enabled: false,
    };
    s.machineSecret = 'SECRET';
  });
  resetStoreCache();
}

await seed();

// ---------- 模板内容锚点（一致性核心：鉴权链路三要素必须随模板走） ----------

test('tunnelConf: 鉴权三要素 + 端口模型齐全', () => {
  const conf = tunnel.tunnelConf({ name: 'sqlh', pubPort: 7877, apiPort: 7801, rtcpPort: 17877 });
  assert.ok(conf.includes('listen 7877;'), '公网监听端口');
  assert.ok(conf.includes('auth_request /_tunnel_auth_7877;'), '数据面 auth_request 鉴权');
  assert.ok(conf.includes('proxy_pass http://127.0.0.1:7801/_nxas/auth/check;'), '委托 nx-as 鉴权端点');
  assert.ok(conf.includes('return 302 /_nxas/login?next=$request_uri;'), '401 跳 SSO 登录');
  assert.ok(conf.includes('proxy_pass http://127.0.0.1:17877;'), '数据面只进 gost 回环（10000+pub）');
  assert.ok(conf.includes('proxy_set_header Cookie $http_cookie;'), '会话 cookie 透传（浏览器载体）');
  assert.ok(conf.includes('proxy_set_header Authorization $http_authorization;'), 'Bearer 透传（CLI 载体）');
  assert.ok(conf.includes('location /assets/'), '面板 SPA 静态资源反代（缺了隧道口面板白屏）');
  assert.ok(conf.includes('favicon'), 'favicon/logo 反代');
});

// ---------- upsert / remove 走文件管线 ----------

test('upsertTunnel: 写 conf + nginx -t 通过；参数校验', async () => {
  const r = await tunnel.upsertTunnel({ name: 'sqlh', public: 7877 });
  assert.equal(r.status, 'ok');
  assert.equal(r.rtcpPort, 17877);
  const content = await readFile(join(CONF_DIR, 'nxas-tunnel-sqlh.conf'), 'utf8');
  assert.ok(content.includes('listen 7877;'), 'conf 落盘且内容来自单一模板');

  await assert.rejects(() => tunnel.upsertTunnel({ name: 'bad name!', public: 1 }), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => tunnel.upsertTunnel({ name: 'x', public: 70000 }), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => tunnel.upsertTunnel({ name: 'x', public: 60000 }), (e) => e.code === 'INVALID_INPUT', '10000+pub 越界拒绝');
});

test('upsertTunnel: nginx -t 失败 → conf 不落盘（管线还原语义）', async () => {
  nginxTestOk = false;
  await assert.rejects(() => tunnel.upsertTunnel({ name: 'broken', public: 7001 }));
  nginxTestOk = true;
  const files = await readdir(CONF_DIR);
  assert.ok(!files.includes('nxas-tunnel-broken.conf'), '失败不残留');
});

test('removeTunnel: 删除（先备份）；不存在报 NOT_FOUND', async () => {
  await tunnel.upsertTunnel({ name: 'gone', public: 7002 });
  const r = await tunnel.removeTunnel({ name: 'gone' });
  assert.equal(r.status, 'ok');
  const backups = await readdir(join(TMP, 'nginx-backups', 'nxas-tunnel-gone.conf')).catch(() => []);
  assert.ok(backups.length >= 1, '删除前已备份');
  await assert.rejects(() => tunnel.removeTunnel({ name: 'gone' }), (e) => e.code === 'NOT_FOUND');
});
