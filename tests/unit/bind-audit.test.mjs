// bind-audit 单测：/proc 解析（小端序 IPv4/tcp6）、回环排除、nginx 端口集合、越权告警
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const audit = await imp('docker/bind-audit.mjs');

// 小端序：127.0.0.1=0100007F；0.0.0.0=00000000；47.110.80.47=2F506E2F
// 端口 hex：17877=45D5 8090=1F9A 23456=5BA0 17866=45CA 7866=1EBA(非 LISTEN 行)
const PROC = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmap   uid
   0: 0100007F:45D5 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0
   1: 00000000:1F9A 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0
   2: 2F506E2F:5BA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0
   3: 0100007F:45CA 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0
   4: 00000000:1EBA 00000000:0000 06 00000000:00000000 00:00000000 00000000     0
`;
// 端口：0x45D5=17877(回环) 0x1F90=8090 0x5B9A=23456(公网 47.110.80.47) 0x1F9C=17866(回环) 0x1F9A=7866(非 LISTEN 行,忽略)

test('parseListen: 小端序 IPv4 解析 + 只取 LISTEN', () => {
  const rows = audit.parseListen(PROC);
  assert.deepEqual(rows.map((r) => `${r.ip}:${r.port}`), [
    '127.0.0.1:17877',
    '0.0.0.0:8090',
    '47.110.80.47:23456',
    '127.0.0.1:17866',
  ]);
});

test('parseListen: tcp6 归一（全零→[::]、::1→[::1]）', () => {
  const V6 = ['  sl local_address rem_address st',
    '   0: 00000000000000000000000000000000:1F9A 00000000000000000000000000000000:0000 0A x',
    '   1: 00000000000000000000000001000000:1F9A 00000000000000000000000000000000:0000 0A x',
  ].join('\n');
  assert.deepEqual(audit.parseListen(V6, true).map((r) => r.ip), ['[::]', '[::1]']);
});

test('isLoopback: 回环判定', () => {
  assert.ok(audit.isLoopback({ ip: '127.0.0.1', port: 1 }));
  assert.ok(!audit.isLoopback({ ip: '0.0.0.0', port: 1 }));
  assert.ok(!audit.isLoopback({ ip: '47.110.80.47', port: 1 }));
});

test('nginxPorts: 从 conf 文本收集 listen（含模板注释行不误收）', () => {
  const conf = [
    'server {\n    listen 7877;\n    server_name _;\n}',
    '# listen 9999;（注释不应收）\nserver {\n    listen 7866;\n}',
  ];
  assert.deepEqual(new Set([...audit.nginxPorts(conf, 8442)]), new Set([8090, 8442, 7877, 7866]));
});

test('auditBinds: 越权 bind 告警、nginx/回环/白名单放行（Linux 实机路径）', async () => {
  const { existsSync } = await import('node:fs');
  if (!existsSync('/proc/net/tcp')) {
    console.log('  (Windows 无 /proc，跳过实机扫描断言——解析逻辑已由上面用例覆盖)');
    return;
  }
  const r = await audit.auditBinds({ allow: [], nginxPortSet: new Set(), log: () => {} });
  assert.equal(r.checked, true);
  assert.ok(Array.isArray(r.offenders));
  assert.ok(r.offenders.length >= 1, `环境上应存在未在白名单的监听（实际 ${r.offenders.length}）`);
});
