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
        `Bearer 代理:    ${s.hasBearerToken ? `${s.bearerProvider} → ${s.bearerBaseUrl}` : '(未配置)'}`,
        s.hasBearerToken ? `Bearer 模型:    ${s.bearerModels}` : '',
        s.hasBearerToken ? `Bearer token:   ${s.bearerToken}` : '',
      ].filter(Boolean).join('\n'),
  },
  {
    id: 'settings.set',
    cli: ['settings', 'set'],
    http: ['PATCH', '/api/settings'],
    summary: `修改设置（PATCH 语义；可设置: ${SETTABLE.join(', ')}）`,
    flags: {
      model: { type: 'string' },
      'max-concurrent': { type: 'number' },
      'auto-run': { type: 'boolean' },
      'bearer-provider': { type: 'string' },
      'bearer-base-url': { type: 'string' },
      'bearer-models': { type: 'string' },
      'bearer-token': { type: 'string' },
    },
    run: (ctx) => {
      const patch = {};
      if (ctx.model !== undefined) patch.model = ctx.model;
      if (ctx['max-concurrent'] !== undefined) patch.maxConcurrent = ctx['max-concurrent'];
      if (ctx['auto-run'] !== undefined) patch.autoRun = ctx['auto-run'];
      if (ctx['bearer-provider'] !== undefined) patch.bearerProvider = ctx['bearer-provider'];
      if (ctx['bearer-base-url'] !== undefined) patch.bearerBaseUrl = ctx['bearer-base-url'];
      if (ctx['bearer-models'] !== undefined) patch.bearerModels = ctx['bearer-models'];
      if (ctx['bearer-token'] !== undefined) patch.bearerToken = ctx['bearer-token'];
      return updateSettings(patch);
    },
    render: (s) =>
      [
        `model=${s.model || '(pi 默认)'}  maxConcurrent=${s.maxConcurrent}  autoRun=${s.autoRun}`,
        s.hasBearerToken
          ? `Bearer: ${s.bearerProvider} → ${s.bearerBaseUrl}  模型=${s.bearerModels}  token=${s.bearerToken}`
          : 'Bearer: (未配置)',
      ].join('\n'),
  },
];

export default { id: 'settings', view: true, actions };
