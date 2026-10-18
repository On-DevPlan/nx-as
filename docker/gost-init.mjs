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
