import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

export default function PluginsView() {
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(null);
  const [content, setContent] = useState('');
  const [filter, setFilter] = useState('all'); // all | extension | skill
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      setData(await api('GET', `/api/plugins?type=${filter}`));
    } catch (e) {
      setErr(e.message);
    }
  }, [filter]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const open = async (type, name) => {
    setErr('');
    try {
      const p = await api('GET', `/api/plugins/${type}/${name}`);
      setSel({ type, name });
      setContent(p.content || '(空)');
    } catch (e) {
      setErr(e.message);
    }
  };

  const toggle = async (type, name, currentEnabled) => {
    setErr('');
    try {
      await api('POST', `/api/plugins/${type}/${name}/enabled`, { disabled: currentEnabled });
      await refresh();
      if (sel?.type === type && sel?.name === name) {
        const p = await api('GET', `/api/plugins/${type}/${name}`);
        setContent(p.content || '(空)');
      }
    } catch (e) {
      setErr(e.message);
    }
  };

  const uninstall = async (type, name) => {
    if (!confirm(`卸载 ${type}/${name}？此操作删除文件，不可恢复`)) return;
    setErr('');
    try {
      await api('DELETE', `/api/plugins/${type}/${name}`);
      setSel(null);
      setContent('');
      await refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  const items = [];
  if (data?.extensions) for (const e of data.extensions) items.push({ ...e, _kind: 'extension' });
  if (data?.skills) for (const s of data.skills) items.push({ ...s, _kind: 'skill' });

  return (
    <Card title="插件（pi extensions + skills）">
      <Row label="类型">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">全部</option>
          <option value="extension">扩展</option>
          <option value="skill">技能</option>
        </select>
        <span className="mid"> 来源：~/.nx-as/pi-agent/{`{extensions,skills}`}/</span>
      </Row>
      <Row label="安装">
        <Btn onClick={async () => {
          const src = prompt('输入本地路径（含 SKILL.md 的目录）');
          if (!src) return;
          try { await api('POST', '/api/plugins/install', { source: src }); await refresh(); }
          catch (e) { setErr(e.message); }
        }}>从本地路径安装</Btn>
        <span className="mid"> git/npm 后续支持</span>
      </Row>
      {err && <Row label="错误"><span className="bad">{err}</span></Row>}

      <div className="list">
        {items.length === 0 && <div className="row mid">无项目</div>}
        {items.map((p) => (
          <div key={`${p._kind}/${p.name}`} className={sel?.type === p._kind && sel?.name === p.name ? 'row active' : 'row'}>
            <span className={p.enabled ? 'tag strong' : 'tag'}>
              {p.enabled ? 'on' : 'off'}
            </span>
            <span className="mono">{p.name}</span>
            <span className="tag">{p._kind}</span>
            <span className="mid">{p.description || ''}</span>
            <button className="linkbtn" onClick={(e) => { e.stopPropagation(); toggle(p._kind, p.name, p.enabled); }}>
              {p.enabled ? '禁' : '启'}
            </button>
            <button className="linkbtn" onClick={(e) => { e.stopPropagation(); open(p._kind, p.name); }}>查看</button>
            <button className="linkbtn" onClick={(e) => { e.stopPropagation(); uninstall(p._kind, p.name); }}>卸</button>
          </div>
        ))}
      </div>

      {sel && (
        <>
          <div className="colhead">{sel.type}/{sel.name}</div>
          <pre className="mono output">{content}</pre>
        </>
      )}
    </Card>
  );
}