import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Row } from '../../web/frontend/components/ui.jsx';

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const detailText = (e) => (e.detail === undefined || e.detail === null ? '' : JSON.stringify(e.detail));

// 审计页（只读）：时间 / 动作徽章 / 详情（截断→点击展开）；动作下拉 + 文本包含过滤
export default function SystemView() {
  const [entries, setEntries] = useState(null);
  const [actionFilter, setActionFilter] = useState('');
  const [textFilter, setTextFilter] = useState('');
  const [expanded, setExpanded] = useState(null); // 展开的条目下标
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api('GET', '/api/audit?limit=200');
      setEntries(r.entries || []);
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // 现有动作枚举（去重排序）——过滤下拉的选项
  const actions = useMemo(
    () => [...new Set((entries || []).map((e) => e.action).filter(Boolean))].sort(),
    [entries],
  );

  const filtered = useMemo(() => {
    let list = entries || [];
    if (actionFilter) list = list.filter((e) => e.action === actionFilter);
    const q = textFilter.trim().toLowerCase();
    if (q) {
      list = list.filter((e) =>
        String(e.action || '').toLowerCase().includes(q) || detailText(e).toLowerCase().includes(q));
    }
    return list;
  }, [entries, actionFilter, textFilter]);

  return (
    <Card title="审计日志（只读，最近 200 条）">
      <Row label="过滤">
        <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="">全部动作（{actions.length}）</option>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <input
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          placeholder="文本包含（动作/详情）"
        />
        <Btn onClick={refresh} disabled={busy}>刷新</Btn>
      </Row>

      <div className="audit-table">
        <div className="audit-row audit-head">
          <span>时间</span><span>动作</span><span>详情</span>
        </div>
        {entries !== null && filtered.length === 0 && (
          <Row label=""><span className="mid">{entries.length ? '（无匹配条目）' : '暂无记录——登录 / 隧道 / nginx 变更都会落审计'}</span></Row>
        )}
        {filtered.map((e, i) => {
          const d = detailText(e);
          const open = expanded === i;
          return (
            <div key={`${e.ts}-${i}`} className={`audit-row ${open ? 'open' : ''}`}
              onClick={() => setExpanded(open ? null : i)}>
              <span className="mid">{fmtTime(e.ts)}</span>
              <span><span className={`tag audit-action ${String(e.action || '').startsWith('gw.') ? '' : 'strong'}`}>{e.action || '?'}</span></span>
              <span className={`audit-detail ${open ? 'open' : ''}`} title={open ? '点击收起' : '点击展开'}>
                {d || <span className="mid">—</span>}
              </span>
            </div>
          );
        })}
      </div>

      {msg && (
        <Row label={msg.type === 'ok' ? '结果' : '错误'}>
          <span className={msg.type === 'ok' ? '' : 'bad'}>{msg.text}</span>
        </Row>
      )}
    </Card>
  );
}
