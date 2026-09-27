import { useState, useEffect, useMemo } from 'react';
import { api } from '../../web/frontend/api/client.js';

// 调试面板：span 树（调用流程）+ 时间线瀑布图（时序交互）+ 详情。
// 时间线模式借鉴 AgentPrism 的 Timeline View（水平条按时长比例定位，零依赖手画）。

const TYPE_TAG = {
  turn: 'tag',
  llm: 'tag strong',
  tool: 'tag',
};

function fmtDur(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(ts) {
  if (ts == null) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

// 扁平 spans + tree + rootIds → 缩进行列表（附带 depth）
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
  const seen = new Set(rows.map((r) => r.id));
  for (const s of spans) {
    if (!seen.has(s.id)) rows.push({ ...s, depth: 0 });
  }
  return rows;
}

// 计算时间线坐标系：全局 [minStart, maxEnd]
function timeBounds(spans) {
  let min = Infinity;
  let max = -Infinity;
  for (const s of spans) {
    if (s.startMs == null) continue;
    if (s.startMs < min) min = s.startMs;
    const e = s.endMs ?? Date.now();
    if (e > max) max = e;
  }
  if (min === Infinity) return { min: 0, max: 1, span: 1 };
  return { min, max, span: Math.max(max - min, 1) };
}

// pi-web 式工具参数智能摘要：command/path/file_path/pattern/query 优先
function toolPreview(input) {
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  if (!keys.length) return '';
  for (const k of ['command', 'path', 'file_path', 'pattern', 'query']) {
    if (k in input) return String(input[k]).slice(0, 90);
  }
  return String(input[keys[0]]).slice(0, 90);
}

// ---------- 树视图 ----------

function SpanRow({ span, selected, onSelect }) {
  const preview = span.spanType === 'tool' ? toolPreview(span.input) : '';
  return (
    <div
      className={selected ? 'trace-row active' : 'trace-row'}
      onClick={() => onSelect(span.id)}
      style={{ paddingLeft: 8 + span.depth * 20 }}
    >
      <span className={TYPE_TAG[span.spanType] || 'tag'}>{span.spanType}</span>
      <span className="trace-name mono">
        {span.name}
        {preview && <span className="trace-preview"> {preview}</span>}
      </span>
      {span.status === 'error' && <span className="tag bad">error</span>}
      <span className="trace-meta">{fmtTime(span.startMs)}</span>
      <span className="trace-meta trace-dur">{fmtDur(span.endMs != null ? span.endMs - span.startMs : null)}</span>
    </div>
  );
}

// ---------- 时间线瀑布图 ----------

function TimelineRow({ span, bounds, selected, onSelect }) {
  const { min, span: total } = bounds;
  const startPct = ((span.startMs - min) / total) * 100;
  const endRaw = span.endMs ?? Date.now();
  const widthPct = Math.max(((endRaw - span.startMs) / total) * 100, 0.6);
  const barClass = `tl-bar tl-${span.spanType}${span.status === 'error' ? ' tl-error' : ''}`;
  return (
    <div
      className={selected ? 'tl-row active' : 'tl-row'}
      onClick={() => onSelect(span.id)}
      title={`${span.name} · ${fmtDur((span.endMs ?? endRaw) - span.startMs)}`}
      style={{ paddingLeft: span.depth * 14 }}
    >
      <div className="tl-label mono">{span.name}</div>
      <div className="tl-track">
        <div className={barClass} style={{ left: `${startPct}%`, width: `${widthPct}%` }} />
      </div>
      <div className="tl-dur trace-meta">{fmtDur((span.endMs ?? endRaw) - span.startMs)}</div>
    </div>
  );
}

// ---------- 详情 ----------

function JsonBlock({ value }) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <pre className="output">{text}</pre>;
}

function SpanDetails({ span }) {
  if (!span) return <div className="trace-details mid">选中左侧 span 查看详情</div>;
  const preview = span.spanType === 'tool' ? toolPreview(span.input) : '';
  return (
    <div className="trace-details">
      <div className="row"><span className="rowlabel">span</span><span className="rowbody mono">{span.id}</span></div>
      <div className="row"><span className="rowlabel">父</span><span className="rowbody mono">{span.parentId || '(根)'}</span></div>
      <div className="row"><span className="rowlabel">开始</span><span className="rowbody">{fmtTime(span.startMs)}</span></div>
      <div className="row"><span className="rowlabel">耗时</span><span className="rowbody">{fmtDur(span.endMs != null ? span.endMs - span.startMs : null)}</span></div>
      <div className="row"><span className="rowlabel">状态</span><span className="rowbody">{span.status}</span></div>
      {preview && (
        <div className="trace-block">
          <div className="colhead">参数</div>
          <JsonBlock value={span.input} />
        </div>
      )}
      {span.text ? (
        <div className="trace-block">
          <div className="colhead">文本</div>
          <pre className="output">{span.text}</pre>
        </div>
      ) : null}
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

// view: 'tree' | 'timeline'
export default function TraceView({ taskId, taskStatus }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [view, setView] = useState('tree');

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
  const bounds = useMemo(() => timeBounds(data?.spans || []), [data]);
  const selected = data?.spans.find((s) => s.id === selectedId) || null;

  if (err) return <span className="bad mono">{err}</span>;
  if (!data) return <div className="mid">加载中…</div>;
  if (!data.spans.length) return <div className="mid">（无事件——此任务早于事件流功能，或尚未开始执行）</div>;

  return (
    <div className="trace">
      <div className="trace-head">
        <span>{data.spans.length} spans · {data.total} events · 总时长 {fmtDur(bounds.span)}</span>
        <span className="chat-views">
          <button className={view === 'tree' ? 'tab active' : 'tab'} onClick={() => setView('tree')}>树</button>
          <button className={view === 'timeline' ? 'tab active' : 'tab'} onClick={() => setView('timeline')}>时序</button>
        </span>
      </div>
      <div className="trace-body">
        <div className="trace-tree">
          {view === 'tree'
            ? rows.map((s) => <SpanRow key={s.id} span={s} selected={selectedId === s.id} onSelect={setSelectedId} />)
            : rows.map((s) => <TimelineRow key={s.id} span={s} bounds={bounds} selected={selectedId === s.id} onSelect={setSelectedId} />)}
        </div>
        <div className="trace-side">
          <div className="colhead">详情</div>
          <SpanDetails span={selected} />
        </div>
      </div>
    </div>
  );
}
