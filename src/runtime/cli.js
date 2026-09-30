import { applySpec, cliPathsOf, usageOf } from './spec.js';
import { CODES } from '../core/errors.js';
import { VERSION } from '../core/version.js';
import { ACTIONS } from '../index.js';

export { VERSION };
export const MODULE_IDS = ['auth', 'cert', 'gateway', 'nginx', 'system'];

// ---------- 平台命令（不属于任何业务域；与模块 action 合成同一张 ALL_COMMANDS） ----------

async function cmdServe(ctx) {
  const { startServer } = await import('./server.js'); // 避开 api → registry → cli 成环
  const { openBrowser } = await import('../core/open.js');
  const port = ctx.port ?? 7801;
  const host = ctx.host || '127.0.0.1';
  const server = await startServer({ port, host });

  // serve 启动时确保有 token：CLI 参数 > 环境变量 > store 里存的 > 自动生成
  const { ensureToken } = await import('../modules/auth/service.js');
  const token = await ensureToken(ctx.token);
  const { setRuntimeToken } = await import('./api.js');
  setRuntimeToken(token);


  const displayHost = host === '0.0.0.0' ? '0.0.0.0' : host;
  console.log(`网关:   http://${displayHost}:${port}   (/m/v1/* 反代 pi-web，device token 鉴权)`);
  console.log(`面板:   http://${displayHost}:${port}   (设备管理/设置，管理密钥)`);
  console.log(`控制台: http://${displayHost}:${port}/?token=${token}   (带密钥直达，可收藏)`);
  console.log(`密钥:   ${token}`);
  console.log(`(管理面 /api/* 走上述密钥；网关 /_nxas/m/v1/* 走 device token：nx-as device issue --name <设备名>)`);
  console.log('提示:   模型/插件/技能管理在 pi-web 自带设置页（http://127.0.0.1:30141 或经网关 Web UI）；扩展装入 ~/.nx-as/pi-agent/extensions/');

  // --with-web：顺带拉起 pi-web（安全启动器：随机 PI_WEB_PASSWORD，只听 127.0.0.1）
  let webChild = null;
  if (ctx['with-web']) {
    const { spawnWeb } = await import('./launcher.js');
    const r = await spawnWeb({ port: ctx['web-port'] ?? 30141 });
    webChild = r?.child ?? null;
  }

  if (!ctx['no-open'] && host !== '0.0.0.0') openBrowser(`http://127.0.0.1:${port}`);

  const shutdown = () => {
    if (webChild) webChild.kill('SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => {}); // 常驻
}

// nx-as web：安全启动器，拉起 pi-web（@agegr/pi-web，MIT），PI_CODING_AGENT_DIR 指向 nx-as 的
// 隔离目录 → 它的生产级 UI（Markdown/KaTeX/Mermaid/diff/会话树/文件浏览）直接可用。
// PI_WEB_PASSWORD 每次启动随机生成注入（机机信任；本机直用时浏览器会要一次 Basic，
// 用户名 pi 密码看启动日志——网关模式 --with-web 下用户永远不需要它）。
// pi-web 不在 dependencies 里（重依赖，Next.js 全家桶）；缺的时候给出一条安装命令。
async function cmdWeb(ctx) {
  const { spawnWeb } = await import('./launcher.js');
  const r = await spawnWeb({ port: ctx.port ?? 30141, open: !ctx['no-open'] });
  if (!r) return { status: 'blocked', note: 'pi-web 未安装' };
  return new Promise(() => {}); // 常驻，随子进程退出
}

function allCommands() {
  return [...BUILTINS, ...ACTIONS];
}

function helpEntries(topic) {
  const all = allCommands().map(commandEntry);
  if (!topic) return all;
  // 主题同时接受模块 id 与命令组（task / prompt 这类第一段）
  const byModule = all.filter((e) => e.module === topic);
  if (byModule.length) return byModule;
  const byRoot = all.filter((e) => e.command.split(' ')[1] === topic);
  if (byRoot.length) return byRoot;
  const byId = all.filter((e) => e.id === topic);
  if (byId.length) return byId;
  const err = new Error(`未知帮助主题: ${topic}（可用模块: ${MODULE_IDS.join(' / ')}；或命令组如 task / prompt / skill / models）`);
  err.code = CODES.INVALID_INPUT;
  throw err;
}

function renderHelp(entries, topic) {
  const head = topic ? `用法主题: ${topic}` : '命令表';
  const lines = entries.map((e) => `  ${e.usage.padEnd(50)} ${e.http ? e.http.padEnd(34) : ''} ${e.summary}`);
  return [head, ...lines].join('\n');
}

const BUILTINS = [
  {
    id: 'serve',
    cli: ['serve'],
    summary: '启动鉴权网关（/m/v1 反代 pi-web）+ Web 面板 + 管理 API',
    flags: {
      port: { type: 'number', default: 7801 },
      host: { type: 'string', default: '127.0.0.1' },
      'no-open': { type: 'boolean' },
      'with-web': { type: 'boolean' },
      'web-port': { type: 'number' },
    },
    run: (ctx) => cmdServe(ctx),
    render: () => '',
  },
  {
    id: 'web',
    cli: ['web'],
    summary: '只拉起 pi-web（安全启动器：随机 PI_WEB_PASSWORD，本机调试用）',
    flags: {
      port: { type: 'number', default: 30141 },
      'no-open': { type: 'boolean' },
    },
    run: (ctx) => cmdWeb(ctx),
    render: () => '',
  },
  {
    id: 'help',
    cli: ['help'],
    args: [{ name: 'topic', required: false }],
    summary: '显示命令表',
    run: (ctx) => helpEntries(ctx.topic),
    render: (entries, ctx) => renderHelp(entries, ctx.topic),
  },
  {
    id: 'version',
    cli: ['version'],
    summary: '版本号',
    run: () => VERSION,
    render: (v) => v,
  },
  {
    id: 'skill.install',
    cli: ['skill', 'install'],
    summary: '把内置 skill 装到 ~/.claude/skills（无参=默认；--group <g> 一键装一组；三态：装/跳过/冲突）',
    args: [{ name: 'name', required: false }],
    flags: { to: { type: 'string' }, force: { type: 'boolean' }, group: { type: 'string' } },
    run: async (ctx) => {
      const skill = await import('./skill.js');
      // --group 与位置参数互斥（二者等价语义，报错比猜意图友好）
      if (ctx.group && ctx.name) {
        const err = new Error('--group 与 [name] 只能给一个');
        err.code = CODES.INVALID_INPUT;
        throw err;
      }
      if (ctx.group) return skill.installGroup({ name: ctx.group, to: ctx.to, force: ctx.force });
      return skill.installBundledSkill({ name: ctx.name, to: ctx.to, force: ctx.force });
    },
    render: (r) => {
      if (r.group) {
        // 多 skill 聚合结果（显式 group 字段判别，不做形状嗅探）
        const head = r.status === 'conflict'
          ? `冲突: group ${r.group}（${r.count} 个文件不同；确认覆盖加 --force）`
          : `已装 group ${r.group}（${r.skills.length} 个 skill，${r.files} 个文件${r.replaced ? '，含替换' : ''}）`;
        const lines = r.skills.map((s) => `  ${s.skill}: ${s.status === 'conflict' ? '冲突' : s.skipped ? '跳过' : s.replaced ? '替换' : '安装'} ${s.path}`);
        return [head, ...lines].join('\n');
      }
      return r.status === 'conflict'
        ? `冲突: ${r.path}（${r.count} 个文件不同；确认覆盖加 --force）`
        : r.skipped
          ? `已是最新: ${r.path}`
          : r.replaced
            ? `已替换: ${r.path}`
            : `已安装: ${r.path}`;
    },
  },
  {
    id: 'skill.list',
    cli: ['skill', 'list'],
    summary: '列出可装的 skill 与 group（标出默认 install；source=manifest|assets-dirs）',
    flags: { to: { type: 'string' } },
    run: async () => {
      const { listBundledSkills } = await import('./skill.js');
      return listBundledSkills();
    },
    render: (r) => {
      const lines = ['可装的 skill:'];
      for (const s of r.skills) {
        lines.push(`  * ${s}${s === r.defaultSkill ? '   （默认 install）' : ''}`);
      }
      lines.push('可装的 group:');
      for (const g of r.groups) lines.push(`  * ${g}`);
      lines.push(`来源: ${r.source}`);
      return lines.join('\n');
    },
  },
  {
    id: 'skill.get',
    cli: ['skill', 'get'],
    summary: '导出 skill 上下文到 stdout（prefix + 文档 + install 状态；外部 agent 用）',
    args: [
      { name: 'name', required: false },
      { name: 'ref', required: false },
    ],
    flags: { to: { type: 'string' }, force: { type: 'boolean' } },
    rawOutput: true,
    run: async (ctx) => {
      const { getSkill } = await import('./skill.js');
      return getSkill(ctx);
    },
  },
];

// ---------- CLI 运行器 ----------

// 全局 flag：出现在 argv 任意位置，先摘掉再匹配命令
const GLOBAL_FLAGS = ['json', 'token', 'store'];

export async function runCli(argv) {
  const { cleanArgv, globals } = extractGlobalFlags(argv);
  const json = globals.json;
  try {
    const action = matchCommand(cleanArgv);
    if (!action) {
      const err = new Error('未知命令。运行 nx-as help 查看命令表');
      err.code = CODES.INVALID_INPUT;
      throw err;
    }
    const ctx = parseCtx(action, cleanArgv, globals);
    const data = await action.run(ctx, { transport: 'cli', json: globals.json === true });
    if (action.sse) return; // SSE 类命令（task events CLI 路径）自行输出
    if (action.rawOutput) {
      // skill get：人类模式三段拼接；--json 单个 JSON 值（不含 prefix）
      const { skillGetPrefix, skillGetInstallStatus } = await import('./skill.js');
      if (globals.json) {
        console.log(JSON.stringify(data));
      } else {
        console.log(skillGetPrefix(data.skillName, data.ref));
        console.log(data.content);
        console.log('');
        console.log(skillGetInstallStatus(data.install));
      }
      return;
    }
    emit(data, action, ctx, json);
  } catch (err) {
    const code = err.code || CODES.INTERNAL;
    if (json) {
      console.log(JSON.stringify({ ok: false, error: err.message, code }));
    } else {
      console.error(err.message);
    }
    process.exitCode = 1;
  }
}

function extractGlobalFlags(argv) {
  const cleanArgv = [];
  const globals = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const name = t.slice(2).split('=')[0];
      if (GLOBAL_FLAGS.includes(name)) {
        if (t.includes('=')) globals[name] = t.slice(t.indexOf('=') + 1);
        else if (name === 'json') globals.json = true;
        else globals[name] = argv[++i];
        continue;
      }
    }
    cleanArgv.push(t);
  }
  return { cleanArgv, globals };
}

