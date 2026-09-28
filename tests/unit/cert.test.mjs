// cert 模块单测：
//  - parseCert/parseKey 拒绝乱码 → 不依赖外部 PEM fixture
//  - validatePair / importCert / removeCert / downloadPem / certStatus
//    → 用 openssl 子进程生成 PEM（Git Bash 下 cwd=绝对 Windows 路径 + MSYS_NO_PATHCONV=1）
//  - 依赖 Node 22 + 已安装 openssl；失败时测试 skip 并打印原因
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const dir = await mkdtemp(join(tmpdir(), 'cert-unit-'));
process.env.NXAS_SSL_DIR = dir;
process.env.NX_AS_HOME = join(ROOT, '.tool', 'test-store', 'cert.json');

const svc = await imp('src/modules/cert/service.js');
const { mutateStore, resetStoreCache } = await imp('src/core/store.js');

// ---------- openssl fixture：cwd=绝对 Windows 路径 + MSYS_NO_PATHCONV=1 ----------

// openssl fixture：cwd=绝对 Windows 路径 + MSYS_NO_PATHCONV=1
// 注意：Node test_runner 在 Windows 上对 spawnSync 的 PATH 解析不稳定；
// 如果连续两次 spawn 失败，第二+次 ENOENT。把这里改成「失败即放弃」的容错。
function selfSignedPem({ commonName = 'nx-as.test.local', days = 30 } = {}) {
  const safe = commonName.replace(/\W/g, '_');
  const keyName = `k_${safe}.pem`;
  const certName = `c_${safe}.pem`;
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', String(days), '-nodes',
    '-keyout', keyName, '-out', certName, '-subj', `/CN=${commonName}`],
    {
      encoding: 'utf8', timeout: 10_000, cwd: dir,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('openssl status=' + r.status);
  return { keyPath: join(dir, keyName), certPath: join(dir, certName) };
}

// 预生成 fixture（fail-fast：openssl 不可用则全测试 skip）
let validCert, validKey;
try {
  const f = selfSignedPem({ commonName: 'fixture.local' });
  validCert = readFileSync(f.certPath, 'utf8');
  validKey = readFileSync(f.keyPath, 'utf8');
} catch (e) {
  console.warn('[cert.test] openssl fixture 失败（部分测试将跳过）：', e.message);
}

test('parseCert: 拒绝乱码', () => {
  assert.throws(() => svc.validatePair({ certPem: 'not a pem', keyPem: 'x' }), (e) => e.code === 'INVALID_INPUT');
});

test('parseKey: 拒绝非 PEM 私钥', () => {
  assert.throws(() => svc.validatePair({ certPem: '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----', keyPem: 'foo' }), (e) => e.code === 'INVALID_INPUT');
});

test('validatePair: 合法 cert+key 通过；公钥不匹配报错', async () => {
  if (!validCert) return;
  const info = svc.validatePair({ certPem: validCert, keyPem: validKey });
  assert.equal(info.subject, 'CN=fixture.local');
  // Node 22 X509Certificate.fingerprint256 是冒号分隔的十六进制
  assert.equal(info.fingerprintSha256.replace(/:/g, '').length, 64);
  const f = selfSignedPem({ commonName: 'wrong.local' });
  const wrongKey = readFileSync(f.keyPath, 'utf8');
  assert.throws(() => svc.validatePair({ certPem: validCert, keyPem: wrongKey }), (e) => e.code === 'INVALID_INPUT');
});

test('importCert: 落盘 0600/0644 + status 显示', async () => {
  if (!validCert) return;
  resetStoreCache();
  await mutateStore((s) => { s.certs = { leaf: null }; });
  const f = selfSignedPem({ commonName: 'imported.local' });
  const certPem = await readFile(f.certPath, 'utf8');
  const keyPem = await readFile(f.keyPath, 'utf8');
  const r = await svc.importCert({ certPem, keyPem });
  assert.equal(r.status, 'ok');
  const certSt = await stat(join(dir, 'cert.pem'));
  assert.equal(certSt.mode & 0o777, 0o644, 'cert 0644');
  const keySt = await stat(join(dir, 'key.pem'));
  assert.equal(keySt.mode & 0o777, 0o600, 'key 0600');
  resetStoreCache();
  const s = await svc.certStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.meta.subject, 'CN=imported.local');
});

test('removeCert: 删文件 + store.leaf=null', async () => {
  if (!validCert) return;
  resetStoreCache();
  await mutateStore((s) => { s.certs = { leaf: null }; });
  const f = selfSignedPem({ commonName: 'remove.local' });
  const certPem = await readFile(f.certPath, 'utf8');
  const keyPem = await readFile(f.keyPath, 'utf8');
  await svc.importCert({ certPem, keyPem });
  await svc.removeCert();
  const s = await svc.certStatus();
  assert.equal(s.enabled, false);
  assert.match(s.message, /未导入/);
});

test('downloadPem: 导出已导入的 cert/key', async () => {
  if (!validCert) return;
  resetStoreCache();
  await mutateStore((s) => { s.certs = { leaf: null }; });
  const f = selfSignedPem({ commonName: 'dl.local' });
  const certPem = await readFile(f.certPath, 'utf8');
  const keyPem = await readFile(f.keyPath, 'utf8');
  await svc.importCert({ certPem, keyPem });
  assert.ok((await svc.downloadPem('cert')).includes('BEGIN CERTIFICATE'));
  assert.ok((await svc.downloadPem('key')).includes('PRIVATE KEY'));
});

test('certStatus: 证书不存在 → enabled false + 提示', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'cert-empty-'));
  const prev = process.env.NXAS_SSL_DIR;
  process.env.NXAS_SSL_DIR = empty;
  resetStoreCache();
  await mutateStore((s) => { s.certs = { leaf: null }; });
  const s = await svc.certStatus();
  assert.equal(s.enabled, false);
  process.env.NXAS_SSL_DIR = prev;
});

await rm(dir, { recursive: true, force: true });