// nginx 多文件配置管理器单测：list/read/write/toggle/delete/backups/restore 全流程
// （执行层 mock：nginx -t / -s reload 不真跑；平台守卫用 NXAS_TEST_ALLOW_NON_LINUX 放行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const TMP = await mkdtemp(join(tmpdir(), 'nginx-files-'));
process.env.NX_AS_STORE = join(TMP, 'store.json');
process.env.NX_AS_HOME = TMP; // 备份目录落在临时根（nginx-backups/）
process.env.NXAS_TEST_ALLOW_NON_LINUX = '1';
delete process.env.NXAS_NGINX_SUDO; // 宿主模式语义

const files = await imp('src/modules/nginx/files.js');
const svc = await imp('src/modules/nginx/service.js');
const { mutateStore, resetStoreCache } = await imp('src/core/store.js');

const CONF_DIR = join(TMP, 'conf.d');
await mkdir(CONF_DIR, { recursive: true });

// 与 nginx.test.mjs 同款执行层 mock：-t 受 nginxTestOk 控制，-s reload 恒成功
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

test('files: list 管理目录（托管文件置顶、停用态识别、目录可写探测）', async () => {
  await seedStore();
  await writeFile(join(CONF_DIR, 'nx-as-managed.conf'), '# managed\n', 'utf8');
  await writeFile(join(CONF_DIR, 'app.conf'), 'server {}\n', 'utf8');
  await writeFile(join(CONF_DIR, 'old.conf.disabled'), '# off\n', 'utf8');
  await writeFile(join(CONF_DIR, 'notes.txt'), 'ignored\n', 'utf8'); // 非 conf 不进清单

  const r = await files.listConfigFiles();
  assert.equal(r.dir, CONF_DIR);
  assert.equal(r.dirWritable, true);
  const names = r.files.map((f) => f.name);
  assert.ok(names.includes('nx-as-managed.conf') && names.includes('app.conf') && names.includes('old.conf.disabled'));
  assert.ok(!names.includes('notes.txt'), '非 *.conf 不进清单');
  assert.equal(r.files[0].name, 'nx-as-managed.conf', '托管文件置顶');
  const app = r.files.find((f) => f.name === 'app.conf');
  assert.equal(app.enabled, true);
  assert.equal(app.managed, false);
  const old = r.files.find((f) => f.name === 'old.conf.disabled');
  assert.equal(old.enabled, false, '.disabled 识别为停用');
});

test('files: write 新建（-t + reload；目录外/非法名拒绝）', async () => {
  await seedStore();
  calls.length = 0;
  const r = await files.writeConfigFile('site-a.conf', 'server { listen 81; }\n');
  assert.equal(r.status, 'ok');
  assert.equal(r.created, true);
  assert.equal(await readFile(join(CONF_DIR, 'site-a.conf'), 'utf8'), 'server { listen 81; }\n');
  assert.ok(calls.some((c) => c.includes('-t')), '执行 nginx -t');
  assert.ok(calls.some((c) => c.includes('-s reload')), '执行 reload');

  await assert.rejects(() => files.writeConfigFile('../evil.conf', 'x'), (e) => e.code === 'INVALID_INPUT', '穿越拒绝');
  await assert.rejects(() => files.writeConfigFile('sub/evil.conf', 'x'), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => files.writeConfigFile('site-a.conf', '   '), (e) => e.code === 'INVALID_INPUT', '空内容拒绝');
});

test('files: write 更新走备份；-t 失败自动还原原文', async () => {
  await seedStore();
  await files.writeConfigFile('app.conf', 'v1-content\n');

  // 成功更新 → 产生备份
  const r = await files.writeConfigFile('app.conf', 'v2-content\n');
  assert.equal(r.created, false);
  assert.ok(r.backedUp, '返回备份时间戳');
  const bakDir = join(TMP, 'nginx-backups', 'app.conf');
  const baks = await readdir(bakDir);
  const bakContents = new Set(await Promise.all(baks.map((b) => readFile(join(bakDir, b), 'utf8'))));
  assert.ok(bakContents.has('v1-content\n'), '更新前的版本在备份里');

  // 失败更新 → 还原
  nginxTestOk = false;
  await assert.rejects(() => files.writeConfigFile('app.conf', 'broken ~~~\n'), (e) => e.code === 'EXTERNAL' && /已还原/.test(e.message));
  nginxTestOk = true;
  assert.equal(await readFile(join(CONF_DIR, 'app.conf'), 'utf8'), 'v2-content\n', '失败后保持上一份可用内容');
});

