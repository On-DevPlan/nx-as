// 外部证书导入模块：仅做 PEM 解析、校验、配对验证、落盘、清理；nx-as 不签证书
import { X509Certificate, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { badInput, notFound } from '../../core/errors.js';
import { loadStore, mutateStore } from '../../core/store.js';
import { appendAudit } from '../../core/audit.js';

const SSL_DIR = process.env.NXAS_SSL_DIR || '/etc/nginx/ssl';
const CERT_PATH = join(SSL_DIR, 'cert.pem');
const KEY_PATH = join(SSL_DIR, 'key.pem');

// ---------- PEM 解析 ----------

function parseCert(pem) {
  if (typeof pem !== 'string') throw badInput('证书必须是 PEM 字符串');
  const text = pem.trim();
  if (!text.includes('-----BEGIN CERTIFICATE-----')) {
    throw badInput('证书 PEM 缺少 BEGIN CERTIFICATE 头');
  }
  let x509;
  try {
    x509 = new X509Certificate(text);
  } catch (e) {
    throw badInput(`证书 PEM 解析失败：${e.message}`);
  }
  return x509;
}

function parseKey(pem) {
  if (typeof pem !== 'string') throw badInput('私钥必须是 PEM 字符串');
  const text = pem.trim();
  if (!/-----BEGIN (RSA |EC |ENCRYPTED |)PRIVATE KEY-----/.test(text)) {
    throw badInput('私钥 PEM 缺少 PRIVATE KEY 头（支持 RSA/EC/加密）');
  }
  try {
    return createPrivateKey(text);
  } catch (e) {
    throw badInput(`私钥 PEM 解析失败：${e.message}`);
  }
}

// 公私钥匹配：导出双方 SPKI DER 后比对 SHA-256
// 已知限制：Node 22 privateKey.export({type:'spki'}) 不支持（仅私钥 PKCS8），需要走
// crypto.createPrivateKey(pkcs8Pem)→publicKey 路径；这里直接通过 crypto.X509Certificate
// + publicKey.export 拿证书端公钥，对私钥则从 PKCS8 PEM 重建 KeyObject（同名 KeyObject
// 的 spki 与私钥的 spki 在 DER 序列化上等价），比对 DER hash 即可。
function certMatchesKey(cert, keyObject) {
  // 1) 证书公钥 → DER
  const certSpki = cert.publicKey.export({ type: 'spki', format: 'der' });
  // 2) Node 22：createPublicKey(privateKeyObject) 直接从 PrivateKeyObject 抽公钥
  const pubFromPriv = createPublicKey(keyObject);
  const privSpki = pubFromPriv.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(certSpki).digest('hex')
    === createHash('sha256').update(privSpki).digest('hex');
}

// ---------- 校验（不落盘）----------

export function validatePair({ certPem, keyPem }) {
  const cert = parseCert(certPem);
  const key = parseKey(keyPem);
  if (!certMatchesKey(cert, key)) {
    throw badInput('私钥与证书不匹配（公钥不同）');
  }
  return {
    subject: cert.subject.replace(/\n/g, ', '),
    issuer: cert.issuer.replace(/\n/g, ', '),
    notBefore: cert.validFrom,
    notAfter: cert.validTo,
    fingerprintSha256: cert.fingerprint256,
    keyType: key.asymmetricKeyType,
    serialNumber: cert.serialNumber,
  };
}

// ---------- 状态查询 ----------

export async function certStatus() {
  const certPath = process.env.NXAS_SSL_CERT_PATH || CERT_PATH;
  const keyPath = process.env.NXAS_SSL_KEY_PATH || KEY_PATH;
  const certExists = existsSync(certPath);
  const keyExists = existsSync(keyPath);

  if (!certExists && !keyExists) {
    const store = await loadStore();
    return {
      enabled: false,
      certPath,
      keyPath,
      message: '未导入证书（nginx 默认 HTTP）',
      meta: store.certs?.leaf || null,
    };
  }

  const meta = {};
  if (certExists) {
    try {
      const pem = await readFile(certPath, 'utf8');
      const cert = parseCert(pem);
      meta.subject = cert.subject.replace(/\n/g, ', ');
      meta.issuer = cert.issuer.replace(/\n/g, ', ');
      meta.notBefore = cert.validFrom;
      meta.notAfter = cert.validTo;
      meta.fingerprintSha256 = cert.fingerprint256;
      meta.serialNumber = cert.serialNumber;
    } catch (e) {
      meta.error = e.message;
    }
  }
  meta.certPath = certPath;
  meta.keyPath = keyPath;
  meta.enabled = certExists && keyExists;

  return { enabled: meta.enabled, certPath, keyPath, meta, message: meta.enabled ? '证书已导入（HTTPS 可启用）' : '证书残缺' };
}

// ---------- 落盘（原子写 + 0644） ----------

async function atomicWriteFile(path, content, mode) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, content, { encoding: 'utf8', mode });
  await rename(tmp, path);
  await chmod(path, mode);
}

// ---------- 导入 ----------

export async function importCert({ certPem, keyPem }) {
  const info = validatePair({ certPem, keyPem });
  const certPath = process.env.NXAS_SSL_CERT_PATH || CERT_PATH;
  const keyPath = process.env.NXAS_SSL_KEY_PATH || KEY_PATH;

  await atomicWriteFile(certPath, certPem.trim() + '\n', 0o644);
  await atomicWriteFile(keyPath, keyPem.trim() + '\n', 0o600);

  await mutateStore((s) => {
    s.certs = {
      ...s.certs,
      leaf: {
        ...info,
        certPath,
        keyPath,
        importedAt: Date.now(),
      },
    };
  });

  appendAudit({ action: 'cert.import', detail: { certPath, fingerprintSha256: info.fingerprintSha256 } }).catch(() => {});

  return { status: 'ok', certPath, keyPath, ...info };
}

// ---------- 清理（仅删文件 + 清 store；managed nginx 配置由用户自行 apply） ----------

export async function removeCert() {
  const certPath = process.env.NXAS_SSL_CERT_PATH || CERT_PATH;
  const keyPath = process.env.NXAS_SSL_KEY_PATH || KEY_PATH;
  const removed = [];
  for (const p of [certPath, keyPath]) {
    try { await unlink(p); removed.push(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await mutateStore((s) => {
    if (s.certs) s.certs.leaf = null;
  });
  appendAudit({ action: 'cert.remove', detail: { removed } }).catch(() => {});
  return { status: 'ok', removed };
}

// ---------- 导出已导入的 PEM（面板/CLI 下载） ----------

export async function downloadPem(type = 'cert') {
  if (!['cert', 'key'].includes(type)) throw badInput('type 必须是 cert 或 key');
  const path = type === 'cert'
    ? (process.env.NXAS_SSL_CERT_PATH || CERT_PATH)
    : (process.env.NXAS_SSL_KEY_PATH || KEY_PATH);
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw notFound('证书文件不存在');
    throw e;
  }
}