// 命令匹配：按 token 前缀逐字比，最长优先
export function matchCommand(tokens) {
  const all = allCommands();
  let best = null;
  let bestLen = -1;
  for (const action of all) {
    for (const path of cliPathsOf(action)) {
      if (path.length > tokens.length) continue;
      if (path.every((seg, i) => tokens[i] === seg) && path.length > bestLen) {
        best = action;
        bestLen = path.length;
      }
    }
  }
  return best;
}

// 测试用（语义别名）
export const matchCommandForTest = matchCommand;

function parseCtx(action, tokens, globals) {
  const paths = cliPathsOf(action);
  let matched = paths[0];
  for (const p of paths) {
    if (p.length <= tokens.length && p.every((seg, i) => tokens[i] === seg)) {
      if (p.length > matched.length) matched = p;
    }
  }
  const rest = tokens.slice(matched.length);
  const raw = {};

  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t.startsWith('--')) {
      const name = t.slice(2).split('=')[0];
      const spec = (action.flags || {})[name];
      const isBool = spec && (typeof spec === 'string' ? spec : spec.type) === 'boolean';
      if (t.includes('=')) raw[name] = t.slice(t.indexOf('=') + 1);
      else if (isBool) raw[name] = true;
      else if (i + 1 < rest.length) raw[name] = rest[++i];
      else {
        const err = new Error(`用法: ${usageOf(action)} —— --${name} 需要一个值`);
        err.code = 'INVALID_INPUT';
        throw err;
      }
    } else {
      positional.push(t);
    }
  }

  const argSpecs = (action.args || []).map((a) => (typeof a === 'string' ? { name: a } : a));
  argSpecs.forEach((spec, i) => {
    if (positional[i] !== undefined) raw[spec.name] = positional[i];
  });
  if (positional.length > argSpecs.length) {
    const err = new Error(`用法: ${usageOf(action)} —— 多余的位置参数: ${positional.slice(argSpecs.length).join(' ')}`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  if (globals.token) raw.token = globals.token;
  return applySpec(action, raw);
}

function emit(data, action, ctx, json) {
  if (json) {
    console.log(JSON.stringify(data === undefined ? null : data));
    return;
  }
  if (action.render) {
    const out = action.render(data, ctx);
    if (out !== undefined && out !== '') console.log(out);
    else if (out === undefined && data !== undefined) {
      console.log(typeof data === 'string' ? data : JSON.stringify(data));
    }
  } else if (data !== undefined) {
    console.log(typeof data === 'string' ? data : JSON.stringify(data));
  }
}

export function commandEntry(action) {
  const module = MODULE_IDS.find((m) => action.id.startsWith(m + '.'));
  return {
    id: action.id,
    module: module || 'platform',
    command: ['nx-as', ...cliPathsOf(action)[0]].join(' '),
    usage: usageOf(action),
    summary: action.summary || '',
    http: action.http ? action.http.join(' ') : null,
  };
}

// 惰性导出：BUILTINS 声明完成后才可调用（避免 TDZ）
export function getAllCommands() {
  return allCommands();
}

// 兼容动态 import 解构 { ALL_COMMANDS } 的调用方（system/service.js）
export const ALL_COMMANDS = new Proxy({}, {
  get(_t, prop) {
    const arr = allCommands();
    if (prop === 'map' || prop === 'filter' || prop === 'find' || prop === 'length') {
      const v = arr[prop];
      return typeof v === 'function' ? v.bind(arr) : v;
    }
    return arr[prop];
  },
});
