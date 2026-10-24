// nginx 看板单测：spec 校验 / 渲染 / conf 解析推断 / listHosts 分类 / upsert 管线（换名替换）
// （执行层 mock：nginx -t / -s reload 不真跑；平台守卫用 NXAS_TEST_ALLOW_NON_LINUX 放行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const TMP = await mkdtemp(join(tmpdir(), 'nginx-hosts-'));
process.env.NX_AS_STORE = join(TMP, 'store.json');
process.env.NX_AS_HOME = TMP;
process.env.NXAS_TEST_ALLOW_NON_LINUX = '1';
delete process.env.NXAS_NGINX_SUDO;

const hosts = await imp('src/modules/nginx/hosts.js');
const svc = await imp('src/modules/nginx/service.js');
const { mutateStore, resetStoreCache } = await imp('src/core/store.js');

const CONF_DIR = join(TMP, 'conf.d');
await mkdir(CONF_DIR, { recursive: true });

let nginxTestOk = true;
const calls = [];
svc._setExecFile((_cmd, args, _opts, cb) => {
  calls.push(args.join(' '));
  if (args.includes('-t')) {
    if (nginxTestOk) return cb(null, '', 'syntax is ok');
    return cb(Object.assign(new Error('t failed'), { stderr: 'emerg: broken' }), '', 'emerg: broken');
  }
  return cb(null, '', '');
});

async function seedStore() {
  await mutateStore((s) => {
    s.nginx = {
      domain: 'agent.example.com',
      certPath: '/c.pem', keyPath: '/k.pem',
      managedPath: join(CONF_DIR, 'nx-as-managed.conf'),
      enabled: false,
    };
    s.machineSecret = 'SECRET';
  });
  resetStoreCache();
}

