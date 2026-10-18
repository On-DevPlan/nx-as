// 行级 LCS diff 纯函数单测（frontend/lib/diff.js——无 JSX，node 直接 import）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { diffLines, hasChanges, changeCount } = await import(
  pathToFileURL(join(ROOT, 'src/web/frontend/lib/diff.js')).href
);

test('diff: 相同文本 → 全 same、无增删（应用置灰语义）', () => {
  const rows = diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(rows.filter((r) => r.type !== 'same').length, 0);
  assert.equal(hasChanges(rows), false);
  assert.deepEqual(changeCount(rows), { add: 0, del: 0 });
});

test('diff: 纯新增 / 纯删除', () => {
  assert.deepEqual(changeCount(diffLines('a\n', 'a\nb\nc\n')), { add: 2, del: 0 });
  assert.deepEqual(changeCount(diffLines('a\nb\nc\n', 'a\n')), { add: 0, del: 2 });
});

test('diff: 中间替换（LCS 保留公共行，行号对齐）', () => {
  const rows = diffLines('server {\n  listen 80;\n  server_name old.com;\n}\n',
    'server {\n  listen 80;\n  server_name new.com;\n}\n');
  // 两文本都以 \n 结尾 → 各自 split 出一个公共空尾行（same）
  const kinds = rows.map((r) => r.type).join(',');
  assert.equal(kinds, 'same,same,del,add,same,same', `实得 ${kinds}`);
  const delRow = rows.find((r) => r.type === 'del');
  const addRow = rows.find((r) => r.type === 'add');
  assert.equal(delRow.aNo, 3, 'del 带旧行号');
  assert.equal(addRow.bNo, 3, 'add 带新行号');
  assert.equal(hasChanges(rows), true);
});

test('diff: 空文本 → 全部为新增（首次 Apply 前语义）', () => {
  // ''.split → ['']；'a\nb\n'.split → ['a','b','']——现网空行与渲染尾空行匹配为 same，
  // 其余为新增（无红色行，绿色新增 2 行）
  assert.deepEqual(changeCount(diffLines('', 'a\nb\n')), { add: 2, del: 0 });
  assert.deepEqual(changeCount(diffLines(null, 'x\n')), { add: 1, del: 0 });
});

test('diff: 尾换行差异被识别（最后一行空行）', () => {
  const rows = diffLines('a', 'a\n');
  assert.deepEqual(changeCount(rows), { add: 1, del: 0 });
});

test('diff: 行序交换 → 删+增（LCS 不输出移动语义，可接受）', () => {
  const rows = diffLines('a\nb\n', 'b\na\n');
  assert.equal(hasChanges(rows), true);
  const { add, del } = changeCount(rows);
  assert.equal(add, del, '行序交换以等量删增表达');
  assert.equal(add, 1, 'LCS 保留一个公共行');
});

test('diff: 大文件量级可承受且正确（500 行追加一行）', () => {
  const a = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const b = a + '\ninserted';
  const rows = diffLines(a, b);
  assert.deepEqual(changeCount(rows), { add: 1, del: 0 });
});
