import { useState, useEffect, useMemo } from 'react';
import { api } from '../../web/frontend/api/client.js';

// 调试面板：从 /api/tasks/:id/timeline 读 span 树，画「树 + 时间条 + 详情」。
// 零依赖手画（A02 规范：28px 行 / 12px 字 / 1px 分隔）。

const TYPE_TAG = {
  turn: 'tag',
  llm: 'tag strong',
  tool: 'tag',
};

function fmtDur(startMs, endMs) {
  if (startMs == null) return '';
  if (endMs == null) return '…';
  const d = endMs - startMs;
  return d < 1000 ? `${d}ms` : `${(d / 1000).toFixed(1)}s`;
}

function fmtTime(ts) {
  if (ts == null) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

// 扁平 spans + tree + rootIds → 缩进行列表
function flattenTree(spans, tree, rootIds) {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const rows = [];
  const walk = (id, depth) => {
    const s = byId.get(id);
    if (!s) return;
    rows.push({ ...s, depth });
    for (const c of tree[id] || []) walk(c, depth + 1);
  };
  for (const r of rootIds || []) walk(r, 0);
  // 防御：既不在树上也不在 root 的 span（数据坏）也展示，不静默丢
  const seen = new Set(rows.map((r) => r.id));
  for (const s of spans) {
    if (!seen.has(s.id)) rows.push({ ...s, depth: 0 });
  }
  return rows;
}

function SpanRow({ span, selected, onSelect }) {
  return (
    <div
      className={selected ? 'trace-row active' : 'trace-row'}
      onClick={() => onSelect(span.id)}
      style={{ paddingLeft: 8 + span.depth * 20 }}
    >
      <span className={TYPE_TAG[span.spanType] || 'tag'}>{span.spanType}</span>
      <span className="trace-name mono">{span.name}</span>
      {span.status === 'error' && <span className="tag bad">error</span>}
      <span className="trace-meta">{fmtTime(span.startMs)}</span>
      <span className="trace-meta trace-dur">{fmtDur(span.startMs, span.endMs)}</span>
    </div>
  );
}

function JsonBlock({ value }) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <pre className="output">{text}</pre>;
}

function SpanDetails({ span }) {
  if (!span) return <div className="trace-details mid">选中左侧 span 查看详情</div>;
  return (
    <div className="trace-details">
      <div className="row"><span className="rowlabel">span</span><span className="rowbody mono">{span.id}</span></div>
      <div className="row"><span className="rowlabel">父</span><span className="rowbody mono">{span.parentId || '(根)'}</span></div>
      <div className="row"><span className="rowlabel">开始</span><span className="rowbody">{fmtTime(span.startMs)}</span></div>
      <div className="row"><span className="rowlabel">耗时</span><span className="rowbody">{fmtDur(span.startMs, span.endMs)}</span></div>
      <div className="row"><span className="rowlabel">状态</span><span className="rowbody">{span.status}</span></div>
      {span.text != null && span.text !== '' && (
        <div className="trace-block">
          <div className="colhead">文本</div>
          <pre className="output">{span.text}</pre>
        </div>
      )}
      {span.attrs && Object.keys(span.attrs).length > 0 && (
        <div className="trace-block">
          <div className="colhead">属性</div>
          <JsonBlock value={span.attrs} />
        </div>
      )}
      {span.output != null && (
        <div className="trace-block">
          <div className="colhead">输出</div>
          <JsonBlock value={span.output} />
        </div>
      )}
    </div>
  );
}

// taskStatus: 'running' 时自动每 2s 刷新；否则只拉一次
export default function TraceView({ taskId, taskStatus }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    let alive = true;
    let timer = null;
    const load = async () => {
      try {
        const d = await api('GET', `/api/tasks/${taskId}/timeline`);
        if (alive) {
          setData(d);
          setErr('');
        }
      } catch (e) {
        if (alive) setErr(e.message);
      }
    };
    load();
    if (taskStatus === 'running') timer = setInterval(load, 2000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [taskId, taskStatus]);

  const rows = useMemo(() => (data ? flattenTree(data.spans, data.tree, data.rootIds) : []), [data]);
  const selected = data?.spans.find((s) => s.id === selectedId) || null;

  if (err) return <span className="bad mono">{err}</span>;
  if (!data) return <div className="mid">加载中…</div>;
  if (!data.spans.length) return <div className="mid">（无事件——此任务早于事件流功能，或尚未开始执行）</div>;

  return (
    <div className="trace">
      <div className="trace-head">
        <span>{data.spans.length} spans · {data.total} events</span>
      </div>
      <div className="trace-body">
        <div className="trace-tree">
          {rows.map((s) => (
            <SpanRow key={s.id} span={s} selected={selectedId === s.id} onSelect={setSelectedId} />
          ))}
        </div>
        <div className="trace-side">
          <div className="colhead">详情</div>
          <SpanDetails span={selected} />
        </div>
      </div>
    </div>
  );
}
