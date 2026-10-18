import { diffLines, changeCount } from '../lib/diff.js';

// 差异视图：行级红绿 diff（复用点——保存前预览 / 漂移横幅共用）
// 设计遵循 A02 轻量规范：无第三方库、等宽字体、1px 分隔、行号灰显。
export function DiffView({ before, after, maxHeight = 420 }) {
  const rows = diffLines(before, after);
  const { add, del } = changeCount(rows);
  return (
    <div>
      <div className="diff-summary">
        <span className="diff-stat add">+{add}</span>{' '}
        <span className="diff-stat del">-{del}</span>
        <span className="mid">  （红=磁盘现网将被替换，绿=本次将写入）</span>
      </div>
      <div className="diff" style={{ maxHeight }}>
        {rows.map((r, idx) => (
          <div key={idx} className={`diff-line ${r.type}`}>
            <span className="diff-no">{r.aNo ?? ''}</span>
            <span className="diff-no">{r.bNo ?? ''}</span>
            <span className="diff-sign">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
            <span className="diff-text">{r.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
