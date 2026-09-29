import { mutateStore } from '../../core/store.js';
import { randomBytes } from 'node:crypto';
import { badInput } from '../../core/errors.js';
import {
  nginxConfig, nginxStatus, nginxApply, nginxRollback, nginxPreview, nginxSetup, isLinux,
} from './service.js';
import {
  isContainerMode, readTemplate, readRendered, applyTemplate, rollbackTemplate,
  TEMPLATE_PATH, RENDERED_PATH,
} from './container.js';

const actions = [
  {
    id: 'nginx.status',
    cli: ['nginx', 'status'],
    http: ['GET', '/api/nginx'],
    summary: 'nginx 托管状态（服务/漂移/sudoers 授权/托管文件路径）',
    run: () => nginxStatus(),
    render: (s) =>
      [
        `平台:       ${s.platform}${!isLinux() ? '  (nginx 管理仅支持 Linux)' : ''}`,
        `托管文件:   ${s.managedPath}`,
        `托管启用:   ${s.enabled ? 'yes' : 'no'}`,
        `nginx 服务: ${s.nginx?.service ?? '?'}`,
        `配置漂移:   ${s.drifted === null ? 'n/a' : s.drifted ? 'yes（磁盘≠模板，Apply 可收敛）' : 'no'}`,
        `sudoers:    ${s.sudoers ?? '?'}`,
      ].join('\n'),
  },
  {
    id: 'nginx.configGet',
    cli: ['nginx', 'config'],
    http: ['GET', '/api/nginx/config'],
    summary: '查看配置（容器模式：返回可编辑的模板 + 渲染后的生效配置）',
    flags: { preview: { type: 'boolean' } },
    run: async (ctx) => {
      if (isContainerMode()) {
        const [template, rendered] = await Promise.all([readTemplate(), readRendered()]);
        return { mode: 'container', templatePath: TEMPLATE_PATH, renderedPath: RENDERED_PATH, template, rendered };
      }
      const cfg = await nginxConfig();
      if (ctx.preview) return { ...cfg, rendered: await nginxPreview() };
      return cfg;
    },
    render: (r) => (r.mode === 'container' ? r.template : r.rendered || JSON.stringify(r, null, 2)),
  },
  {
    id: 'nginx.apply',
    cli: ['nginx', 'apply'],
    http: ['POST', '/api/nginx/apply'],
    summary: '写模板→渲染→nginx -t（失败自动回滚）→graceful reload（容器/宿主双模式）',
    flags: {
      domain: { type: 'string' },
      'cert-path': { type: 'string' },
      'key-path': { type: 'string' },
      'managed-path': { type: 'string' },
    },
    run: async (ctx) => {
      // 容器模式：整文件模板编辑（面板高级模式送 template 字段）
      if (isContainerMode()) {
        if (typeof ctx.template !== 'string') throw badInput('容器模式需要 template 字段（整文件模板内容）');
        return applyTemplate(ctx.template);
      }
      const patch = {};
      if (ctx.domain !== undefined) patch.domain = ctx.domain;
      if (ctx['cert-path'] !== undefined) patch.certPath = ctx['cert-path'];
      if (ctx['key-path'] !== undefined) patch.keyPath = ctx['key-path'];
      if (ctx['managed-path'] !== undefined) patch.managedPath = ctx['managed-path'];
      return nginxApply(patch, { rawConfig: ctx.rawConfig });
    },
    render: (r) => r.mode === undefined && r.template
      ? `已生效（容器）: ${r.template} → ${r.rendered}（nginx -t 通过 + reload）`
      : `已生效: ${r.domain}\n托管文件: ${r.managedPath}（nginx -t 通过 + graceful reload）`,
  },
  {
    id: 'nginx.rollback',
    cli: ['nginx', 'rollback'],
    http: ['POST', '/api/nginx/rollback'],
    summary: '回滚到上一版配置（.bak）并 reload',
    run: () => (isContainerMode() ? rollbackTemplate() : nginxRollback()),
    render: (r) => `已回滚: ${r.rolledBackTo}`,
  },
  {
    id: 'nginx.setup',
    cli: ['nginx', 'setup'],
    http: null,
    summary: '打印部署引导（sudoers 白名单 + 托管文件初始化命令）',
    run: () => nginxSetup(),
    render: (r) =>
      [
        '部署引导（一次性，root 执行）：',
        ...r.steps.map((s) => `  ${s}`),
        `  说明: ${r.note}`,
      ].join('\n'),
  },
  {
    id: 'nginx.rotateSecret',
    cli: ['nginx', 'rotate-secret'],
    http: ['POST', '/api/nginx/rotate-secret'],
    summary: '轮换机机密码（store→模板→reload→重启 pi-web，旧 Basic 立即失效）',
    run: async () => {
      const secret = randomBytes(32).toString('hex');
      await mutateStore((s) => { s.machineSecret = secret; });
      // 原子四步的简版：apply（渲染新密码 + reload）；pi-web 由 launcher 下次启动带新密码，
      // 运行中的 pi-web 需要 --with-web 场景下重启子进程（面板提示）
      const r = await nginxApply({});
      return { status: 'ok', note: '机机密码已更新并 reload nginx。运行中的 pi-web 需重启才能用新密码（systemctl restart nx-as 或重启 --with-web）。', domain: r.domain };
    },
    render: (r) => `机机密码已轮换。${r.note}`,
  },
];

export default { id: 'nginx', view: true, actions };
