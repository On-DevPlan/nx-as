import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

const STATUS_TAG = {
  pending: 'tag',
  queued: 'tag',
  running: 'tag strong',
  done: 'tag strong',
  error: 'tag bad',
};

export default function TasksView() {
  const [list, setList] = useState([]);
  const [prompts, setPrompts] = useState([]);
  const [sel, setSel] = useState(null);
  const [stream, setStream] = useState('');
  const [form, setForm] = useState({ promptId: '', input: '' });
  const [err, setErr] = useState('');
  const esRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      setList(await api('GET', '/api/tasks'));
      setPrompts(await api('GET', '/api/prompts'));
    } catch (e) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // 选中任务后接 SSE 实时流
  useEffect(() => {
    esRef.current?.close();
    setStream('');
    if (!sel) return;
    const token = localStorage.getItem('nxas_token') || '';
    const es = new EventSource(`/api/tasks/${sel}/events?token=${encodeURIComponent(token)}`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'text') setStream((s) => s + ev.delta);
        else if (ev.type === 'done') {
          setStream(ev.result);
          refresh();
        } else if (ev.type === 'error') {
          setErr(ev.error);
          refresh();
        } else if (ev.type === 'tool_start') {
          setStream((s) => s + `\n[调用工具: ${ev.tool}]\n`);
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [sel, refresh]);

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
        <Input value={form.input} onChange={(v) => setForm({ ...form, input: v })}
          placeholder="传给 $input 的内容" />
      </Row>
      <Row label="">
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
        <>
          <div className="colhead">实时输出 / 结果 — {sel}</div>
          <pre className="mono output">{stream || '(等待事件)'}</pre>
        </>
      )}
    </Card>
  );
}
