import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

export default function PromptsView() {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null); // 当前选中的提示词
  const [editing, setEditing] = useState(null); // {name, description, content} 编辑缓冲
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      setList(await api('GET', '/api/prompts'));
    } catch (e) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const open = async (name) => {
    setErr('');
    try {
      const p = await api('GET', `/api/prompts/${name}`);
      setSel(p);
      setEditing({ name: p.name, description: p.description, content: p.content });
      setCreating(false);
    } catch (e) {
      setErr(e.message);
    }
  };

  const save = async () => {
    setErr('');
    try {
      if (creating) {
        await api('POST', '/api/prompts', editing);
      } else {
        await api('PATCH', `/api/prompts/${editing.name}`, {
          description: editing.description,
          content: editing.content,
        });
      }
      await refresh();
      await open(editing.name);
    } catch (e) {
      setErr(e.message);
    }
  };

  const remove = async (name) => {
    if (!confirm(`删除提示词 ${name}?`)) return;
    setErr('');
    try {
      await api('DELETE', `/api/prompts/${name}`);
      setSel(null);
      setEditing(null);
      await refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <Card title="提示词">
      <div className="list">
        {list.length === 0 && <div className="row mid">无提示词，点「新建」创建第一个</div>}
        {list.map((p) => (
          <div key={p.name} className={sel?.name === p.name ? 'row active' : 'row'} onClick={() => open(p.name)}>
            <span className="mono">{p.name}</span>
            <span className="mid">{p.description || ''}</span>
          </div>
        ))}
      </div>
      <Row label="">
        <Btn onClick={() => { setCreating(true); setSel(null); setEditing({ name: '', description: '', content: '' }); }}>
          新建
        </Btn>
      </Row>
      {err && <Row label="错误"><span className="bad">{err}</span></Row>}
      {editing && (
        <>
          <Row label="名称">
            <Input value={editing.name} disabled={!creating}
              onChange={(v) => setEditing({ ...editing, name: v })} placeholder="英文/数字/-_，如 daily-report" />
          </Row>
          <Row label="描述">
            <Input value={editing.description} onChange={(v) => setEditing({ ...editing, description: v })} />
          </Row>
          <Row label="正文">
            <textarea className="mono" rows={8} value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
          </Row>
          <Row label="">
            <Btn onClick={save}>{creating ? '创建' : '保存'}</Btn>
            {!creating && <Btn onClick={() => remove(editing.name)} className="danger">删除</Btn>}
          </Row>
          <Row label="模板变量"><span className="mid">正文里用 $input 或 $&#123;input:-默认值&#125; 接收任务输入</span></Row>
        </>
      )}
    </Card>
  );
}
