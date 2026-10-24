import {
  ensureSessionSecret,
  rotateSessionSecret,
  setOidcConfig,
  oidcStatus,
  oidcProbe,
  oidcRegister,
  promptHidden,
} from './service.js';
import { VERSION } from '../../core/version.js';
import { unauthorized } from '../../core/errors.js';

// auth.verify 是公开路由（App 探活），鉴权在 api.js 的 PUBLIC_PATHS 白名单。
// 静态密钥时代它「带密钥自证」；SSO 时代密钥不存在了，退化为纯存活探针
// （entrypoint 就绪探测 / serve-port 端口协商 / client doctor 都依赖 {valid, version} 形状）。
const actions = [
  {
    id: 'auth.verify',
    cli: ['auth', 'verify'],
    http: ['GET', '/api/auth/verify'],
    summary: '存活探针（无凭据可调用；返回 valid:true + 版本）',
    run: async () => {
      const { configComplete, oidcConfig } = await import('../../runtime/oidc.js');
      const cfg = await oidcConfig();
      return { valid: true, version: VERSION, sso: configComplete(cfg) };
    },
  },
  {
    id: 'auth.status',
    cli: ['auth', 'status'],
    http: ['GET', '/api/auth/status'],
    summary: 'SSO 接入状态（issuer/client_id/白名单/会话密钥）',
    run: () => oidcStatus(),
    render: (r) => [
      `OIDC:     ${r.complete ? '已配置' : '未配置（nx-as oidc config set --issuer <url> --client-id <id>）'}`,
      `issuer:   ${r.issuer || '(未设置)'}${r.source.issuer === 'env' ? '  [env]' : ''}`,
      `clientId: ${r.clientId || '(未设置)'}${r.source.clientId === 'env' ? '  [env]' : ''}`,
      `callback: ${r.redirectUri}`,
      `scopes:   ${r.scopes}`,
      `白名单:   ${r.allowedEmails.length ? r.allowedEmails.join(', ') : '(放行全部 go-ah 用户)'}`,
      `会话密钥: ${r.hasSessionSecret ? '已生成' : '首次登录时自动生成'}`,
    ].join('\n'),
  },
  {
    id: 'auth.me',
    cli: ['auth', 'me'],
    http: ['GET', '/api/auth/me'],
    summary: '当前登录身份（未登录 401；面板 AuthGate 用）',
    run: (ctx) => {
      if (!ctx.session) throw unauthorized('未登录（访问 /oidc/login 走 go-ah 单点登录）');
      return { sub: ctx.session.sub, email: ctx.session.email, name: ctx.session.name };
    },
    render: (r) => `${r.name || r.email || r.sub}  <${r.email || '无邮箱'}>  sub=${r.sub}`,
  },
  {
    id: 'auth.rotate',
    cli: ['auth', 'rotate'],
    http: ['POST', '/api/auth/rotate'],
    summary: '轮换会话签名密钥（= 全端下线；SSO 重新登录即可恢复）',
    run: async () => {
      await ensureSessionSecret(); // 未生成过先补一把（rotate 才有意义）
      return rotateSessionSecret();
    },
    render: (r) => r.note,
  },
  {
    id: 'auth.oidcConfig',
    cli: ['oidc', 'config', 'set'],
    http: ['POST', '/api/oidc/config'],
    summary: '写入 OIDC 接入配置（--issuer --client-id [--redirect-uri] [--scopes] [--allowed-emails]）',
    flags: {
      issuer: { type: 'string' },
      'client-id': { type: 'string' },
      'redirect-uri': { type: 'string' },
      scopes: { type: 'string' },
      'allowed-emails': { type: 'string' },
    },
    run: (ctx) => setOidcConfig({
      issuer: ctx.issuer,
      clientId: ctx['client-id'],
      redirectUri: ctx['redirect-uri'],
      scopes: ctx.scopes,
      allowedEmails: ctx['allowed-emails'],
    }),
    render: (r) => `OIDC 配置已更新（complete=${r.complete}）\nissuer:   ${r.issuer || '(空)'}\nclientId: ${r.clientId || '(空)'}\n白名单:   ${r.allowedEmails.length ? r.allowedEmails.join(', ') : '(放行全部)'}`,
  },
  {
    id: 'auth.oidcProbe',
    cli: ['oidc', 'probe'],
    http: ['GET', '/api/oidc/probe'],
    summary: '零凭据探测：发现文档可达性 + client 是否已注册 + 白名单生效（A01 探测法）',
    run: () => oidcProbe(),
    render: (r) => [
      `结论: ${r.ok ? '通过' : '未通过'}`,
      ...r.checks.map((c) => `  [${c.ok ? '✓' : '✗'}] ${c.name}: ${c.note}`),
    ].join('\n'),
  },
  {
    id: 'auth.oidcRegister',
    cli: ['oidc', 'register'],
    http: null, // 管理员凭据只在 CLI 出现；不暴露 HTTP 签发面
    summary: '一次性：登录 go-ah 管理员并注册 nx-as client（--username --password --issuer [--redirect-uri 逗号分隔多个]；缺省回环端口通配）',
    flags: {
      username: { type: 'string' },
      password: { type: 'string' },
      issuer: { type: 'string' },
      'redirect-uri': { type: 'string' },
      'client-name': { type: 'string' },
    },
    run: async (ctx) => {
      const username = ctx.username || (await promptHidden('go-ah 管理员账号: '));
      const password = ctx.password || (await promptHidden('go-ah 管理员密码: '));
      const redirectUris = String(ctx['redirect-uri'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      return oidcRegister({ username, password, issuer: ctx.issuer, redirectUris, clientName: ctx['client-name'] || 'nx-as' });
    },
    render: (r) => [
      `已在 ${r.issuer} 注册 client`,
      `clientId: ${r.clientId}`,
      'redirect_uris:',
      ...r.redirectUris.map((u) => `  - ${u}`),
      r.postLogoutUris.length ? `post_logout_uris:\n${r.postLogoutUris.map((u) => `  - ${u}`).join('\n')}` : '',
      '下一步: nx-as oidc config set --issuer ' + r.issuer + ' --client-id ' + r.clientId,
    ].filter(Boolean).join('\n'),
  },
];

export default { id: 'auth', view: true, actions };
