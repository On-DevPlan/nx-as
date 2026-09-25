import { getSettings, updateSettings, SETTABLE } from './service.js';

const actions = [
  {
    id: 'settings.get',
    cli: ['settings', 'get'],
    http: ['GET', '/api/settings'],
    summary: '查看设置',
    run: () => getSettings(),
    render: (s) =>
      [
        `model:          ${s.model || '(pi 默认)'}`,
        `maxConcurrent:  ${s.maxConcurrent}`,
        `autoRun:        ${s.autoRun}`,
      ].join('\n'),
  },
  {
    id: 'settings.set',
    cli: ['settings', 'set'],
    http: ['PATCH', '/api/settings'],
    summary: `修改设置（PATCH 语义；可设置: ${SETTABLE.join(', ')}）`,
    flags: { model: { type: 'string' }, 'max-concurrent': { type: 'number' }, 'auto-run': { type: 'boolean' } },
    run: (ctx) => {
      const patch = {};
      if (ctx.model !== undefined) patch.model = ctx.model;
      if (ctx['max-concurrent'] !== undefined) patch.maxConcurrent = ctx['max-concurrent'];
      if (ctx['auto-run'] !== undefined) patch.autoRun = ctx['auto-run'];
      return updateSettings(patch);
    },
    render: (s) => `model=${s.model || '(pi 默认)'}  maxConcurrent=${s.maxConcurrent}  autoRun=${s.autoRun}`,
  },
];

export default { id: 'settings', view: true, actions };