test('files: toggle 停用/启用（改名语义）与冲突拒绝', async () => {
  await seedStore();
  const r1 = await files.toggleConfigFile('site-a.conf');
  assert.equal(r1.to, 'site-a.conf.disabled');
  assert.equal(r1.enabled, false);
  assert.equal(await readFile(join(CONF_DIR, 'site-a.conf.disabled'), 'utf8'), 'server { listen 81; }\n');

  // 停用副本存在时写同名启用态文件 → shadow 规则拒绝（一个语义两份的混乱源头）
  await assert.rejects(() => files.writeConfigFile('site-a.conf', 'shadow\n'), (e) => e.code === 'INVALID_INPUT');

  // 双胞胎冲突（外部直接落盘构造）：目标名已存在 → toggle 拒绝
  await writeFile(join(CONF_DIR, 'twin.conf'), 'a\n', 'utf8');
  await writeFile(join(CONF_DIR, 'twin.conf.disabled'), 'b\n', 'utf8');
  await assert.rejects(() => files.toggleConfigFile('twin.conf'), (e) => e.code === 'INVALID_INPUT');

  const r2 = await files.toggleConfigFile('site-a.conf.disabled');
  assert.deepEqual({ to: r2.to, enabled: r2.enabled }, { to: 'site-a.conf', enabled: true });
});

test('files: delete + backups + restore 全链', async () => {
  await seedStore();
  await files.writeConfigFile('gone.conf', 'final-content\n');   // 新建：无备份
  await files.writeConfigFile('gone.conf', 'final-content-mid\n'); // 备份 v0
  await files.writeConfigFile('gone.conf', 'final-content-v2\n');  // 备份 v-mid

  const lb1 = await files.listBackups('gone.conf');
  assert.equal(lb1.backups.length, 2, '两次更新两份备份');
  assert.ok(lb1.backups[0].ts >= lb1.backups[1].ts, '倒序（新→旧）');

  const d = await files.deleteConfigFile('gone.conf');
  assert.equal(d.status, 'ok');
  await assert.rejects(() => files.readConfigFile('gone.conf'), (e) => e.code === 'NOT_FOUND');

  // 还原到最早那份（还原前当前内容先再备份 → 还原可再还原）
  const oldest = lb1.backups[lb1.backups.length - 1].ts;
  const r = await files.restoreBackup('gone.conf', oldest);
  assert.equal(r.status, 'ok');
  assert.equal(await readFile(join(CONF_DIR, 'gone.conf'), 'utf8'), 'final-content\n');

  await assert.rejects(() => files.restoreBackup('gone.conf', 'not-a-ts'), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => files.restoreBackup('gone.conf', '19990101-000000'), (e) => e.code === 'NOT_FOUND');
});

test('files: 容器模式同样可用（gost-as 容器形态同一套规则）', async () => {
  await seedStore();
  process.env.NXAS_NGINX_SUDO = '0';
  try {
    const r = await files.listConfigFiles();
    assert.equal(r.dirExists, true);
    assert.ok(r.files.some((f) => f.name === 'app.conf'), '容器模式能列出托管目录');
    const w = await files.writeConfigFile('container-test.conf', 'server {}\n');
    assert.equal(w.status, 'ok');
  } finally {
    delete process.env.NXAS_NGINX_SUDO;
  }
});

test('files: setup 输出完整管理授权（两档）', async () => {
  const s = await svc.nginxSetup();
  assert.ok(Array.isArray(s.steps) && s.steps.some((l) => l.includes('sudoers') || l.includes('NOPASSWD')));
  assert.ok((s.stepsFullManage || []).some((l) => l.includes('chgrp')), '完整管理档给出目录授权命令');
});

test('cleanup', async () => {
  svc._setExecFile(null);
  delete process.env.NXAS_TEST_ALLOW_NON_LINUX;
  await rm(TMP, { recursive: true, force: true });
});
