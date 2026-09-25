// 一致性断言：模块目录 ↔ 注册表 ↔ 前端视图 ↔ 视图调用的 API（A00 闸 2/3）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const { ACTIONS } = await imp('src/index.js');
const { MODULES } = await imp('src/runtime/registry.js');
const { cliPathsOf } = await imp('src/runtime/spec.js');
const { getAllCommands, matchCommandForTest } = await imp('src/runtime/cli.js');

function srcDirs(rel) {
  const p = join(ROOT, ...rel.split('/'));
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

test('模块目录 ↔ MODULES 注册表双向对账', () => {
  const dirs = srcDirs('src/modules').filter((d) => d !== 'index.js' && d !== '.DS_Store');
  const registered = MODULES.map((m) => m.id);
  assert.deepEqual(dirs.sort(), [...registered].sort(), 'src/modules 目录与 registry MODULES 不一致');
});

test('带 view 的模块 ↔ 前端 VIEWS 注册表双向对账', () => {
  const frontendSrc = readFileSync(join(ROOT, 'src', 'web', 'frontend', 'registry.js'), 'utf8');
  for (const m of MODULES.filter((m) => m.view)) {
    assert.ok(frontendSrc.includes(`${m.id}:`), `模块 ${m.id} 有 view 但前端 VIEWS 没登记`);
  }
  // 反向：VIEWS 里登记的每个 id 都得是带 view 的模块
  const viewIds = [...frontendSrc.matchAll(/^\s{2}(\w+): \(\)/gm)].map((m) => m[1]);
  const allowed = MODULES.filter((m) => m.view).map((m) => m.id);
  for (const id of viewIds) {
    assert.ok(allowed.includes(id), `前端 VIEWS 登记了未知模块: ${id}`);
  }
});

test('带 view 的模块都有 view.jsx 文件', () => {
  for (const m of MODULES.filter((m) => m.view)) {
    assert.ok(existsSync(join(ROOT, 'src', 'modules', m.id, 'view.jsx')), `缺 view.jsx: ${m.id}`);
  }
});

test('每条 action 的 CLI 路径都能被运行器解析回它自己', () => {
  for (const a of ACTIONS) {
    for (const path of cliPathsOf(a)) {
      const found = matchCommandForTest(path);
      assert.equal(found?.id, a.id, `CLI 路径解析错位: ${path.join(' ')}`);
    }
  }
});

test('每条 HTTP 路由都能由某条 CLI 命令触达（方向：web→cli 保底）', () => {
  for (const a of ACTIONS) {
    if (!a.http) continue;
    assert.ok(cliPathsOf(a).length > 0, `${a.id} 有 HTTP 无 CLI`);
  }
});

test('CRUD 声明资源五操作齐备且两端可调用', () => {
  const CRUD_VERB = { list: 'list', get: 'get', create: 'add', update: 'update', remove: 'remove' };
  const resources = MODULES.filter((m) => m.resource);
  assert.ok(resources.length > 0, '没有任何模块声明 resource，检查形同虚设');
  const problems = [];
  for (const m of resources) {
    for (const [op, verb] of Object.entries(CRUD_VERB)) {
      const a = ACTIONS.find((x) => x.id === `${m.resource}.${verb}`);
      if (!a) { problems.push(`${m.id}: 缺 ${op}（应为 ${m.resource}.${verb}）`); continue; }
      if (!cliPathsOf(a).length) problems.push(`${m.id}: ${a.id} 缺 CLI 命令`);
      if (!a.http) problems.push(`${m.id}: ${a.id} 缺 HTTP 路由`);
    }
  }
  assert.deepEqual(problems, [], `CRUD 不完备:\n${problems.join('\n')}`);
});

test('CRUD 路由形状对得上语义', () => {
  const CRUD_VERB = { list: 'list', get: 'get', create: 'add', update: 'update', remove: 'remove' };
  const hasParam = (p) => p.split('/').some((s) => s.startsWith(':'));
  for (const m of MODULES.filter((m) => m.resource)) {
    const http = (op) => ACTIONS.find((a) => a.id === `${m.resource}.${CRUD_VERB[op]}`).http;
    assert.equal(hasParam(http('list')[1]), false, `${m.id}: list 路由不应含 :param`);
    for (const op of ['get', 'update', 'remove']) {
      assert.ok(hasParam(http(op)[1]), `${m.id}: ${op} 路由必须含 :param`);
    }
  }
});

test('视图里调用的每个 /api 路径都有对应路由', () => {
  // 收集视图里的 API 调用
  const calls = new Set();
  for (const m of MODULES.filter((m) => m.view)) {
    const src = readFileSync(join(ROOT, 'src', 'modules', m.id, 'view.jsx'), 'utf8');
    for (const match of src.matchAll(/api\(\s*['"](GET|POST|PATCH|DELETE)['"]\s*,\s*([`'"])([^`'"]+)\2/g)) {
      calls.add(`${match[1]} ${match[3]}`);
    }
  }
  const appSrc = readFileSync(join(ROOT, 'src', 'web', 'frontend', 'App.jsx'), 'utf8');
  for (const match of appSrc.matchAll(/fetch\((['"])(\/api[^'"]+)\1/g)) {
    calls.add(`GET ${match[2]}`);
  }

  // 模板字面量归一成 :param（${editing.name} → :name）
  function normalize(methodPath) {
    const [method, path] = methodPath.split(' ');
    const norm = path
      .replace(/\$\{[^}]+\}/g, ':param')
      .split('/')
      .map((seg) => (seg.startsWith(':') ? ':x' : seg))
      .join('/');
    return { method, norm };
  }
  function routeToPattern(httpPath) {
    return httpPath
      .split('/')
      .map((seg) => (seg.startsWith(':') ? ':x' : seg))
      .join('/');
  }

  const routes = ACTIONS.filter((a) => a.http).map((a) => ({
    method: a.http[0],
    pattern: routeToPattern(a.http[1]),
  }));

  const problems = [];
  for (const call of calls) {
    const { method, norm } = normalize(call);
    const hit = routes.find((r) => r.method === method && r.pattern === norm);
    if (!hit) problems.push(`视图调用了不存在的路由: ${call}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('help/命令表覆盖全部 action（一张表原则）', () => {
  const all = getAllCommands();
  const ids = new Set(all.map((a) => a.id));
  for (const a of ACTIONS) {
    assert.ok(ids.has(a.id), `action ${a.id} 不在 ALL_COMMANDS 里`);
  }
});

test('路由按字面量段优先排序（声明顺序无关）', async () => {
  const { sortRoutes } = await imp('src/runtime/spec.js');
  const routes = sortRoutes([
    { path: '/api/tasks/:id/events', regex: /x/, keys: [], method: 'GET' },
    { path: '/api/tasks', regex: /x/, keys: [], method: 'GET' },
    { path: '/api/models/current', regex: /x/, keys: [], method: 'GET' },
    { path: '/api/models/:provider', regex: /x/, keys: [], method: 'GET' },
  ]);
  // /api/models/current 必须排在 /api/models/:provider 前面
  const idxCurrent = routes.findIndex((r) => r.path === '/api/models/current');
  const idxParam = routes.findIndex((r) => r.path === '/api/models/:provider');
  assert.ok(idxCurrent < idxParam, '字面量路由被参数路由遮蔽');
});
