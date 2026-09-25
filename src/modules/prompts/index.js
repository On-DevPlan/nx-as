import * as svc from './service.js';

const actions = [
  {
    id: 'prompt.list',
    cli: ['prompt', 'list'],
    http: ['GET', '/api/prompts'],
    summary: '提示词列表',
    run: () => svc.listPrompts(),
    render: (list) =>
      list.length
        ? list.map((p) => `${p.name.padEnd(20)}  ${p.description || '(无描述)'}`).join('\n')
        : '(无提示词；prompt add 创建)',
  },
  {
    id: 'prompt.get',
    cli: ['prompt', 'get'],
    http: ['GET', '/api/prompts/:name'],
    summary: '查看提示词内容',
    args: ['name'],
    run: (ctx) => svc.getPrompt(ctx.name),
    render: (p) => `# ${p.name}\n${p.description ? `${p.description}\n\n` : ''}${p.content}`,
  },
  {
    id: 'prompt.add',
    cli: ['prompt', 'add'],
    http: ['POST', '/api/prompts'],
    summary: '创建提示词（CLI: --file 读文件或 --content；HTTP: body {name, content}）',
    args: [{ name: 'name', required: false }],
    flags: { file: { type: 'string' }, content: { type: 'string' }, description: { type: 'string' } },
    run: async (ctx) => {
      let content = ctx.content || '';
      if (!content && ctx.file) {
        const fsp = (await import('node:fs/promises')).default;
        content = await fsp.readFile(ctx.file, 'utf8');
      }
      return svc.addPrompt({ name: ctx.name, content, description: ctx.description || '' });
    },
    render: (p) => `已创建: ${p.name}`,
  },
  {
    id: 'prompt.update',
    cli: ['prompt', 'update'],
    http: ['PATCH', '/api/prompts/:name'],
    summary: '更新提示词（PATCH 语义：只改传入字段）',
    args: ['name'],
    flags: { file: { type: 'string' }, content: { type: 'string' }, description: { type: 'string' } },
    run: async (ctx) => {
      let content = ctx.content;
      if (!content && ctx.file) {
        const fsp = (await import('node:fs/promises')).default;
        content = await fsp.readFile(ctx.file, 'utf8');
      }
      return svc.updatePrompt({ name: ctx.name, content, description: ctx.description });
    },
    render: (p) => `已更新: ${p.name}`,
  },
  {
    id: 'prompt.remove',
    cli: ['prompt', 'remove'],
    http: ['DELETE', '/api/prompts/:name'],
    summary: '删除提示词',
    args: ['name'],
    run: (ctx) => svc.removePrompt(ctx.name),
    render: (r) => `已删除: ${r.removed}`,
  },
];

export default { id: 'prompts', resource: 'prompt', view: true, actions };
