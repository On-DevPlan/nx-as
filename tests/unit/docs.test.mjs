// 文档漂移防护（闸 4）：assets/ skill 文档里提到的每条 nx-as 命令都必须真实可解析
// 方向是「文档→代码」；「代码→文档」无断言——加命令必须同步更新 assets/（A07 闭环表第 11 项）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const { matchCommandForTest } = await imp('src/runtime/cli.js');

function skillFiles() {
  // 扫 assets/ 下**所有** skill 目录（新独立 skill 也要纳入命令可解析性断言）
  const out = [];
  for (const skill of readdirSync(join(ROOT, 'assets'))) {
    const dir = join(ROOT, 'assets', skill);
    if (!statSync(dir).isDirectory()) continue;
    (function walk(p) {
      for (const name of readdirSync(p)) {
        const full = join(p, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.md')) out.push(full);
      }
    })(dir);
  }
  return out;
}

test('assets 文档里的每条 nx-as 命令都能解析到 action', () => {
  const problems = [];
  for (const file of skillFiles()) {
    const src = readFileSync(file, 'utf8');
    // 提取 `nx-as xxx` 形式（反引号内或行首）；跳过 skill get 自身示例中的歧义
    const candidates = new Set();
    for (const m of src.matchAll(/nx-as ([a-z-]+(?: [a-z-]+)*)/g)) {
      candidates.add(m[1].trim());
    }
    for (const cmd of candidates) {
      const tokens = cmd.split(' ').filter((t) => !t.startsWith('[') && !t.startsWith('-') && t !== '...');
      if (!tokens.length) continue;
      const found = matchCommandForTest(tokens);
      if (!found) problems.push(`${file.replace(ROOT, '')}: "${cmd}" 解析不到命令`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
