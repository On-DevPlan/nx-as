// nginx 托管模块单测：模板渲染 / apply 备份回滚（mock 执行层）/ status 形状
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

process.env.NX_AS_STORE = join(await mkdtemp(join(tmpdir(), 'nginx-unit-')), 'store.json');

const svc = await imp('src/modules/nginx/service.js');
const { mutateStore, resetStoreCache } = await imp('src/core/store.js');

// ---------- 模板渲染（纯函数） ----------

const CFG = { domain: 'agent.example.com', certPath: '/etc/ssl/fullchain.pem', keyPath: '/etc/ssl/privkey.pem', managedPath: '/etc/nginx/conf.d/nx-as-managed.conf' };

test('renderTemplate: 关键结构齐备（auth_request/直代/短票端点/SSE 不缓冲）', () => {
  const t = svc.renderTemplate(CFG, { machineSecret: 'SECRET' });
  assert.ok(t.includes('server_name agent.example.com'), '域名');
  assert.ok(t.includes('auth_request /_nxas_auth'), '委托鉴权');
  assert.ok(t.includes('proxy_pass http://127.0.0.1:7801/auth/check'), '委托端点');
  assert.ok(t.includes('proxy_pass http://127.0.0.1:30141/api/'), '直代 pi-web 且前缀替换 /m/v1→/api');
  assert.ok(t.includes('Authorization "Basic SECRET"'), '机机 Basic 注入');
  assert.ok(t.includes('proxy_buffering off'), 'SSE 不缓冲');
  assert.ok(t.includes('location ~ ^/m/v1/sessions/[^/]+/ticket$'), '短票端点直通');
  assert.ok(t.includes('ticket$'), '短票端点直通');
  assert.ok(t.includes('proxy_read_timeout 1h'), 'SSE 长连超时');
});

test('renderTemplate: 缺 domain/密码 报 INVALID_INPUT；缺证书 → 默认 HTTP', () => {
  assert.throws(() => svc.renderTemplate({ ...CFG, domain: '' }, { machineSecret: 'S' }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => svc.renderTemplate(CFG, { machineSecret: '' }), (e) => e.code === 'INVALID_INPUT');
});

test('renderTemplate: 无证书 → 默认 HTTP listen 80（无 ssl_* 指令）', () => {
  const cfgNoTls = { ...CFG, certPath: '', keyPath: '' };
  const t = svc.renderTemplate(cfgNoTls, { machineSecret: 'S' });
  assert.ok(t.includes('listen 80;'), '默认 HTTP listen 80');
  assert.ok(!t.includes('ssl_certificate'), '无 ssl_certificate');
  assert.ok(!t.includes('ssl_certificate_key'), '无 ssl_certificate_key');
  assert.ok(!t.includes('listen 443 ssl'), '无 TLS listen');
});

test('renderTemplate: 仅 certPath 或仅 keyPath → 报 INVALID_INPUT', () => {
  assert.throws(() => svc.renderTemplate({ ...CFG, keyPath: '' }, { machineSecret: 'S' }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => svc.renderTemplate({ ...CFG, certPath: '' }, { machineSecret: 'S' }), (e) => e.code === 'INVALID_INPUT');
});

test('renderTemplate: 有证书 → emit ssl_* 指令与 listen 443 ssl', () => {
  const t = svc.renderTemplate({ ...CFG, certPath: '/c.pem', keyPath: '/k.pem' }, { machineSecret: 'S' });
  assert.ok(t.includes('listen 443 ssl'), 'TLS listen');
  assert.ok(t.includes('ssl_certificate     /c.pem;'), 'ssl_certificate 路径');
  assert.ok(t.includes('ssl_certificate_key /k.pem;'), 'ssl_certificate_key 路径');
});

// ---------- apply 备份/回滚（mock sudo nginx 执行层，平台无关） ----------

test('nginxApply: 写托管文件 + nginx -t 失败自动回滚 + 成功 reload', async () => {
  process.env.NXAS_TEST_ALLOW_NON_LINUX = '1'; // 执行层已 mock，放行平台守卫验证文件层逻辑
  const dir = await mkdtemp(join(tmpdir(), 'nginx-apply-'));
  const managed = join(dir, 'nx-as-managed.conf');
  await mutateStore((s) => {
    s.nginx = { ...CFG, managedPath: managed };
    s.machineSecret = 'SECRET';
  });
  resetStoreCache();

  // 预置一个"现网旧版"，验证备份产生
  const fsp = (await import('node:fs/promises')).default;
  await fsp.writeFile(managed, '# old version', 'utf8');

  let nginxTestOk = true;
  const calls = [];
  svc._setExecFile((cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    if (args.includes('-t')) {
      if (nginxTestOk) return cb(null, '', 'syntax is ok');
      return cb(Object.assign(new Error('test failed'), { stderr: 'emerg: broken config' }), '', 'emerg: broken config');
    }
    return cb(null, '', '');
  });
  // 成功路径
  const r = await svc.nginxApply({});
  assert.equal(r.status, 'ok');
  const after = await fsp.readFile(managed, 'utf8');
  assert.ok(after.includes('server_name agent.example.com'), '托管文件被模板覆盖');
  const bak = await fsp.readFile(managed + '.bak', 'utf8');
  assert.equal(bak, '# old version', '现网旧版已备份');
  assert.ok(calls.some((c) => c.join(' ').includes('-s reload')), '执行了 reload');

  // 失败路径：nginx -t 失败 → 自动回滚
  nginxTestOk = false;
  await assert.rejects(() => svc.nginxApply({ domain: 'broken.example.com' }), (e) => e.code === 'EXTERNAL' && /已回滚/.test(e.message));
  const rolled = await fsp.readFile(managed, 'utf8');
  assert.ok(rolled.includes('agent.example.com'), '失败后保持上一份可用配置');

  // 重建备份为「旧版」，验证 rollback 动作
  await fsp.writeFile(managed + '.bak', '# rollback target', 'utf8');
  nginxTestOk = true;
  await svc.nginxRollback();
  assert.equal(await fsp.readFile(managed, 'utf8'), '# rollback target');

  svc._setExecFile(null);
  delete process.env.NXAS_TEST_ALLOW_NON_LINUX;
});

// ---------- 机机密码 ----------

test('machineSecret: 设置后 nginx 模板用该值（轮换语义）', async () => {
  resetStoreCache();
  // nginxApply 测试已写入 'SECRET'——验证 store → 模板的传导
  assert.equal(await svc.machineSecret(), 'SECRET');
  await mutateStore((s) => { s.machineSecret = 'NEWSECRET'; });
  resetStoreCache();
  assert.equal(await svc.machineSecret(), 'NEWSECRET');
  const t = svc.renderTemplate(CFG, { machineSecret: await svc.machineSecret() });
  assert.ok(t.includes('Basic NEWSECRET'));
});
