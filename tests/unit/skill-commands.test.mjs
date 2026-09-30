// skill 子命令面单测（B04 验收标准）：
//   三种 install 形式（无参默认 / 显式 name / --group）、skill list（默认标记 + source）、
//   互斥报错、未知 group 报错 + 可用列表、groups.json 降级（缺失→assets-dirs）与 schema 错。
// 隔离：USERPROFILE/HOME 指向临时目录（绝不碰真实 ~/.claude/skills）；
//       node 用 process.execPath（Volta shim 在改 USERPROFILE 后会挂）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, rename, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const BIN = join(ROOT, 'bin', 'nx-as.mjs');

function runCli(args, { home, cwd } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    cwd: cwd || ROOT,
    env: {
      ...process.env,
      ...(home ? { USERPROFILE: home, HOME: home } : {}),
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('skill list: 默认标记 + source=manifest', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nx-skill-list-'));
  const r = runCli(['skill', 'list', '--json'], { home });
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out.trim().split('\n').pop());
  assert.ok(j.skills.includes('nx-as') && j.skills.includes('nx-as-sidecar'), '两个 skill 都在');
  assert.equal(j.defaultSkill, 'nx-as', '默认 = package.json.name');
  assert.ok(j.groups.includes('nx-as') && j.groups.includes('sidecar'));
  assert.equal(j.source, 'manifest');
  await rm(home, { recursive: true, force: true });
});

test('skill list: groups.json 缺失 → 降级 assets-dirs（不崩）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nx-skill-deg-'));
  const bak = join(ROOT, 'assets', 'groups.json.bak-test');
  await rename(join(ROOT, 'assets', 'groups.json'), bak);
  try {
    const r = runCli(['skill', 'list', '--json'], { home });
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(r.out.trim().split('\n').pop());
    assert.equal(j.source, 'assets-dirs', '降级路径可被观测');
    assert.ok(j.skills.includes('nx-as') && j.skills.includes('nx-as-sidecar'), '资产兜底');
  } finally {
    await rename(bak, join(ROOT, 'assets', 'groups.json'));
  }
});

test('skill list: groups.json schema 错 → INVALID_INPUT（不静默）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nx-skill-bad-'));
  const orig = await readFile(join(ROOT, 'assets', 'groups.json'), 'utf8');
  await writeFile(join(ROOT, 'assets', 'groups.json'), JSON.stringify({ version: 1, groups: { broken: {} } }));
  try {
    const r = runCli(['skill', 'list', '--json'], { home });
    assert.equal(r.code, 1);
    const j = JSON.parse(r.out.trim().split('\n').pop());
    assert.equal(j.code, 'INVALID_INPUT');
    assert.match(j.error, /schema/);
  } finally {
    await writeFile(join(ROOT, 'assets', 'groups.json'), orig);
  }
});

test('三种 install 形式：无参默认 / 显式 name / --group（全部装到隔离 HOME）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nx-skill-inst-'));
  // 1) 无参 → 默认 nx-as
  let r = runCli(['skill', 'install'], { home });
  assert.equal(r.code, 0, r.out);
  await access(join(home, '.claude', 'skills', 'nx-as', 'SKILL.md'));
  // 2) 显式 name
  r = runCli(['skill', 'install', 'nx-as-sidecar'], { home });
  assert.equal(r.code, 0, r.out);
  await access(join(home, '.claude', 'skills', 'nx-as-sidecar', 'SKILL.md'));
  // 3) --group
  r = runCli(['skill', 'install', '--group', 'sidecar'], { home });
  assert.equal(r.code, 0, r.out);
  await access(join(home, '.claude', 'skills', 'nx-as-sidecar', 'SKILL.md'));
  // 4) 幂等：二次安装 skipped
  r = runCli(['skill', 'install'], { home });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /已是最新/);
  await rm(home, { recursive: true, force: true });
});

test('--group 与 [name] 互斥 → INVALID_INPUT', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nx-skill-mutex-'));
  const r = runCli(['skill', 'install', 'nx-as', '--group', 'sidecar'], { home });
  assert.equal(r.code, 1);
  assert.match(r.out, /只能给一个/);
  await rm(home, { recursive: true, force: true });
});

test('--group=bogus → INVALID_INPUT 且给出可用 group 列表', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nx-skill-bogus-'));
  const r = runCli(['skill', 'install', '--group', 'bogus'], { home });
  assert.equal(r.code, 1);
  assert.match(r.out, /未知 group/);
  assert.match(r.out, /nx-as, sidecar/);
  await rm(home, { recursive: true, force: true });
});

test('loadGroups schema 校验与默认 group 推导（进程内直测）', async () => {
  const { loadGroups } = await imp('src/runtime/skill.js');
  const g = await loadGroups();
  assert.equal(g['nx-as'].skills[0], 'nx-as', '默认 group key ≡ package.json.name');
  assert.equal(g.sidecar.skills[0], 'nx-as-sidecar');
});
