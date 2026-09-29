// cert 模块单测：
//  - 静态 PEM fixture（tests/fixtures/test-cert.pem + test-key.pem / wrong-key.pem）
//    —— 不依赖 openssl CLI（CI 的 ubuntu-24.04 runner 不自带 openssl，spawnSync ENOENT 曾拦死发版）
//  - parseCert/parseKey 拒绝乱码、validatePair / importCert / removeCert / downloadPem / certStatus
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(new URL(`file://${ROOT.replace(/\\/g, '/')}/${p}`).href);

const dir = await mkdtemp(join(tmpdir(), 'cert-unit-'));
process.env.NXAS_SSL_DIR = dir;
process.env.NX_AS_HOME = join(ROOT, '.tool', 'test-store', 'cert.json');

const svc = await imp('src/modules/cert/service.js');
const { mutateStore, resetStoreCache } = await imp('src/core/store.js');

// ---------- 静态 fixture（签发时 CN=nx-as.test.local，36500 天） ----------

const FIXTURES = join(ROOT, 'tests', 'fixtures');
const validCert = readFileSync(join(FIXTURES, 'test-cert.pem'), 'utf8');
const validKey = readFileSync(join(FIXTURES, 'test-key.pem'), 'utf8');
const wrongKey = readFileSync(join(FIXTURES, 'wrong-key.pem'), 'utf8');

test('parseCert: 拒绝乱码', () => {
  assert.throws(() => svc.validatePair({ certPem: 'not a pem', keyPem: 'x' }), (e) => e.code === 'INVALID_INPUT');
});

test('parseKey: 拒绝非 PEM 私钥', () => {
  assert.throws(() => svc.validatePair({ certPem: '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----', keyPem: 'foo' }), (e) => e.code === 'INVALID_INPUT');
});

test('validatePair: 合法 cert+key 通过；公钥不匹配报错', () => {
  const info = svc.validatePair({ certPem: validCert, keyPem: validKey });
  assert.equal(info.subject, 'CN=nx-as.test.local');
  // Node 22 X509Certificate.fingerprint256 是冒号分隔的十六进制
  assert.equal(info.fingerprintSha256.replace(/:/g, '').length, 64);
  assert.throws(() => svc.validatePair({ certPem: validCert, keyPem: wrongKey }), (e) => e.code === 'INVALID_INPUT');
});

test('importCert: 落盘 0600/0644 + status 显示', async () => {
  resetStoreCache();
  await mutateStore((s) => { s.certs = { leaf: null }; });
  const r = await svc.importCert({ certPem: validCert, keyPem: validKey });
  assert.equal(r.status, 'ok');
  if (process.platform !== 'win32') {
    // Windows 不实现 POSIX 权限位，mode 断言仅在 Linux/CI 有效
    const certSt = await stat(join(dir, 'cert.pem'));
    assert.equal(certSt.mode & 0o777, 0o644, 'cert 0644');
    const keySt = await stat(join(dir, 'key.pem'));
    assert.equal(keySt.mode & 0o777, 0o600, 'key 0600');
  }
  resetStoreCache();
  const s = await svc.certStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.meta.subject, 'CN=nx-as.test.local');
});

test('removeCert: 删文件 + store.leaf=null', async () => {
  resetStoreCache();
  await mutateStore((s) => { s.certs = { leaf: null }; });
  await svc.importCert({ certPem: validCert, keyPem: validKey });
  await svc.removeCert();
  const s = await svc.certStatus();
  assert.equal(s.enabled, false);
  assert.match(s.message, /未导入/);
});

test('downloadPem: 导出已导入的 cert/key', async () => {
  resetStoreCache();
  await mutateStore((s) => { s.certs = { leaf: null }; });
  await svc.importCert({ certPem: validCert, keyPem: validKey });
  assert.ok((await svc.downloadPem('cert')).includes('BEGIN CERTIFICATE'));
  assert.ok((await svc.downloadPem('key')).includes('PRIVATE KEY'));
});

test('certStatus: 证书不存在 → enabled false + 提示', async () => {
  // service 在 import 时绑定 SSL 路径；清空 store.leaf 并删掉落盘文件来模拟「未导入」
  resetStoreCache();
  await mutateStore((s) => { s.certs = { leaf: null }; });
  await svc.removeCert();
  const s = await svc.certStatus();
  assert.equal(s.enabled, false);
  assert.match(s.message, /未导入/);
});

await rm(dir, { recursive: true, force: true });
