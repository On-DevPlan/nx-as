// nx-as client 的 action 表：CLI（nx-as client ...）与本地 web API（/api/client/*）同源
// 形状与 src/modules/*/index.js 一致，但独立顶层——不进 server 面板的 tab/注册表体系
import {
  loadClientConfig, updateClientConfig, listTunnels,
  startGost, stopGost, gostStatus, remoteList, registerTunnel, unregisterTunnel, doctor, reconcile,
  pairWithServer, pairingStatus,
} from './service.js';

export const CLIENT_ACTIONS = [
  {
    id: 'client.configGet',
    cli: ['client', 'config'],
    http: ['GET', '/api/client/config'],
    summary: '查看 client 连接配置与配对状态（凭据是 SSO 会话，存 credentials.json）',
    run: async () => {
      const [c, pair] = await Promise.all([loadClientConfig(), pairingStatus()]);
      return {
        server: c.server.api,
        paired: pair.paired,
        identity: pair.identity,
        relay: c.relay.url,
        gostBin: c.gost.bin,
        tunnels: c.tunnels.length,
        configPath: (await import('./service.js')).CLIENT_CONFIG_PATH,
      };
    },
    render: (r) => [
      `server:   ${r.server || '(未配置)'}`,
      `配对:     ${r.paired ? `已配对（${r.identity?.email || r.identity?.sub || 'SSO 会话有效'}）` : '未配对（nx-as client login 走浏览器 SSO）'}`,
      `relay:    ${r.relay || '(未配置)'}`,
      `gost:     ${r.gostBin}`,
      `隧道数:   ${r.tunnels}`,
      `配置文件: ${r.configPath}`,
    ].join('\n'),
  },
  {
    id: 'client.configSet',
    cli: ['client', 'config', 'set'],
    http: ['POST', '/api/client/config'],
    summary: '写连接配置（--server/--relay/--gost-bin；凭据不在这里——client login 走浏览器 SSO 配对）',
    flags: {
      server: { type: 'string' },
      relay: { type: 'string' },
      'gost-bin': { type: 'string' },
    },
    run: async (ctx) => {
      const patch = {};
      if (ctx.server !== undefined) patch.server = { api: ctx.server, token: '' };
      if (ctx.relay !== undefined) patch.relay = { url: ctx.relay };
      if (ctx['gost-bin'] !== undefined) patch.gost = { bin: ctx['gost-bin'] };
      if (!Object.keys(patch).length) {
        throw Object.assign(new Error('至少给一项：--server / --relay / --gost-bin（登录用 nx-as client login）'), { code: 'INVALID_INPUT' });
      }
      const next = await updateClientConfig(patch);
      return { status: 'ok', server: next.server.api, relay: next.relay.url };
    },
    render: (r) => `已保存: server=${r.server || '(空)'} relay=${r.relay || '(空)'}\n下一步: nx-as client login（浏览器 SSO 配对）`,
  },
  {
    id: 'client.login',
    cli: ['client', 'login'],
    http: ['POST', '/api/client/login'],
    summary: '配对远程 nx-as（浏览器 SSO：打开 <server>/oidc/login 完成登录，会话自动落 credentials.json）',
    flags: {
      server: { type: 'string' },
      'no-open': { type: 'boolean' },
    },
    run: (ctx) => pairWithServer({ server: ctx.server, open: !ctx['no-open'] }),
    render: (r) => [
      `已配对:   ${r.server}`,
      `身份:     ${r.identity?.email || r.identity?.sub || '(未取得)'}`,
      '会话已存 credentials.json（7 天；过期重新 client login，go-ah 全局会话内免密）',
    ].join('\n'),
  },
  {
    id: 'client.register',
    cli: ['client', 'register'],
    http: ['POST', '/api/client/register'],
    summary: '一键注册穿透：server 写 conf + 本地 gost -L + 自动生效',
    args: [{ name: 'name', required: true }, { name: 'local', required: true }],
    flags: { 'public-port': { type: 'number' } },
    run: (ctx) => registerTunnel({ name: ctx.name, local: Number(ctx.local), public: ctx['public-port'] }),
    render: (r) => `已注册: ${r.tunnel.name}（本地 :${r.tunnel.local} → 公网 :${r.tunnel.public}）\n公网入口: ${r.url || '(server 未返回)'}\n访问需 SSO 登录（浏览器打开跳 go-ah）或 Bearer 会话`,
  },
  {
    id: 'client.unregister',
    cli: ['client', 'unregister'],
    http: ['POST', '/api/client/unregister'],
    summary: '注销隧道：本地清单移除 + server 侧 conf 删除',
    args: [{ name: 'name', required: true }],
    run: (ctx) => unregisterTunnel({ name: ctx.name }),
    render: (r) => `已注销: ${r.removed.name}（本地 + server 侧）`,
  },
  {
    id: 'client.tunnels',
    cli: null, // 面板专用（CLI 用 tunnel list / client reconcile）
    http: ['GET', '/api/client/tunnels'],
    summary: '本地隧道清单（含 gost 进程状态）',
    run: async () => ({ tunnels: await listTunnels(), gost: await gostStatus() }),
    render: (r) => [
      `gost: ${r.gost.running ? `运行中 (pid ${r.gost.pid})` : '未运行'}  隧道 ${r.gost.tunnels} 条  二进制 ${r.gost.bin}`,
      ...r.tunnels.map((t) => `  ${t.name.padEnd(16)} 本地:${String(t.local).padEnd(6)} 公网:${String(t.public).padEnd(6)}`),
      r.tunnels.length ? '' : '  (空 — nx-as client register <名> <本地端口>)',
    ].filter((l) => l !== '').join('\n'),
  },
  {
    id: 'client.remoteList',
    cli: null, // 面板专用（CLI 用 tunnel list / client reconcile）
    http: ['GET', '/api/client/remote'],
    summary: 'server 侧已注册隧道（含可点击的公网 URL）',
    run: () => remoteList(),
    render: (r) => [
      `server: ${r.host || '(未配置)'}`,
      ...r.tunnels.map((t) => `  ${t.enabled ? '·' : '×'} ${t.name.padEnd(16)} 公网:${String(t.public || '?').padEnd(6)} ${t.url || ''}${t.enabled ? '' : '（已停用）'}`),
      r.tunnels.length ? '' : '  (server 侧暂无 nxas-tunnel-*.conf)',
    ].filter((l) => l !== '').join('\n'),
  },
  {
    id: 'client.reconcile',
    cli: ['client', 'reconcile'],
    http: ['GET', '/api/client/reconcile'],
    summary: '本地 ∪ server 对账（按名称对齐：通 / 仅 server / 仅本地）',
    run: () => reconcile(),
    render: (r) => [
      `gost: ${r.gost.running ? `运行中 (pid ${r.gost.pid})` : '未运行'}${r.serverError ? `  server 错误: ${r.serverError}` : ''}`,
      ...r.rows.map((t) => {
        const side = t.localSide && t.serverSide ? '通' : t.serverSide ? '仅server' : '仅本地';
        return `  ${side.padEnd(8)} ${t.name.padEnd(16)} ${t.localSide ? `本地:${t.local} → ` : ''}公网:${t.public ?? '?'} ${t.enabled === false ? '(停用)' : ''} ${t.url || ''}`;
      }),
      r.rows.length ? '' : '  (无隧道 — register 一条试试)',
    ].filter((l) => l !== '').join('\n'),
  },
  {
    id: 'client.start',
    cli: null, // 面板专用（gost 由 tunnel add/reconcile 自动拉起常驻）
    http: ['POST', '/api/client/gost/start'],
    summary: '启动 gost 隧道进程（聚合全部本地 -L）',
    run: () => startGost(),
    render: (r) => `gost ${r.status}（pid ${r.pid}，${r.tunnels} 条隧道）`,
  },
  {
    id: 'client.stop',
    cli: null, // 面板专用（gost 由 tunnel add/reconcile 自动拉起常驻）
    http: ['POST', '/api/client/gost/stop'],
    summary: '停止 gost 隧道进程',
    run: () => stopGost(),
    render: (r) => `gost ${r.status}${r.pid ? `（原 pid ${r.pid}）` : ''}`,
  },
  {
    id: 'client.doctor',
    cli: ['client', 'doctor'],
    http: ['GET', '/api/client/doctor'],
    summary: '自检：配置/凭据/gost 二进制/连通性',
    run: () => doctor(),
    render: (r) => [
      `配置文件: ${r.config}`,
      `配置完整: ${r.config ? 'yes' : 'no（缺 server/relay）'}`,
      `server:   ${r.server}`,
      `会话:     ${r.session || '未配对（nx-as client login）'}`,
      `gost:     ${r.gostBin}`,
    ].join('\n'),
  },
];
