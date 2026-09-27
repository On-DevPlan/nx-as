import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';
import TraceView from './trace.jsx';

const STATUS_TAG = {
  pending: 'tag',
  queued: 'tag',
  running: 'tag strong',
  done: 'tag strong',
  error: 'tag bad',
};

// ---------- 极简 Markdown 渲染（零依赖） ----------
// 支持：代码块 ```、行内代码 `、粗体 **、标题 #~###、无序/有序列表、段落。
// 不支持的不硬解——原样输出。XSS 安全：全部走 React 文本节点，不碰 innerHTML。

function renderInline(text) {
  const parts = [];
  let rest = String(text);
  let key = 0;
  const codeRe = /`([^`\n]+)`/;
  const boldRe = /\*\*([^*]+)\*\*/;
  while (rest) {
    const cm = rest.match(codeRe);
    const bm = rest.match(boldRe);
    const cmIdx = cm ? cm.index : Infinity;
    const bmIdx = bm ? bm.index : Infinity;
    if (cmIdx === Infinity && bmIdx === Infinity) {
      parts.push(<span key={key++}>{rest}</span>);
      break;
    }
    if (cmIdx < bmIdx) {
      if (cm.index > 0) parts.push(<span key={key++}>{rest.slice(0, cm.index)}</span>);
      parts.push(<code key={key++}>{cm[1]}</code>);
      rest = rest.slice(cm.index + cm[0].length);
    } else {
      if (bm.index > 0) parts.push(<span key={key++}>{rest.slice(0, bm.index)}</span>);
      parts.push(<strong key={key++}>{bm[1]}</strong>);
      rest = rest.slice(bm.index + bm[0].length);
    }
  }
  return parts;
}

function Markdown({ text }) {
  const blocks = useMemo(() => {
    const src = String(text ?? '');
    const out = [];
    const lines = src.split(/\r?\n/);
    let i = 0;
    let key = 0;
    const isListItem = (l) => /^\s*[-*]\s+/.test(l);
    const isOrderedItem = (l) => /^\s*\d+[.)]\s+/.test(l);
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const body = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // 跳过收尾 ```
        out.push(<pre key={key++} className="md-code"><code>{body.join('\n')}</code></pre>);
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        out.push(<div key={key++} className={`md-h md-h${h[1].length}`}>{renderInline(h[2])}</div>);
        i++;
        continue;
      }
      if (isListItem(line)) {
        const items = [];
        while (i < lines.length && isListItem(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
          i++;
        }
        out.push(<ul key={key++}>{items.map((t, n) => <li key={n}>{renderInline(t)}</li>)}</ul>);
        continue;
      }
      if (isOrderedItem(line)) {
        const items = [];
        while (i < lines.length && isOrderedItem(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          i++;
        }
        out.push(<ol key={key++}>{items.map((t, n) => <li key={n}>{renderInline(t)}</li>)}</ol>);
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      // 普通段落：连续非空、非结构行
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^(#{1,3})\s/.test(lines[i]) && !isListItem(lines[i]) && !isOrderedItem(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      out.push(<p key={key++}>{renderInline(para.join('\n'))}</p>);
    }
    return out;
  }, [text]);
  return <div className="md">{blocks}</div>;
}

// ---------- span 工具 ----------

function fmtDur(startMs, endMs) {
  if (startMs == null) return '';
  if (endMs == null) return '…';
  const d = endMs - startMs;
  return d < 1000 ? `${d}ms` : `${(d / 1000).toFixed(1)}s`;
}

// timeline spans → 对话消息：
//   每个 turn span → 一条 assistant 消息（text + thinking）
//   turn 下的 tool span → 独立 tool 卡片消息
function spansToMessages(spans, tree, rootIds) {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const msgs = [];
  const visit = (id, depth) => {
    const s = byId.get(id);
    if (!s) return;
    if (s.spanType === 'turn') {
      msgs.push({ kind: 'assistant', span: s });
      for (const c of tree[id] || []) {
        const cs = byId.get(c);
        if (cs && cs.spanType === 'tool') msgs.push({ kind: 'tools', tool: cs });
      }
    } else if (s.spanType === 'llm' && depth === 0) {
      // 没有外层 turn 的散 llm span（兼容）
      msgs.push({ kind: 'assistant', span: s });
    }
    for (const c of tree[id] || []) visit(c, depth + 1);
  };
  for (const r of rootIds || []) visit(r, 0);
  return msgs;
}

function ThinkingBlock({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="msg-think">
      <button className="think-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 思考过程
      </button>
      {open && <pre className="output think-body">{text}</pre>}
    </div>
  );
}

function ToolCard({ tool }) {
  const [open, setOpen] = useState(false);
  const argsText = useMemo(() => (tool.input ? JSON.stringify(tool.input, null, 2) : ''), [tool.input]);
  const outText = useMemo(() => {
    const o = tool.output;
    if (o == null) return '';
    return typeof o === 'string' ? o : JSON.stringify(o, null, 2);
  }, [tool.output]);
  return (
    <div className="tool-card">
      <button className="think-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 工具 <span className="mono">{tool.name}</span>
        <span className="trace-meta"> {fmtDur(tool.startMs, tool.endMs)}</span>
      </button>
      {open && (
        <div className="tool-body">
          {argsText ? <><div className="colhead">输入</div><pre className="output">{argsText}</pre></> : null}
          {outText ? <><div className="colhead">输出</div><pre className="output">{outText}</pre></> : null}
        </div>
      )}
    </div>
  );
}

