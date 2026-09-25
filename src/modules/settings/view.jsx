import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

export default function SettingsView() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setS(await api('GET', '/api/settings'));
    } catch (e) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async () => {
    setErr('');
    setSaved(false);
    try {
      await api('PATCH', '/api/settings', {
        maxConcurrent: Number(s.maxConcurrent),
        autoRun: Boolean(s.autoRun),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  if (!s) return <Card title="设置">加载中{err ? ` — ${err}` : ''}</Card>;

  return (
    <Card title="设置">
      <Row label="并发数">
        <Input value={String(s.maxConcurrent)} onChange={(v) => setS({ ...s, maxConcurrent: Number(v) || 1 })} />
      </Row>
      <Row label="创建即执行">
        <input type="checkbox" checked={Boolean(s.autoRun)} onChange={(e) => setS({ ...s, autoRun: e.target.checked })} />
        <span className="mid"> task add 后自动开始执行</span>
      </Row>
      <Row label="">
        <Btn onClick={save}>保存</Btn>
        {saved && <span className="tag strong">已保存</span>}
      </Row>
      {err && <Row label="错误"><span className="bad">{err}</span></Row>}
    </Card>
  );
}
