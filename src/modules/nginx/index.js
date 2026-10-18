import { mutateStore } from '../../core/store.js';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { badInput } from '../../core/errors.js';
import {
  nginxConfig, nginxStatus, nginxApply, nginxRollback, nginxPreview, nginxSetup, isLinux,
} from './service.js';
import {
  listConfigFiles, readConfigFile, writeConfigFile, deleteConfigFile, toggleConfigFile,
  listBackups, restoreBackup,
} from './files.js';
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
        `nginx:      ${s.nginx?.version ? `v${s.nginx.version} · ` : ''}${s.nginx?.service ?? '?'}`,
        `托管文件:   ${s.managedPath}`,
        `托管目录:   ${s.managedDir}${s.dirWritable === null ? '' : s.dirWritable ? '（可写：可新建/删除/停用）' : '（只读：可编辑托管单文件内容）'}`,
        `托管启用:   ${s.enabled ? 'yes' : 'no'}`,
        `配置漂移:   ${s.drifted === null ? 'n/a' : s.drifted ? 'yes（磁盘≠模板，Apply 可收敛）' : 'no'}`,
        `sudoers:    ${s.sudoers ?? '?'}`,
      ].join('\n'),
  },
  // ---------- 多文件配置管理器（宿主机模式；容器模式走模板编辑器） ----------
  {
    id: 'nginx.files',
    cli: ['nginx', 'files'],
    http: ['GET', '/api/nginx/files'],
    summary: '托管目录内配置文件清单（启用态/大小/备份数/目录可写性）',
    run: () => listConfigFiles(),
    render: (r) => [
      `托管目录: ${r.dir}${r.dirExists ? '' : '（不存在）'}${r.dirWritable ? '  [可写]' : '  [只读]'}`,
      ...r.files.map((f) =>
        `  ${f.managed ? '*' : ' '}${f.name.padEnd(36)} ${f.enabled ? 'enabled ' : 'disabled'} ${String(f.size).padStart(8)}B  备份 ${f.backups}${f.writable ? '' : '  (无写权)'}`),
      r.files.length ? '' : '  (目录内暂无 *.conf)',
    ].filter((l) => l !== '').join('\n'),
  },
  {
    id: 'nginx.fileGet',
    cli: ['nginx', 'file', 'get'],
    http: ['GET', '/api/nginx/files/:name'],
    summary: '读取托管目录内某个配置文件内容',
    args: ['name'],
    run: (ctx) => readConfigFile(ctx.name),
    render: (r) => r.content,
  },
  {
    id: 'nginx.filePut',
    cli: ['nginx', 'file', 'put'],
    http: ['POST', '/api/nginx/files/:name'],
    summary: '写入/新建配置文件（备份→nginx -t 失败自动还原→reload）',
    args: ['name'],
    flags: { from: { type: 'string' }, content: { type: 'string' } },
    run: async (ctx) => {
      let content = ctx.content;
      if (ctx.from !== undefined) content = await readFile(ctx.from, 'utf8');
      if (typeof content !== 'string') throw badInput('需要 --from <文件> 或 --content <文本>（HTTP 用 body.content）');
      return writeConfigFile(ctx.name, content);
    },
    render: (r) => `已生效: ${r.name}（${r.created ? '新建' : '更新'}，nginx -t 通过 + reload${r.backedUp ? `，已备份 ${r.backedUp}` : ''}）`,
  },
  {
    id: 'nginx.fileDelete',
    cli: ['nginx', 'file', 'delete'],
    http: ['DELETE', '/api/nginx/files/:name'],
    summary: '删除配置文件（先备份；nginx -t 失败自动还原）',
    args: ['name'],
    run: (ctx) => deleteConfigFile(ctx.name),
    render: (r) => `已删除: ${r.name}${r.backedUp ? `（备份 ${r.backedUp}，可还原）` : ''}`,
  },
  {
    id: 'nginx.fileToggle',
    cli: ['nginx', 'file', 'toggle'],
    http: ['POST', '/api/nginx/files/:name/toggle'],
    summary: '停用/启用配置文件（.conf ↔ .conf.disabled，改名 + nginx -t + reload）',
    args: ['name'],
    run: (ctx) => toggleConfigFile(ctx.name),
    render: (r) => `${r.enabled ? '已启用' : '已停用'}: ${r.from} → ${r.to}`,
  },
  {
    id: 'nginx.fileBackups',
    cli: ['nginx', 'file', 'backups'],
    http: ['GET', '/api/nginx/files/:name/backups'],
    summary: '某配置文件的备份清单（新→旧，最多保留 10 份）',
    args: ['name'],
    run: (ctx) => listBackups(ctx.name),
    render: (r) => r.backups.length
      ? r.backups.map((b) => `  ${b.ts}  ${b.size}B`).join('\n')
      : `（${r.name} 暂无备份）`,
  },
  {
    id: 'nginx.fileRestore',
    cli: ['nginx', 'file', 'restore'],
    http: ['POST', '/api/nginx/files/:name/restore'],
    summary: '还原到指定备份（当前内容先再备份一份；nginx -t 失败自动回退）',
    args: ['name'],
    flags: { ts: { type: 'string', required: true } },
    run: (ctx) => restoreBackup(ctx.name, ctx.ts),
    render: (r) => `已还原: ${r.name} ← ${r.restoredFrom}（nginx -t 通过 + reload）`,
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
        ...(r.stepsFullManage || []).map((s) => `  ${s}`),
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
