import { fsp as _fsp } from './fs.js';
import { storePathFromEnv } from './paths.js';
import { dirname } from 'node:path';

export { dirname };

// 统一从这里拿 fsp，测试里好 mock
export const fsp = _fsp;

const EMPTY = () => ({
  version: 1,
  oidc: {                   // OIDC SSO（go-ah 认证中心）——人的凭据唯一来源
    issuer: '',             // 如 http://47.110.80.47:8082（逐字等于发现文档 issuer）
    clientId: '',           // 在 go-ah 注册的 client_id（public + PKCE，无 secret）
    redirectUri: '',        // 公网部署的精确回调地址；空 = 按请求动态构造（回环部署）
    scopes: 'openid profile email',
    sessionSecret: '',      // 会话 HMAC 密钥（持久化：重启不掉线；auth rotate 轮换）
    allowedEmails: [],      // 登录白名单（空 = 放行全部 go-ah 用户）
  },
  machineSecret: '',        // 机机密码（nginx 模板 Basic 注入；轮换走 nginx rotate-secret）
  nginx: {                  // nginx 托管配置（nginx 模块管理）
    domain: '',
    certPath: '',
    keyPath: '',
    managedPath: '/etc/nginx/conf.d/nx-as-managed.conf',
    enabled: false,
  },
  certs: {                  // 已导入的外部证书 metadata（cert/key 文件本身在 /etc/nginx/ssl）
    leaf: null,              // { subject, issuer, notBefore, notAfter, fingerprintSha256, keyType, serialNumber, certPath, keyPath, importedAt }
  },
});

function normalize(data) {
  const base = EMPTY();
  if (!data || typeof data !== 'object') return base;
  base.version = data.version ?? 1;
  base.oidc = { ...base.oidc, ...(data.oidc || {}) };
  if (typeof base.oidc.allowedEmails === 'string') {
    base.oidc.allowedEmails = base.oidc.allowedEmails.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(base.oidc.allowedEmails)) base.oidc.allowedEmails = [];
  // 旧结构的 auth.token / devices 已废弃（OIDC SSO 替代）：读进来直接丢弃，不再落盘
  base.machineSecret = data.machineSecret || '';
  base.nginx = { ...base.nginx, ...(data.nginx || {}) };
  base.certs = data.certs && typeof data.certs === 'object'
    ? { ...base.certs, ...data.certs }
    : base.certs;
  return base;
}

let cache = null;
let cacheMtime = -1;
let cachePath = '';

export async function loadStore(explicitPath) {
  const p = explicitPath || storePathFromEnv();
  try {
    const st = await fsp.stat(p);
    if (cache && cachePath === p && cacheMtime === st.mtimeMs) return cache;
    const raw = await fsp.readFile(p, 'utf8');
    cache = normalize(JSON.parse(raw));
    cacheMtime = st.mtimeMs;
    cachePath = p;
    return cache;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 权限/占用/损坏（EBUSY/EPERM/JSON 解析错…）绝不能静默当空 store——
      // 空结构会顺着 ensureToken/mutateStore 把真实密钥与设备清单「重置」掉。
      // 只有「文件确实不存在」（首次运行）才允许走空结构。
      throw Object.assign(new Error(`store 读取失败（${p}）: ${e.message}`), { code: 'INTERNAL' });
    }
    // 文件不存在：返回空结构（首次运行；测试/多实例重定向后首读同此）
    cache = normalize(null);
    cacheMtime = -1;
    cachePath = '';
    return cache;
  }
}

export async function saveStore(next, explicitPath) {
  const p = explicitPath || storePathFromEnv();
  const data = normalize(next);
  await fsp.mkdir(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, p); // rename 在同一文件系统上是原子的
  cache = data;
  cachePath = p;
  cacheMtime = (await fsp.stat(p)).mtimeMs; // 自己写入后主动刷新 mtime，避免「自己触发自己重读」
  return data;
}

// 读-改-写事务：fn 直接改传入的深拷贝；抛错则不落盘
export async function mutateStore(fn, explicitPath) {
  const cur = structuredClone(await loadStore(explicitPath));
  const result = await fn(cur);
  await saveStore(cur, explicitPath);
  return result === undefined ? cur : result;
}

// 测试辅助：清缓存（环境变量切换存储路径后必须调）
export function resetStoreCache() {
  cache = null;
  cacheMtime = -1;
  cachePath = '';
}
