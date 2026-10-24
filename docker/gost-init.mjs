// gost-as 首启初始化：machineSecret + 托管目录指向 http.d
// 托管目录 = /etc/nginx/http.d → 面板「配置文件管理器」直接管理隧道 server 块
// （nxas-tunnel-*.conf 即端口映射），与宿主机形态同一套安全管线（nginx -t + reload + 备份）。
import { loadStore, mutateStore } from '../src/core/store.js';
import { randomBytes } from 'node:crypto';

const MANAGED = '/etc/nginx/http.d/gost-as-managed.conf';

const store = await loadStore(); // ENOENT → 空结构（首启）
const patch = {};
if (!store.machineSecret) patch.machineSecret = randomBytes(32).toString('hex');
if (!store.nginx?.managedPath || store.nginx.managedPath === '/etc/nginx/conf.d/nx-as-managed.conf') {
  patch.nginx = { ...(store.nginx || {}), managedPath: MANAGED };
}
if (patch.machineSecret || patch.nginx) {
  await mutateStore((s) => {
    if (patch.machineSecret) s.machineSecret = patch.machineSecret;
    if (patch.nginx) s.nginx = { ...s.nginx, ...patch.nginx };
  });
  console.error('[gost-init] store 已初始化（machineSecret + managedPath=http.d）');
} else {
  console.error('[gost-init] store 复用现有配置');
}

// ---------- 公网部署硬门槛：SSO 三要素齐全才许启动 ----------
// gost-as 形态公网可达，鉴权是它的存在意义。特别是登录白名单：不设的话
// **任何 go-ah 用户**都能登录面板与全部隧道端口——等于把内网穿透开放给整个平台。
// 生效值 = env 覆盖 store（与 runtime/oidc.js 的 oidcConfig 同一优先级）。
// 本地调试可 NXAS_OIDC_ENFORCE=0 跳过。
if (process.env.NXAS_OIDC_ENFORCE !== '0') {
  const issuer = (process.env.NXAS_OIDC_ISSUER || store.oidc.issuer || '').trim();
  const clientId = (process.env.NXAS_OIDC_CLIENT_ID || store.oidc.clientId || '').trim();
  const emails = (process.env.NXAS_OIDC_ALLOWED_EMAILS
    || (Array.isArray(store.oidc.allowedEmails) ? store.oidc.allowedEmails.join(',') : '')).trim();
  const missing = [];
  if (!issuer) missing.push('NXAS_OIDC_ISSUER（go-ah 地址，如 http://47.110.80.47:8082）');
  if (!clientId) missing.push('NXAS_OIDC_CLIENT_ID（如 nx-as）');
  if (!emails) missing.push('NXAS_OIDC_ALLOWED_EMAILS（登录白名单邮箱——不设则任何 go-ah 用户都能进面板与隧道）');
  if (missing.length) {
    console.error(`[gost-init] FATAL: 公网部署缺少 SSO 配置，拒绝启动。缺: ${missing.join('; ')}。本地调试可 NXAS_OIDC_ENFORCE=0 跳过。`);
    process.exit(1);
  }
  console.error(`[gost-init] SSO 门槛通过：issuer=${issuer} client=${clientId} 白名单=${emails}`);
}
