// 行级 diff（LCS 最长公共子序列）——前端通用工具，不依赖任何第三方库。
// 使用方：nginx 模块的「保存前 diff 预览」（view.jsx）与漂移横幅（复用点）。
// 纯 JS 无 JSX、无 React 依赖：node 单测可直接 import（tests/unit/diff.test.mjs）。

/**
 * 行级 diff：aText → bText 需要的最小编辑集（LCS 语义，行级稳定）。
 * @param {string} aText 旧文本（磁盘现网）
 * @param {string} bText 新文本（最新渲染）
 * @returns {Array<{type:'same'|'del'|'add', text:string, aNo?:number, bNo?:number}>}
 *   aNo/bNo 为该行在旧/新文本中的 1 起始行号（same/del 有 aNo；same/add 有 bNo）
 */
export function diffLines(aText, bText) {
  const a = String(aText ?? '').split('\n');
  const b = String(bText ?? '').split('\n');
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i:] 与 b[j:] 的 LCS 长度（滚动到底向上填表）
  // 配置文件量级（数百行）下 n*m 的 Uint32Array 完全可承受
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  // 回溯：优先输出 del（先旧后新，阅读顺序与 patch 习惯一致）
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], aNo: i + 1, bNo: j + 1 });
      i += 1; j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i], aNo: i + 1 });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j], bNo: j + 1 });
      j += 1;
    }
  }
  while (i < n) { out.push({ type: 'del', text: a[i], aNo: i + 1 }); i += 1; }
  while (j < m) { out.push({ type: 'add', text: b[j], bNo: j + 1 }); j += 1; }
  return out;
}

/** 是否存在增/删（same 行不算变化）——「无差异时应用置灰」的判定。 */
export function hasChanges(rows) {
  return rows.some((r) => r.type !== 'same');
}

/** 变化行计数（+x -y 形式的摘要用）。 */
export function changeCount(rows) {
  let add = 0;
  let del = 0;
  for (const r of rows) {
    if (r.type === 'add') add += 1;
    else if (r.type === 'del') del += 1;
  }
  return { add, del };
}
