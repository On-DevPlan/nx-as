import { pairCreate, listDevices, revokeDevice } from './service.js';

const actions = [
  {
    id: 'gateway.pair',
    cli: ['device', 'pair'],
    http: null, // 兑换走 /m/v1/pair（网关自管路由），此处只发码
    summary: '生成设备配对码（5 分钟有效、单次；设备用它兑换 device token）',
    flags: { name: { type: 'string', required: true } },
    run: (ctx) => pairCreate({ name: ctx.name }),
    render: (r) =>
      `配对码: ${r.code}\n设备:   ${r.name}\n有效:   5 分钟内、单次使用\n设备端: curl -X POST http://<host>:7801/m/v1/pair -H "Content-Type: application/json" -d '{"code":"${r.code}"}'`,
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
        : '(无设备；nx-as device pair --name <名> 生成配对码)',
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
