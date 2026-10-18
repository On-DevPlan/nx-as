import { issueToken, listDevices, revokeDevice, revokeAllDevices } from './service.js';

const actions = [
  {
    id: 'gateway.deviceIssue',
    cli: ['device', 'issue'],
    http: null, // token 经线下安全渠道交付（SSH/加密消息）；不暴露 HTTP 签发面
    summary: '直接签发 device token（管理员操作；token 明文只出现这一次；--scope admin|client）',
    flags: { name: { type: 'string', required: true }, scope: { type: 'string', enum: ['admin', 'client'] } },
    run: (ctx) => issueToken({ name: ctx.name, scope: ctx.scope || 'admin' }),
    render: (r) =>
      `设备:   ${r.device.name} (${r.device.id})  scope=${r.device.scope}\ntoken:  ${r.token}\n\n交付给设备后即用：Authorization: Bearer ${r.token.slice(0, 20)}...`,
  },
  {
    id: 'gateway.deviceList',
    cli: ['device', 'list'],
    http: ['GET', '/api/devices'],
    summary: '设备清单（scope/最近使用 IP·UA；token 不出库）',
    run: () => listDevices(),
    render: (list) =>
      list.length
        ? list
            .map(
              (d) =>
                `${d.id.padEnd(18)}  ${d.name.padEnd(16)}  ${d.scope.padEnd(6)}  ${d.revoked ? 'revoked' : 'active'}  last=${d.lastUsedAt ? new Date(d.lastUsedAt).toISOString() : 'never'}${d.lastIp ? ` @${d.lastIp}` : ''}`,
            )
            .join('\n')
        : '(无设备；nx-as device issue --name <名> 直接签发 token)',
  },
  {
    id: 'gateway.deviceRevoke',
    cli: ['device', 'revoke'],
    http: ['POST', '/api/devices/:id/revoke'],
    summary: '吊销设备（下一次请求即 401；该设备已发会话同时失效）',
    args: ['id'],
    run: (ctx) => revokeDevice({ id: ctx.id }),
    render: (r) =>
      r.status === 'already_revoked' ? `已吊销过: ${r.id}` : `已吊销: ${r.id}（其已发会话立即失效）`,
  },
  {
    id: 'gateway.deviceRevokeAll',
    cli: ['device', 'revoke-all'],
    http: ['POST', '/api/devices/revoke-all'],
    summary: '吊销全部设备（应急；所有 token 与已发会话立即失效）',
    run: () => revokeAllDevices(),
    render: (r) => (r.revoked ? `已吊销 ${r.revoked} 台设备（全部会话立即失效）` : '没有需要吊销的设备'),
  },
];

export default { id: 'gateway', view: true, actions };