export default function TasksView() {
  const [list, setList] = useState([]);
  const [prompts, setPrompts] = useState([]);
  const [sel, setSel] = useState(null);
  const [task, setTask] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [liveText, setLiveText] = useState('');
  const [viewMode, setViewMode] = useState('chat'); // chat | trace
  const [form, setForm] = useState({ promptId: '', input: '' });
  const [err, setErr] = useState('');
  const esRef = useRef(null);
  const scrollRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      setList(await api('GET', '/api/tasks'));
      setPrompts(await api('GET', '/api/prompts'));
      if (sel) setTask(await api('GET', `/api/tasks/${sel}`));
    } catch (e) {
      setErr(e.message);
    }
  }, [sel]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // 选中任务 → 拉 timeline（终态任务用）+ SSE（running 时增量）
  useEffect(() => {
    setLiveText('');
    setTimeline(null);
    if (!sel) return undefined;

    let alive = true;
    api('GET', `/api/tasks/${sel}/timeline`)
      .then((d) => { if (alive) setTimeline(d); })
      .catch(() => { /* 老任务没有事件数据，静默 */ });

    esRef.current?.close();
    const token = localStorage.getItem('nxas_token') || '';
    const es = new EventSource(`/api/tasks/${sel}/events?token=${encodeURIComponent(token)}`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'text') setLiveText((s) => s + ev.delta);
        else if (ev.type === 'done' || ev.type === 'error') {
          refresh();
          // 终态后拉一次完整 timeline（拿到 thinking/tool span）
          api('GET', `/api/tasks/${sel}/timeline`).then((d) => { if (alive) setTimeline(d); }).catch(() => {});
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => es.close();
    return () => {
      alive = false;
      es.close();
    };
  }, [sel, refresh]);

  // 消息流：终态/历史任务从 timeline 重建；running 时在末尾追加 live 文本
  const messages = useMemo(() => {
    if (!timeline) return [];
    return spansToMessages(timeline.spans, timeline.tree, timeline.rootIds);
  }, [timeline]);

  const submit = async () => {
    setErr('');
    try {
      const t = await api('POST', '/api/tasks', { promptId: form.promptId, input: form.input });
      setForm({ promptId: '', input: '' });
      await refresh();
      setSel(t.id);
    } catch (e) {
      setErr(e.message);
    }
  };

  const remove = async (id) => {
    if (!confirm(`删除任务 ${id}?`)) return;
    try {
      await api('DELETE', `/api/tasks/${id}`);
      if (sel === id) setSel(null);
      await refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  const running = task?.status === 'running' || task?.status === 'queued';

  return (
    <Card title="任务">
      <Row label="提示词">
        <select value={form.promptId} onChange={(e) => setForm({ ...form, promptId: e.target.value })}>
          <option value="">选择提示词</option>
          {prompts.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
      </Row>
      <Row label="输入">
        <Input value={form.input} onChange={(v) => setForm({ ...form, input: v })} placeholder="传给 $input 的内容" />
        <Btn onClick={submit} disabled={!form.promptId}>提交任务</Btn>
      </Row>
      {err && <Row label="错误"><span className="bad">{err}</span></Row>}

      <div className="list">
        {list.length === 0 && <div className="row mid">无任务</div>}
        {list.map((t) => (
          <div key={t.id} className={sel === t.id ? 'row active' : 'row'} onClick={() => setSel(t.id)}>
            <span className={STATUS_TAG[t.status] || 'tag'}>{t.status}</span>
            <span className="mono">{t.id}</span>
            <span className="mid">{t.promptId} {String(t.input).slice(0, 30)}</span>
            {t.status !== 'running' && (
              <button className="linkbtn" onClick={(e) => { e.stopPropagation(); remove(t.id); }}>删</button>
            )}
          </div>
        ))}
      </div>

      {sel && (
        <div className="chat-wrap">
          <div className="chat-head">
            <span className="mono">{sel}</span>
            <span className={STATUS_TAG[task?.status] || 'tag'}>{task?.status}</span>
            <span className="chat-views">
              <button className={viewMode === 'chat' ? 'tab active' : 'tab'} onClick={() => setViewMode('chat')}>对话</button>
              <button className={viewMode === 'trace' ? 'tab active' : 'tab'} onClick={() => setViewMode('trace')}>调试</button>
            </span>
          </div>

          {viewMode === 'chat' && (
            <>
              <div className="chat-scroll" ref={scrollRef}>
                {messages.length === 0 && !liveText && <div className="row mid">（暂无消息）</div>}
                {messages.map((m) => (
                  m.kind === 'tools'
                    ? <div key={m.tool.id} className="msg"><ToolCard tool={m.tool} /></div>
                    : (
                      <div key={m.span.id} className="msg">
                        <ThinkingBlock text={m.span.attrs?.thinking} />
                        <div className="bubble assistant">
                          <Markdown text={m.span.text} />
                        </div>
                      </div>
                    )
                ))}
                {liveText && (
                  <div className="msg">
                    <div className="bubble assistant streaming">
                      <Markdown text={liveText} />
                    </div>
                  </div>
                )}
                {running && !liveText && <div className="row mid">执行中…</div>}
              </div>
              <div className="chat-input">
                <Input
                  value={form.input}
                  onChange={(v) => setForm({ ...form, input: v })}
                  placeholder={running ? '任务执行中…' : '补充输入（会作为新任务提交）'}
                />
                <Btn onClick={submit} disabled={!form.promptId || running}>发送</Btn>
              </div>
            </>
          )}

          {viewMode === 'trace' && <TraceView taskId={sel} taskStatus={task?.status} />}
        </div>
      )}
    </Card>
  );
}
