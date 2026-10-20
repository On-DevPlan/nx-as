import { loadStore } from '../../core/store.js';
import { listAudit } from '../../core/audit.js';
import { VERSION } from '../../runtime/cli.js';

// 聚合模块：bootstrap / health / routes（无视图）
// 需要 runtime 数据的地方用动态 import 破环（见 A00 第四节）

async function commandTable() {
  const { ALL_COMMANDS, commandEntry } = await import('../../runtime/cli.js');
  return ALL_COMMANDS.map(commandEntry);
}

async function routesTable({ http } = {}) {
  const all = await commandTable();
  if (http) {
    const [method, path] = http.split(' ');
    const { compileRoute, sortRoutes } = await import('../../runtime/spec.js');
    const { ACTIONS } = await import('../../index.js');
    const target = sortRoutes(
      ACTIONS.filter((a) => a.http).map((a) => ({ action: a, ...compileRoute(a.http) })),
    ).find((r) => r.method === method && r.regex.test(path));
    return target ? [all.find((e) => e.id === target.action.id)].filter(Boolean) : [];
  }
  return all;
}

export async function bootstrap() {
  const store = await loadStore();
  const { APP_NAME } = await import('../../core/paths.js');
  const app = { name: APP_NAME, version: VERSION };
  return {
    app,
    version: VERSION,
    appStorePath: store ? undefined : undefined, // store 不暴露真实路径给 HTTP；CLI 端下面单独给
    cwdScope: process.cwd(),
    settings: store.settings,
    commands: await commandTable(),
    // 端口探测的认领签名（跨项目统一口径）：共享 helper 的 probePanel 只认 body.data.app.name，
    // 而 nx-as 的管理面 API 不套 {ok,data} 信封（前端 api() 直接吃裸 payload），
    // 所以把 app 段再挂一份到 data 下——纯增量字段，不动任何既有字段名与语义。
    data: { app },
  };
}

export async function bootstrapCli() {
  const { storePathFromEnv } = await import('../../core/paths.js');
  const base = await bootstrap();
  return { ...base, appStorePath: storePathFromEnv() };
}

export async function health() {
  const store = await loadStore();
  return {
    ok: true,
    version: VERSION,
    storeReachable: Boolean(store),
    time: new Date().toISOString(),
  };
}

export async function routesQuery(ctx) {
  return routesTable({ http: ctx.http });
}

// 审计列表（只读）：JSONL 逐条倒序给前端（新在前），limit 默认与 listAudit 一致
export async function auditList(ctx) {
  const limit = Number.isInteger(ctx.limit) && ctx.limit > 0 ? Math.min(ctx.limit, 1000) : 200;
  const entries = await listAudit({ limit });
  return { entries: entries.reverse(), limit };
}

