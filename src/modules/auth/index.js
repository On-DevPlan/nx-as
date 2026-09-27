import {
  ensureToken,
  rotateToken,
  authStatus,
  mask,
} from './service.js';

// auth.verify 是公开路由（App 无 token 探活），鉴权在 api.js 的 PUBLIC_PATHS 白名单
const actions = [
  {
    id: 'auth.verify',
    cli: ['auth', 'verify'],
    http: ['GET', '/api/auth/verify'],
    summary: '验证密钥（App 探活；无密钥也可调用，返回 valid:false）',
    run: async (ctx) => {
      try {
        const expected = await ensureToken(null);
        return { valid: ctx.token === expected, version: '0.1.2' };
      } catch {
        return { valid: false, version: '0.1.2' };
      }
    },
  },
  {
    id: 'auth.status',
    cli: ['auth', 'status'],
    http: ['GET', '/api/auth/status'],
    summary: '密钥配置状态（掩码显示）',
    run: () => authStatus(),
    render: (r) => `密钥来源: ${r.source}${r.configured ? `\n密钥:     ${r.masked}` : '\n(未设置，serve 首次启动时自动生成)'}`,
  },
  {
    id: 'auth.rotate',
    cli: ['auth', 'rotate'],
    http: ['POST', '/api/auth/rotate'],
    summary: '轮换密钥（旧密钥立即失效）',
    run: (ctx) => rotateToken(ctx),
    render: (r) => `新密钥: ${mask(r.token)}\n${r.note}`,
  },
];

export default { id: 'auth', view: true, actions };
