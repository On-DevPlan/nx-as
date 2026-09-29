import { issueToken, listDevices, revokeDevice } from './service.js';

const actions = [
  {
    id: 'gateway.deviceIssue',
    cli: ['device', 'issue'],
    http: null, // token 经线下安全渠道交付（SSH/加密消息）；不暴露 HTTP 签发面
    summary: '直接签发 device token（管理员操作；token 明文只出现这一次）',
    flags: { name: { type: 'string', required: true } },
    run: (ctx) => issueToken({ name: ctx.name }),
    render: (r) =>
      `设备:   ${r.device.name} (${r.device.id})\ntoken:  ${r.token}\n\n交付给设备后即用：Authorization: Bearer ${r.token.slice(0, 20)}...`,
  },
  {
    id: 'gateway.deviceList',
    cli: ['device', 'list'],
    http: ['GET', '/api/devices'],
    summary: '设备清单（last_used 原值；token 不出库）',
    run: () => listDevices(),
    render: (list) =>
      list.length
        ? list
            .map(
              (d) =>
                `${d.id.padEnd(18)}  ${d.name.padEnd(16)}  ${d.revoked ? 'revoked' : 'active'}  last_used=${d.lastUsedAt ? new Date(d.lastUsedAt).toISOString() : 'never'}`,
            )
            .join('\n')
        : '(无设备；nx-as device issue --name <名> 直接签发 token)',
  },
  {
    id: 'gateway.deviceRevoke',
    cli: ['device', 'revoke'],
    http: ['POST', '/api/devices/:id/revoke'],
    summary: '吊销设备（下一次请求即 401）',
    args: ['id'],
    run: (ctx) => revokeDevice({ id: ctx.id }),
    render: (r) =>
      r.status === 'already_revoked' ? `已吊销过: ${r.id}` : `已吊销: ${r.id}`,
  },
];

export default { id: 'gateway', view: false, actions };
