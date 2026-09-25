import * as svc from './service.js';

const actions = [
  {
    id: 'models.list',
    cli: ['models', 'list'],
    http: ['GET', '/api/models'],
    summary: '模型目录（内置 provider + 自定义端点）',
    run: () => svc.listModels(),
    render: (r) => {
      const lines = ['== 内置 provider =='];
      for (const p of r.builtin) {
        lines.push(`${p.provider.padEnd(16)} ${p.envVar ? `(${p.envVar})` : ''}  ${p.models.length} 个模型`);
      }
      const custom = Object.entries(r.custom);
      if (custom.length) {
        lines.push('', '== 自定义端点 ==');
        for (const [id, ep] of custom) lines.push(`${id.padEnd(16)} ${ep.baseUrl || ''}`);
      }
      return lines.join('\n');
    },
  },
  {
    id: 'models.current',
    cli: ['models', 'current'],
    http: ['GET', '/api/models/current'],
    summary: '当前默认模型',
    run: () => svc.currentModel(),
    render: (r) => `默认模型: ${r.model}`,
  },
  {
    id: 'models.set',
    cli: ['models', 'set'],
    http: ['POST', '/api/models/current'],
    summary: '设置默认模型（空字符串回到 pi 默认）',
    flags: { model: { type: 'string' } },
    run: (ctx) => svc.setCurrentModel(ctx),
    render: (r) => `默认模型: ${r.model}`,
  },
  {
    id: 'models.set-endpoint',
    cli: ['models', 'set-endpoint'],
    http: ['POST', '/api/models/endpoints'],
    summary: '添加自定义端点（OpenAI 兼容 / Ollama / vLLM）',
    flags: {
      'base-url': { type: 'string', required: true },
      'api-key-env': { type: 'string' },
      models: { type: 'array' },
    },
    args: ['provider'],
    run: (ctx) =>
      svc.setCustomEndpoint({
        provider: ctx.provider,
        baseUrl: ctx['base-url'],
        apiKeyEnv: ctx['api-key-env'] || '',
        models: ctx.models || [],
      }),
    render: (r) => `已写入端点: ${r.provider} → ${r.file}`,
  },
  {
    id: 'models.remove-endpoint',
    cli: ['models', 'remove-endpoint'],
    http: ['DELETE', '/api/models/endpoints/:provider'],
    summary: '删除自定义端点',
    args: ['provider'],
    run: (ctx) => svc.removeCustomEndpoint(ctx),
    render: (r) => `已删除端点: ${r.removed}`,
  },
];

export default { id: 'models', view: true, actions };