test('hosts: renderHostConf 站点（TLS/WS/多域名）与端口转发两种形态', async () => {
  const site = hosts.renderHostConf({
    kind: 'site', domains: ['a.com', 'b.com'], upstream: '127.0.0.1:3000', ws: true,
    tls: { certPath: '/c.pem', keyPath: '/k.pem' },
  });
  assert.match(site, /listen 443 ssl;\n {4}http2 on;/);
  assert.match(site, /server_name a\.com b\.com;/);
  assert.match(site, /ssl_certificate\s+\/c\.pem;/);
  assert.match(site, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.match(site, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(site, /^# nxas-spec /m, '带 spec 头供面板回填');

  const port = hosts.renderHostConf({ kind: 'port', listenPort: 8081, upstream: 'http://192.168.1.5:9000' });
  assert.match(port, /listen 8081;/);
  assert.doesNotMatch(port, /server_name/);
  assert.match(port, /proxy_pass http:\/\/192\.168\.1\.5:9000;/);
  assert.match(port, /^# nxas-spec /m);
});

test('hosts: assertSpec 拒绝坏输入（域名/上游/端口/TLS 半配）', async () => {
  await seedStore();
  const bad = async (spec, msg) => assert.throws(() => hosts.renderHostConf(spec), (e) => e.message.includes(msg));
  await bad({ kind: 'site', domains: ['a b.com'], upstream: '1.2.3.4:80' }, '域名含非法字符');
  await bad({ kind: 'site', domains: [], upstream: '1.2.3.4:80' }, '至少需要一个域名');
  await bad({ kind: 'site', domains: ['a.com'], upstream: 'no-port' }, 'upstream 不合法');
  await bad({ kind: 'port', listenPort: 70000, upstream: '1.2.3.4:80' }, '1-65535');
  await bad({ kind: 'port', listenPort: 8081, upstream: '1.2.3.4:80', tls: { certPath: '/c.pem' } }, '必须同时给出');
  await bad({ kind: 'weird', upstream: '1.2.3.4:80' }, 'kind');
});

test('hosts: 解析推断（手写 conf 无 spec 也能进看板）', async () => {
  const conf = `server {
    listen 8080;
    server_name old.example.com;
    location / { proxy_pass http://192.168.1.5:8081/; }
}
`;
  const block = hosts.extractServerBlocks(conf)[0];
  const p = hosts.parseServerBlock(block);
  assert.deepEqual(p.domains, ['old.example.com']);
  assert.equal(p.listenPort, 8080);
  assert.equal(p.upstream, '192.168.1.5:8081');
  assert.equal(p.tls, null);
  assert.equal(p.ws, false);

  // 多 server 块与注释不干扰
  const multi = '# server { listen 1; }\nserver { listen 9090; }\nserver { listen 9091; }\n';
  assert.equal(hosts.extractServerBlocks(multi).length, 2);
});

test('hosts: listHosts 分类（gateway/site/port/custom）与 spec 回读', async () => {
  await seedStore();
  await writeFile(join(CONF_DIR, 'nx-as-managed.conf'), 'server { listen 443 ssl; server_name agent.example.com; }\n', 'utf8');
  await writeFile(join(CONF_DIR, hosts.hostFileName({ kind: 'site', domains: ['a.com'] })),
    hosts.renderHostConf({ kind: 'site', domains: ['a.com'], upstream: '127.0.0.1:3000' }), 'utf8');
  await writeFile(join(CONF_DIR, hosts.hostFileName({ kind: 'port', listenPort: 8081 })),
    hosts.renderHostConf({ kind: 'port', listenPort: 8081, upstream: '127.0.0.1:9000' }), 'utf8');
  await writeFile(join(CONF_DIR, 'hand.conf'), 'server { listen 80; server_name hand.com; location / { proxy_pass http://10.0.0.2:80/; } }\n', 'utf8');

  const r = await hosts.listHosts();
  const by = Object.fromEntries(r.hosts.map((h) => [h.name, h]));
  assert.equal(by['nx-as-managed.conf'].kind, 'gateway');
  assert.equal(by['nxas-site.a-com.conf'].kind, 'site');
  assert.equal(by['nxas-site.a-com.conf'].upstream, 'http://127.0.0.1:3000');
  assert.ok(by['nxas-site.a-com.conf'].spec, 'spec 回读');
  assert.equal(by['nxas-port.8081.conf'].kind, 'port');
  assert.equal(by['nxas-port.8081.conf'].listenPort, 8081);
  assert.equal(by['hand.conf'].kind, 'custom');
  assert.equal(by['hand.conf'].upstream, '10.0.0.2:80');
  assert.equal(by['hand.conf'].spec, null, '无 spec 头 → 表单编辑不可用');
  assert.equal(r.dirWritable, true);
});

test('hosts: upsertHost 新建落盘（走 -t + reload 管线）与换名替换', async () => {
  await seedStore();
  calls.length = 0;
  const r1 = await hosts.upsertHost({ kind: 'site', domains: ['x.com'], upstream: '127.0.0.1:4000' });
  assert.equal(r1.status, 'ok');
  assert.equal(r1.name, 'nxas-site.x-com.conf');
  assert.ok(calls.some((c) => c.includes('-t')) && calls.some((c) => c.includes('-s reload')));
  const onDisk = await readFile(join(CONF_DIR, 'nxas-site.x-com.conf'), 'utf8');
  assert.match(onDisk, /server_name x\.com;/);

  // 编辑并改名（域名变了 → 新文件落盘 + 旧文件删除）
  calls.length = 0;
  const r2 = await hosts.upsertHost({ kind: 'site', domains: ['y.com'], upstream: '127.0.0.1:4000' }, 'nxas-site.x-com.conf');
  assert.equal(r2.name, 'nxas-site.y-com.conf');
  await assert.rejects(readFile(join(CONF_DIR, 'nxas-site.x-com.conf'), 'utf8'), /ENOENT/, '旧文件已删除');
  assert.match(await readFile(join(CONF_DIR, 'nxas-site.y-com.conf'), 'utf8'), /server_name y\.com;/);

  // 同名编辑：原位更新（先备份）
  calls.length = 0;
  const r3 = await hosts.upsertHost({ kind: 'site', domains: ['y.com'], upstream: '127.0.0.1:4001' }, 'nxas-site.y-com.conf');
  assert.equal(r3.name, 'nxas-site.y-com.conf');
  assert.ok(r3.backedUp, '原位更新先备份');
  assert.match(await readFile(join(CONF_DIR, 'nxas-site.y-com.conf'), 'utf8'), /127\.0\.0\.1:4001/);
});

test('hosts: upsertHost nginx -t 失败时抛出且目标文件不生效', async () => {
  await seedStore();
  nginxTestOk = false;
  try {
    await assert.rejects(
      hosts.upsertHost({ kind: 'port', listenPort: 9099, upstream: '127.0.0.1:1' }),
      (e) => e.message.includes('nginx -t 失败'),
    );
    // -t 失败管线会还原：新建场景目标文件被移除
    await assert.rejects(readFile(join(CONF_DIR, 'nxas-port.9099.conf'), 'utf8'), /ENOENT/);
  } finally {
    nginxTestOk = true;
  }
});

test('hosts: 停用副本编辑（previousName 为 .disabled）不残留双文件', async () => {
  await seedStore();
  await hosts.upsertHost({ kind: 'port', listenPort: 9100, upstream: '127.0.0.1:2' });
  const filesMod = await imp('src/modules/nginx/files.js');
  await filesMod.toggleConfigFile('nxas-port.9100.conf'); // → .disabled
  await hosts.upsertHost({ kind: 'port', listenPort: 9101, upstream: '127.0.0.1:2' }, 'nxas-port.9100.conf.disabled');
  await assert.rejects(readFile(join(CONF_DIR, 'nxas-port.9100.conf.disabled'), 'utf8'), /ENOENT/);
  assert.match(await readFile(join(CONF_DIR, 'nxas-port.9101.conf'), 'utf8'), /listen 9101;/);
  // 清理，避免影响后续用例（如有）
  await rm(join(CONF_DIR, 'nxas-port.9101.conf'), { force: true });
});
