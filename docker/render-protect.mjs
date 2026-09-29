// 渲染 NXAS_PROTECT 路径为 nginx location 块（v0.6 基础镜像）
//
// NXAS_PROTECT：空格分隔的路径模式，需要 nx-as 鉴权后才放行
//   /*               → 全部路径都鉴权（catch-all 带 auth_request）
//   /api/* /admin/*  → 只有这些前缀鉴权，其余公开直通
// 每条前缀模式渲染出「精确匹配 + 前缀匹配」两条 location（/api 与 /api/ 都覆盖）
//
// 输出两个文件（避免 shell 变量转义问题）：
//   /tmp/nxas-protect-blocks.conf  —— 受保护路径的 location 块
//   /tmp/nxas-catchall-auth.txt    —— "1"/"0"：catch-all location / 是否带 auth_request
import { writeFileSync } from 'node:fs';

const protect = (process.env.NXAS_PROTECT || '/*').trim();
const targetPort = process.env.NXAS_TARGET_PORT || '30141';
const authHeader = process.env.NXAS_TARGET_AUTH_HEADER || '';  // 例：Basic xxx（上游需要时）
const patterns = protect.split(/\s+/).filter(Boolean);

const PROTECT_ALL = patterns.includes('/*') || patterns.includes('/');

function body(indent) {
  const i = ' '.repeat(indent);
  const lines = [
    `${i}auth_request /_nxas/auth-internal;`,
    `${i}auth_request_set $nxas_device $upstream_http_x_device_id;`,
    `${i}error_page 401 = @nxas_login;`,
    `${i}proxy_pass http://127.0.0.1:${targetPort};`,
    `${i}proxy_set_header Host $http_host;`,
    `${i}proxy_set_header X-Forwarded-Proto $scheme;`,
    `${i}proxy_http_version 1.1;`,
    `${i}proxy_set_header Connection "";`,
    `${i}proxy_buffering off;`,
    `${i}proxy_read_timeout 1h;`,
    `${i}proxy_set_header X-Forwarded-For $remote_addr;`,
    `${i}add_header X-Nxas-Device $nxas_device always;`,
  ];
  if (authHeader && authHeader !== 'none') {
    lines.push(`${i}proxy_set_header Authorization "${authHeader}";`);
  }
  return lines.join('\n');
}

const out = [];
if (!PROTECT_ALL) {
  for (const p of patterns) {
    const isPrefix = p.endsWith('/*');
    const base = isPrefix ? p.slice(0, -2) : p;
    if (!base.startsWith('/')) continue;
    out.push(`    location = ${base} {\n${body(8)}\n    }`);
    if (isPrefix && base !== '') {
      out.push(`    location ${base}/ {\n${body(8)}\n    }`);
    }
  }
}

writeFileSync(process.env.NXAS_TMPDIR ? process.env.NXAS_TMPDIR + '/nxas-protect-blocks.conf' : '/tmp/nxas-protect-blocks.conf', out.join('\n') + (out.length ? '\n' : ''), 'utf8');
writeFileSync(process.env.NXAS_TMPDIR ? process.env.NXAS_TMPDIR + '/nxas-catchall-auth.txt' : '/tmp/nxas-catchall-auth.txt', PROTECT_ALL ? '1' : '0', 'utf8');
console.log(`[render-protect] NXAS_PROTECT="${protect}" → ${PROTECT_ALL ? 'catch-all 鉴权' : out.length + ' 个受保护 location'}；上游 127.0.0.1:${targetPort}`);
