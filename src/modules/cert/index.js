import { importCert, certStatus, removeCert, downloadPem } from './service.js';
import { readFile } from 'node:fs/promises';
import { badInput } from '../../core/errors.js';

const actions = [
  {
    id: 'cert.status',
    cli: ['cert', 'status'],
    http: ['GET', '/api/cert'],
    summary: '查看当前证书状态（subject/notAfter/fingerprint/启用？）',
    run: () => certStatus(),
    render: (r) =>
      r.enabled
        ? `已启用 HTTPS
certPath: ${r.certPath}
keyPath:  ${r.keyPath}
subject:  ${r.meta.subject}
notAfter: ${r.meta.notAfter}
fp:       ${r.meta.fingerprintSha256}`
        : `未启用 HTTPS（${r.message}）
certPath: ${r.certPath}
keyPath:  ${r.keyPath}`,
  },
  {
    id: 'cert.import',
    cli: ['cert', 'import'],
    http: ['POST', '/api/cert/import'],
    summary: '导入外部证书（CRT + KEY 落盘到 nginx ssl 目录；nx-as 不签证书）',
    flags: {
      'cert-file': { type: 'string' },
      'key-file': { type: 'string' },
      cert: { type: 'string' },
      key: { type: 'string' },
    },
    run: async (ctx) => {
      let certPem = ctx.cert;
      let keyPem = ctx.key;
      if (ctx['cert-file']) certPem = await readFile(ctx['cert-file'], 'utf8');
      if (ctx['key-file']) keyPem = await readFile(ctx['key-file'], 'utf8');
      if (!certPem || !keyPem) throw badInput('需同时提供 cert + key（PEM 字符串或 --cert-file/--key-file）');
      return importCert({ certPem, keyPem });
    },
    render: (r) => `已导入
certPath: ${r.certPath}
keyPath:  ${r.keyPath}
subject:  ${r.subject}
notAfter: ${r.notAfter}
fp:       ${r.fingerprintSha256}
下一步: nx-as nginx apply（写入 certPath/keyPath 到托管配置）`,
  },
  {
    id: 'cert.remove',
    cli: ['cert', 'remove'],
    http: ['POST', '/api/cert/remove'],
    summary: '删除已导入的证书文件 + 清 store（managed 配置需 apply 才会回 HTTP）',
    run: () => removeCert(),
    render: (r) => `已删除: ${r.removed.join(', ')}`,
  },
  {
    id: 'cert.download',
    cli: ['cert', 'download'],
    http: ['GET', '/api/cert/download'],
    summary: '导出已导入的 PEM（type=cert|key；面板用）',
    flags: { type: { type: 'string', enum: ['cert', 'key'] } },
    run: async (ctx) => ({ pem: await downloadPem(ctx.type || 'cert') }),
    render: (r) => r.pem,
  },
];

export default { id: 'cert', view: true, actions };