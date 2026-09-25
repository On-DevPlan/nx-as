import * as svc from './service.js';

const actions = [
  {
    id: 'plugin.list',
    cli: ['plugin', 'list'],
    http: ['GET', '/api/plugins'],
    summary: '列出已装扩展与技能',
    flags: { type: { type: 'string', enum: ['all', 'extension', 'skill'] } },
    run: (ctx) => svc.listPlugins(ctx),
    render: (r) => {
      const lines = ['== 扩展 =='];
      for (const e of r.extensions) lines.push(`  ${e.enabled ? 'on ' : 'off'} ${e.name}  (${e.path})`);
      lines.push('', '== 技能 ==');
      for (const s of r.skills) lines.push(`  ${s.enabled ? 'on ' : 'off'} ${s.name}  ${s.description || ''}`);
      return lines.join('\n');
    },
  },
  {
    id: 'plugin.get',
    cli: ['plugin', 'get'],
    http: ['GET', '/api/plugins/:type/:name'],
    summary: '查看插件内容',
    args: ['type', 'name'],
    run: (ctx) => svc.getPlugin(ctx),
    render: (p) => `# ${p.type}/${p.name}（${p.enabled ? 'on' : 'off'}）\n${p.description ? `${p.description}\n\n` : ''}${p.content || '(空)'}`,
  },
  {
    id: 'plugin.set-enabled',
    cli: ['plugin', 'set-enabled'],
    http: ['POST', '/api/plugins/:type/:name/enabled'],
    summary: '启用/禁用（POST body {disabled:true} 切换；pi 不加载 .disabled 文件）',
    args: ['type', 'name'],
    flags: { disabled: { type: 'boolean' } },
    run: (ctx) => svc.setEnabled({ ...ctx, enabled: !ctx.disabled }),
    render: (r) => (r.enabled ? `${r.type}/${r.name} → 启用` : `${r.type}/${r.name} → 禁用`),
  },
  {
    id: 'plugin.install',
    cli: ['plugin', 'install'],
    http: ['POST', '/api/plugins/install'],
    summary: '安装（目前仅本地目录路径；git/npm 后续）',
    flags: { source: { type: 'string', required: true } },
    run: (ctx) => svc.installSkill(ctx),
    render: (r) => `已安装: ${r.installed}`,
  },
  {
    id: 'plugin.uninstall',
    cli: ['plugin', 'uninstall'],
    http: ['DELETE', '/api/plugins/:type/:name'],
    summary: '卸载扩展或技能',
    args: ['type', 'name'],
    run: (ctx) => svc.uninstallPlugin(ctx),
    render: (r) => `已卸载: ${r.type}/${r.removed}`,
  },
];

export default { id: 'plugins', view: true, actions };