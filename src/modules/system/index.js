import { bootstrap, bootstrapCli, health, routesQuery } from './service.js';

const actions = [
  {
    id: 'system.bootstrap',
    cli: ['bootstrap'],
    http: ['GET', '/api/bootstrap'],
    summary: '一次性拿齐上下文（version/存储路径/设置/命令表）',
    run: (ctx, meta) => (meta.transport === 'cli' ? bootstrapCli() : bootstrap()),
    render: (b) =>
      [
        `version:   ${b.version}`,
        `存储:      ${b.appStorePath || '(HTTP 模式不暴露)'}`,
        `cwd:       ${b.cwdScope}`,
        `命令数:    ${b.commands.length}`,
      ].join('\n'),
  },
  {
    id: 'system.health',
    cli: ['health'],
    http: ['GET', '/api/health'],
    summary: '存活 + 存储可达',
    run: () => health(),
    render: (h) => `ok=${h.ok}  version=${h.version}  store=${h.storeReachable}`,
  },
  {
    id: 'system.routes',
    cli: ['routes'],
    http: ['GET', '/api/routes'],
    summary: '全量命令-路由对照（--http "METHOD /path" 反查命令）',
    flags: { http: { type: 'string' } },
    run: (ctx) => routesQuery(ctx),
    render: (list) =>
      (list || [])
        .map((e) => `${e.command.padEnd(46)} ${e.http ? e.http.padEnd(36) : ''} ${e.summary}`)
        .join('\n') || '(无匹配路由；用 --http "METHOD /path" 反查)',
  },
];

export default { id: 'system', view: false, actions };
